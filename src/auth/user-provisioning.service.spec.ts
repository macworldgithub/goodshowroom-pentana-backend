import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { UserProvisioningService } from './user-provisioning.service.js';
import { createAdminSupabaseClient } from './user-supabase.js';
import type { MongoService } from '../database/mongo.service.js';
import type { AuditService } from '../database/audit.service.js';
import type { AccessService } from './access.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';

vi.mock('./user-supabase.js', () => ({ createAdminSupabaseClient: vi.fn() }));
const organisationId = '00000000-0000-0000-0000-000000000001';
const siteId = '00000000-0000-0000-0000-000000000002';
const userId = '00000000-0000-0000-0000-000000000003';
const identity = { email: 'staff@example.test', password: 'Strong Password With Spaces 123!', fullName: 'Test Staff' };
const request = { user: { id: 'admin' } } as unknown as AuthenticatedRequest;

describe('Direct account provisioning', () => {
  let service: UserProvisioningService;
  let createUser: ReturnType<typeof vi.fn>;
  let mongo: {
    transaction: ReturnType<typeof vi.fn>;
    organisations: { findOne: ReturnType<typeof vi.fn>; updateOne: ReturnType<typeof vi.fn> };
    systemState: { findOne: ReturnType<typeof vi.fn>; insertOne: ReturnType<typeof vi.fn>; updateOne: ReturnType<typeof vi.fn> };
    sites: { findOne: ReturnType<typeof vi.fn> };
    memberships: { insertOne: ReturnType<typeof vi.fn> };
    users: { updateOne: ReturnType<typeof vi.fn> };
  };
  let access: { requireAdmin: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.stubEnv('INITIAL_SETUP_KEY', 'test-only-initial-secret');
    createUser = vi.fn().mockResolvedValue({ data: { user: { id: userId } }, error: null });
    vi.mocked(createAdminSupabaseClient).mockReturnValue({ auth: { admin: { createUser } } } as unknown as ReturnType<typeof createAdminSupabaseClient>);
    mongo = {
      transaction: vi.fn(async operation => operation({})),
      organisations: { findOne: vi.fn().mockResolvedValue(null), updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }) },
      systemState: { findOne: vi.fn().mockResolvedValue(null), insertOne: vi.fn(), updateOne: vi.fn() },
      sites: { findOne: vi.fn().mockResolvedValue({ id: siteId, organisation_id: organisationId }) },
      memberships: { insertOne: vi.fn() }, users: { updateOne: vi.fn() },
    };
    access = { requireAdmin: vi.fn() };
    audit = { record: vi.fn() };
    service = new UserProvisioningService(mongo as unknown as MongoService, access as unknown as AccessService, audit as unknown as AuditService);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it('rejects an invalid setup key without creating an identity', async () => {
    await expect(service.initial({ ...identity, setupKey: 'wrong' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('disables initial-user creation after dealership setup', async () => {
    mongo.organisations.findOne.mockResolvedValue({ id: organisationId });
    await expect(service.initial({ ...identity, setupKey: 'test-only-initial-secret' })).rejects.toBeInstanceOf(ConflictException);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('stores only an identity/profile initially, without granting roles before setup', async () => {
    const result = await service.initial({ ...identity, setupKey: 'test-only-initial-secret' });
    expect(result.user.id).toBe(userId);
    expect(createUser).toHaveBeenCalledWith({ email: identity.email, password: identity.password, email_confirm: true, user_metadata: { full_name: identity.fullName } });
    expect(mongo.memberships.insertOne).not.toHaveBeenCalled();
    expect(JSON.stringify(mongo.users.updateOne.mock.calls)).not.toContain(identity.password);
    expect(JSON.stringify(result)).not.toContain(identity.password);
  });

  it('does not provision a user for a non-admin caller', async () => {
    access.requireAdmin.mockRejectedValue(new ForbiddenException());
    await expect(service.staff(request, { ...identity, organisationId, siteId, roles: ['SALES'] })).rejects.toBeInstanceOf(ForbiddenException);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('rejects a wrong site and a site-scoped ADMIN before creating an account', async () => {
    mongo.sites.findOne.mockResolvedValue(null);
    await expect(service.staff(request, { ...identity, organisationId, siteId, roles: ['SALES'] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.staff(request, { ...identity, organisationId, siteId, roles: ['ADMIN'] })).rejects.toBeInstanceOf(BadRequestException);
    expect(createUser).not.toHaveBeenCalled();
  });

  it.each(['SALES', 'SERVICE'])('rejects omitted and null site for %s before creating an identity', async role => {
    for (const scope of [undefined, null]) {
      await expect(service.staff(request, { ...identity, organisationId, siteId: scope, roles: [role] })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(createUser).not.toHaveBeenCalled();
  });

  it('creates one identity with multiple scoped memberships and an audit event', async () => {
    const result = await service.staff(request, { ...identity, organisationId, siteId, roles: ['SALES', 'SERVICE'] });
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(result.memberships.map(item => item.role)).toEqual(['SALES', 'SERVICE']);
    expect(result.memberships.every(item => item.site_id === siteId && item.status === 'active')).toBe(true);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(identity.password);
    expect(result).not.toHaveProperty('password');
  });

  it.each(['ADMIN', 'SALES', 'SERVICE'])('allows an administrator to create an active %s user with the correct scope', async role => {
    const scope = role === 'ADMIN' ? null : siteId;
    const result = await service.staff(request, { ...identity, organisationId, siteId: scope, roles: [role] });
    expect(result.memberships).toHaveLength(1);
    expect(result.memberships[0]).toMatchObject({ organisation_id: organisationId, site_id: scope, role, status: 'active', user_id: userId });
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(access.requireAdmin).toHaveBeenCalledTimes(2);
  });

  it('reports an existing account without resetting its password or granting access', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', status: 422 } });
    await expect(service.staff(request, { ...identity, organisationId, siteId, roles: ['SALES'] })).rejects.toBeInstanceOf(ConflictException);
    expect(mongo.memberships.insertOne).not.toHaveBeenCalled();
  });

  it('reports partial provisioning and never deletes the external identity', async () => {
    mongo.transaction.mockRejectedValue(new Error('Database unavailable'));
    const error = await service.staff(request, { ...identity, organisationId, siteId, roles: ['SALES'] }).catch(error => error);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse()).toMatchObject({ code: 'USER_PROVISIONING_INCOMPLETE', userId });
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it.each(['short', null, 12345])('rejects an invalid password before contacting Supabase', async password => {
    await expect(service.staff(request, { ...identity, password, organisationId, siteId, roles: ['SALES'] })).rejects.toBeInstanceOf(BadRequestException);
    expect(createUser).not.toHaveBeenCalled();
  });
});
