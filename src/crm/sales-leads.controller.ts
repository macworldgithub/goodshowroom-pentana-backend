import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import { AccessService } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import { AuditService } from '../database/audit.service.js';
import { MongoService } from '../database/mongo.service.js';
import { publicRecord, type SalesLead, type Task } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { requireAssignee } from './assignment.js';
import { pipelineStage } from './sales-pipeline.js';

const statuses = ['new', 'contacted', 'qualified', 'closed'];
const schema = { type: 'object' as const, properties: {
  siteId: { type: 'string', format: 'uuid' }, customerId: { type: 'string', format: 'uuid' },
  title: { type: 'string' }, source: { type: 'string' }, vehicleInterest: { type: 'string', nullable: true },
  assignedTo: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: statuses },
  followUpAt: { type: 'string', format: 'date-time' }, version: { type: 'integer', minimum: 0 },
} };

@Controller('sales/leads')
@ApiTags('Sales enquiries')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class SalesLeadsController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntegrationService) private readonly integration: IntegrationService) {}

  @Get()
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'status', required: false, enum: statuses })
  @ApiQuery({ name: 'search', required: false })
  @ApiPagination()
  async list(@Req() request: AuthenticatedRequest, @Query('siteId') siteId: string,
    @Query('status') status?: string, @Query('search') search?: string,
    @Query('offset') offset?: string, @Query('limit') limit?: string) {
    const id = uuid(siteId, 'siteId');
    const site = await this.access.requireSite(request, id, 'sales.read');
    if (status !== undefined && !statuses.includes(status)) throw new BadRequestException('Invalid enquiry status');
    if (search !== undefined && typeof search !== 'string') throw new BadRequestException('search must be text');
    const term = search?.trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const team = await this.access.hasSitePermission(request, id, 'sales.view_team');
    const page = pagination(offset, limit);
    const rows = await this.mongo.salesLeads.find({ ...this.integration.projectionFilter(), site_id: id, organisation_id: site.organisation_id,
      ...(team ? {} : { assigned_to: request.user!.id }), ...(status ? { status: status as SalesLead['status'] } : {}),
      ...(term ? { title: { $regex: term, $options: 'i' } } : {}),
    }).sort({ updated_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray();
    const result = pageResult(rows, page);
    return { leads: result.rows.map(lead => this.publicLead(lead)), pagination: result.pagination, visibility: team ? 'team' : 'own' };
  }

  private publicLead(lead: SalesLead) {
    const { create_key: _createKey, create_hash: _createHash, ...record } = publicRecord(lead);
    return { ...record, pipeline_stage: pipelineStage(lead) };
  }

  @Get(':id')
  @ApiQuery({ name: 'siteId', required: true })
  async detail(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('siteId') siteId: string) {
    uuid(id, 'leadId'); uuid(siteId, 'siteId');
    const site = await this.access.requireSite(request, siteId, 'sales.read');
    const team = await this.access.hasSitePermission(request, siteId, 'sales.view_team');
    const lead = await this.mongo.salesLeads.findOne({ ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id,
      ...(team ? {} : { assigned_to: request.user!.id }) });
    if (!lead) throw new NotFoundException('Enquiry is unavailable');
    return { lead: this.publicLead(lead) };
  }

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema })
  async create(@Req() request: AuthenticatedRequest, @Headers('idempotency-key') key: string, @Body() body: Record<string, unknown>) {
    if (Object.keys(body).some(field => !['siteId', 'customerId', 'title', 'source', 'vehicleInterest', 'assignedTo', 'followUpAt'].includes(field))) throw new BadRequestException('Unsupported enquiry field');
    const siteId = uuid(body.siteId, 'siteId'); const customerId = uuid(body.customerId, 'customerId');
    const title = text(body.title, 'title', 2, 180); const source = text(body.source, 'source', 2, 100);
    const interest = body.vehicleInterest == null || body.vehicleInterest === '' ? null : text(body.vehicleInterest, 'vehicleInterest', 1, 1000);
    const assignedTo = body.assignedTo === undefined ? request.user!.id : uuid(body.assignedTo, 'assignedTo');
    const createKey = text(key, 'Idempotency-Key', 8, 200);
    if (body.followUpAt !== undefined && (typeof body.followUpAt !== 'string' || !Number.isFinite(Date.parse(body.followUpAt)))) throw new BadRequestException('followUpAt must be a valid timestamp');
    const due = body.followUpAt === undefined ? undefined : new Date(body.followUpAt as string).toISOString();
    const hash = createHash('sha256').update(JSON.stringify({ siteId, customerId, title, source, interest, assignedTo, due })).digest('hex');
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'sales.write', session);
      if (assignedTo !== request.user!.id) await this.access.requireSite(request, siteId, 'sales.assign_leads', session);
      await requireAssignee(this.access, assignedTo, siteId, 'sales.write', session);
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id: customerId, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!customer) throw new BadRequestException('Customer is unavailable at this site');
      const existing = await this.mongo.salesLeads.findOne({ organisation_id: site.organisation_id, created_by: request.user!.id, create_key: createKey }, { session });
      if (existing) {
        if (existing.create_hash !== hash) throw new ConflictException('Idempotency key already used for a different enquiry');
        if (existing.assigned_to !== request.user!.id && !(await this.access.hasSitePermission(request, siteId, 'sales.view_team', session))) throw new NotFoundException('Enquiry is unavailable');
        return { lead: this.publicLead(existing) };
      }
      const now = new Date().toISOString(); const id = randomUUID();
      const lead: SalesLead = { _id: id, id, organisation_id: site.organisation_id, site_id: siteId, customer_id: customerId, assigned_to: assignedTo,
        created_by: request.user!.id, title, source, vehicle_interest: interest, status: 'new', version: 0, created_at: now, updated_at: now,
        create_key: createKey, create_hash: hash, ...(customer.integration_mode ? { integration_mode: customer.integration_mode } : {}) };
      if (due) {
        await this.access.requireSite(request, siteId, 'tasks.write', session);
        await requireAssignee(this.access, assignedTo, siteId, 'tasks.write', session);
        if (assignedTo !== request.user!.id) await this.access.requireSite(request, siteId, 'tasks.assign', session);
        const taskId = randomUUID(); lead.follow_up_task_id = taskId;
        const task: Task = { _id: taskId, id: taskId, organisation_id: site.organisation_id, site_id: siteId, customer_id: customerId,
          created_by: request.user!.id, assigned_to: assignedTo, title: `Enquiry: ${title}`, details: null, due_at: due,
          kind: 'follow_up', priority: 'normal', completed_at: null, version: 0, created_at: now, updated_at: now,
          ...(customer.integration_mode ? { integration_mode: customer.integration_mode } : {}) };
        await this.mongo.tasks.insertOne(task, { session });
        await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'task.created', 'task', taskId, { lead_id: id });
      }
      await this.mongo.salesLeads.insertOne(lead, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'sales.lead_created', 'sales_lead', id, { customer_id: customerId, to_stage: 'new', version: 0 });
      return { lead: this.publicLead(lead) };
    });
  }

  @Patch(':id')
  @ApiBody({ schema })
  async edit(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'leadId'); const siteId = uuid(body.siteId, 'siteId');
    if (!Number.isInteger(body.version) || Number(body.version) < 0) throw new BadRequestException('Provide the current version');
    const allowed = ['siteId', 'version', 'title', 'source', 'vehicleInterest', 'status', 'assignedTo'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new BadRequestException('Unsupported enquiry field');
    const changes: Partial<SalesLead> = {};
    if (body.title !== undefined) changes.title = text(body.title, 'title', 2, 180);
    if (body.source !== undefined) changes.source = text(body.source, 'source', 2, 100);
    if (body.vehicleInterest !== undefined) changes.vehicle_interest = body.vehicleInterest === null || body.vehicleInterest === '' ? null : text(body.vehicleInterest, 'vehicleInterest', 1, 1000);
    if (body.status !== undefined) { if (!statuses.includes(body.status as string)) throw new BadRequestException('Invalid status'); changes.status = body.status as SalesLead['status']; }
    if (body.assignedTo !== undefined) changes.assigned_to = uuid(body.assignedTo, 'assignedTo');
    if (!Object.keys(changes).length) throw new BadRequestException('Provide at least one change');
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'sales.write', session);
      const team = await this.access.hasSitePermission(request, siteId, 'sales.view_team', session);
      const filter = { ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id, ...(team ? {} : { assigned_to: request.user!.id }) };
      const lead = await this.mongo.salesLeads.findOne(filter, { session });
      if (!lead) throw new NotFoundException('Enquiry is unavailable');
      // Sending an unchanged status from a contact editor must preserve advanced pipeline stages.
      if (changes.status && changes.status !== lead.status) changes.pipeline_stage = changes.status;
      if (changes.assigned_to && changes.assigned_to !== lead.assigned_to) {
        await this.access.requireSite(request, siteId, 'sales.assign_leads', session);
        await requireAssignee(this.access, changes.assigned_to, siteId, 'sales.write', session);
      }
      changes.updated_at = new Date().toISOString();
      const updated = await this.mongo.salesLeads.findOneAndUpdate({ ...filter, version: Number(body.version) }, { $set: changes, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!updated) throw new ConflictException('Enquiry changed; refresh before editing');
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'sales.lead_updated', 'sales_lead', id, { customer_id: lead.customer_id, fields: Object.keys(changes).filter(field => field !== 'updated_at'),
        from_stage: pipelineStage(lead), to_stage: pipelineStage(updated), from_assignee: lead.assigned_to, to_assignee: updated.assigned_to, version: updated.version });
      return { lead: this.publicLead(updated) };
    });
  }
}
