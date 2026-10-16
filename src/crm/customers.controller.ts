import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  NotFoundException,
  Param,
  Headers,
  HttpCode,
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  UseGuards,
  Inject,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ApiJsonBody } from '../api-bodies.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AccessService, grantsForBrand } from '../auth/access.service.js';
import { permissionsFor } from '../auth/permissions.js';
import { randomUUID } from 'node:crypto';
import { text, uuid } from '../auth/validation.js';
import { AuditService } from '../database/audit.service.js';
import type { ClientSession } from 'mongodb';
import { MongoService } from '../database/mongo.service.js';
import { IntegrationService } from '../integration/integration.service.js';
import { customerInput } from '../integration/validation.js';
import {
  publicRecord,
  type CustomerRelationship,
  type CustomerVehicle,
} from '../database/models.js';

@Controller('customers')
@ApiTags('Customers')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class CustomersController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(IntegrationService)
    private readonly integration: IntegrationService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiPagination()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('siteId') siteId?: string,
    @Query('search') search?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    const id = uuid(siteId, 'siteId');
    const site = await this.access.requireSite(request, id, 'customers.read');
    if (search !== undefined && typeof search !== 'string')
      throw new BadRequestException('search must be text');
    const term = search?.trim().slice(0, 60);
    const escaped = term?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Shared customer identity is visible across the authorized site; tasks remain assigned-user scoped.
    const page = pagination(offset, limit);
    const customers = await this.mongo.customers
      .find({
        ...this.integration.projectionFilter(),
        site_id: id,
        organisation_id: site.organisation_id,
        ...(escaped
          ? {
              $or: ['first_name', 'last_name', 'email', 'phone'].map(
                (field) => ({ [field]: { $regex: escaped, $options: 'i' } }),
              ),
            }
          : {}),
      })
      .sort({ updated_at: -1, id: 1 })
      .skip(page.offset)
      .limit(page.limit + 1)
      .toArray();
    const result = pageResult(customers, page);
    return {
      customers: result.rows.map(publicRecord),
      pagination: result.pagination,
      integration: this.integration.config.info(),
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get customer profile and linked follow-ups',
    description:
      'Requires siteId and current customer read access. Returns customer contact/source/assignment, site metadata, assignee name, taskVisibility, follow-up permission, and integration label. offset/limit paginate linked follow-ups only. Default staff see own follow-ups; tasks.view_team permits team visibility. Unknown, other-site, or other-mode customer IDs return 404 after site authorization.',
  })
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  @ApiPagination()
  async detail(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('siteId') siteId?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    uuid(id, 'customerId');
    const targetSite = uuid(siteId, 'siteId');
    const page = pagination(offset, limit);
    // Site and mode are part of every lookup; guessing a customer ID cannot widen access.
    return this.mongo.transaction(async (session) => {
      const site = await this.access.requireSite(
        request,
        targetSite,
        'customers.read',
        session,
      );
      const customer = await this.mongo.customers.findOne(
        {
          ...this.integration.projectionFilter(),
          id,
          site_id: targetSite,
          organisation_id: site.organisation_id,
        },
        { session },
      );
      if (!customer)
        throw new NotFoundException('Customer is unavailable at this site');
      const canReadTasks = await this.access.hasSitePermission(
        request,
        targetSite,
        'tasks.read',
        session,
      );
      const viewTeam =
        canReadTasks &&
        (await this.access.hasSitePermission(
          request,
          targetSite,
          'tasks.view_team',
          session,
        ));
      const canCreateFollowUp = await this.access.hasSitePermission(
        request,
        targetSite,
        'tasks.write',
        session,
      );
      const rows = canReadTasks
        ? await this.mongo.tasks
            .find(
              {
                ...this.integration.projectionFilter(),
                customer_id: id,
                site_id: targetSite,
                organisation_id: site.organisation_id,
                ...(viewTeam ? {} : { assigned_to: request.user!.id }),
              },
              { session },
            )
            .sort({ completed_at: 1, due_at: 1, id: 1 })
            .skip(page.offset)
            .limit(page.limit + 1)
            .toArray()
        : [];
      const result = pageResult(rows, page);
      const membership = await this.mongo.memberships.findOne(
        {
          user_id: customer.assigned_to,
          organisation_id: site.organisation_id,
          $or: [
            { site_id: null, role: 'ADMIN' },
            { site_id: targetSite, role: { $in: ['SALES', 'SERVICE'] } },
          ],
        },
        { session },
      );
      // Expose only a name for an assignee in this site/organisation, never staff credentials/contact details.
      const profile = membership
        ? await this.mongo.users.findOne(
            { _id: customer.assigned_to },
            { session, projection: { full_name: 1 } },
          )
        : null;
      return {
        customer: publicRecord(customer),
        site: {
          id: site.id,
          organisation_id: site.organisation_id,
          name: site.name,
          timezone: site.timezone,
        },
        assignee: {
          id: customer.assigned_to,
          fullName: profile?.full_name ?? null,
        },
        tasks: result.rows.map(publicRecord),
        pagination: result.pagination,
        taskVisibility: canReadTasks ? (viewTeam ? 'team' : 'own') : 'none',
        permissions: { canCreateFollowUp },
        integration: this.integration.config.info(),
      };
    });
  }

  @Get(':id/activity')
  @ApiOperation({
    summary: 'Read customer activity history',
    description:
      'Paginated customer/source events and permitted follow-up events. Staff see own task events unless tasks.view_team is granted. Raw audit metadata and integration request bodies are not exposed.',
  })
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  @ApiQuery({
    name: 'desk',
    required: false,
    enum: ['all', 'sales', 'service', 'messages', 'tasks'],
  })
  @ApiPagination()
  async activity(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('siteId') siteId?: string,
    @Query('desk') desk?: string,
    @Query('order') order?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    uuid(id, 'customerId');
    const targetSite = uuid(siteId, 'siteId');
    const page = pagination(offset, limit);
    return this.mongo.transaction(async (session) => {
      const site = await this.access.requireSite(
        request,
        targetSite,
        'customers.read',
        session,
      );
      const customer = await this.mongo.customers.findOne(
        {
          ...this.integration.projectionFilter(),
          id,
          site_id: targetSite,
          organisation_id: site.organisation_id,
        },
        { session },
      );
      if (!customer)
        throw new NotFoundException('Customer is unavailable at this site');
      const canReadTasks = await this.access.hasSitePermission(
        request,
        targetSite,
        'tasks.read',
        session,
      );
      const viewTeam =
        canReadTasks &&
        (await this.access.hasSitePermission(
          request,
          targetSite,
          'tasks.view_team',
          session,
        ));
      const serviceRead = await this.access.hasSitePermission(
        request,
        targetSite,
        'service.read',
        session,
      );
      const serviceTeam =
        serviceRead &&
        (await this.access.hasSitePermission(
          request,
          targetSite,
          'service.view_team',
          session,
        ));
      const salesRead = await this.access.hasSitePermission(
        request,
        targetSite,
        'sales.read',
        session,
      );
      const salesTeam =
        salesRead &&
        (await this.access.hasSitePermission(
          request,
          targetSite,
          'sales.view_team',
          session,
        ));
      const grants =
        serviceRead || salesRead
          ? await this.access.memberships(request, session)
          : [];
      const salesBrands = (site.brand_ids ?? []).filter((brand) =>
        permissionsFor(grantsForBrand(grants, site, brand)).includes(
          'sales.read',
        ),
      );
      const serviceBrands = (site.brand_ids ?? []).filter((brand) =>
        permissionsFor(grantsForBrand(grants, site, brand)).includes(
          'service.read',
        ),
      );
      const customerActions = [
        'customer.created',
        'customer.source_imported',
        'customer.source_updated',
        'customer.note_added',
        'customer.call_logged',
        'customer.updated',
        'customer.privacy_updated',
        'customer.assigned',
        'customer.change_queued',
        'customer.change_rejected',
        'customer.change_retry_wait',
        'customer.change_failed',
        'customer.change_needs_review',
        'customer.activity_mirror_succeeded',
        'customer.activity_mirror_rejected',
        'customer.activity_mirror_failed',
        'customer.activity_mirror_needs_review',
        'customer.service_recovery_resolved',
        'customer.message_sending',
        'customer.message_accepted',
        'customer.message_rejected',
        'customer.message_needs_review',
        'customer.message_delivered',
        'customer.message_bounced',
      ];
      const taskActions = [
        'task.created',
        'task.completed',
        'task.updated',
        'task.rescheduled',
        'task.assigned',
        'task.cancelled',
      ];
      const messageActions = [
        'customer.message_sending',
        'customer.message_accepted',
        'customer.message_rejected',
        'customer.message_needs_review',
        'customer.message_delivered',
        'customer.message_bounced',
      ];

      const deskFilter = desk ?? 'all';
      if (
        !['all', 'sales', 'service', 'messages', 'tasks'].includes(
          deskFilter,
        ) ||
        (order && !['asc', 'desc'].includes(order))
      )
        throw new BadRequestException('Invalid timeline filter/order');
      const matchCriteria = [];
      if (deskFilter === 'all') {
        matchCriteria.push({
          entity_type: 'customer',
          entity_id: id,
          action: { $in: customerActions },
        });
      }
      if ((deskFilter === 'all' || deskFilter === 'sales') && salesRead)
        matchCriteria.push({ entity_type: 'sales_lead' });
      if ((deskFilter === 'all' || deskFilter === 'tasks') && canReadTasks) {
        matchCriteria.push({
          entity_type: 'task',
          action: { $in: taskActions },
        });
      }
      if ((deskFilter === 'all' || deskFilter === 'service') && serviceRead) {
        matchCriteria.push({
          entity_type: 'service_appointment',
          'metadata.customer_id': id,
        });
        matchCriteria.push({
          entity_type: 'repair_order',
          'metadata.customer_id': id,
        });
      }
      if (deskFilter === 'messages') {
        matchCriteria.push({
          entity_type: 'customer',
          entity_id: id,
          action: { $in: messageActions },
        });
      }

      const rows = await this.mongo.auditEvents
        .aggregate<
          import('../database/models.js').AuditEvent & {
            journal: import('../database/models.js').CustomerJournal[];
            activity_at: string;
          }
        >(
          [
            {
              $match: {
                organisation_id: site.organisation_id,
                site_id: targetSite,
                $or: matchCriteria.length
                  ? matchCriteria
                  : [{ _id: '__none__' }],
              },
            },
            {
              $lookup: {
                from: 'sales_leads',
                let: { entity: '$entity_id' },
                pipeline: [
                  {
                    $match: {
                      ...this.integration.projectionFilter(),
                      organisation_id: site.organisation_id,
                      site_id: targetSite,
                      customer_id: id,
                      ...(salesTeam ? {} : { assigned_to: request.user!.id }),
                      $expr: { $eq: ['$id', '$$entity'] },
                    },
                  },
                  { $project: { _id: 0, id: 1 } },
                ],
                as: 'linked_sales_lead',
              },
            },
            {
              $lookup: {
                from: 'tasks',
                let: { entity: '$entity_id' },
                pipeline: [
                  {
                    $match: {
                      ...this.integration.projectionFilter(),
                      site_id: targetSite,
                      organisation_id: site.organisation_id,
                      customer_id: id,
                      ...(viewTeam ? {} : { assigned_to: request.user!.id }),
                      $expr: { $eq: ['$id', '$$entity'] },
                    },
                  },
                  { $project: { _id: 0, id: 1 } },
                ],
                as: 'linked_task',
              },
            },
            {
              $lookup: {
                from: 'service_appointments',
                let: { entity: '$entity_id' },
                pipeline: [
                  {
                    $match: {
                      ...this.integration.projectionFilter(),
                      organisation_id: site.organisation_id,
                      site_id: targetSite,
                      customer_id: id,
                      brand_id: { $in: serviceBrands },
                      ...(serviceTeam ? {} : { assigned_to: request.user!.id }),
                      $expr: { $eq: ['$id', '$$entity'] },
                    },
                  },
                  { $project: { _id: 0, id: 1 } },
                ],
                as: 'linked_appointment',
              },
            },
            {
              $lookup: {
                from: 'repair_orders',
                let: { entity: '$entity_id' },
                pipeline: [
                  {
                    $match: {
                      ...this.integration.projectionFilter(),
                      organisation_id: site.organisation_id,
                      site_id: targetSite,
                      customer_id: id,
                      brand_id: { $in: serviceBrands },
                      ...(serviceTeam ? {} : { assigned_to: request.user!.id }),
                      $expr: { $eq: ['$id', '$$entity'] },
                    },
                  },
                  { $project: { _id: 0, id: 1 } },
                ],
                as: 'linked_repair_order',
              },
            },
            {
              $match: {
                $or: [
                  { entity_type: 'customer' },
                  ...(salesRead
                    ? [{ 'linked_sales_lead.0': { $exists: true } }]
                    : []),
                  ...(canReadTasks
                    ? [{ 'linked_task.0': { $exists: true } }]
                    : []),
                  ...(serviceRead
                    ? [
                        { 'linked_appointment.0': { $exists: true } },
                        { 'linked_repair_order.0': { $exists: true } },
                      ]
                    : []),
                ],
              },
            },
            {
              $lookup: {
                from: 'customer_journal',
                let: { journalId: '$metadata.journal_id' },
                pipeline: [
                  {
                    $match: {
                      ...this.integration.projectionFilter(),
                      organisation_id: site.organisation_id,
                      site_id: targetSite,
                      customer_id: id,
                      $expr: { $eq: ['$id', '$$journalId'] },
                    },
                  },
                ],
                as: 'journal',
              },
            },
            {
              $match: {
                $or: [
                  {
                    action: {
                      $nin: ['customer.note_added', 'customer.call_logged'],
                    },
                  },
                  { 'journal.0': { $exists: true } },
                ],
              },
            },
            {
              $addFields: {
                activity_at: {
                  $ifNull: [
                    { $arrayElemAt: ['$journal.occurred_at', 0] },
                    '$created_at',
                  ],
                },
              },
            },
            {
              $match: {
                $or: [
                  { entity_type: { $ne: 'sales_lead' } },
                  { 'metadata.stock_brand_id': { $exists: false } },
                  { 'metadata.stock_brand_id': { $in: salesBrands } },
                ],
              },
            },
            { $sort: { activity_at: order === 'asc' ? 1 : -1, id: 1 } },
            { $skip: page.offset },
            { $limit: page.limit + 1 },
          ],
          { session },
        )
        .toArray();
      const result = pageResult(rows, page);
      const names = await this.mongo.users
        .find(
          {
            _id: {
              $in: [
                ...new Set(result.rows.map((event) => event.actor_user_id)),
              ],
            },
          },
          { session, projection: { full_name: 1 } },
        )
        .toArray();
      const labels: Record<string, string> = {
        'customer.created': 'Customer creation confirmed',
        'customer.source_imported': 'Customer imported from source',
        'customer.source_updated': 'Customer refreshed from source',
        'task.created': 'Follow-up created',
        'task.completed': 'Follow-up completed',
        'customer.note_added': 'Internal note added',
        'customer.call_logged': 'Customer call logged',
        'customer.updated': 'Contact changes confirmed',
        'customer.privacy_updated': 'Privacy changes confirmed',
        'customer.assigned': 'Customer reassigned',
        'customer.change_queued': 'Customer change pending',
        'customer.change_rejected': 'Customer change rejected',
        'customer.change_retry_wait': 'Customer change waiting to retry',
        'customer.change_failed': 'Customer change failed',
        'customer.change_needs_review': 'Customer change needs review',
        'task.updated': 'Task edited',
        'task.rescheduled': 'Task rescheduled',
        'task.assigned': 'Task reassigned',
        'task.cancelled': 'Task cancelled',
        'customer.message_sending': 'Message submission started',
        'customer.message_accepted': 'Message accepted by transport',
        'customer.message_rejected': 'Message rejected',
        'customer.message_needs_review': 'Email outcome needs review',
        'customer.message_delivered': 'Email delivery evidence recorded',
        'customer.message_bounced': 'Email bounce evidence recorded',
      };
      return {
        customerId: id,
        activities: result.rows.map((event) => ({
          id: event.id,
          type: event.action,
          summary:
            event.entity_type === 'repair_order'
              ? event.action
                  .replace('service.repair_order_', 'Repair order ')
                  .replaceAll('_', ' ')
              : event.entity_type === 'service_appointment'
                ? event.action
                    .replace('service.appointment_', 'Service appointment ')
                    .replaceAll('_', ' ')
                : event.entity_type === 'sales_lead'
                  ? event.action
                      .replace('sales.', 'Sales ')
                      .replaceAll('_', ' ')
                  : (labels[event.action] ?? event.action.replaceAll('_', ' ')),
          occurredAt: event.activity_at,
          recordedAt: event.created_at,
          author: {
            id: event.actor_user_id,
            fullName:
              names.find((user) => user._id === event.actor_user_id)
                ?.full_name ?? null,
          },
          ...(event.entity_type === 'task' ? { taskId: event.entity_id } : {}),
          ...(event.entity_type === 'service_appointment'
            ? { appointmentId: event.entity_id }
            : {}),
          ...(event.entity_type === 'repair_order'
            ? { repairOrderId: event.entity_id }
            : {}),
          ...(event.metadata?.command_id
            ? { commandId: event.metadata.command_id }
            : {}),
          ...(event.metadata?.message_id
            ? { messageId: event.metadata.message_id }
            : {}),
          ...(event.journal[0]
            ? {
                journal: {
                  id: event.journal[0].id,
                  kind: event.journal[0].kind,
                  text: event.journal[0].text,
                  ...(event.journal[0].kind === 'call'
                    ? {
                        direction: event.journal[0].direction,
                        outcome: event.journal[0].outcome,
                      }
                    : {}),
                },
              }
            : {}),
        })),
        pagination: result.pagination,
        taskVisibility: canReadTasks ? (viewTeam ? 'team' : 'own') : 'none',
        integration: this.integration.config.info(),
      };
    });
  }

  @Post()
  @HttpCode(202)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      '8–200 characters; reuse for retries of the identical request.',
  })
  @ApiJsonBody('customer')
  async create(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body()
    body: {
      siteId?: unknown;
      firstName?: unknown;
      lastName?: unknown;
      email?: unknown;
      phone?: unknown;
    },
  ) {
    const siteId = uuid(body.siteId, 'siteId');
    return this.integration.enqueueCustomer(
      request,
      siteId,
      customerInput(body),
      key,
    );
  }

  private async customerScope(
    request: AuthenticatedRequest,
    id: string,
    siteId: string,
    permission = 'customers.read',
    session?: ClientSession,
  ) {
    const site = await this.access.requireSite(
      request,
      uuid(siteId, 'siteId'),
      permission,
      session,
    );
    const customer = await this.mongo.customers.findOne(
      {
        ...this.integration.projectionFilter(),
        id: uuid(id, 'customerId'),
        site_id: siteId,
        organisation_id: site.organisation_id,
      },
      { session },
    );
    if (!customer) throw new NotFoundException('Customer is unavailable');
    return { site, customer };
  }
  @Get(':id/vehicles')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async vehicles(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() q: Record<string, string>,
  ) {
    const { site } = await this.customerScope(req, id, q.siteId),
      page = pagination(q.offset, q.limit);
    const result = pageResult(
      await this.mongo.customerVehicles
        .find({
          ...this.integration.projectionFilter(),
          organisation_id: site.organisation_id,
          site_id: site.id,
          customer_id: id,
        })
        .sort({ updated_at: -1, id: 1 })
        .skip(page.offset)
        .limit(page.limit + 1)
        .toArray(),
      page,
    );
    return {
      vehicles: result.rows.map(publicRecord),
      pagination: result.pagination,
      sitesDealtWith: [{ id: site.id, name: site.name }],
    };
  }
  @Post(':id/vehicles')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        siteId: { type: 'string', format: 'uuid' },
        make: { type: 'string' },
        model: { type: 'string' },
        year: { type: 'integer' },
        registration: { type: 'string' },
        vin: { type: 'string' },
        ownership: { type: 'string', enum: ['owned', 'previous'] },
        odometerKm: { type: 'integer' },
        nextServiceDate: { type: 'string' },
        openCampaigns: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  async addVehicle(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() b: Record<string, unknown>,
  ) {
    if (this.integration.config.mode !== 'simulated')
      throw new ServiceUnavailableException(
        'Customer vehicle fixtures are local/simulated only',
      );
    const siteId = uuid(b.siteId, 'siteId'),
      createKey = text(key, 'Idempotency-Key', 8, 200);
    if (
      !Number.isInteger(b.year) ||
      Number(b.year) < 1900 ||
      Number(b.year) > 2100
    )
      throw new BadRequestException('Invalid vehicle year');
    if (
      b.odometerKm !== undefined &&
      (!Number.isInteger(b.odometerKm) || Number(b.odometerKm) < 0)
    )
      throw new BadRequestException('Invalid odometer');
    if (
      b.ownership !== undefined &&
      !['owned', 'previous'].includes(String(b.ownership))
    )
      throw new BadRequestException('Invalid vehicle ownership');
    if (
      b.nextServiceDate &&
      !Number.isFinite(Date.parse(String(b.nextServiceDate)))
    )
      throw new BadRequestException('Invalid next service date');
    const fields = {
      make: text(b.make, 'make', 1, 50),
      model: text(b.model, 'model', 1, 50),
      year: Number(b.year),
      registration: text(b.registration, 'registration', 1, 20).toUpperCase(),
      vin: text(b.vin, 'vin', 1, 30).toUpperCase(),
      odometer_km: b.odometerKm === undefined ? null : Number(b.odometerKm),
      next_service_date: b.nextServiceDate
        ? new Date(String(b.nextServiceDate)).toISOString()
        : null,
      ownership: (b.ownership ?? 'owned') as 'owned' | 'previous',
      open_campaigns: Array.isArray(b.openCampaigns)
        ? b.openCampaigns.map((v) => text(v, 'campaign', 1, 200)).slice(0, 30)
        : [],
      notes: b.notes ? text(b.notes, 'notes', 1, 1000) : null,
    };
    return this.mongo.transaction(async (session) => {
      const { site } = await this.customerScope(
        req,
        id,
        siteId,
        'customers.write',
        session,
      );
      await this.access.requireSite(req, siteId, 'users.manage', session);
      await this.mongo.organisations.updateOne(
        { id: site.organisation_id },
        { $inc: { access_revision: 1 } },
        { session },
      );
      const external = 'simulated-vehicle-' + createKey;
      const prior = await this.mongo.customerVehicles.findOne(
        { site_id: siteId, external_id: external },
        { session },
      );
      if (prior) {
        if (
          prior.customer_id !== id ||
          Object.entries(fields).some(
            ([k, v]) =>
              JSON.stringify(prior[k as keyof typeof prior]) !==
              JSON.stringify(v),
          )
        )
          throw new ConflictException('Fixture key reused');
        return { vehicle: publicRecord(prior), replayed: true };
      }
      const vehicleId = randomUUID(),
        now = new Date().toISOString();
      const record: CustomerVehicle = {
        _id: vehicleId,
        id: vehicleId,
        organisation_id: site.organisation_id,
        site_id: siteId,
        customer_id: id,
        ...fields,
        external_id: external,
        integration_mode: 'simulated',
        created_at: now,
        updated_at: now,
      };
      await this.mongo.customerVehicles.insertOne(record, { session });
      await this.audit.record(
        session,
        req.user!.id,
        site.organisation_id,
        siteId,
        'customer.vehicle_simulated',
        'customer',
        id,
        { vehicle_id: vehicleId },
      );
      return { vehicle: publicRecord(record), replayed: false };
    });
  }
  @Get(':id/relationships')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async relationships(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() q: Record<string, string>,
  ) {
    const { site } = await this.customerScope(req, id, q.siteId),
      page = pagination(q.offset, q.limit),
      filter = {
        organisation_id: site.organisation_id,
        site_id: site.id,
        ...this.integration.projectionFilter(),
      };
    const rows = pageResult(
      await this.mongo.customerRelationships
        .find({ ...filter, customer_id: id })
        .sort({ updated_at: -1, id: 1 })
        .skip(page.offset)
        .limit(page.limit + 1)
        .toArray(),
      page,
    );
    const related = await this.mongo.customers
      .find({
        ...filter,
        id: { $in: rows.rows.map((r) => r.related_customer_id) },
      })
      .toArray();
    return {
      relationships: rows.rows.map((r) => ({
        ...publicRecord(r),
        relatedCustomer:
          related
            .filter((c) => c.id === r.related_customer_id)
            .map((c) => ({
              id: c.id,
              fullName: `${c.first_name} ${c.last_name}`,
            }))[0] ?? null,
      })),
      pagination: rows.pagination,
    };
  }
  @Post(':id/relationships')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        siteId: { type: 'string', format: 'uuid' },
        relatedCustomerId: { type: 'string', format: 'uuid' },
        relationType: { type: 'string' },
        notes: { type: 'string' },
      },
    },
  })
  async addRelationship(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() b: Record<string, unknown>,
  ) {
    if (this.integration.config.mode !== 'simulated')
      throw new ServiceUnavailableException(
        'Relationship fixtures are local/simulated only',
      );
    const siteId = uuid(b.siteId, 'siteId'),
      relatedId = uuid(b.relatedCustomerId, 'relatedCustomerId');
    if (id === relatedId)
      throw new BadRequestException('Cannot relate a customer to itself');
    if (
      ![
        'household',
        'spouse',
        'company',
        'subsidiary',
        'fleet_driver',
        'parent_child',
        'other',
      ].includes(String(b.relationType))
    )
      throw new BadRequestException('Invalid relationType');
    return this.mongo.transaction(async (session) => {
      const { site } = await this.customerScope(
        req,
        id,
        siteId,
        'customers.write',
        session,
      );
      await this.access.requireSite(req, siteId, 'users.manage', session);
      await this.customerScope(
        req,
        relatedId,
        siteId,
        'customers.read',
        session,
      );
      const prior = await this.mongo.customerRelationships.findOne(
        { site_id: siteId, customer_id: id, related_customer_id: relatedId },
        { session },
      );
      if (prior) {
        if (prior.relation_type !== b.relationType)
          throw new ConflictException(
            'Relationship exists with a different type',
          );
        return { relationship: publicRecord(prior) };
      }
      const relId = randomUUID(),
        now = new Date().toISOString();
      const rel: CustomerRelationship = {
        _id: relId,
        id: relId,
        organisation_id: site.organisation_id,
        site_id: siteId,
        customer_id: id,
        related_customer_id: relatedId,
        relation_type: b.relationType as CustomerRelationship['relation_type'],
        notes: b.notes ? text(b.notes, 'notes', 1, 1000) : null,
        integration_mode: 'simulated',
        created_at: now,
        updated_at: now,
      };
      await this.mongo.customerRelationships.insertOne(rel, { session });
      await this.audit.record(
        session,
        req.user!.id,
        site.organisation_id,
        siteId,
        'customer.relationship_simulated',
        'customer',
        id,
        { related_customer_id: relatedId },
      );
      return { relationship: publicRecord(rel) };
    });
  }
}
