import { Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AccessService } from '../auth/access.service.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { text, uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord, type CustomerJournal, type Task } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiJsonBody } from '../api-bodies.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { journalInput, type JournalInput } from './journal-validation.js';

export function publicJournal(entry: CustomerJournal, canReadFollowUp = false) {
  const { idempotency_key: _key, request_hash: _hash, follow_up_task_id, ...result } = publicRecord(entry);
  return { ...result, ...(canReadFollowUp && follow_up_task_id ? { follow_up_task_id } : {}) };
}
@Controller('customers/:id')
@ApiTags('Customer notes and calls')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class CustomerJournalController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntegrationService) private readonly integration: IntegrationService) {}

  private async create(request: AuthenticatedRequest, id: string, siteId: string, kind: 'note' | 'call', input: JournalInput, key: unknown) {
    const idempotencyKey = text(key, 'Idempotency-Key', 8, 200);
    // An omitted occurrence time hashes as null, not the changing current time.
    const hash = createHash('sha256').update(JSON.stringify({ id, siteId, kind, input, mode: this.integration.config.mode })).digest('hex');
    return this.mongo.transaction(async session => {
      const initialSite = await this.access.requireSite(request, siteId, 'customers.write', session);
      await this.mongo.organisations.updateOne({ id: initialSite.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      const site = await this.access.requireSite(request, siteId, 'customers.write', session);
      await this.access.requireSite(request, siteId, 'customers.read', session);
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!customer) throw new NotFoundException('Customer is unavailable at this site');
      const previous = await this.mongo.customerJournal.findOne({ organisation_id: site.organisation_id, created_by: request.user!.id, idempotency_key: idempotencyKey }, { session });
      const canViewTeam = await this.access.hasSitePermission(request, siteId, 'tasks.view_team', session);
      if (previous) {
        if (previous.request_hash !== hash) throw new ConflictException('Idempotency key already used for a different journal entry');
        const followUp = previous.follow_up_task_id && await this.access.hasSitePermission(request, siteId, 'tasks.read', session)
          ? await this.mongo.tasks.findOne({ ...this.integration.projectionFilter(), id: previous.follow_up_task_id, customer_id: id, organisation_id: site.organisation_id, site_id: siteId, ...(canViewTeam ? {} : { assigned_to: request.user!.id }) }, { session }) : null;
        return { entry: publicJournal(previous, !!followUp), followUp: followUp ? publicRecord(followUp) : null, replayed: true, integration: this.integration.config.info() };
      }
      const now = new Date().toISOString();
      const entryId = randomUUID();
      let followUp: Task | null = null;
      if (input.followUp) {
        await this.access.requireSite(request, siteId, 'tasks.write', session);
        const taskId = randomUUID();
        followUp = { _id: taskId, id: taskId, organisation_id: site.organisation_id, site_id: siteId, customer_id: id,
          created_by: request.user!.id, assigned_to: request.user!.id, kind: 'call', title: input.followUp.title, details: null,
          due_at: input.followUp.dueAt, priority: input.followUp.priority, completed_at: null, created_at: now, updated_at: now,
          ...(customer.integration_mode ? { integration_mode: customer.integration_mode } : {}) };
        await this.mongo.tasks.insertOne(followUp, { session });
        await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'task.created', 'task', taskId);
      }
      const entry: CustomerJournal = { _id: entryId, id: entryId, organisation_id: site.organisation_id, site_id: siteId, customer_id: id,
        created_by: request.user!.id, kind, text: input.text, occurred_at: input.occurredAt ?? now, created_at: now,
        ...(input.direction ? { direction: input.direction, outcome: input.outcome } : {}),
        ...(followUp ? { follow_up_task_id: followUp.id } : {}), ...(customer.integration_mode ? { integration_mode: customer.integration_mode } : {}),
        idempotency_key: idempotencyKey, request_hash: hash };
      await this.mongo.customerJournal.insertOne(entry, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, kind === 'note' ? 'customer.note_added' : 'customer.call_logged', 'customer', id, { journal_id: entryId });
      return { entry: publicJournal(entry, !!followUp), followUp: followUp ? publicRecord(followUp) : null, replayed: false, integration: this.integration.config.info() };
    });
  }

  @Post('notes')
  @ApiOperation({ summary: 'Add an internal customer note', description: 'Append-only, shared within the authorised site. Does not send customer messages or write to Pentana.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiJsonBody('customerNote')
  async note(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: Record<string, unknown>) {
    return this.create(request, uuid(id, 'customerId'), uuid(body.siteId, 'siteId'), 'note', journalInput('note', body), key);
  }

  @Post('calls')
  @ApiOperation({ summary: 'Record a completed/attempted customer call', description: 'Historical log only; never dials a number. Optional followUp creates one call task assigned to the recorder in the same transaction. Notes/call content is site-shared; linked task details retain ownership rules.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiJsonBody('customerCall')
  async call(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: Record<string, unknown>) {
    return this.create(request, uuid(id, 'customerId'), uuid(body.siteId, 'siteId'), 'call', journalInput('call', body), key);
  }

  @Get('journal')
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  @ApiPagination()
  @ApiOperation({ summary: 'Read shared internal notes and call logs', description: 'Sorted by occurrence time, then ID. Entries are append-only. Internal request hashes/keys are excluded; follow-up IDs appear only when the linked task is currently readable.' })
  async list(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('siteId') siteId?: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(id, 'customerId');
    const targetSite = uuid(siteId, 'siteId');
    const page = pagination(offset, limit);
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, targetSite, 'customers.read', session);
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id, site_id: targetSite, organisation_id: site.organisation_id }, { session });
      if (!customer) throw new NotFoundException('Customer is unavailable at this site');
      const result = pageResult(await this.mongo.customerJournal.find({ ...this.integration.projectionFilter(), customer_id: id, site_id: targetSite, organisation_id: site.organisation_id }, { session }).sort({ occurred_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
      const viewTeam = await this.access.hasSitePermission(request, targetSite, 'tasks.view_team', session);
      const canReadTasks = await this.access.hasSitePermission(request, targetSite, 'tasks.read', session);
      const tasks = canReadTasks ? await this.mongo.tasks.find({ ...this.integration.projectionFilter(), customer_id: id, site_id: targetSite, organisation_id: site.organisation_id,
        id: { $in: result.rows.flatMap(entry => entry.follow_up_task_id ? [entry.follow_up_task_id] : []) }, ...(viewTeam ? {} : { assigned_to: request.user!.id }) }, { session }).toArray() : [];
      return { entries: result.rows.map(entry => publicJournal(entry, tasks.some(task => task.id === entry.follow_up_task_id))), pagination: result.pagination, integration: this.integration.config.info() };
    });
  }
}
