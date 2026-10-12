import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { AccessService } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { publicRecord, type Customer } from '../database/models.js';
import { text } from '../auth/validation.js';
import { IntegrationConfig } from './integration.config.js';
import { SimulatedAdapter } from './simulated.adapter.js';
import type { Command, CommandResult, CustomerInput, SourceCustomer } from './contracts.js';

export function publicCommand(command: Command) {
  const { lease_token: _leaseToken, ...record } = publicRecord(command);
  return { ...record, simulated: command.mode === 'simulated' };
}

@Injectable()
export class IntegrationService {
  constructor(@Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntegrationConfig) readonly config: IntegrationConfig,
    @Inject(SimulatedAdapter) private readonly simulator: SimulatedAdapter) {}

  projectionFilter(): { integration_mode: { $ne: 'simulated' | 'scraping' } } {
    return { integration_mode: this.config.mode === 'simulated' ? { $ne: 'scraping' } : { $ne: 'simulated' } };
  }

  async enqueueCustomer(request: AuthenticatedRequest, siteId: string, payload: CustomerInput, key: unknown) {
    const site = await this.access.requireSite(request, siteId, 'customers.write');
    if (!this.config.writesEnabled || this.config.mode === 'disabled') throw new ServiceUnavailableException('Source writes are disabled; configure simulation or the scraping runner before creating customers');
    const idempotencyKey = text(key, 'Idempotency-Key', 8, 200);
    const mode = this.config.mode;
    const requestHash = createHash('sha256').update(JSON.stringify({ mode, siteId, kind: 'customer.create', payload })).digest('hex');
    const filter = { organisation_id: site.organisation_id, actor_user_id: request.user!.id, idempotency_key: idempotencyKey };
    const existing = await this.mongo.commands.findOne(filter);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new ConflictException('Idempotency key already used for a different request');
      return { command: publicCommand(existing), replayed: true, integration: this.config.info() };
    }
    const operation = async () => this.mongo.transaction(async session => {
      await this.mongo.organisations.updateOne({ id: site.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      await this.access.requireSite(request, siteId, 'customers.write', session);
      const prior = await this.mongo.commands.findOne(filter, { session });
      if (prior) {
        if (prior.request_hash !== requestHash) throw new ConflictException('Idempotency key already used for a different request');
        return { command: publicCommand(prior), replayed: true, integration: this.config.info() };
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const command: Command = { _id: id, id, ...filter, mode, kind: 'customer.create', payload, customer_id: randomUUID(), request_hash: requestHash,
        site_id: siteId, status: 'queued', attempts: 0, available_at: now, created_at: now, updated_at: now };
      await this.mongo.commands.insertOne(command, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'integration.command_queued', 'command', id, { kind: command.kind, mode });
      return { command: publicCommand(command), replayed: false, integration: this.config.info() };
    });
    // Concurrent identical submissions may hit the unique key after a transaction
    // retry. Re-read the winner rather than returning a misleading duplicate error.
    try { return await operation(); } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      const winner = await this.mongo.commands.findOne(filter);
      if (!winner || winner.request_hash !== requestHash) throw error;
      return { command: publicCommand(winner), replayed: true, integration: this.config.info() };
    }
  }

  async visible(request: AuthenticatedRequest, id: string) {
    const command = await this.mongo.commands.findOne({ id });
    if (!command) throw new NotFoundException('Command is unavailable');
    await this.access.requireSite(request, command.site_id, 'customers.read');
    if (command.actor_user_id !== request.user!.id) await this.access.requireAdmin(request, command.organisation_id);
    return command;
  }

  async claim(id: string, admin?: AuthenticatedRequest) {
    if (!this.config.writesEnabled || this.config.mode === 'disabled') throw new ServiceUnavailableException('Source writes are disabled');
    const claimed = await this.mongo.transaction(async session => {
      const previous = await this.mongo.commands.findOne({ id }, { session });
      if (!previous) throw new NotFoundException('Command is unavailable');
      if (admin) await this.access.requireAdmin(admin, previous.organisation_id, session);
      if (previous.mode !== this.config.mode) throw new ConflictException('Command belongs to another integration mode');
      const now = new Date().toISOString();
      if (!['queued', 'retry_wait'].includes(previous.status) || previous.available_at > now) throw new ConflictException('Command is not ready to claim');
      await this.mongo.organisations.updateOne({ id: previous.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      try {
        await this.access.requireSite({ user: { id: previous.actor_user_id } } as AuthenticatedRequest, previous.site_id, 'customers.write', session);
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
        await this.mongo.commands.updateOne({ id }, { $set: { status: 'rejected', updated_at: now, error: { code: 'ACCESS_REVOKED', message: 'The requesting user no longer has write access' } } }, { session });
        await this.audit.record(session, admin?.user!.id ?? previous.actor_user_id, previous.organisation_id, previous.site_id, 'integration.command_rejected', 'command', id, { code: 'ACCESS_REVOKED' });
        return null;
      }
      const next: Command = { ...previous, status: 'processing', attempts: previous.attempts + 1, lease_token: randomUUID(), lease_expires_at: new Date(Date.now() + 300000).toISOString(), updated_at: now };
      delete next.error;
      await this.mongo.commands.replaceOne({ _id: previous._id }, next, { session });
      const attemptId = `${id}:${next.attempts}`;
      await this.mongo.commandAttempts.insertOne({ _id: attemptId, id: attemptId, command_id: id, organisation_id: next.organisation_id, site_id: next.site_id, mode: next.mode, attempt: next.attempts, request: next.payload, response: null, completed_at: null, created_at: now }, { session });
      await this.audit.record(session, admin?.user!.id ?? next.actor_user_id, next.organisation_id, next.site_id, 'integration.command_claimed', 'command', id, { attempt: next.attempts, mode: next.mode });
      return next;
    });
    if (!claimed && admin) throw new ConflictException('The requesting user no longer has access; command rejected');
    return claimed;
  }

  private async project(command: Pick<Command, 'organisation_id' | 'site_id' | 'mode' | 'actor_user_id' | 'customer_id'>, record: SourceCustomer, session: ClientSession, recordActivity = false) {
    const filter = { organisation_id: command.organisation_id, integration_mode: command.mode, integration_external_id: record.external_id };
    const existing = await this.mongo.customers.findOne(filter, { session });
    if (existing && existing.site_id !== command.site_id) throw new ConflictException('Source customer is already mapped to another site; reconciliation is required');
    if (existing && existing.source_observed_at! > record.observed_at) return existing;
    if (existing?.source_observed_at === record.observed_at && (existing.source_revision !== record.revision ||
      existing.first_name !== record.first_name || existing.last_name !== record.last_name || existing.email !== record.email || existing.phone !== record.phone)) {
      throw new ConflictException('Conflicting source observations at the same timestamp');
    }
    const id = existing?.id ?? command.customer_id;
    const now = new Date().toISOString();
    const customer: Customer = { _id: existing?._id ?? id, id, organisation_id: command.organisation_id, site_id: command.site_id,
      created_by: existing?.created_by ?? command.actor_user_id, assigned_to: existing?.assigned_to ?? command.actor_user_id,
      first_name: record.first_name, last_name: record.last_name, email: record.email, phone: record.phone,
      source: command.mode === 'simulated' ? 'simulated' : 'pentana', integration_mode: command.mode, integration_external_id: record.external_id,
      external_ids: command.mode === 'simulated' ? { simulated: record.external_id } : { pentana: record.external_id },
      source_revision: record.revision, source_observed_at: record.observed_at, created_at: existing?.created_at ?? now, updated_at: now };
    await this.mongo.customers.replaceOne(filter, customer, { session, upsert: true });
    if (recordActivity && (!existing || existing.source_revision !== record.revision || existing.first_name !== record.first_name || existing.last_name !== record.last_name || existing.email !== record.email || existing.phone !== record.phone)) {
      await this.audit.record(session, command.actor_user_id, command.organisation_id, command.site_id, existing ? 'customer.source_updated' : 'customer.source_imported', 'customer', customer.id, { mode: command.mode });
    }
    return customer;
  }

  async finish(id: string, lease: string, result: CommandResult, admin?: AuthenticatedRequest, resolutionNote?: string) {
    return this.mongo.transaction(async session => {
      const command = await this.mongo.commands.findOne({ id }, { session });
      if (!command) throw new NotFoundException('Command is unavailable');
      await this.mongo.organisations.updateOne({ id: command.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      if (admin) await this.access.requireAdmin(admin, command.organisation_id, session);
      if (command.mode !== this.config.mode) throw new ConflictException('Command belongs to another integration mode');
      const now = new Date().toISOString();
      if (resolutionNote && (!admin || command.status !== 'needs_review')) throw new ConflictException('Only an administrator can resolve a needs-review command');
      if (!resolutionNote && (command.status !== 'processing' || command.lease_token !== lease || !command.lease_expires_at || command.lease_expires_at <= now)) throw new ConflictException('Lease is unavailable or expired; reconcile the command before another write');
      let customer: Customer | undefined;
      let status: Command['status'];
      let response = result;
      if (result.outcome === 'succeeded') {
        // A source acknowledgement is not permission to change unrelated contact data.
        if (JSON.stringify({ first_name: result.customer.first_name, last_name: result.customer.last_name, email: result.customer.email, phone: result.customer.phone }) !== JSON.stringify(command.payload)) {
          response = { outcome: 'unknown', code: 'SOURCE_RESULT_MISMATCH', message: 'Source response differs from requested customer; reconciliation is required' };
          status = 'needs_review';
        } else {
          customer = await this.project(command, result.customer, session);
          status = 'succeeded';
        }
      } else status = result.outcome === 'rejected' ? 'rejected' : result.outcome === 'unknown' ? 'needs_review' : command.attempts >= 3 ? 'failed' : 'retry_wait';
      const next: Command = { ...command, status, updated_at: now, available_at: status === 'retry_wait' ? new Date(Date.now() + 1000 * 2 ** command.attempts).toISOString() : command.available_at,
        ...(customer ? { customer_id: customer.id } : {}), ...(response.outcome === 'succeeded' ? { result: response.customer } : { error: { code: response.code, message: response.message } }) };
      delete next.lease_token; delete next.lease_expires_at;
      await this.mongo.commands.replaceOne({ _id: command._id }, next, { session });
      await this.mongo.commandAttempts.updateOne({ command_id: id, attempt: command.attempts }, { $set: resolutionNote ? { resolution: { response: result, status, note: resolutionNote, actor: admin!.user!.id, resolved_at: now } } : { response: result, processing_outcome: response, outcome_status: status, completed_at: now } }, { session });
      await this.audit.record(session, admin?.user!.id ?? command.actor_user_id, command.organisation_id, command.site_id, `integration.command_${status}`, 'command', id, { attempt: command.attempts, outcome: response.outcome, mode: command.mode, ...(resolutionNote ? { resolutionNote } : {}) });
      if (customer) await this.audit.record(session, command.actor_user_id, command.organisation_id, command.site_id, 'customer.created', 'customer', customer.id, { command_id: id, mode: command.mode });
      return { command: publicCommand(next), customer: customer ? publicRecord(customer) : null, integration: this.config.info() };
    });
  }

  async recoverExpired(organisationId?: string) {
    if (this.config.mode === 'disabled') return { recovered: 0 };
    const expired = await this.mongo.commands.find({ mode: this.config.mode, status: 'processing', lease_expires_at: { $lte: new Date().toISOString() }, ...(organisationId ? { organisation_id: organisationId } : {}) }).limit(100).toArray();
    let recovered = 0;
    for (const record of expired) {
      const changed = await this.mongo.transaction(async session => {
        const now = new Date().toISOString();
        const response: CommandResult = { outcome: 'unknown', code: 'LEASE_EXPIRED', message: record.mode === 'simulated' ? 'Simulator lease expired; replay uses the durable source receipt' : 'Scraping runner lease expired; source outcome must be checked before another write' };
        const status: Command['status'] = record.mode === 'scraping' ? 'needs_review' : record.attempts >= 3 ? 'failed' : 'retry_wait';
        const result = await this.mongo.commands.updateOne({ id: record.id, status: 'processing', lease_token: record.lease_token, lease_expires_at: { $lte: now } }, { $set: { status, updated_at: now, available_at: now, error: { code: response.code, message: response.message } }, $unset: { lease_token: '', lease_expires_at: '' } }, { session });
        if (!result.modifiedCount) return;
        await this.mongo.commandAttempts.updateOne({ command_id: record.id, attempt: record.attempts }, { $set: { response, completed_at: now } }, { session });
        await this.audit.record(session, record.actor_user_id, record.organisation_id, record.site_id, 'integration.lease_expired', 'command', record.id, { status });
        return true;
      });
      if (changed) recovered++;
    }
    return { recovered };
  }

  async processOne(id?: string, admin?: AuthenticatedRequest) {
    if (this.config.mode !== 'simulated') throw new BadRequestException('Local processing is available only in simulation; scraping writes must be claimed by the external runner');
    const candidate = id ? { id } : await this.mongo.commands.findOne({ mode: 'simulated', status: { $in: ['queued', 'retry_wait'] }, available_at: { $lte: new Date().toISOString() } }, { sort: { available_at: 1, id: 1 } });
    if (!candidate) return null;
    const command = await this.claim(candidate.id, admin);
    if (!command) return null;
    let result: CommandResult;
    try { result = await this.simulator.execute(command); }
    catch { result = { outcome: 'unknown', code: 'ADAPTER_EXCEPTION', message: 'Source outcome could not be confirmed' }; }
    return this.finish(command.id, command.lease_token!, result, admin);
  }

  async retry(request: AuthenticatedRequest, id: string, note: string, confirmedNotApplied: boolean) {
    return this.mongo.transaction(async session => {
      const previous = await this.mongo.commands.findOne({ id }, { session });
      if (!previous) throw new NotFoundException('Command is unavailable');
      await this.mongo.organisations.updateOne({ id: previous.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      await this.access.requireAdmin(request, previous.organisation_id, session);
      if (previous.mode !== this.config.mode || !this.config.writesEnabled) throw new ConflictException('Enable the matching write mode before retrying');
      if (!['failed', 'needs_review'].includes(previous.status)) throw new ConflictException('Only failed or needs-review commands can be retried; rejected requests must be corrected with a new key');
      if (previous.status === 'needs_review' && !confirmedNotApplied) throw new BadRequestException('Confirm in the source that this write was not applied before retrying');
      const now = new Date().toISOString();
      await this.mongo.commands.updateOne({ id }, { $set: { status: 'queued', updated_at: now, available_at: now }, $unset: { error: '' } }, { session });
      await this.audit.record(session, request.user!.id, previous.organisation_id, previous.site_id, 'integration.retry_authorized', 'command', id, { note, confirmedNotApplied });
      const next: Command = { ...previous, status: 'queued', updated_at: now, available_at: now };
      delete next.error;
      return { command: publicCommand(next) };
    });
  }

  async importCustomers(request: AuthenticatedRequest, siteId: string, records: SourceCustomer[]) {
    if (this.config.mode === 'disabled') throw new ServiceUnavailableException('Integration is disabled');
    const site = await this.access.requireSite(request, siteId, 'customers.read');
    await this.access.requireAdmin(request, site.organisation_id);
    const mode = this.config.mode;
    return this.mongo.transaction(async session => {
      await this.mongo.organisations.updateOne({ id: site.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      await this.access.requireAdmin(request, site.organisation_id, session);
      const imported: Customer[] = [];
      for (const record of records) imported.push(await this.project({ organisation_id: site.organisation_id, site_id: siteId, actor_user_id: request.user!.id, customer_id: randomUUID(), mode }, record, session, true));
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'integration.customers_synchronized', 'site', siteId, { count: imported.length, mode });
      return { customers: imported.map(publicRecord), integration: this.config.info() };
    });
  }
  async syncSimulated(request: AuthenticatedRequest, siteId: string) {
    if (this.config.mode !== 'simulated') throw new BadRequestException('Fixture reads are available only in simulation');
    const site = await this.access.requireSite(request, siteId, 'customers.read');
    await this.access.requireAdmin(request, site.organisation_id);
    return this.importCustomers(request, siteId, await this.simulator.readCustomers(site.organisation_id, siteId));
  }

  async heartbeat(request: AuthenticatedRequest, id: string, lease: string) {
    return this.mongo.transaction(async session => {
      const previous = await this.mongo.commands.findOne({ id }, { session });
      if (!previous) throw new NotFoundException('Command is unavailable');
      await this.mongo.organisations.updateOne({ id: previous.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      await this.access.requireAdmin(request, previous.organisation_id, session);
      const now = new Date().toISOString();
      if (previous.mode !== 'scraping' || this.config.mode !== 'scraping' || previous.status !== 'processing' || previous.lease_token !== lease || !previous.lease_expires_at || previous.lease_expires_at <= now) throw new ConflictException('Cannot renew an expired or unavailable lease');
      const expires = new Date(Date.now() + 300000).toISOString();
      await this.mongo.commands.updateOne({ id }, { $set: { lease_expires_at: expires, updated_at: now } }, { session });
      return { leaseExpiresAt: expires };
    });
  }
}
