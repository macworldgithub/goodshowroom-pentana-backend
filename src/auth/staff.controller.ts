import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { AccessService } from './access.service.js';
import { SupabaseAuthGuard } from './supabase-auth.guard.js';
import { createAdminSupabaseClient } from './user-supabase.js';
import { brandScope, roles, text, uuid, validateRoleScope } from './validation.js';
import { EXTRA_PERMISSIONS, type Role } from './permissions.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord } from '../database/models.js';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiJsonBody } from '../api-bodies.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { invitationDeliveryFailure } from './invitation-delivery.js';

@Controller()
@ApiTags('Staff and invitations')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class StaffController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  private async lockAdmin(request: AuthenticatedRequest, organisationId: string, session: ClientSession) {
    // Serialize access changes per dealership, including last-administrator protection.
    const result = await this.mongo.organisations.updateOne({ id: organisationId }, { $inc: { access_revision: 1 } }, { session });
    if (!result.matchedCount) throw new NotFoundException('Organisation is unavailable');
    await this.access.requireAdmin(request, organisationId, session);
  }

  @Get('admin/memberships')
  @ApiQuery({ name: 'organisationId', required: true, type: String, format: 'uuid' })
  @ApiPagination()
  async list(@Req() request: AuthenticatedRequest, @Query('organisationId') organisationId: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    const page = pagination(offset, limit);
    const result = pageResult(await this.mongo.memberships.find({ organisation_id: organisationId }).sort({ created_at: 1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
    const profiles = await this.mongo.users.find({ _id: { $in: result.rows.map(row => row.user_id) } }, { projection: { email: 1, full_name: 1 } }).toArray();
    return { memberships: result.rows.map(row => { const profile = profiles.find(item => item._id === row.user_id); return { ...publicRecord(row), user: { fullName: profile?.full_name ?? null, email: profile?.email ?? null } }; }), pagination: result.pagination };
  }

  @Patch('admin/memberships/:id')
  @ApiJsonBody('membership')
  async update(@Req() request: AuthenticatedRequest, @Param('id') id: string,
    @Body() body: { organisationId?: unknown; role?: unknown; siteId?: unknown; brandIds?: unknown; status?: unknown; extraPermissions?: unknown }) {
    uuid(id, 'membershipId');
    const organisationId = uuid(body.organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    const role = body.role === undefined ? undefined : roles([body.role])[0] as Role;
    if (body.status !== undefined && !['active', 'suspended'].includes(body.status as string)) throw new BadRequestException('Status must be active or suspended');
    if (body.extraPermissions !== undefined && (!Array.isArray(body.extraPermissions) || body.extraPermissions.length > 30 ||
      body.extraPermissions.some(p => typeof p !== 'string' || !(EXTRA_PERMISSIONS as readonly string[]).includes(p)))) {
      throw new BadRequestException('Choose supported additional permissions');
    }
    const requestedBrands = body.brandIds === undefined ? undefined : brandScope(body.brandIds);
    if (role === undefined && body.siteId === undefined && body.brandIds === undefined && body.status === undefined && body.extraPermissions === undefined) throw new BadRequestException('Provide role, siteId, brandIds, status, or extraPermissions');
    return this.mongo.transaction(async session => {
      await this.lockAdmin(request, organisationId, session);
      const previous = await this.mongo.memberships.findOne({ id, organisation_id: organisationId }, { session });
      if (!previous) throw new NotFoundException('Membership is unavailable');
      const nextRole = role ?? previous.role;
      const nextStatus = (body.status ?? previous.status) as 'active' | 'suspended';
      const nextSiteId = body.siteId === undefined ? previous.site_id : body.siteId === null ? null : uuid(body.siteId, 'siteId');
      const nextBrandIds = requestedBrands === undefined ? previous.brand_ids ?? null : requestedBrands;
      // Allow suspending invalid legacy grants without silently assigning a site.
      if (nextStatus === 'active') validateRoleScope([nextRole], nextSiteId);
      if (nextSiteId !== null && !(await this.mongo.sites.findOne({ id: nextSiteId, organisation_id: organisationId }, { session }))) {
        throw new BadRequestException('Site does not belong to this organisation');
      }
      if (nextBrandIds !== null && (nextStatus === 'active' || body.brandIds !== undefined || body.siteId !== undefined || role !== undefined)) {
        await this.access.validateBrandScope(organisationId, nextSiteId, [nextRole], nextBrandIds, session);
      }
      if (previous.role === 'ADMIN' && previous.status === 'active' && (nextRole !== 'ADMIN' || nextStatus !== 'active')) {
        const other = await this.mongo.memberships.findOne({ organisation_id: organisationId, site_id: null, role: 'ADMIN', status: 'active', id: { $ne: id } }, { session });
        if (!other) throw new ConflictException('Cannot remove the last active administrator');
      }
      const next = { ...previous, role: nextRole, site_id: nextSiteId, brand_ids: nextBrandIds, status: nextStatus,
        extra_permissions: body.extraPermissions === undefined ? previous.extra_permissions : [...new Set(body.extraPermissions as string[])] };
      await this.mongo.memberships.replaceOne({ _id: previous._id }, next, { session });
      await this.audit.record(session, request.user!.id, organisationId, next.site_id, 'staff.access_updated', 'membership', id,
        { before: publicRecord(previous), after: publicRecord(next) });
      return { membership: publicRecord(next) };
    });
  }

  @Get('admin/audit')
  @ApiQuery({ name: 'organisationId', required: true, type: String, format: 'uuid' })
  @ApiPagination()
  async auditLog(@Req() request: AuthenticatedRequest, @Query('organisationId') organisationId: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    const page = pagination(offset, limit);
    const result = pageResult(await this.mongo.auditEvents.find({ organisation_id: organisationId }).sort({ created_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
    return { events: result.rows.map(publicRecord), pagination: result.pagination };
  }

  @Get('admin/invitations')
  @ApiQuery({ name: 'organisationId', required: true, type: String, format: 'uuid' })
  @ApiPagination()
  async invitations(@Req() request: AuthenticatedRequest, @Query('organisationId') organisationId: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    const page = pagination(offset, limit);
    const result = pageResult(await this.mongo.invitations.find({ organisation_id: organisationId }).sort({ created_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
    return { invitations: result.rows.map(publicRecord), pagination: result.pagination };
  }

  @Post('admin/invitations')
  @ApiJsonBody('invitation')
  async invite(@Req() request: AuthenticatedRequest,
    @Body() body: { organisationId?: unknown; siteId?: unknown; brandIds?: unknown; email?: unknown; roles?: unknown }) {
    const organisationId = uuid(body.organisationId, 'organisationId');
    const siteId = body.siteId == null ? null : uuid(body.siteId, 'siteId');
    const email = text(body.email, 'email', 3, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Enter a valid email address');
    const requestedRoles = roles(body.roles) as Role[];
    validateRoleScope(requestedRoles, siteId);
    const brandIds = brandScope(body.brandIds);
    await this.access.requireAdmin(request, organisationId);
    return this.mongo.transaction(async session => {
      await this.lockAdmin(request, organisationId, session);
      if (siteId && !(await this.mongo.sites.findOne({ id: siteId, organisation_id: organisationId }, { session }))) {
        throw new BadRequestException('Site does not belong to this organisation');
      }
      if (brandIds !== null) await this.access.validateBrandScope(organisationId, siteId, requestedRoles, brandIds, session);
      const now = new Date().toISOString();
      await this.mongo.invitations.updateMany({ organisation_id: organisationId, email, status: 'pending', expires_at: { $lte: now } }, { $set: { status: 'revoked' } }, { session });
      const id = randomUUID();
      const invitation = { _id: id, id, organisation_id: organisationId, site_id: siteId, brand_ids: brandIds, email, roles: requestedRoles,
        status: 'pending' as const, delivery_status: 'not_sent' as const, invited_by: request.user!.id,
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), created_at: now };
      await this.mongo.invitations.insertOne(invitation, { session });
      await this.audit.record(session, request.user!.id, organisationId, siteId, 'staff.invitation_created', 'invitation', id);
      return { invitation: publicRecord(invitation) };
    });
  }

  @Post('admin/invitations/:id/send')
  @ApiJsonBody('organisation')
  async send(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: { organisationId?: unknown }) {
    uuid(id, 'invitationId');
    const organisationId = uuid(body.organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    const invitation = await this.mongo.invitations.findOne({ id, organisation_id: organisationId, status: 'pending', expires_at: { $gt: new Date().toISOString() } });
    if (!invitation) throw new BadRequestException('Invitation is unavailable or expired');
    const redirectTo = process.env.AUTH_INVITE_REDIRECT_URL;
    if (!redirectTo) throw new BadRequestException('Configure AUTH_INVITE_REDIRECT_URL before sending invitations');
    // Supabase is used only for identity/email, never for CRM persistence.
    const { error: sendError } = await createAdminSupabaseClient().auth.admin.inviteUserByEmail(invitation.email, { redirectTo });
    const failure = sendError ? invitationDeliveryFailure(sendError) : undefined;
    await this.mongo.transaction(async session => {
      await this.mongo.invitations.updateOne({ id, status: 'pending' }, { $set: { delivery_status: sendError ? 'failed' : 'sent' } }, { session });
      await this.audit.record(session, request.user!.id, organisationId, invitation.site_id, 'staff.invitation_delivery', 'invitation', id,
        { sent: !sendError, ...(failure ? { error_code: failure.errorCode, provider_status: failure.providerStatus } : {}) });
    });
    return { invitationId: id, sent: !sendError,
      ...(failure ?? { message: 'Invitation email submitted' }) };
  }

  @Post('admin/invitations/:id/revoke')
  @ApiJsonBody('organisation')
  async revoke(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: { organisationId?: unknown }) {
    uuid(id, 'invitationId');
    const organisationId = uuid(body.organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    return this.mongo.transaction(async session => {
      await this.lockAdmin(request, organisationId, session);
      const invitation = await this.mongo.invitations.findOneAndUpdate({ id, organisation_id: organisationId, status: 'pending' },
        { $set: { status: 'revoked' } }, { session, returnDocument: 'after' });
      if (!invitation) throw new BadRequestException('Pending invitation is unavailable');
      await this.audit.record(session, request.user!.id, organisationId, invitation.site_id, 'staff.invitation_revoked', 'invitation', id);
      return { invitation: publicRecord(invitation) };
    });
  }

  private confirmedEmail(request: AuthenticatedRequest) {
    if (!request.user?.email || !request.user.email_confirmed_at) throw new UnauthorizedException('A confirmed email is required');
    return request.user.email.toLowerCase();
  }

  @Get('auth/invitations')
  @ApiPagination()
  async mine(@Req() request: AuthenticatedRequest, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    const email = this.confirmedEmail(request);
    const page = pagination(offset, limit);
    const result = pageResult(await this.mongo.invitations.find({ email, status: 'pending', expires_at: { $gt: new Date().toISOString() } }).sort({ created_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
    return { invitations: result.rows.map(publicRecord), pagination: result.pagination };
  }

  @Post('auth/invitations/:id/accept')
  async accept(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    uuid(id, 'invitationId');
    const email = this.confirmedEmail(request);
    return this.mongo.transaction(async session => {
      const invitation = await this.mongo.invitations.findOneAndUpdate({ id, email, status: 'pending', expires_at: { $gt: new Date().toISOString() } },
        { $set: { status: 'accepted', accepted_by: request.user!.id, accepted_at: new Date().toISOString() } }, { session, returnDocument: 'after' });
      if (!invitation) throw new BadRequestException('Invitation is unavailable or expired');
      validateRoleScope(roles(invitation.roles), invitation.site_id);
      const brandIds = brandScope(invitation.brand_ids);
      if (brandIds !== null) await this.access.validateBrandScope(invitation.organisation_id, invitation.site_id, invitation.roles, brandIds, session);
      if (invitation.site_id !== null && !(await this.mongo.sites.findOne({ id: invitation.site_id, organisation_id: invitation.organisation_id }, { session }))) {
        throw new BadRequestException('Invitation site is unavailable; ask an administrator for a new invitation');
      }
      await this.mongo.organisations.updateOne({ id: invitation.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      const suspended = await this.mongo.memberships.findOne({ organisation_id: invitation.organisation_id, user_id: request.user!.id, status: 'suspended' }, { session });
      if (suspended) throw new ConflictException('Ask an administrator to reactivate your suspended access');
      for (const role of invitation.roles) {
        const membershipId = randomUUID();
        await this.mongo.memberships.updateOne({ organisation_id: invitation.organisation_id, site_id: invitation.site_id, user_id: request.user!.id, role },
          { $setOnInsert: { _id: membershipId, id: membershipId, organisation_id: invitation.organisation_id, site_id: invitation.site_id,
            user_id: request.user!.id, role, status: 'active', extra_permissions: [], brand_ids: brandIds, created_at: new Date().toISOString() } }, { session, upsert: true });
      }
      await this.audit.record(session, request.user!.id, invitation.organisation_id, invitation.site_id, 'staff.invitation_accepted', 'invitation', id);
      const memberships = await this.mongo.memberships.find({ organisation_id: invitation.organisation_id, user_id: request.user!.id, status: 'active' }, { session }).toArray();
      return { memberships: memberships.map(publicRecord) };
    });
  }
}
