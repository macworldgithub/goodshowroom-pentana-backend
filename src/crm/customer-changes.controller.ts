import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { AccessService } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { text, uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiJsonBody } from '../api-bodies.js';
import { privacyInput } from './privacy.js';
import { requireAssignee } from './assignment.js';
import type { CustomerInput } from '../integration/contracts.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';

@Controller('customers/:id')
@ApiTags('Customer changes')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class CustomerChangesController {
  constructor(@Inject(IntegrationService) private readonly integration: IntegrationService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  @Get('changes')
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  @ApiPagination()
  @ApiOperation({ summary: 'Read shared customer change states', description: 'Paginated site-shared status summaries. Does not expose command payloads, request keys, attempts, or provider diagnostics.' })
  async changes(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('siteId') siteId?: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(id, 'customerId'); const target = uuid(siteId, 'siteId'); const page = pagination(offset, limit);
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, target, 'customers.read', session);
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id, site_id: target, organisation_id: site.organisation_id }, { session });
      if (!customer) throw new NotFoundException('Customer is unavailable');
      const result = pageResult(await this.mongo.commands.find({ customer_id: id, site_id: target, organisation_id: site.organisation_id, mode: customer.integration_mode, kind: { $in: ['customer.update', 'customer.privacy_update'] } }, { session }).sort({ created_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
      return { changes: result.rows.map(command => ({ id: command.id, kind: command.kind, status: command.status,
        state: command.status === 'succeeded' ? 'confirmed' : ['queued', 'processing', 'retry_wait'].includes(command.status) ? 'pending' : command.status,
        authorId: command.actor_user_id, createdAt: command.created_at, updatedAt: command.updated_at })), pagination: result.pagination };
    });
  }

  @Patch()
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiJsonBody('customerEdit')
  @ApiOperation({ summary: 'Queue source-owned contact changes', description: 'Partial contact edit. Confirmed data remains unchanged until source acceptance. Requires a source-backed customer and serializes pending changes for that customer.' })
  async edit(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: Record<string, unknown>) {
    const patch: Partial<CustomerInput> = {};
    if (body.firstName !== undefined) patch.first_name = text(body.firstName, 'firstName', 1, 100);
    if (body.lastName !== undefined) patch.last_name = text(body.lastName, 'lastName', 1, 100);
    if (body.email !== undefined) patch.email = body.email === null || body.email === '' ? null : text(body.email, 'email', 3, 254).toLowerCase();
    if (body.phone !== undefined) patch.phone = body.phone === null || body.phone === '' ? null : text(body.phone, 'phone', 1, 40);
    if (!Object.keys(patch).length) throw new BadRequestException('Provide a contact field to change');
    return this.integration.enqueueChange(request, uuid(body.siteId, 'siteId'), uuid(id, 'customerId'), 'customer.update', patch, key, body.expectedRevision === undefined ? undefined : text(body.expectedRevision, 'expectedRevision', 1, 100));
  }

  @Patch('privacy')
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiJsonBody('customerPrivacy')
  async privacy(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: Record<string, unknown>) {
    return this.integration.enqueueChange(request, uuid(body.siteId, 'siteId'), uuid(id, 'customerId'), 'customer.privacy_update', { privacy: privacyInput(body.privacy) }, key, body.expectedRevision === undefined ? undefined : text(body.expectedRevision, 'expectedRevision', 1, 100));
  }

  @Patch('assignment')
  @ApiJsonBody('customerAssignment')
  async assign(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'customerId'); const siteId = uuid(body.siteId, 'siteId');
    return this.mongo.transaction(async session => {
      const initial = await this.access.requireSite(request, siteId, 'customers.assign', session);
      await this.mongo.organisations.updateOne({ id: initial.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      const site = await this.access.requireSite(request, siteId, 'customers.assign', session);
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!customer) throw new NotFoundException('Customer is unavailable');
      const assignee = await requireAssignee(this.access, body.assignedTo, siteId, 'customers.read', session);
      const updatedAt = new Date().toISOString();
      await this.mongo.customers.updateOne({ id }, { $set: { assigned_to: assignee, updated_at: updatedAt } }, { session });
      if (customer.assigned_to !== assignee) await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'customer.assigned', 'customer', id, { from: customer.assigned_to, to: assignee });
      return { customer: publicRecord({ ...customer, assigned_to: assignee, updated_at: updatedAt }) };
    });
  }
}
