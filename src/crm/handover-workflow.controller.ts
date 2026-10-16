import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import { AccessService, grantsForBrand } from '../auth/access.service.js';
import { permissionsFor } from '../auth/permissions.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import {
  publicRecord,
  type HandoverItem,
  type ServiceAppointment,
} from '../database/models.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { DeliveriesService } from './deliveries.service.js';
import { IntegrationService } from '../integration/integration.service.js';
import { appointmentWindow } from './service-appointments.controller.js';
import { WorkshopService } from './workshop.service.js';
import { repairOrderPromise } from './repair-order-lifecycle.js';

@Controller('service/handover-lane')
@ApiTags('Handover lane')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class HandoverController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DeliveriesService) private readonly deliveries: DeliveriesService,
    @Inject(IntegrationService)
    private readonly integration: IntegrationService,
    @Inject(WorkshopService) private readonly workshop: WorkshopService,
  ) {}
  @Get()
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() q: Record<string, string>,
  ) {
    const siteId = uuid(q.siteId, 'siteId'),
      page = pagination(q.offset, q.limit);
    if (q.status && !['active', 'completed', 'cancelled'].includes(q.status))
      throw new BadRequestException('Invalid handover status');
    return this.mongo.transaction(async (session) => {
      const { site, ownOnly } = await this.deliveries.scope(
          req,
          siteId,
          'deliveries.read',
          session,
        ),
        grants = await this.access.memberships(req, session);
      const brands = (site.brand_ids ?? []).filter((id) =>
        permissionsFor(grantsForBrand(grants, site, id)).includes(
          'deliveries.read',
        ),
      );
      const rows = await this.mongo.handoverItems
        .aggregate<HandoverItem>(
          [
            {
              $match: {
                organisation_id: site.organisation_id,
                site_id: siteId,
                brand_id: { $in: brands },
                ...this.integration.projectionFilter(),
                status: q.status ?? 'active',
              },
            },
            {
              $lookup: {
                from: 'delivery_plans',
                localField: 'delivery_plan_id',
                foreignField: 'id',
                pipeline: [
                  {
                    $match: {
                      site_id: siteId,
                      organisation_id: site.organisation_id,
                      ...this.integration.projectionFilter(),
                      ...(q.status === 'cancelled'
                        ? { status: 'cancelled' }
                        : { status: { $ne: 'cancelled' } }),
                    },
                  },
                  {
                    $lookup: {
                      from: 'sales_leads',
                      localField: 'lead_id',
                      foreignField: 'id',
                      pipeline: [
                        {
                          $match: {
                            site_id: siteId,
                            organisation_id: site.organisation_id,
                            ...this.integration.projectionFilter(),
                            ...(ownOnly ? { assigned_to: req.user!.id } : {}),
                          },
                        },
                      ],
                      as: 'lead',
                    },
                  },
                  { $match: { 'lead.0': { $exists: true } } },
                ],
                as: 'plan',
              },
            },
            {
              $lookup: {
                from: 'sales_leads',
                localField: 'lead_id',
                foreignField: 'id',
                pipeline: [
                  {
                    $match: {
                      site_id: siteId,
                      organisation_id: site.organisation_id,
                      ...this.integration.projectionFilter(),
                      ...(ownOnly ? { assigned_to: req.user!.id } : {}),
                    },
                  },
                ],
                as: 'orderLead',
              },
            },
            {
              $match: {
                $or: [
                  { 'plan.0': { $exists: true } },
                  { 'orderLead.0': { $exists: true } },
                ],
              },
            },
            { $unset: ['plan', 'orderLead'] },
            {
              $lookup: {
                from: 'service_appointments',
                localField: 'first_service_appointment_id',
                foreignField: 'id',
                pipeline: [
                  {
                    $match: {
                      site_id: siteId,
                      organisation_id: site.organisation_id,
                      ...this.integration.projectionFilter(),
                      status: { $in: ['booked', 'confirmed'] },
                    },
                  },
                ],
                as: 'firstService',
              },
            },
            ...(q.riskOnly === 'true'
              ? [
                  {
                    $match: {
                      $or: [
                        { pdi_status: { $ne: 'completed' } },
                        { 'firstService.0': { $exists: false } },
                      ],
                    },
                  },
                ]
              : []),
            { $unset: 'firstService' },
            { $sort: { scheduled_delivery_at: 1, id: 1 } },
            { $skip: page.offset },
            { $limit: page.limit + 1 },
          ],
          { session },
        )
        .toArray();
      const result = pageResult(rows, page);
      const booked = await this.mongo.serviceAppointments
        .find(
          {
            organisation_id: site.organisation_id,
            site_id: siteId,
            ...this.integration.projectionFilter(),
            id: {
              $in: result.rows
                .map((r) => r.first_service_appointment_id)
                .filter((id): id is string => !!id),
            },
            status: { $in: ['booked', 'confirmed'] },
          },
          { session },
        )
        .toArray();
      return {
        handovers: result.rows.map((r) => ({
          ...publicRecord(r),
          version: r.version ?? 0,
          risks: {
            pdiRisk: r.pdi_status !== 'completed',
            firstServiceMissing: !booked.some(
              (a) =>
                a.id === r.first_service_appointment_id &&
                a.customer_id === r.customer_id,
            ),
            hoursUntilDelivery: Math.round(
              (Date.parse(r.scheduled_delivery_at) - Date.now()) / 3600000,
            ),
          },
        })),
        pagination: result.pagination,
      };
    });
  }
  @Post(':id/:action')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        siteId: { type: 'string' },
        version: { type: 'integer' },
        status: { type: 'string' },
        notes: { type: 'string' },
      },
      additionalProperties: true,
    },
  })
  async action(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('action') action: string,
    @Headers('idempotency-key') key: string,
    @Body() b: Record<string, unknown>,
  ) {
    const siteId = uuid(b.siteId, 'siteId');
    uuid(id, 'handoverId');
    if (this.integration.config.mode !== 'simulated')
      throw new ServiceUnavailableException(
        'Handover mutations are local/simulated only',
      );
    if (!Number.isInteger(b.version) || Number(b.version) < 0)
      throw new BadRequestException('Current handover version is required');
    if (
      ![
        'pdi',
        'accessories',
        'preferences',
        'first-service-booking',
        'book-first-service',
        'complete',
      ].includes(action)
    )
      throw new BadRequestException('Unsupported handover action');
    const allowed: Record<string, string[]> = {
      pdi: ['status', 'notes', 'dueAt', 'ownerId', 'technician'],
      accessories: ['status', 'notes'],
      preferences: ['preferred_channel', 'notes'],
      'first-service-booking': ['startsAt', 'endsAt', 'resourceId', 'notes'],
      'book-first-service': ['startsAt', 'endsAt', 'resourceId', 'notes'],
      complete: ['notes'],
    };
    if (
      Object.keys(b).some(
        (k) => !['siteId', 'version', ...allowed[action]].includes(k),
      )
    )
      throw new BadRequestException('Unsupported handover field');
    if (action === 'complete') text(b.notes, 'notes', 3, 2000);
    return this.mongo.transaction(async (session) => {
      const site = await this.access.requireSite(
        req,
        siteId,
        'deliveries.read',
        session,
      );
      await this.mongo.organisations.updateOne(
        { id: site.organisation_id },
        { $inc: { access_revision: 1 } },
        { session },
      );
      const row = await this.mongo.handoverItems.findOne(
        {
          id,
          site_id: siteId,
          organisation_id: site.organisation_id,
          ...this.integration.projectionFilter(),
        },
        { session },
      );
      if (!row) throw new NotFoundException('Handover is unavailable');
      const permission =
        action === 'pdi' || action === 'accessories'
          ? 'deliveries.prepare'
          : action.includes('service')
            ? 'service.write'
            : 'deliveries.write';
      const plan = row.delivery_plan_id
        ? (
            await this.deliveries.context(
              req,
              siteId,
              row.delivery_plan_id,
              permission === 'service.write' ? 'deliveries.read' : permission,
              session,
            )
          ).plan
        : null;
      if (!plan) {
        const { ownOnly } = await this.deliveries.scope(
          req,
          siteId,
          permission === 'service.write' ? 'deliveries.read' : permission,
          session,
        );
        const lead = await this.mongo.salesLeads.findOne(
          {
            id: row.lead_id,
            site_id: siteId,
            organisation_id: site.organisation_id,
            ...this.integration.projectionFilter(),
            ...(ownOnly ? { assigned_to: req.user!.id } : {}),
          },
          { session },
        );
        if (!lead) throw new NotFoundException('Handover is unavailable');
        if (action === 'complete' || action.includes('service'))
          throw new ConflictException(
            'Create a delivery plan before booking or final handover',
          );
      }
      await this.access.requireBrand(
        req,
        siteId,
        row.brand_id,
        permission,
        session,
      );
      if ((plan && plan.status !== 'planned') || row.status !== 'active')
        throw new ConflictException('Closed/cancelled handovers cannot change');
      const current = row.version ?? 0;
      const firstService =
        action === 'first-service-booking' || action === 'book-first-service';
      const bookingHash = firstService
        ? createHash('sha256')
            .update(
              JSON.stringify({
                siteId,
                id,
                startsAt: b.startsAt,
                endsAt: b.endsAt,
                resourceId: b.resourceId,
                notes: b.notes ?? '',
              }),
            )
            .digest('hex')
        : '';
      if (firstService) {
        text(key, 'Idempotency-Key', 8, 200);
        const prior = await this.mongo.serviceAppointments.findOne(
          {
            organisation_id: site.organisation_id,
            created_by: req.user!.id,
            create_key: key,
          },
          { session },
        );
        if (prior) {
          if (prior.create_hash !== bookingHash)
            throw new ConflictException('Booking key reused');
          return {
            handover: publicRecord(row),
            appointment: publicRecord(prior),
            replayed: true,
          };
        }
      }
      if (current !== b.version)
        throw new ConflictException('Handover changed; refresh');
      const now = new Date().toISOString(),
        changes: Partial<HandoverItem> = {
          updated_at: now,
          version: current + 1,
        };
      if (action === 'pdi') {
        if (
          !['pending', 'booked', 'in_progress', 'completed'].includes(
            String(b.status),
          )
        )
          throw new BadRequestException('Invalid PDI status');
        changes.pdi_status = b.status as HandoverItem['pdi_status'];
        changes.pdi_notes = b.notes ? text(b.notes, 'notes', 1, 2000) : '';
        changes.pdi_technician = b.technician
          ? text(b.technician, 'technician', 1, 100)
          : '';
        changes.pdi_due_date = b.dueAt
          ? repairOrderPromise(b.dueAt)
          : row.pdi_due_date;
        if (b.ownerId && b.ownerId !== req.user!.id)
          await this.access.requireSite(
            req,
            siteId,
            'service.assign_work',
            session,
          );
        if (b.ownerId) {
          changes.pdi_owner = uuid(b.ownerId, 'ownerId');
          await this.access.requireBrand(
            { user: { id: changes.pdi_owner } } as AuthenticatedRequest,
            siteId,
            row.brand_id,
            'deliveries.prepare',
            session,
          );
        }
      } else if (action === 'accessories') {
        if (!['pending', 'in_progress', 'ready'].includes(String(b.status)))
          throw new BadRequestException('Invalid accessories status');
        changes.accessories_status =
          b.status as HandoverItem['accessories_status'];
        changes.accessories_notes = b.notes
          ? text(b.notes, 'notes', 1, 2000)
          : '';
      } else if (action === 'preferences') {
        const channel = String(b.preferred_channel ?? '');
        if (!['email', 'sms', 'call'].includes(channel))
          throw new BadRequestException('Invalid contact preference');
        changes.customer_service_preference = {
          preferred_channel: channel,
          notes: b.notes ? text(b.notes, 'notes', 1, 1000) : '',
        };
      } else if (firstService) {
        if (row.first_service_appointment_id) {
          const old = await this.mongo.serviceAppointments.findOne(
            {
              id: row.first_service_appointment_id,
              site_id: siteId,
              organisation_id: site.organisation_id,
              ...this.integration.projectionFilter(),
            },
            { session },
          );
          if (old && !['cancelled', 'no_show'].includes(old.status))
            throw new ConflictException(
              'A first-service booking already exists; reschedule it through the diary',
            );
        }
        const window = appointmentWindow(b.startsAt, b.endsAt),
          resourceId = uuid(b.resourceId, 'resourceId');
        if (
          Date.parse(window.starts_at) <= Date.now() ||
          Date.parse(window.starts_at) > Date.now() + 365 * 86400000
        )
          throw new BadRequestException('Book within the next 365 days');
        const customer = await this.mongo.customers.findOne(
          {
            id: row.customer_id,
            site_id: siteId,
            organisation_id: site.organisation_id,
            ...this.integration.projectionFilter(),
          },
          { session },
        );
        if (!customer)
          throw new ConflictException('Linked customer is unavailable');
        await this.workshop.reserve(
          siteId,
          site.organisation_id,
          resourceId,
          window.starts_at,
          window.ends_at,
          site.timezone,
          session,
        );
        const aId = randomUUID(),
          a: ServiceAppointment = {
            _id: aId,
            id: aId,
            organisation_id: site.organisation_id,
            site_id: siteId,
            brand_id: row.brand_id,
            customer_id: row.customer_id,
            assigned_to: req.user!.id,
            created_by: req.user!.id,
            title: 'First service / complimentary inspection',
            vehicle: row.vehicle_label,
            ...window,
            resource_id: resourceId,
            notes: b.notes ? text(b.notes, 'notes', 1, 2000) : '',
            status: 'booked',
            outcome_note: null,
            version: 0,
            integration_mode: 'simulated',
            create_key: key,
            create_hash: bookingHash,
            created_at: now,
            updated_at: now,
          };
        await this.mongo.serviceAppointments.insertOne(a, { session });
        changes.first_service_status = 'booked';
        changes.first_service_appointment_id = aId;
        await this.audit.record(
          session,
          req.user!.id,
          site.organisation_id,
          siteId,
          'service.appointment_created',
          'service_appointment',
          aId,
          { customer_id: row.customer_id, handover_id: id },
        );
      } else if (action === 'complete') {
        if (!plan) throw new ConflictException('Delivery plan required');
        const view = await this.deliveries.view(req, plan, session);
        if (
          !view.readiness.ready ||
          row.pdi_status !== 'completed' ||
          row.accessories_status !== 'ready' ||
          row.first_service_status !== 'booked'
        )
          throw new ConflictException(
            'Complete delivery checks, PDI, accessories and first-service booking before final handover',
          );
        const first = await this.mongo.serviceAppointments.findOne(
          {
            id: row.first_service_appointment_id!,
            site_id: siteId,
            organisation_id: site.organisation_id,
            status: { $in: ['booked', 'confirmed'] },
            ...this.integration.projectionFilter(),
          },
          { session },
        );
        if (!first)
          throw new ConflictException('First service must remain booked');
        changes.status = 'completed';
        changes.completed_at = now;
        changes.completed_by = req.user!.id;
        await this.mongo.deliveries.updateOne(
          { id: plan.id, version: plan.version },
          {
            $set: {
              status: 'handed_over',
              handed_over_at: now,
              handed_over_by: req.user!.id,
              updated_at: now,
            },
            $inc: { version: 1 },
          },
          { session },
        );
        await this.mongo.salesLeads.updateOne(
          {
            id: plan.lead_id,
            organisation_id: site.organisation_id,
            site_id: siteId,
          },
          {
            $set: { pipeline_stage: 'delivered', updated_at: now },
            $inc: { version: 1 },
          },
          { session },
        );
      }
      const merged = { ...row, ...changes };
      if (plan && (action === 'pdi' || action === 'accessories'))
        await this.mongo.deliveries.updateOne(
          { id: plan.id, version: plan.version },
          {
            $set: {
              'checklist.vehicle_preparation': {
                complete:
                  merged.pdi_status === 'completed' &&
                  merged.accessories_status === 'ready',
                note: 'PDI/accessories handover preparation',
                updated_by: req.user!.id,
                updated_at: now,
              },
              updated_at: now,
            },
            $inc: { version: 1 },
          },
          { session },
        );
      if (action === 'pdi' && row.pdi_task_id) {
        const completed = merged.pdi_status === 'completed';
        await this.mongo.tasks.updateOne(
          {
            id: row.pdi_task_id,
            organisation_id: site.organisation_id,
            site_id: siteId,
          },
          {
            $set: {
              ...(merged.pdi_due_date ? { due_at: merged.pdi_due_date } : {}),
              ...(merged.pdi_owner ? { assigned_to: merged.pdi_owner } : {}),
              completed_at: completed ? now : null,
              updated_at: now,
            },
            $inc: { version: 1 },
          },
          { session },
        );
        await this.audit.record(
          session,
          req.user!.id,
          site.organisation_id,
          siteId,
          completed ? 'task.completed' : 'task.updated',
          'task',
          row.pdi_task_id,
        );
      }
      await this.mongo.handoverItems.updateOne(
        { id },
        { $set: changes },
        { session },
      );
      await this.audit.record(
        session,
        req.user!.id,
        site.organisation_id,
        siteId,
        'sales.handover_' + action.replaceAll('-', '_'),
        'sales_lead',
        plan?.lead_id ?? row.lead_id!,
        {
          customer_id: row.customer_id,
          handover_id: id,
          stock_brand_id: row.brand_id,
          note: b.notes ?? '',
          version: current + 1,
        },
      );
      return { handover: publicRecord(merged) };
    });
  }
}
