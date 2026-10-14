import { BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ApiBearerAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AccessService } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord, type CustomerMessage } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiJsonBody } from '../api-bodies.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { CustomerMailTransport } from './customer-mail.transport.js';
import { requireEmailConsent } from './privacy.js';

export function publicMessage(message: CustomerMessage) {
  const { send_key: _sendKey, draft_key: _draftKey, draft_hash: _draftHash, ...rest } = publicRecord(message);
  return rest;
}
@Controller()
@ApiTags('Customer email messaging')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class CustomerMessagesController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntegrationService) private readonly integration: IntegrationService,
    @Inject(CustomerMailTransport) private readonly transport: CustomerMailTransport) {}

  @Get('messaging/status')
  status() { return this.transport.info(); }

  @Post('customers/:id/messages')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiJsonBody('messageDraft')
  async draft(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: Record<string, unknown>) {
    uuid(id, 'customerId'); const siteId = uuid(body.siteId, 'siteId');
    if (body.channel !== undefined && body.channel !== 'email') throw new BadRequestException('SMTP supports email only; SMS provider is not configured');
    const subject = text(body.subject, 'subject', 1, 200);
    if (/[\r\n]/.test(subject)) throw new BadRequestException('subject must not contain line breaks');
    const content = text(body.body, 'body', 1, 20000); const draftKey = text(key, 'Idempotency-Key', 8, 200);
    const hash = createHash('sha256').update(JSON.stringify({ id, siteId, subject, content, mode: this.integration.config.mode })).digest('hex');
    return this.mongo.transaction(async session => {
      const initial = await this.access.requireSite(request, siteId, 'messages.write', session);
      await this.mongo.organisations.updateOne({ id: initial.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      const site = await this.access.requireSite(request, siteId, 'messages.write', session);
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id, organisation_id: site.organisation_id, site_id: siteId }, { session });
      if (!customer) throw new NotFoundException('Customer is unavailable');
      const prior = await this.mongo.customerMessages.findOne({ organisation_id: site.organisation_id, created_by: request.user!.id, draft_key: draftKey }, { session });
      if (prior) { if (prior.draft_hash !== hash) throw new ConflictException('Draft key reused for different content'); return { message: publicMessage(prior), replayed: true }; }
      const messageId = randomUUID(); const now = new Date().toISOString();
      const message: CustomerMessage = { _id: messageId, id: messageId, organisation_id: site.organisation_id, site_id: siteId, customer_id: id, created_by: request.user!.id,
        channel: 'email', subject, body: content, status: 'draft', version: 0, created_at: now, updated_at: now, draft_key: draftKey, draft_hash: hash,
        ...(customer.integration_mode ? { integration_mode: customer.integration_mode } : {}) };
      await this.mongo.customerMessages.insertOne(message, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'message.drafted', 'message', messageId);
      return { message: publicMessage(message), replayed: false };
    });
  }

  @Get('customers/:id/messages')
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  @ApiPagination()
  async list(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('siteId') siteId?: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(id, 'customerId'); const target = uuid(siteId, 'siteId'); const page = pagination(offset, limit);
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, target, 'messages.read', session);
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id, organisation_id: site.organisation_id, site_id: target }, { session });
      if (!customer) throw new NotFoundException('Customer is unavailable');
      const admin = await this.access.hasSitePermission(request, target, 'users.manage', session);
      const result = pageResult(await this.mongo.customerMessages.find({ ...this.integration.projectionFilter(), customer_id: id, site_id: target, organisation_id: site.organisation_id,
        ...(admin ? {} : { $or: [{ created_by: request.user!.id }, { status: { $nin: ['draft', 'cancelled'] } }] }) }, { session }).sort({ created_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
      return { messages: result.rows.map(publicMessage), pagination: result.pagination, transport: this.transport.info() };
    });
  }

  @Patch('messages/:id')
  @ApiJsonBody('messageEdit')
  async edit(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'messageId'); const siteId = uuid(body.siteId, 'siteId');
    if (!Number.isInteger(body.version) || Number(body.version) < 0) throw new BadRequestException('Current version is required');
    return this.mongo.transaction(async session => {
      const initial = await this.access.requireSite(request, siteId, 'messages.write', session);
      await this.mongo.organisations.updateOne({ id: initial.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      const site = await this.access.requireSite(request, siteId, 'messages.write', session);
      const message = await this.mongo.customerMessages.findOne({ ...this.integration.projectionFilter(), id, organisation_id: site.organisation_id, site_id: siteId }, { session });
      if (!message) throw new NotFoundException('Message is unavailable');
      if (message.created_by !== request.user!.id) await this.access.requireAdmin(request, site.organisation_id, session);
      if (message.status !== 'draft' || message.version !== body.version) throw new ConflictException('Only the current draft version can be edited');
      const next = { ...message, version: message.version + 1, updated_at: new Date().toISOString() };
      if (body.cancel === true) next.status = 'cancelled';
      else {
        if (body.subject === undefined && body.body === undefined) throw new BadRequestException('Provide subject/body or cancel=true');
        if (body.subject !== undefined) { next.subject = text(body.subject, 'subject', 1, 200); if (/[\r\n]/.test(next.subject)) throw new BadRequestException('subject must not contain line breaks'); }
        if (body.body !== undefined) next.body = text(body.body, 'body', 1, 20000);
      }
      await this.mongo.customerMessages.replaceOne({ _id: message._id }, next, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, next.status === 'cancelled' ? 'message.cancelled' : 'message.edited', 'message', id);
      return { message: publicMessage(next) };
    });
  }

  @Post('messages/:id/send')
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiJsonBody('messageSend')
  async send(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: Record<string, unknown>) {
    uuid(id, 'messageId'); const siteId = uuid(body.siteId, 'siteId'); const sendKey = text(key, 'Idempotency-Key', 8, 200);
    if (!Number.isInteger(body.version) || Number(body.version) < 0) throw new BadRequestException('Current version is required');
    const claimed = await this.mongo.transaction(async session => {
      const initial = await this.access.requireSite(request, siteId, 'messages.send', session);
      await this.mongo.organisations.updateOne({ id: initial.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      const site = await this.access.requireSite(request, siteId, 'messages.send', session);
      const message = await this.mongo.customerMessages.findOne({ ...this.integration.projectionFilter(), id, organisation_id: site.organisation_id, site_id: siteId }, { session });
      if (!message) throw new NotFoundException('Message is unavailable');
      if (message.created_by !== request.user!.id) await this.access.requireAdmin(request, site.organisation_id, session);
      if (message.status !== 'draft') { if (message.send_key === sendKey) return { message, replayed: true }; throw new ConflictException('Message already sent/cancelled or requires review; no automatic resend'); }
      this.transport.assertReady();
      if (message.version !== body.version) throw new ConflictException('Draft changed; refresh before sending');
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id: message.customer_id, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!customer) throw new NotFoundException('Customer is unavailable');
      requireEmailConsent(customer);
      if (await this.mongo.commands.findOne({ mode: customer.integration_mode, customer_id: customer.id, kind: 'customer.privacy_update', status: { $in: ['queued', 'processing', 'retry_wait', 'needs_review'] } }, { session })) throw new ConflictException('Resolve pending privacy changes before sending');
      const mode = this.transport.info().mode;
      if (mode === 'smtp' && (customer.integration_mode === 'simulated' || this.integration.config.mode === 'simulated')) throw new ConflictException('Real SMTP cannot send simulation customer data');
      const now = new Date().toISOString();
      const next: CustomerMessage = { ...message, status: 'sending', transport: mode as 'smtp' | 'simulated', to: customer.email!, send_key: sendKey, send_started_at: now, version: message.version + 1, updated_at: now };
      await this.mongo.customerMessages.replaceOne({ _id: message._id }, next, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'customer.message_sending', 'customer', customer.id, { message_id: id });
      return { message: next, replayed: false };
    });
    if (claimed.replayed) return { message: publicMessage(claimed.message), replayed: true };
    // External SMTP effects must never run inside a retryable database transaction.
    const m = claimed.message;
    let result: import('./customer-mail.transport.js').MailResult;
    try { result = await this.transport.send(m.id, m.to!, m.subject, m.body); } catch { result = { outcome: 'unknown', errorCode: 'SMTP_UNCERTAIN' }; }
    return this.mongo.transaction(async session => {
      const current = await this.mongo.customerMessages.findOne({ id, status: 'sending', send_key: sendKey }, { session });
      if (!current) throw new ConflictException('Message state changed; reconcile provider outcome');
      const status: CustomerMessage['status'] = result.outcome === 'accepted' ? 'accepted' : result.outcome === 'rejected' ? 'rejected' : 'needs_review';
      const now = new Date().toISOString();
      const next = { ...current, status, provider_id: result.providerId, sent_at: result.outcome === 'accepted' ? now : undefined, error_code: result.errorCode, updated_at: now };
      await this.mongo.customerMessages.replaceOne({ _id: current._id }, next, { session });
      await this.audit.record(session, request.user!.id, current.organisation_id, siteId, 'customer.message_' + status, 'customer', current.customer_id, { message_id: id });
      return { message: publicMessage(next), replayed: false };
    });
  }

  @Post('messages/:id/delivery')
  @ApiJsonBody('messageDelivery')
  async delivery(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'messageId'); const siteId = uuid(body.siteId, 'siteId');
    if (!['delivered', 'bounced'].includes(body.status as string)) throw new BadRequestException('status must be delivered or bounced');
    const providerId = text(body.providerId, 'providerId', 1, 254); const evidence = text(body.evidence, 'evidence', 5, 2000);
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'messages.read', session);
      await this.mongo.organisations.updateOne({ id: site.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      await this.access.requireAdmin(request, site.organisation_id, session);
      const message = await this.mongo.customerMessages.findOne({ ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!message) throw new NotFoundException('Message is unavailable');
      if (message.provider_id !== providerId || message.status !== 'accepted') throw new ConflictException('Delivery evidence must match an accepted provider message');
      const next = { ...message, status: body.status as CustomerMessage['status'], updated_at: new Date().toISOString() };
      await this.mongo.customerMessages.replaceOne({ _id: message._id }, next, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'customer.message_' + next.status, 'customer', message.customer_id, { message_id: id, evidence });
      return { message: publicMessage(next) };
    });
  }

  @Post('messages/:id/recover')
  @ApiJsonBody('messageRecover')
  async recover(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'messageId'); const siteId = uuid(body.siteId, 'siteId'); const note = text(body.note, 'note', 5, 2000);
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'messages.read', session);
      await this.mongo.organisations.updateOne({ id: site.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      await this.access.requireAdmin(request, site.organisation_id, session);
      const message = await this.mongo.customerMessages.findOne({ ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!message) throw new NotFoundException('Message is unavailable');
      if (message.status !== 'sending' || !message.send_started_at || Date.now() - Date.parse(message.send_started_at) < 120000) throw new ConflictException('Only stale sends can be recovered');
      const next = { ...message, status: 'needs_review' as const, updated_at: new Date().toISOString(), error_code: 'SEND_OUTCOME_UNKNOWN' };
      await this.mongo.customerMessages.replaceOne({ _id: message._id }, next, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'customer.message_needs_review', 'customer', message.customer_id, { message_id: id, note });
      return { message: publicMessage(next) };
    });
  }

  @Post('messages/:id/resolve')
  @ApiJsonBody('messageResolve')
  async resolve(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'messageId'); const siteId = uuid(body.siteId, 'siteId');
    if (!['accepted', 'rejected'].includes(body.status as string)) throw new BadRequestException('status must be accepted or rejected');
    const evidence = text(body.evidence, 'evidence', 5, 2000);
    const providerId = body.status === 'accepted' ? text(body.providerId, 'providerId', 1, 254) : undefined;
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'messages.read', session);
      await this.mongo.organisations.updateOne({ id: site.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      await this.access.requireAdmin(request, site.organisation_id, session);
      const message = await this.mongo.customerMessages.findOne({ ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!message) throw new NotFoundException('Message is unavailable');
      if (message.status !== 'needs_review') throw new ConflictException('Only uncertain sends can be reconciled');
      const now = new Date().toISOString();
      const next = { ...message, status: body.status as 'accepted' | 'rejected', provider_id: providerId, sent_at: body.status === 'accepted' ? now : undefined, error_code: undefined, updated_at: now };
      await this.mongo.customerMessages.replaceOne({ _id: message._id }, next, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'customer.message_' + next.status, 'customer', message.customer_id, { message_id: id, evidence, reconciled: true });
      return { message: publicMessage(next) };
    });
  }
}
