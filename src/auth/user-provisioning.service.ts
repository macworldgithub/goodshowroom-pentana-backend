import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord, type Membership } from '../database/models.js';
import { AccessService } from './access.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { brandScope, requireSetupKey, roles, text, uuid, validateRoleScope } from './validation.js';
import type { Role } from './permissions.js';
import { createAdminSupabaseClient } from './user-supabase.js';

export type CreateUserBody = {
  email?: unknown; password?: unknown; fullName?: unknown; setupKey?: unknown;
  organisationId?: unknown; siteId?: unknown; roles?: unknown; brandIds?: unknown;
};

@Injectable()
export class UserProvisioningService {
  constructor(@Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  private identity(body: CreateUserBody) {
    const email = text(body.email, 'email', 3, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Enter a valid email address');
    // Passwords are never trimmed, stored in MongoDB, returned, or audited.
    if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
      throw new BadRequestException('Password must contain 12 to 128 characters');
    }
    const fullName = body.fullName === undefined ? undefined : text(body.fullName, 'fullName', 1, 120);
    return { email, password: body.password, fullName };
  }

  private async createIdentity(identity: ReturnType<UserProvisioningService['identity']>) {
    let result: Awaited<ReturnType<ReturnType<typeof createAdminSupabaseClient>['auth']['admin']['createUser']>>;
    try {
      result = await createAdminSupabaseClient().auth.admin.createUser({
        email: identity.email, password: identity.password, email_confirm: true,
        ...(identity.fullName ? { user_metadata: { full_name: identity.fullName } } : {}),
      });
    } catch { throw new ServiceUnavailableException('Unable to create the authentication account; check Supabase before retrying'); }
    if (result.error) {
      if (['email_exists', 'user_already_exists'].includes(result.error.code ?? '')) {
        throw new ConflictException('This email already has a Supabase account. Sign in for initial setup, or grant access through an application invitation. Existing passwords are not changed.');
      }
      if (result.error.status && result.error.status < 500 && result.error.name !== 'AuthRetryableFetchError') {
        throw new BadRequestException('Supabase rejected account creation. Check the email, password policy, and server key configuration.');
      }
      throw new ServiceUnavailableException('Account creation could not be confirmed; check Supabase before retrying');
    }
    if (!result.data.user) throw new ServiceUnavailableException('Account creation could not be confirmed');
    return { id: result.data.user.id, email: identity.email };
  }

  async initial(body: CreateUserBody) {
    requireSetupKey(body.setupKey);
    const identity = this.identity(body);
    const reserved = await this.mongo.transaction(async session => {
      await this.mongo.systemState.updateOne({ _id: 'setup_gate' }, { $inc: { revision: 1 } }, { session, upsert: true });
      if (await this.mongo.organisations.findOne({}, { session })) throw new ConflictException('Initial setup has already been completed. An ADMIN must create further users.');
      const previous = await this.mongo.systemState.findOne({ _id: 'initial_user' }, { session });
      if (previous && previous.email !== identity.email) throw new ConflictException('Another initial administrator email is already reserved');
      if (!previous) {
        await this.mongo.systemState.insertOne({ _id: 'initial_user', email: identity.email, created_at: new Date().toISOString() }, { session });
      }
      return previous;
    });
    if (reserved?.user_id) return { user: { id: reserved.user_id, email: identity.email }, created: false, nextStep: 'Sign in and call POST /api/setup' };
    // External identity creation must remain outside the retryable MongoDB transaction.
    const user = await this.createIdentity(identity);
    try {
      await this.mongo.transaction(async session => {
        await this.mongo.systemState.updateOne({ _id: 'initial_user', email: identity.email }, { $set: { user_id: user.id } }, { session });
        await this.mongo.users.updateOne({ _id: user.id }, { $set: {
          email: identity.email, ...(identity.fullName ? { full_name: identity.fullName } : {}), updated_at: new Date().toISOString(),
        } }, { session, upsert: true });
      });
    } catch {
      throw new ServiceUnavailableException({ message: 'The authentication account was created. Sign in with this account and complete setup; application profile persistence needs verification.', code: 'USER_PROVISIONING_INCOMPLETE', userId: user.id });
    }
    return { user, created: true, nextStep: 'Sign in and call POST /api/setup' };
  }

  async staff(request: AuthenticatedRequest, body: CreateUserBody) {
    const organisationId = uuid(body.organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    const siteId = body.siteId == null ? null : uuid(body.siteId, 'siteId');
    const requestedRoles = roles(body.roles) as Role[];
    validateRoleScope(requestedRoles, siteId);
    const brandIds = brandScope(body.brandIds);
    if (brandIds !== null) await this.access.validateBrandScope(organisationId, siteId, requestedRoles, brandIds);
    const identity = this.identity(body);
    if (siteId && !(await this.mongo.sites.findOne({ id: siteId, organisation_id: organisationId }))) {
      throw new BadRequestException('Site does not belong to this organisation');
    }
    const user = await this.createIdentity(identity);
    try {
      return await this.mongo.transaction(async session => {
        const organisation = await this.mongo.organisations.updateOne({ id: organisationId }, { $inc: { access_revision: 1 } }, { session });
        if (!organisation.matchedCount) throw new ConflictException('Organisation is unavailable');
        await this.access.requireAdmin(request, organisationId, session);
        if (siteId && !(await this.mongo.sites.findOne({ id: siteId, organisation_id: organisationId }, { session }))) {
          throw new BadRequestException('Site is unavailable');
        }
        if (brandIds !== null) await this.access.validateBrandScope(organisationId, siteId, requestedRoles, brandIds, session);
        const memberships: Membership[] = [];
        const now = new Date().toISOString();
        await this.mongo.users.updateOne({ _id: user.id }, { $set: {
          email: identity.email, ...(identity.fullName ? { full_name: identity.fullName } : {}), updated_at: now,
        } }, { session, upsert: true });
        for (const role of requestedRoles) {
          const id = randomUUID();
          const membership: Membership = { _id: id, id, organisation_id: organisationId, site_id: siteId,
            user_id: user.id, role, status: 'active', extra_permissions: [], brand_ids: brandIds, created_at: now };
          await this.mongo.memberships.insertOne(membership, { session });
          memberships.push(membership);
        }
        await this.audit.record(session, request.user!.id, organisationId, siteId, 'staff.user_created', 'user', user.id,
          { roles: requestedRoles, membership_ids: memberships.map(item => item.id) });
        return { user, memberships: memberships.map(publicRecord) };
      });
    } catch {
      // Two services cannot share a transaction. Never delete an identity on an ambiguous DB outcome.
      throw new ServiceUnavailableException({ message: 'The Supabase account was created, but application access could not be confirmed. Check memberships and grant access through an invitation if needed.', code: 'USER_PROVISIONING_INCOMPLETE', userId: user.id });
    }
  }
}
