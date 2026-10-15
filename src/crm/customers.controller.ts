import { BadRequestException, NotFoundException, Param, Headers, HttpCode, Controller, Get, Post, Body, Query, Req, UseGuards, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiJsonBody } from '../api-bodies.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AccessService, grantsForBrand } from '../auth/access.service.js';
import { permissionsFor } from '../auth/permissions.js';
import { uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { IntegrationService } from '../integration/integration.service.js';
import { customerInput } from '../integration/validation.js';
import { publicRecord } from '../database/models.js';

@Controller('customers')
@ApiTags('Customers')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class CustomersController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(IntegrationService) private readonly integration: IntegrationService) {}

  @Get()
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiPagination()
  async list(@Req() request: AuthenticatedRequest, @Query('siteId') siteId?: string, @Query('search') search?: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    const id = uuid(siteId, 'siteId');
    const site = await this.access.requireSite(request, id, 'customers.read');
    if (search !== undefined && typeof search !== 'string') throw new BadRequestException('search must be text');
    const term = search?.trim().slice(0, 60);
    const escaped = term?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Shared customer identity is visible across the authorized site; tasks remain assigned-user scoped.
    const page = pagination(offset, limit);
    const customers = await this.mongo.customers.find({ ...this.integration.projectionFilter(), site_id: id, organisation_id: site.organisation_id,
      ...(escaped ? { $or: ['first_name', 'last_name', 'email', 'phone'].map(field => ({ [field]: { $regex: escaped, $options: 'i' } })) } : {}),
    }).sort({ updated_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray();
    const result = pageResult(customers, page);
    return { customers: result.rows.map(publicRecord), pagination: result.pagination, integration: this.integration.config.info() };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get customer profile and linked follow-ups', description: 'Requires siteId and current customer read access. Returns customer contact/source/assignment, site metadata, assignee name, taskVisibility, follow-up permission, and integration label. offset/limit paginate linked follow-ups only. Default staff see own follow-ups; tasks.view_team permits team visibility. Unknown, other-site, or other-mode customer IDs return 404 after site authorization.' })
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  @ApiPagination()
  async detail(@Req() request: AuthenticatedRequest, @Param('id') id: string,
    @Query('siteId') siteId?: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(id, 'customerId');
    const targetSite = uuid(siteId, 'siteId');
    const page = pagination(offset, limit);
    // Site and mode are part of every lookup; guessing a customer ID cannot widen access.
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, targetSite, 'customers.read', session);
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id,
        site_id: targetSite, organisation_id: site.organisation_id }, { session });
      if (!customer) throw new NotFoundException('Customer is unavailable at this site');
      const canReadTasks = await this.access.hasSitePermission(request, targetSite, 'tasks.read', session);
      const viewTeam = canReadTasks && await this.access.hasSitePermission(request, targetSite, 'tasks.view_team', session);
      const canCreateFollowUp = await this.access.hasSitePermission(request, targetSite, 'tasks.write', session);
      const rows = canReadTasks ? await this.mongo.tasks.find({ ...this.integration.projectionFilter(), customer_id: id,
        site_id: targetSite, organisation_id: site.organisation_id,
        ...(viewTeam ? {} : { assigned_to: request.user!.id }) }, { session })
        .sort({ completed_at: 1, due_at: 1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray() : [];
      const result = pageResult(rows, page);
      const membership = await this.mongo.memberships.findOne({ user_id: customer.assigned_to, organisation_id: site.organisation_id,
        $or: [{ site_id: null, role: 'ADMIN' }, { site_id: targetSite, role: { $in: ['SALES', 'SERVICE'] } }] }, { session });
      // Expose only a name for an assignee in this site/organisation, never staff credentials/contact details.
      const profile = membership ? await this.mongo.users.findOne({ _id: customer.assigned_to }, { session, projection: { full_name: 1 } }) : null;
      return { customer: publicRecord(customer), site: { id: site.id, organisation_id: site.organisation_id, name: site.name, timezone: site.timezone },
        assignee: { id: customer.assigned_to, fullName: profile?.full_name ?? null },
        tasks: result.rows.map(publicRecord), pagination: result.pagination,
        taskVisibility: canReadTasks ? viewTeam ? 'team' : 'own' : 'none', permissions: { canCreateFollowUp },
        integration: this.integration.config.info() };
    });
  }

  @Get(':id/activity')
  @ApiOperation({ summary: 'Read customer activity history', description: 'Paginated customer/source events and permitted follow-up events. Staff see own task events unless tasks.view_team is granted. Raw audit metadata and integration request bodies are not exposed.' })
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  @ApiPagination()
  async activity(@Req() request: AuthenticatedRequest, @Param('id') id: string,
    @Query('siteId') siteId?: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(id, 'customerId');
    const targetSite = uuid(siteId, 'siteId');
    const page = pagination(offset, limit);
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, targetSite, 'customers.read', session);
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id, site_id: targetSite, organisation_id: site.organisation_id }, { session });
      if (!customer) throw new NotFoundException('Customer is unavailable at this site');
      const canReadTasks = await this.access.hasSitePermission(request, targetSite, 'tasks.read', session);
      const viewTeam = canReadTasks && await this.access.hasSitePermission(request, targetSite, 'tasks.view_team', session);
      const serviceRead = await this.access.hasSitePermission(request, targetSite, 'service.read', session);
      const serviceTeam = serviceRead && await this.access.hasSitePermission(request, targetSite, 'service.view_team', session);
      const grants = serviceRead ? await this.access.memberships(request, session) : [];
      const serviceBrands = (site.brand_ids ?? []).filter(brand => permissionsFor(grantsForBrand(grants, site, brand)).includes('service.read'));
      const customerActions = ['customer.created', 'customer.source_imported', 'customer.source_updated', 'customer.note_added', 'customer.call_logged', 'customer.updated', 'customer.privacy_updated', 'customer.assigned',
        'customer.change_queued', 'customer.change_rejected', 'customer.change_retry_wait', 'customer.change_failed', 'customer.change_needs_review',
        'customer.message_sending', 'customer.message_accepted', 'customer.message_rejected', 'customer.message_needs_review', 'customer.message_delivered', 'customer.message_bounced'];
      const taskActions = ['task.created', 'task.completed', 'task.updated', 'task.rescheduled', 'task.assigned', 'task.cancelled'];
      const rows = await this.mongo.auditEvents.aggregate<import('../database/models.js').AuditEvent & { journal: import('../database/models.js').CustomerJournal[]; activity_at: string }>([
        { $match: { organisation_id: site.organisation_id, site_id: targetSite, $or: [
          { entity_type: 'customer', entity_id: id, action: { $in: customerActions } },
          ...(canReadTasks ? [{ entity_type: 'task', action: { $in: taskActions } }] : []),
          ...(serviceRead ? [{ entity_type: 'service_appointment', 'metadata.customer_id': id }] : []),
        ] } },
        { $lookup: { from: 'tasks', let: { entity: '$entity_id' }, pipeline: [
          { $match: { ...this.integration.projectionFilter(), site_id: targetSite, organisation_id: site.organisation_id, customer_id: id,
            ...(viewTeam ? {} : { assigned_to: request.user!.id }), $expr: { $eq: ['$id', '$$entity'] } } },
          { $project: { _id: 0, id: 1 } },
        ], as: 'linked_task' } },
        { $lookup: { from: 'service_appointments', let: { entity: '$entity_id' }, pipeline: [
          { $match: { ...this.integration.projectionFilter(), organisation_id: site.organisation_id, site_id: targetSite, customer_id: id,
            brand_id: { $in: serviceBrands }, ...(serviceTeam ? {} : { assigned_to: request.user!.id }), $expr: { $eq: ['$id', '$$entity'] } } },
          { $project: { _id: 0, id: 1 } },
        ], as: 'linked_appointment' } },
        { $match: { $or: [{ entity_type: 'customer' }, ...(canReadTasks ? [{ 'linked_task.0': { $exists: true } }] : []), ...(serviceRead ? [{ 'linked_appointment.0': { $exists: true } }] : [])] } },
        { $lookup: { from: 'customer_journal', let: { journalId: '$metadata.journal_id' }, pipeline: [
          { $match: { ...this.integration.projectionFilter(), organisation_id: site.organisation_id, site_id: targetSite, customer_id: id,
            $expr: { $eq: ['$id', '$$journalId'] } } },
        ], as: 'journal' } },
        { $match: { $or: [{ action: { $nin: ['customer.note_added', 'customer.call_logged'] } }, { 'journal.0': { $exists: true } }] } },
        { $addFields: { activity_at: { $ifNull: [{ $arrayElemAt: ['$journal.occurred_at', 0] }, '$created_at'] } } },
        { $sort: { activity_at: -1, id: 1 } }, { $skip: page.offset }, { $limit: page.limit + 1 },
      ], { session }).toArray();
      const result = pageResult(rows, page);
      const names = await this.mongo.users.find({ _id: { $in: [...new Set(result.rows.map(event => event.actor_user_id))] } }, { session, projection: { full_name: 1 } }).toArray();
      const labels: Record<string, string> = { 'customer.created': 'Customer creation confirmed', 'customer.source_imported': 'Customer imported from source', 'customer.source_updated': 'Customer refreshed from source', 'task.created': 'Follow-up created', 'task.completed': 'Follow-up completed', 'customer.note_added': 'Internal note added', 'customer.call_logged': 'Customer call logged',
        'customer.updated': 'Contact changes confirmed', 'customer.privacy_updated': 'Privacy changes confirmed', 'customer.assigned': 'Customer reassigned', 'customer.change_queued': 'Customer change pending', 'customer.change_rejected': 'Customer change rejected', 'customer.change_retry_wait': 'Customer change waiting to retry', 'customer.change_failed': 'Customer change failed', 'customer.change_needs_review': 'Customer change needs review',
        'task.updated': 'Task edited', 'task.rescheduled': 'Task rescheduled', 'task.assigned': 'Task reassigned', 'task.cancelled': 'Task cancelled', 'customer.message_sending': 'Email submission started', 'customer.message_accepted': 'Email accepted by transport', 'customer.message_rejected': 'Email rejected', 'customer.message_needs_review': 'Email outcome needs review', 'customer.message_delivered': 'Email delivery evidence recorded', 'customer.message_bounced': 'Email bounce evidence recorded' };
      return { customerId: id, activities: result.rows.map(event => ({ id: event.id, type: event.action, summary: event.entity_type === 'service_appointment' ? event.action.replace('service.appointment_', 'Service appointment ').replaceAll('_', ' ') : labels[event.action], occurredAt: event.activity_at, recordedAt: event.created_at,
        author: { id: event.actor_user_id, fullName: names.find(user => user._id === event.actor_user_id)?.full_name ?? null },
        ...(event.entity_type === 'task' ? { taskId: event.entity_id } : {}),
        ...(event.entity_type === 'service_appointment' ? { appointmentId: event.entity_id } : {}),
        ...(event.metadata?.command_id ? { commandId: event.metadata.command_id } : {}),
        ...(event.metadata?.message_id ? { messageId: event.metadata.message_id } : {}),
        ...(event.journal[0] ? { journal: { id: event.journal[0].id, kind: event.journal[0].kind, text: event.journal[0].text,
          ...(event.journal[0].kind === 'call' ? { direction: event.journal[0].direction, outcome: event.journal[0].outcome } : {}) } } : {}),
      })), pagination: result.pagination, taskVisibility: canReadTasks ? viewTeam ? 'team' : 'own' : 'none', integration: this.integration.config.info() };
    });
  }

  @Post()
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8–200 characters; reuse for retries of the identical request.' })
  @ApiJsonBody('customer')
  async create(@Req() request: AuthenticatedRequest, @Headers('idempotency-key') key: string | undefined, @Body() body: {
    siteId?: unknown; firstName?: unknown; lastName?: unknown; email?: unknown; phone?: unknown;
  }) {
    const siteId = uuid(body.siteId, 'siteId');
    return this.integration.enqueueCustomer(request, siteId, customerInput(body), key);
  }
}
