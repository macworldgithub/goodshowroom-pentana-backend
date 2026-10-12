import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiQuery } from '@nestjs/swagger';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { AccessService } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { text, uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { publicRecord } from '../database/models.js';
import { ApiJsonBody } from '../api-bodies.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { IntegrationService, publicCommand } from './integration.service.js';
import { commandResult, sourceCustomer } from './validation.js';
import { AuditService } from '../database/audit.service.js';

@Controller()
@ApiTags('Integration commands and scraping runner')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class IntegrationController {
  constructor(@Inject(IntegrationService) private readonly integration: IntegrationService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  @Get('integration/status')
  status() { return this.integration.config.info(); }

  @Get('integration/commands/:id')
  async command(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    uuid(id, 'commandId');
    const command = await this.integration.visible(request, id);
    const customer = command.status === 'succeeded' && command.mode === this.integration.config.mode ? await this.mongo.customers.findOne({ id: command.customer_id, organisation_id: command.organisation_id, site_id: command.site_id, integration_mode: command.mode }) : null;
    return { command: publicCommand(command), customer: customer ? publicRecord(customer) : null, integration: this.integration.config.info() };
  }

  @Get('admin/integration/commands')
  @ApiQuery({ name: 'organisationId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'status', required: false, enum: ['queued', 'processing', 'retry_wait', 'succeeded', 'rejected', 'failed', 'needs_review'] })
  @ApiPagination()
  async list(@Req() request: AuthenticatedRequest, @Query('organisationId') org: string, @Query('status') status?: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    const organisationId = uuid(org, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    if (status !== undefined && !['queued', 'processing', 'retry_wait', 'succeeded', 'rejected', 'failed', 'needs_review'].includes(status)) throw new BadRequestException('Choose a supported command status');
    const page = pagination(offset, limit);
    const result = pageResult(await this.mongo.commands.find({ organisation_id: organisationId, ...(status ? { status: status as import('./contracts.js').CommandStatus } : {}) }).sort({ created_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
    return { commands: result.rows.map(publicCommand), pagination: result.pagination, integration: this.integration.config.info() };
  }

  @Get('admin/integration/commands/:id/attempts')
  @ApiPagination()
  async attempts(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(id, 'commandId');
    const command = await this.integration.visible(request, id);
    await this.access.requireAdmin(request, command.organisation_id);
    const page = pagination(offset, limit);
    const result = pageResult(await this.mongo.commandAttempts.find({ command_id: id }).sort({ attempt: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
    return { attempts: result.rows.map(publicRecord), pagination: result.pagination };
  }

  @Post('admin/integration/commands/:id/process')
  @ApiJsonBody('integrationEmpty')
  async process(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    uuid(id, 'commandId');
    if (this.integration.config.mode !== 'simulated') throw new BadRequestException('Local processing is simulation-only');
    const previous = await this.integration.visible(request, id);
    await this.access.requireAdmin(request, previous.organisation_id);
    if (previous.mode !== this.integration.config.mode) throw new ConflictException('Command belongs to another integration mode');
    if (['succeeded', 'rejected', 'failed', 'needs_review'].includes(previous.status)) return this.command(request, id);
    try { return await this.integration.processOne(id, request); }
    catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      const latest = await this.integration.visible(request, id);
      if (latest.status === 'succeeded') return this.command(request, id);
      throw error;
    }
  }

  @Post('admin/integration/commands/:id/claim')
  @ApiJsonBody('integrationEmpty')
  @HttpCode(200)
  async claim(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    uuid(id, 'commandId');
    if (this.integration.config.mode !== 'scraping') throw new BadRequestException('External claims require scraping mode');
    const command = await this.integration.claim(id, request);
    return { command: publicCommand(command!), leaseToken: command!.lease_token, leaseExpiresAt: command!.lease_expires_at, integration: this.integration.config.info() };
  }

  @Post('admin/integration/commands/:id/result')
  @ApiJsonBody('integrationResult')
  @HttpCode(200)
  async result(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'commandId');
    if (this.integration.config.mode !== 'scraping') throw new BadRequestException('External results require scraping mode');
    const lease = uuid(body.leaseToken, 'leaseToken');
    return this.integration.finish(id, lease, commandResult(body), request);
  }

  @Post('admin/integration/commands/:id/heartbeat')
  @ApiJsonBody('integrationLease')
  @HttpCode(200)
  async heartbeat(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: { leaseToken?: unknown }) {
    return this.integration.heartbeat(request, uuid(id, 'commandId'), uuid(body.leaseToken, 'leaseToken'));
  }

  @Post('admin/integration/commands/:id/retry')
  @ApiJsonBody('integrationRetry')
  async retry(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: { note?: unknown; confirmedNotApplied?: unknown }) {
    uuid(id, 'commandId');
    if (body.confirmedNotApplied !== undefined && typeof body.confirmedNotApplied !== 'boolean') throw new BadRequestException('confirmedNotApplied must be a boolean');
    return this.integration.retry(request, id, text(body.note, 'note', 5, 1000), body.confirmedNotApplied === true);
  }

  @Post('admin/integration/commands/:id/resolve')
  @ApiJsonBody('integrationResolve')
  async resolve(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'commandId');
    const result = commandResult(body);
    if (result.outcome !== 'succeeded' && result.outcome !== 'rejected') throw new BadRequestException('Resolve with a verified succeeded or rejected result; use retry only after confirming not applied');
    return this.integration.finish(id, '', result, request, text(body.note, 'note', 5, 1000));
  }

  @Post('admin/integration/recover')
  @ApiJsonBody('organisation')
  async recover(@Req() request: AuthenticatedRequest, @Body() body: { organisationId?: unknown }) {
    const organisationId = uuid(body.organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    return this.integration.recoverExpired(organisationId);
  }

  @Post('admin/integration/customers/import')
  @ApiJsonBody('integrationImport')
  async importCustomers(@Req() request: AuthenticatedRequest, @Body() body: { siteId?: unknown; customers?: unknown }) {
    const siteId = uuid(body.siteId, 'siteId');
    if (this.integration.config.mode !== 'scraping') throw new BadRequestException('Scraped imports require scraping mode');
    if (!Array.isArray(body.customers) || body.customers.length < 1 || body.customers.length > 100) throw new BadRequestException('Provide 1 to 100 normalized customers');
    const records = body.customers.map(sourceCustomer);
    if (new Set(records.map(record => record.external_id)).size !== records.length) throw new BadRequestException('A batch must not repeat external IDs');
    return this.integration.importCustomers(request, siteId, records);
  }

  @Post('admin/integration/simulator/sync')
  @ApiJsonBody('integrationSite')
  async sync(@Req() request: AuthenticatedRequest, @Body() body: { siteId?: unknown }) {
    return this.integration.syncSimulated(request, uuid(body.siteId, 'siteId'));
  }

  @Post('admin/integration/simulator/behavior')
  @ApiJsonBody('simulationBehavior')
  async behavior(@Req() request: AuthenticatedRequest, @Body() body: { siteId?: unknown; behavior?: unknown; count?: unknown }) {
    if (this.integration.config.mode !== 'simulated') throw new BadRequestException('Simulator controls require simulation mode');
    const siteId = uuid(body.siteId, 'siteId');
    const site = await this.access.requireSite(request, siteId, 'customers.read');
    await this.access.requireAdmin(request, site.organisation_id);
    if (!['accept', 'reject', 'outage', 'unknown'].includes(body.behavior as string)) throw new BadRequestException('Choose accept, reject, outage, or unknown');
    if (!Number.isInteger(body.count) || Number(body.count) < 1 || Number(body.count) > 100) throw new BadRequestException('count must be 1 to 100');
    return this.mongo.transaction(async session => {
      await this.mongo.organisations.updateOne({ id: site.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      await this.access.requireAdmin(request, site.organisation_id, session);
      await this.mongo.simulatorBehaviors.updateOne({ organisation_id: site.organisation_id, site_id: siteId }, { $set: { behavior: body.behavior as 'accept' | 'reject' | 'outage' | 'unknown', remaining: Number(body.count) } }, { session, upsert: true });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'integration.simulation_configured', 'site', siteId, { behavior: body.behavior, count: body.count });
      return { behavior: body.behavior, count: body.count, integration: this.integration.config.info() };
    });
  }
}
