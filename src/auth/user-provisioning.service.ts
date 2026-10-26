import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord, type Membership, type DbUser } from '../database/models.js';
import { AccessService } from './access.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { brandScope, requireSetupKey, roles, text, uuid, validateRoleScope } from './validation.js';
import type { Role } from './permissions.js';
import { hashPassword } from './crypto.util.js';

export type CreateUserBody = {
  email?: unknown; password?: unknown; fullName?: unknown; setupKey?: unknown;
  organisationId?: unknown; siteId?: unknown; roles?: unknown; brandIds?: unknown;
};

@Injectable()
export class UserProvisioningService {
  constructor(
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private identity(body: CreateUserBody) {
    const email = text(body.email, 'email', 3, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Enter a valid email address');
    if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
      throw new BadRequestException('Password must contain 12 to 128 characters');
    }
    const fullName = body.fullName === undefined ? undefined : text(body.fullName, 'fullName', 1, 120);
    return { email, password: body.password, fullName };
  }

  async initial(body: CreateUserBody) {
    requireSetupKey(body.setupKey);
    const identity = this.identity(body);

    const existingUser = await this.mongo.users.findOne({ email: identity.email });
    if (existingUser) {
      throw new ConflictException('An account with this email address already exists.');
    }

    const { hash, salt } = await hashPassword(identity.password);
    const userId = randomUUID();
    const now = new Date().toISOString();

    await this.mongo.transaction(async (session) => {
      await this.mongo.systemState.updateOne({ _id: 'setup_gate' }, { $inc: { revision: 1 } }, { session, upsert: true });
      if (await this.mongo.organisations.findOne({}, { session })) {
        throw new ConflictException('Initial setup has already been completed. An ADMIN must create further users.');
      }
      const previous = await this.mongo.systemState.findOne({ _id: 'initial_user' }, { session });
      if (previous && previous.email !== identity.email) {
        throw new ConflictException('Another initial administrator email is already reserved');
      }
      await this.mongo.systemState.updateOne(
        { _id: 'initial_user' },
        { $set: { email: identity.email, user_id: userId, created_at: now } },
        { session, upsert: true },
      );
      const userRecord: DbUser = {
        _id: userId,
        id: userId,
        email: identity.email,
        full_name: identity.fullName,
        password_hash: hash,
        password_salt: salt,
        email_confirmed_at: now,
        created_at: now,
        updated_at: now,
      };
      await this.mongo.users.insertOne(userRecord, { session });
    });

    return {
      user: { id: userId, email: identity.email, fullName: identity.fullName },
      created: true,
      nextStep: 'Sign in and call POST /api/setup',
    };
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

    const existingUser = await this.mongo.users.findOne({ email: identity.email });
    if (existingUser) {
      throw new ConflictException('An account with this email address already exists. Grant access through an invitation instead.');
    }

    const { hash, salt } = await hashPassword(identity.password);
    const userId = randomUUID();
    const now = new Date().toISOString();

    return this.mongo.transaction(async (session) => {
      const organisation = await this.mongo.organisations.updateOne({ id: organisationId }, { $inc: { access_revision: 1 } }, { session });
      if (!organisation.matchedCount) throw new ConflictException('Organisation is unavailable');
      await this.access.requireAdmin(request, organisationId, session);
      if (siteId && !(await this.mongo.sites.findOne({ id: siteId, organisation_id: organisationId }, { session }))) {
        throw new BadRequestException('Site is unavailable');
      }
      if (brandIds !== null) await this.access.validateBrandScope(organisationId, siteId, requestedRoles, brandIds, session);

      const userRecord: DbUser = {
        _id: userId,
        id: userId,
        email: identity.email,
        full_name: identity.fullName,
        password_hash: hash,
        password_salt: salt,
        email_confirmed_at: now,
        created_at: now,
        updated_at: now,
      };
      await this.mongo.users.insertOne(userRecord, { session });

      const memberships: Membership[] = [];
      for (const role of requestedRoles) {
        const id = randomUUID();
        const membership: Membership = {
          _id: id,
          id,
          organisation_id: organisationId,
          site_id: siteId,
          user_id: userId,
          role,
          status: 'active',
          extra_permissions: [],
          brand_ids: brandIds,
          created_at: now,
        };
        await this.mongo.memberships.insertOne(membership, { session });
        memberships.push(membership);
      }
      await this.audit.record(session, request.user!.id, organisationId, siteId, 'staff.user_created', 'user', userId, {
        roles: requestedRoles,
        membership_ids: memberships.map((item) => item.id),
      });

      return {
        user: { id: userId, email: identity.email, fullName: identity.fullName },
        memberships: memberships.map(publicRecord),
      };
    });
  }
}
