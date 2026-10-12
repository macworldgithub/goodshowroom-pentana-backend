import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { IntegrationService } from '../src/integration/integration.service.js';
import { AccessService } from '../src/auth/access.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { SupabaseAuthGuard } from '../src/auth/supabase-auth.guard.js';
import { createAdminSupabaseClient } from '../src/auth/user-supabase.js';

vi.mock('../src/auth/user-supabase.js', () => ({ createAdminSupabaseClient: vi.fn() }));

// Uses a real temporary replica set. Supabase identity verification is covered separately.
describe('CRM access and transactions against MongoDB', () => {
  let replica: MongoMemoryReplSet;
  let app: INestApplication;
  let mongo: MongoService;
  const identities: Record<string, { id: string; email: string; email_confirmed_at: string }> = {
    admin: { id: randomUUID(), email: 'admin@example.test', email_confirmed_at: '2026-01-01' },
    sales: { id: randomUUID(), email: 'sales@example.test', email_confirmed_at: '2026-01-01' },
    service: { id: randomUUID(), email: 'service@example.test', email_confirmed_at: '2026-01-01' },
    stranger: { id: randomUUID(), email: 'stranger@example.test', email_confirmed_at: '2026-01-01' },
    direct: { id: randomUUID(), email: 'direct@example.test', email_confirmed_at: '2026-01-01' },
  };
  const createdEmails = new Set<string>();
  const createUser = vi.fn(async ({ email }: { email: string }) => {
    if (createdEmails.has(email)) return { data: { user: null }, error: { code: 'email_exists', status: 422 } };
    createdEmails.add(email);
    return { data: { user: Object.values(identities).find(user => user.email === email) ?? { id: randomUUID(), email } }, error: null };
  });
  const api = (identity = 'admin') => ({
    get: (path: string) => request(app.getHttpServer()).get(`/api/${path}`).set('Authorization', `Bearer ${identity}`),
    post: (path: string, body: object = {}) => request(app.getHttpServer()).post(`/api/${path}`).set('Authorization', `Bearer ${identity}`).send(body),
    patch: (path: string, body: object = {}) => request(app.getHttpServer()).patch(`/api/${path}`).set('Authorization', `Bearer ${identity}`).send(body),
  });
  const createCustomer = async (identity: string, body: object) => {
    const queued = await request(app.getHttpServer()).post('/api/customers').set('Authorization', 'Bearer ' + identity).set('Idempotency-Key', randomUUID()).send(body).expect(202);
    const result = await app.get(IntegrationService).processOne(queued.body.command.id);
    expect(result!.command.status).toBe('succeeded');
    return { body: result! };
  };
  let organisationId: string;
  let siteId: string;

  beforeAll(async () => {
    vi.mocked(createAdminSupabaseClient).mockReturnValue({ auth: { admin: { createUser } } } as unknown as ReturnType<typeof createAdminSupabaseClient>);
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    vi.stubEnv('MONGODB_URI', replica.getUri());
    vi.stubEnv('MONGODB_DATABASE', 'crm_test');
    vi.stubEnv('INTEGRATION_MODE', 'simulated');
    vi.stubEnv('ALLOW_SIMULATED_INTEGRATION', 'true');
    vi.stubEnv('INTEGRATION_WORKER_ENABLED', 'false');
    vi.stubEnv('INITIAL_SETUP_KEY', 'test-only-setup-secret');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(SupabaseAuthGuard).useValue({ canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest();
        const key = req.headers.authorization?.replace('Bearer ', '') as keyof typeof identities;
        req.user = identities[key];
        req.accessToken = 'test-verified-token';
        return Boolean(req.user);
      } }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    mongo = app.get(MongoService);
  });

  afterAll(async () => { await app?.close(); await replica?.stop(); vi.unstubAllEnvs(); });

  it('creates the initial account only with the setup key and binds setup to that account', async () => {
    const body = { email: identities.admin.email, password: 'Test Password 123!', fullName: 'Initial Admin', setupKey: 'test-only-setup-secret' };
    await request(app.getHttpServer()).post('/api/auth/initial-user').send({ ...body, setupKey: 'wrong' }).expect(401);
    expect(createUser).not.toHaveBeenCalled();
    const created = await request(app.getHttpServer()).post('/api/auth/initial-user').send(body).expect(201);
    expect(created.body.user.id).toBe(identities.admin.id);
    expect(await mongo.memberships.countDocuments()).toBe(0);
    expect(await mongo.users.findOne({ _id: identities.admin.id })).not.toHaveProperty('password');
    await api('stranger').post('setup', { organisationName: 'Wrong Dealer', siteName: 'Wrong Site', setupKey: 'test-only-setup-secret' }).expect(401);
    const repeated = await request(app.getHttpServer()).post('/api/auth/initial-user').send(body).expect(201);
    expect(repeated.body.created).toBe(false);
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it('bootstraps exactly one organisation under concurrent requests', async () => {
    const body = { organisationName: 'Pilot Dealer', siteName: 'Pilot Site', setupKey: 'test-only-setup-secret' };
    const results = await Promise.all([api().post('setup', body), api().post('setup', body)]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    const accepted = results.find(result => result.status === 201)!;
    organisationId = accepted.body.setup.organisation_id;
    siteId = accepted.body.setup.site_id;
    expect(await mongo.organisations.countDocuments()).toBe(1);
    expect(await mongo.auditEvents.countDocuments({ action: 'organisation.bootstrapped' })).toBe(1);
    const context = await api().get('auth/me').expect(200);
    expect(context.body.sites[0].roles).toEqual(['ADMIN']);
    expect(context.body.needsInitialSetup).toBe(false);
    expect(context.body.memberships[0]).not.toHaveProperty('_id');
  });

  it('does not suspend the last administrator', async () => {
    const membership = await mongo.memberships.findOne({ user_id: identities.admin.id });
    await api().patch(`admin/memberships/${membership!.id}`, { organisationId, status: 'suspended' }).expect(409);
    expect((await mongo.memberships.findOne({ id: membership!.id }))!.status).toBe('active');
  });

  it('disables initial account creation after setup', async () => {
    await request(app.getHttpServer()).post('/api/auth/initial-user').send({ email: 'another@example.test', password: 'Test Password 123!', setupKey: 'test-only-setup-secret' }).expect(409);
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it('creates staff directly with auditable memberships and rejects duplicate identities', async () => {
    const body = { organisationId, siteId, email: identities.direct.email, password: 'Direct Password 123!', fullName: 'Direct Staff', roles: ['SALES', 'SERVICE'] };
    await api('stranger').post('admin/users', body).expect(403);
    expect(createUser).toHaveBeenCalledTimes(1);
    const created = await api().post('admin/users', body).expect(201);
    expect(created.body.memberships.map((item: { role: string }) => item.role)).toEqual(['SALES', 'SERVICE']);
    expect(await mongo.auditEvents.countDocuments({ action: 'staff.user_created', entity_id: identities.direct.id })).toBe(1);
    await api('direct').get(`customers?siteId=${siteId}`).expect(200);
    await api('direct').get(`admin/memberships?organisationId=${organisationId}`).expect(403);
    await api().post('admin/users', body).expect(409);
    expect(await mongo.memberships.countDocuments({ user_id: identities.direct.id })).toBe(2);
    const records = await mongo.users.findOne({ _id: identities.direct.id });
    expect(records).not.toHaveProperty('password');
  });

  it('accepts only the invited confirmed email and only once', async () => {
    const created = await api().post('admin/invitations', { organisationId, siteId, email: identities.sales.email, roles: ['SALES'] }).expect(201);
    const id = created.body.invitation.id;
    await api('stranger').post(`auth/invitations/${id}/accept`).expect(400);
    const mine = await api('sales').get('auth/invitations').expect(200);
    expect(mine.body.invitations.map((item: { id: string }) => item.id)).toContain(id);
    await api('sales').post(`auth/invitations/${id}/accept`).expect(201);
    await api('sales').post(`auth/invitations/${id}/accept`).expect(400);
    expect(await mongo.memberships.countDocuments({ user_id: identities.sales.id })).toBe(1);
    expect(await mongo.auditEvents.countDocuments({ action: 'staff.invitation_accepted' })).toBe(1);
  });

  it('denies staff administration and cross-site customer access', async () => {
    await api('sales').get(`admin/memberships?organisationId=${organisationId}`).expect(403);
    const otherSite = randomUUID();
    await mongo.sites.insertOne({ _id: otherSite, id: otherSite, organisation_id: organisationId, name: 'Other Site', timezone: 'Australia/Sydney', created_at: new Date().toISOString() });
    await api('sales').get(`customers?siteId=${otherSite}`).expect(403);
    await api('stranger').get(`customers?siteId=${siteId}`).expect(403);
  });

  it('rejects arbitrary permission escalation and a site-specific ADMIN invitation', async () => {
    const membership = await mongo.memberships.findOne({ user_id: identities.sales.id });
    await api().patch(`admin/memberships/${membership!.id}`, { organisationId, extraPermissions: ['users.manage'] }).expect(400);
    await api().post('admin/invitations', { organisationId, siteId, email: 'bad@example.test', roles: ['ADMIN'] }).expect(400);
  });

  it('keeps customer and task mutations auditable and tasks assigned-user scoped', async () => {
    const customer = await createCustomer('sales', { siteId, firstName: 'Sam', lastName: 'Customer', phone: '0400000000' });
    const task = await api('sales').post('tasks', { siteId, customerId: customer.body.customer.id, title: 'Call customer', dueAt: '2026-01-01T09:00:00Z' }).expect(201);
    const ownTasks = await api('sales').get(`tasks?siteId=${siteId}&through=2027-01-01`).expect(200);
    expect(ownTasks.body.tasks[0].customers.first_name).toBe('Sam');
    const invited = await api().post('admin/invitations', { organisationId, siteId, email: identities.service.email, roles: ['SERVICE'] }).expect(201);
    await api('service').post(`auth/invitations/${invited.body.invitation.id}/accept`).expect(201);
    const serviceTasks = await api('service').get(`tasks?siteId=${siteId}&through=2027-01-01`).expect(200);
    expect(serviceTasks.body.tasks).toEqual([]);
    await api('service').patch(`tasks/${task.body.task.id}/complete?siteId=${siteId}`).expect(400);
    const crossSite = randomUUID();
    await api('sales').post('tasks', { siteId: crossSite, customerId: customer.body.customer.id, title: 'Wrong site', dueAt: '2026-01-01' }).expect(403);
    await api('sales').patch(`tasks/${task.body.task.id}/complete?siteId=${siteId}`).expect(200);
    await api('sales').patch(`tasks/${task.body.task.id}/complete?siteId=${siteId}`).expect(400);
    expect(await mongo.auditEvents.countDocuments({ entity_id: task.body.task.id })).toBe(2);
    const audits = await api().get(`admin/audit?organisationId=${organisationId}`).expect(200);
    expect(audits.body.events.length).toBeGreaterThan(0);
    await api('sales').get(`admin/audit?organisationId=${organisationId}`).expect(403);
  });

  it('blocks expired and revoked invitations without granting access', async () => {
    const expired = await api().post('admin/invitations', { organisationId, siteId, email: identities.stranger.email, roles: ['SALES'] }).expect(201);
    await mongo.invitations.updateOne({ id: expired.body.invitation.id }, { $set: { expires_at: '2020-01-01T00:00:00.000Z' } });
    await api('stranger').post(`auth/invitations/${expired.body.invitation.id}/accept`).expect(400);
    const replacement = await api().post('admin/invitations', { organisationId, siteId, email: identities.stranger.email, roles: ['SALES'] }).expect(201);
    await api().post(`admin/invitations/${replacement.body.invitation.id}/revoke`, { organisationId }).expect(201);
    await api('stranger').post(`auth/invitations/${replacement.body.invitation.id}/accept`).expect(400);
    expect(await mongo.memberships.countDocuments({ user_id: identities.stranger.id })).toBe(0);
  });

  it('lets only ADMIN manage sites and brands, and validates site mappings', async () => {
    await api('sales').post('admin/brands', { organisationId, name: 'Forbidden Brand' }).expect(403);
    await api('sales').post('admin/sites', { organisationId, name: 'Forbidden Site' }).expect(403);
    const brand = await api().post('admin/brands', { organisationId, name: 'Pilot Brand' }).expect(201);
    const brandId = brand.body.brand.id;
    await api().post('admin/brands', { organisationId, name: 'Pilot Brand' }).expect(409);
    const site = await api().post('admin/sites', { organisationId, name: 'Managed Site', brandIds: [brandId], timezone: 'Australia/Perth' }).expect(201);
    const managedId = site.body.site.id;
    await api().post('admin/sites', { organisationId, name: 'Managed Site' }).expect(409);
    await api().post('admin/sites', { organisationId, name: 'Invalid Zone', timezone: 'Not/AZone' }).expect(400);
    await api().post('admin/sites', { organisationId, name: 'Invalid Brand', brandIds: [randomUUID()] }).expect(400);
    await api().patch(`admin/sites/${managedId}`, { organisationId, name: 'Managed Site Renamed' }).expect(200);
    await api().patch(`admin/brands/${brandId}`, { organisationId, name: 'Pilot Brand Renamed' }).expect(200);
    const otherOrg = randomUUID();
    await mongo.organisations.insertOne({ _id: otherOrg, id: otherOrg, name: 'Other Dealer Fixture', access_revision: 0, created_at: new Date().toISOString() });
    const foreignBrand = randomUUID();
    await mongo.brands.insertOne({ _id: foreignBrand, id: foreignBrand, organisation_id: otherOrg, name: 'Foreign Brand', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    await api().patch(`admin/sites/${managedId}`, { organisationId, brandIds: [foreignBrand] }).expect(400);
    await api().patch(`admin/brands/${foreignBrand}`, { organisationId, name: 'Cross-org Edit' }).expect(404);
    await api('sales').get(`sites/${managedId}/brands`).expect(403);
    const available = await api().get(`sites/${managedId}/brands`).expect(200);
    expect(available.body.brands.map((b: { id: string }) => b.id)).toEqual([brandId]);
    expect(await mongo.auditEvents.countDocuments({ entity_id: managedId })).toBe(2);
    expect(await mongo.auditEvents.countDocuments({ entity_id: brandId })).toBe(2);
  });

  it('applies brand restrictions to each role without combining permissions across brands', async () => {
    const a = await api().post('admin/brands', { organisationId, name: 'Brand A' }).expect(201);
    const b = await api().post('admin/brands', { organisationId, name: 'Brand B' }).expect(201);
    const brandA = a.body.brand.id;
    const brandB = b.body.brand.id;
    await api().patch(`admin/sites/${siteId}`, { organisationId, brandIds: [brandA, brandB] }).expect(200);
    const sales = await mongo.memberships.findOne({ user_id: identities.direct.id, role: 'SALES' });
    const service = await mongo.memberships.findOne({ user_id: identities.direct.id, role: 'SERVICE' });
    await api().patch(`admin/memberships/${sales!.id}`, { organisationId, brandIds: [brandA] }).expect(200);
    await api().patch(`admin/memberships/${service!.id}`, { organisationId, brandIds: [brandB] }).expect(200);
    const access = app.get(AccessService);
    const directRequest = { user: identities.direct } as unknown as import('../src/auth/authenticated-request.js').AuthenticatedRequest;
    await expect(access.requireBrand(directRequest, siteId, brandA, 'sales.write')).resolves.toBeDefined();
    await expect(access.requireBrand(directRequest, siteId, brandA, 'service.write')).rejects.toThrow();
    await expect(access.requireBrand(directRequest, siteId, brandB, 'sales.write')).rejects.toThrow();
    const context = await api('direct').get('auth/me').expect(200);
    const brands = context.body.sites.find((site: { id: string }) => site.id === siteId).brands;
    expect(brands.find((brand: { id: string }) => brand.id === brandA).permissions).toContain('sales.write');
    expect(brands.find((brand: { id: string }) => brand.id === brandA).permissions).not.toContain('service.write');
    expect(brands.find((brand: { id: string }) => brand.id === brandB).permissions).toContain('service.write');
    expect(brands.find((brand: { id: string }) => brand.id === brandB).permissions).not.toContain('sales.write');
    await api().patch(`admin/memberships/${service!.id}`, { organisationId, status: 'suspended' }).expect(200);
    await api('direct').get(`sites/${siteId}/brands/${brandB}`).expect(403);
    const list = await api('direct').get(`sites/${siteId}/brands`).expect(200);
    expect(list.body.brands.map((brand: { id: string }) => brand.id)).toEqual([brandA]);
    await api('direct').get(`customers?siteId=${siteId}`).expect(200);
    await api().patch(`admin/sites/${siteId}`, { organisationId, brandIds: [brandB] }).expect(200);
    await api('direct').get(`sites/${siteId}/brands/${brandA}`).expect(403);
    const admin = await api().get(`sites/${siteId}/brands`).expect(200);
    expect(admin.body.brands.map((brand: { id: string }) => brand.id)).toEqual([brandB]);
    await api().patch(`admin/sites/${siteId}`, { organisationId, brandIds: [brandA, brandB] }).expect(200);
  });

  it('validates restricted grants before external identity creation and during invitation acceptance', async () => {
    const brand = await mongo.brands.findOne({ organisation_id: organisationId, name: 'Brand A' });
    const brandId = brand!.id;
    const calls = createUser.mock.calls.length;
    await api().post('admin/users', { organisationId, siteId, brandIds: [randomUUID()], email: 'invalid-brand@example.test', password: 'Test Password 123!', roles: ['SALES'] }).expect(400);
    await api().post('admin/users', { organisationId, brandIds: [brandId], email: 'invalid-admin@example.test', password: 'Test Password 123!', roles: ['ADMIN'] }).expect(400);
    expect(createUser).toHaveBeenCalledTimes(calls);
    const account = await api().post('admin/users', { organisationId, siteId, brandIds: [brandId], email: 'brand-staff@example.test', password: 'Test Password 123!', roles: ['SALES'] }).expect(201);
    expect(account.body.memberships[0].brand_ids).toEqual([brandId]);
    const invite = await api().post('admin/invitations', { organisationId, siteId, brandIds: [brandId], email: identities.stranger.email, roles: ['SALES'] }).expect(201);
    await api().patch(`admin/sites/${siteId}`, { organisationId, brandIds: [] }).expect(200);
    await api('stranger').post(`auth/invitations/${invite.body.invitation.id}/accept`).expect(400);
    expect((await mongo.invitations.findOne({ id: invite.body.invitation.id }))!.status).toBe('pending');
    expect(await mongo.memberships.countDocuments({ user_id: identities.stranger.id })).toBe(0);
    await api().patch(`admin/sites/${siteId}`, { organisationId, brandIds: [brandId] }).expect(200);
    await api('stranger').post(`auth/invitations/${invite.body.invitation.id}/accept`).expect(201);
    expect((await mongo.memberships.findOne({ user_id: identities.stranger.id }))!.brand_ids).toEqual([brandId]);
    await api().post('admin/invitations', { organisationId, siteId, brandIds: [randomUUID()], email: 'wrong-brand@example.test', roles: ['SERVICE'] }).expect(400);
    await api().patch(`admin/memberships/${account.body.memberships[0].id}`, { organisationId, brandIds: [randomUUID()] }).expect(400);
    // Release the fixture identity for the existing final administrator invitation test.
    await mongo.memberships.deleteMany({ user_id: identities.stranger.id });
  });

  it('rejects unscoped grants and rolls back legacy invitation acceptance', async () => {
    for (const role of ['SALES', 'SERVICE']) {
      await api().post('admin/users', { organisationId, email: 'unscoped@example.test', password: 'Test Password 123!', roles: [role] }).expect(400);
      await api().post('admin/invitations', { organisationId, email: 'unscoped@example.test', roles: [role] }).expect(400);
    }
    const invitationId = randomUUID();
    await mongo.invitations.insertOne({ _id: invitationId, id: invitationId, organisation_id: organisationId, site_id: null, email: identities.stranger.email, roles: ['SALES'], status: 'pending', delivery_status: 'not_sent', invited_by: identities.admin.id, expires_at: '2099-01-01T00:00:00.000Z', created_at: new Date().toISOString() });
    await api('stranger').post(`auth/invitations/${invitationId}/accept`).expect(400);
    expect((await mongo.invitations.findOne({ id: invitationId }))!.status).toBe('pending');
    await api().post(`admin/invitations/${invitationId}/revoke`, { organisationId }).expect(201);
  });

  it('denies legacy unscoped access until an administrator explicitly assigns a site', async () => {
    const membershipId = randomUUID();
    await mongo.memberships.insertOne({ _id: membershipId, id: membershipId, organisation_id: organisationId, site_id: null, user_id: identities.stranger.id, role: 'SALES', status: 'active', extra_permissions: [], created_at: new Date().toISOString() });
    await api('stranger').get(`customers?siteId=${siteId}`).expect(403);
    const legacy = await api('stranger').get('auth/me').expect(200);
    expect(legacy.body.sites).toEqual([]);
    expect(legacy.body.memberships[0].site_id).toBeNull();
    await api().patch(`admin/memberships/${membershipId}`, { organisationId, status: 'active' }).expect(400);
    await api().patch(`admin/memberships/${membershipId}`, { organisationId, siteId }).expect(200);
    await api('stranger').get(`customers?siteId=${siteId}`).expect(200);
    const second = await mongo.sites.findOne({ organisation_id: organisationId, name: 'Managed Site Renamed' });
    await api().patch(`admin/memberships/${membershipId}`, { organisationId, siteId: second!.id }).expect(200);
    await api('stranger').get(`customers?siteId=${siteId}`).expect(403);
    await api('stranger').get(`customers?siteId=${second!.id}`).expect(200);
    await mongo.memberships.deleteOne({ id: membershipId });
  });

  it('does not widen an existing brand-restricted membership through invitation acceptance', async () => {
    const brand = await mongo.brands.findOne({ organisation_id: organisationId, name: 'Brand A' });
    const member = await mongo.memberships.findOne({ user_id: identities.sales.id, role: 'SALES' });
    await api().patch(`admin/memberships/${member!.id}`, { organisationId, brandIds: [brand!.id] }).expect(200);
    const invitation = await api().post('admin/invitations', { organisationId, siteId, email: identities.sales.email, roles: ['SALES'] }).expect(201);
    await api('sales').post(`auth/invitations/${invitation.body.invitation.id}/accept`).expect(201);
    expect((await mongo.memberships.findOne({ id: member!.id }))!.brand_ids).toEqual([brand!.id]);
    await api().patch(`admin/memberships/${member!.id}`, { organisationId, brandIds: null }).expect(200);
  });

  it('paginates site-scoped and administrator lists with validated bounds', async () => {
    const first = await api().get(`admin/sites?organisationId=${organisationId}&limit=1`).expect(200);
    expect(first.body.sites).toHaveLength(1);
    expect(first.body.pagination).toEqual({ offset: 0, limit: 1, hasMore: true, nextOffset: 1 });
    const second = await api().get(`admin/sites?organisationId=${organisationId}&limit=1&offset=1`).expect(200);
    expect(second.body.sites[0].id).not.toBe(first.body.sites[0].id);
    const empty = await api().get(`admin/sites?organisationId=${organisationId}&offset=1000000`).expect(200);
    expect(empty.body.sites).toEqual([]);
    expect(empty.body.pagination.nextOffset).toBeNull();
    await api('sales').get(`customers?siteId=${siteId}&limit=0`).expect(400);
    await api('sales').get(`tasks?siteId=${siteId}&offset=-1`).expect(400);
    await api().get(`admin/memberships?organisationId=${organisationId}&limit=101`).expect(400);
    await api().get(`admin/brands?organisationId=${organisationId}&offset=1.5`).expect(400);
    const memberships = await api().get(`admin/memberships?organisationId=${organisationId}&limit=1`).expect(200);
    expect(memberships.body.memberships).toHaveLength(1);
    expect(memberships.body.pagination.hasMore).toBe(true);
    const customer = await createCustomer('sales', { siteId, firstName: 'Second', lastName: 'Page', phone: '0400000001' });
    await api('sales').post('tasks', { siteId, customerId: customer.body.customer.id, title: 'Second page task', dueAt: '2026-01-01' }).expect(201);
    const customers = await api('sales').get(`customers?siteId=${siteId}&limit=1`).expect(200);
    expect(customers.body.customers).toHaveLength(1);
    expect(customers.body.pagination.hasMore).toBe(true);
    const tasks = await api('sales').get(`tasks?siteId=${siteId}&limit=1&through=2027-01-01`).expect(200);
    expect(tasks.body.tasks).toHaveLength(1);
    expect(tasks.body.pagination.hasMore).toBe(true);
  });

  it('blocks the same authenticated user immediately after suspension', async () => {
    const membership = await mongo.memberships.findOne({ user_id: identities.sales.id });
    await api().patch(`admin/memberships/${membership!.id}`, { organisationId, status: 'suspended' }).expect(200);
    await api('sales').get(`customers?siteId=${siteId}`).expect(403);
    const context = await api('sales').get('auth/me').expect(200);
    expect(context.body.sites).toEqual([]);
    const invite = await api().post('admin/invitations', { organisationId, siteId, email: identities.sales.email, roles: ['SERVICE'] }).expect(201);
    await api('sales').post(`auth/invitations/${invite.body.invitation.id}/accept`).expect(409);
    expect((await mongo.invitations.findOne({ id: invite.body.invitation.id }))!.status).toBe('pending');
  });

  it('protects the last administrator during simultaneous self-suspensions', async () => {
    const invite = await api().post('admin/invitations', { organisationId, email: identities.stranger.email, roles: ['ADMIN'] }).expect(201);
    await api('stranger').post(`auth/invitations/${invite.body.invitation.id}/accept`).expect(201);
    const first = await mongo.memberships.findOne({ user_id: identities.admin.id, role: 'ADMIN' });
    const second = await mongo.memberships.findOne({ user_id: identities.stranger.id, role: 'ADMIN' });
    const results = await Promise.all([
      api().patch(`admin/memberships/${first!.id}`, { organisationId, status: 'suspended' }),
      api('stranger').patch(`admin/memberships/${second!.id}`, { organisationId, status: 'suspended' }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(await mongo.memberships.countDocuments({ organisation_id: organisationId, role: 'ADMIN', status: 'active' })).toBe(1);
  });
});
