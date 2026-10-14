import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { IntegrationService } from '../src/integration/integration.service.js';
import { ReservationsService } from '../src/crm/reservations.service.js';
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

  it('creates idempotent site-scoped enquiries and linked My Day tasks, with owner/version protection', async () => {
    const customer = await createCustomer('sales', { siteId, firstName: 'Lead', lastName: 'Customer', email: 'lead@example.test' });
    const body = { siteId, customerId: customer.body.customer!.id, title: 'SUV enquiry', source: 'Website', vehicleInterest: 'Family SUV', followUpAt: '2026-01-01T10:00:00Z' };
    const key = randomUUID();
    const submit = (payload: object = body) => api('sales').post('sales/leads', payload).set('Idempotency-Key', key);
    const created = await submit().expect(201); const lead = created.body.lead;
    expect(lead).not.toHaveProperty('create_hash'); expect(lead).not.toHaveProperty('create_key');
    const repeated = await submit().expect(201); expect(repeated.body.lead.id).toBe(lead.id);
    expect(await mongo.tasks.countDocuments({ id: lead.follow_up_task_id })).toBe(1);
    await submit({ ...body, title: 'Changed' }).expect(409);
    await api('service').get(`sales/leads?siteId=${siteId}`).expect(403);
    await api('service').post('sales/leads', body).set('Idempotency-Key', randomUUID()).expect(403);
    await api('sales').get(`sales/leads/${lead.id}?siteId=${randomUUID()}`).expect(403);
    await api('sales').patch(`sales/leads/${lead.id}`, { siteId, version: 0, status: 'qualified' }).expect(200);
    await api('sales').patch(`sales/leads/${lead.id}`, { siteId, version: 0, status: 'closed' }).expect(409);
    await api('sales').patch(`sales/leads/${lead.id}`, { siteId, version: 1, assignedTo: identities.service.id }).expect(403);
    await api().patch(`sales/leads/${lead.id}`, { siteId, version: 1, assignedTo: identities.service.id }).expect(400);
    await api('sales').post('sales/leads', { ...body, customerId: randomUUID() }).set('Idempotency-Key', randomUUID()).expect(400);
    await api().patch(`sales/leads/${lead.id}`, { siteId, version: 1, assignedTo: identities.admin.id }).expect(200);
    await api('sales').get(`sales/leads/${lead.id}?siteId=${siteId}`).expect(404);
    const own = await api('sales').get(`sales/leads?siteId=${siteId}`).expect(200);
    expect(own.body.leads.some((item: { id: string }) => item.id === lead.id)).toBe(false);
    const team = await api().get(`sales/leads?siteId=${siteId}&limit=1`).expect(200);
    expect(team.body.visibility).toBe('team');
    const task = await mongo.tasks.findOne({ id: lead.follow_up_task_id }); expect(task!.assigned_to).toBe(identities.sales.id);
    const day = await api('sales').get(`my-day?siteId=${siteId}`).expect(200);
    expect(day.body.items.some((item: { id: string }) => item.id === task!.id)).toBe(true);
    expect(await mongo.auditEvents.countDocuments({ entity_id: lead.id })).toBe(3);
  });

  it('tracks pipeline moves, outcomes, reopening and paginated author history without leaking team enquiries', async () => {
    const customer = await createCustomer('sales', { siteId, firstName: 'Pipeline', lastName: 'Customer', phone: '0400000055' });
    const created = await api('sales').post('sales/leads', { siteId, customerId: customer.body.customer!.id, title: 'Pipeline test drive', source: 'Referral' }).set('Idempotency-Key', randomUUID()).expect(201);
    const id = created.body.lead.id;
    await api('service').get(`sales/pipeline?siteId=${siteId}`).expect(403);
    await api('service').patch(`sales/pipeline/${id}/stage`, { siteId, version: 0, stage: 'won', reason: 'Agreed' }).expect(403);
    await api('sales').patch(`sales/pipeline/${id}/stage`, { siteId, version: 0, stage: 'qualified', reason: '' }).expect(400);
    await api('sales').patch(`sales/pipeline/${id}/stage`, { siteId, version: 0, stage: 'fake', reason: 'Invalid stage' }).expect(400);
    const move = await api('sales').patch(`sales/pipeline/${id}/stage`, { siteId, version: 0, stage: 'test_drive', reason: 'Customer requested a test drive' }).expect(200);
    expect(move.body.lead.status).toBe('qualified'); expect(move.body.lead.pipeline_stage).toBe('test_drive');
    await api('sales').patch(`sales/pipeline/${id}/stage`, { siteId, version: 0, stage: 'won', reason: 'Old browser form' }).expect(409);
    // Editing an unchanged enquiry status must not silently reset its advanced stage.
    const edited = await api('sales').patch(`sales/leads/${id}`, { siteId, version: 1, status: 'qualified', title: 'Updated pipeline test drive' }).expect(200);
    expect(edited.body.lead.pipeline_stage).toBe('test_drive');
    const won = await api('sales').patch(`sales/pipeline/${id}/stage`, { siteId, version: 2, stage: 'won', reason: 'Customer selected vehicle' }).expect(200);
    expect(won.body.lead.status).toBe('closed');
    await api('sales').patch(`sales/pipeline/${id}/stage`, { siteId, version: 3, stage: 'contacted', reason: 'Customer reopened their enquiry' }).expect(200);
    const history = await api('sales').get(`sales/pipeline/${id}/history?siteId=${siteId}&limit=2`).expect(200);
    expect(history.body.history).toHaveLength(2); expect(history.body.pagination.hasMore).toBe(true);
    expect(history.body.history[0]).toMatchObject({ fromStage: 'won', toStage: 'contacted', reason: 'Customer reopened their enquiry', version: 4, author: { id: identities.sales.id } });
    expect(history.body.history[0]).not.toHaveProperty('metadata');
    const next = await api('sales').get(`sales/pipeline/${id}/history?siteId=${siteId}&offset=2&limit=2`).expect(200);
    expect(next.body.history[0].id).not.toBe(history.body.history[0].id);
    const filtered = await api('sales').get(`sales/pipeline?siteId=${siteId}&stage=contacted&search=Updated%20pipeline`).expect(200);
    expect(filtered.body.leads.map((lead: { id: string }) => lead.id)).toEqual([id]);
    expect(filtered.body.stages.find((stage: { id: string }) => stage.id === 'contacted').count).toBe(1);
    await api('sales').get(`sales/pipeline?siteId=${siteId}&stage=bad`).expect(400);
    await api().patch(`sales/leads/${id}`, { siteId, version: 4, assignedTo: identities.admin.id }).expect(200);
    await api('sales').get(`sales/pipeline/${id}/history?siteId=${siteId}`).expect(404);
    const own = await api('sales').get(`sales/pipeline?siteId=${siteId}&search=Updated%20pipeline`).expect(200);
    expect(own.body.leads).toEqual([]); expect(own.body.stages.every((stage: { count: number }) => stage.count === 0)).toBe(true);
    await api().get(`sales/pipeline/${id}/history?siteId=${siteId}`).expect(200);
    await api().get(`sales/pipeline/${id}/history?siteId=${randomUUID()}`).expect(403);
  });

  it('allows only one of two concurrent pipeline moves and rolls back the losing history entry', async () => {
    const customer = await createCustomer('sales', { siteId, firstName: 'Concurrent', lastName: 'Pipeline', phone: '0400000056' });
    const created = await api('sales').post('sales/leads', { siteId, customerId: customer.body.customer!.id, title: 'Concurrent outcome', source: 'Website' }).set('Idempotency-Key', randomUUID()).expect(201);
    const id = created.body.lead.id;
    const moves = await Promise.all(['won', 'lost'].map(stage => api('sales').patch(`sales/pipeline/${id}/stage`, { siteId, version: 0, stage, reason: 'Concurrent staff decision' })));
    expect(moves.map(result => result.status).sort()).toEqual([200, 409]);
    expect(await mongo.auditEvents.countDocuments({ entity_id: id, action: 'sales.stage_changed' })).toBe(1);
    const record = await mongo.salesLeads.findOne({ id }); expect(record!.version).toBe(1); expect(record!.status).toBe('closed');
  });

  it('maintains simulated stock and validates scoped matching, availability, versions and brand-safe history', async () => {
    const originalSite = await mongo.sites.findOne({ id: siteId });
    const originalMembership = await mongo.memberships.findOne({ user_id: identities.sales.id, role: 'SALES' });
    const first = await api().post('admin/brands', { organisationId, name: 'Stock Brand A' }).expect(201);
    const second = await api().post('admin/brands', { organisationId, name: 'Stock Brand B' }).expect(201);
    const brandId = first.body.brand.id; const otherBrand = second.body.brand.id;
    await api().patch(`admin/sites/${siteId}`, { organisationId, brandIds: [...(originalSite!.brand_ids ?? []), brandId, otherBrand] }).expect(200);
    await api().patch(`admin/memberships/${originalMembership!.id}`, { organisationId, brandIds: [brandId] }).expect(200);
    const body = { siteId, brandId, stockNumber: 'STOCK-001', make: 'Kia', model: 'Sportage', year: 2026, odometerKm: 100,
      bodyType: 'SUV', fuelType: 'Petrol', transmission: 'Automatic', priceCents: 3499000 };
    const key = randomUUID();
    const created = await api().post('sales/stock', body).set('Idempotency-Key', key).expect(201); const vehicle = created.body.vehicle;
    expect(vehicle.source).toBe('simulated'); expect(vehicle).not.toHaveProperty('create_hash');
    const replay = await api().post('sales/stock', body).set('Idempotency-Key', key).expect(201); expect(replay.body.vehicle.id).toBe(vehicle.id);
    await api().post('sales/stock', { ...body, priceCents: 100 }).set('Idempotency-Key', key).expect(409);
    await api().post('sales/stock', body).set('Idempotency-Key', randomUUID()).expect(409);
    await api('sales').post('sales/stock', { ...body, stockNumber: 'NOT-ALLOWED' }).set('Idempotency-Key', randomUUID()).expect(403);
    await api().post('sales/stock', { ...body, stockNumber: 'INVALID', priceCents: -1 }).set('Idempotency-Key', randomUUID()).expect(400);
    const hidden = await api().post('sales/stock', { ...body, brandId: otherBrand, stockNumber: 'HIDDEN' }).set('Idempotency-Key', randomUUID()).expect(201);
    const list = await api('sales').get(`sales/stock?siteId=${siteId}&maxPriceCents=3500000&bodyType=suv`).expect(200);
    expect(list.body.vehicles.map((row: { id: string }) => row.id)).toEqual([vehicle.id]);
    expect((await api('sales').get(`sales/stock?siteId=${siteId}&maxPriceCents=100`).expect(200)).body.vehicles).toEqual([]);
    await api('sales').get(`sales/stock/${hidden.body.vehicle.id}?siteId=${siteId}`).expect(403);
    await api('service').get(`sales/stock?siteId=${siteId}`).expect(403);
    await api('sales').get(`sales/stock?siteId=${randomUUID()}`).expect(403);
    const customer = await createCustomer('sales', { siteId, firstName: 'Stock', lastName: 'Customer', phone: '0400000088' });
    const enquiry = await api('sales').post('sales/leads', { siteId, customerId: customer.body.customer!.id, title: 'Stock matching enquiry', source: 'Walk-in' }).set('Idempotency-Key', randomUUID()).expect(201);
    const id = enquiry.body.lead.id;
    const match = { siteId, version: 0, stockId: vehicle.id, action: 'add', note: 'Matches requested family SUV' };
    await api('sales').patch(`sales/leads/${id}/stock`, { ...match, stockId: hidden.body.vehicle.id }).expect(403);
    await api('sales').patch(`sales/leads/${id}/stock`, match).expect(200);
    const history = await api('sales').get(`sales/pipeline/${id}/history?siteId=${siteId}`).expect(200);
    expect(history.body.history[0]).toMatchObject({ type: 'sales.stock_matched', stockLabel: 'STOCK-001 · Kia Sportage' });
    await api('sales').patch(`sales/leads/${id}/stock`, { ...match, action: 'remove' }).expect(409);
    await api('sales').patch(`sales/leads/${id}/stock`, { ...match, version: 1 }).expect(400);
    await api().patch(`sales/stock/${vehicle.id}`, { ...body, brandId: undefined, version: 0, status: 'sold' }).expect(200);
    await api().patch(`sales/stock/${vehicle.id}`, { ...body, brandId: undefined, version: 0, status: 'available' }).expect(409);
    await api('sales').patch(`sales/leads/${id}/stock`, { ...match, version: 1, action: 'remove' }).expect(200);
    await api('sales').patch(`sales/leads/${id}/stock`, { ...match, version: 2 }).expect(400);
    await api().patch(`admin/memberships/${originalMembership!.id}`, { organisationId, brandIds: [otherBrand] }).expect(200);
    const restricted = await api('sales').get(`sales/pipeline/${id}/history?siteId=${siteId}`).expect(200);
    expect(restricted.body.history.some((event: { stockLabel: string | null }) => event.stockLabel)).toBe(false);
    await api().patch(`admin/memberships/${originalMembership!.id}`, { organisationId, brandIds: originalMembership!.brand_ids ?? null }).expect(200);
    await api().patch(`admin/sites/${siteId}`, { organisationId, brandIds: originalSite!.brand_ids ?? [] }).expect(200);
  });

  it('records local appraisals and valuations with idempotency, current lead ownership, versions and atomic progress history', async () => {
    const customer = await createCustomer('sales', { siteId, firstName: 'Appraisal', lastName: 'Customer', phone: '0400000099' });
    const enquiry = await api('sales').post('sales/leads', { siteId, customerId: customer.body.customer!.id, title: 'Trade-in enquiry', source: 'Walk-in' }).set('Idempotency-Key', randomUUID()).expect(201);
    const leadId = enquiry.body.lead.id; const path = `sales/leads/${leadId}/appraisals`;
    const body = { siteId, make: 'Toyota', model: 'Corolla', year: 2020, odometerKm: 85000, registration: 'abc123', conditionNotes: 'Good condition; minor bumper scratches' };
    const key = randomUUID();
    const created = await api('sales').post(path, body).set('Idempotency-Key', key).expect(201);
    const appraisal = created.body.appraisal; expect(appraisal).toMatchObject({ status: 'draft', valuation_cents: null, registration: 'ABC123', source: 'local', customer_id: customer.body.customer!.id });
    expect(appraisal).not.toHaveProperty('create_hash');
    expect((await api('sales').post(path, body).set('Idempotency-Key', key).expect(201)).body.appraisal.id).toBe(appraisal.id);
    expect(await mongo.appraisals.countDocuments({ lead_id: leadId })).toBe(1);
    await api('sales').post(path, { ...body, model: 'Camry' }).set('Idempotency-Key', key).expect(409);
    await api('sales').post(path, { ...body, year: 0 }).set('Idempotency-Key', randomUUID()).expect(400);
    await api('service').get(`${path}?siteId=${siteId}`).expect(403);
    await api('service').post(path, body).set('Idempotency-Key', randomUUID()).expect(403);
    await api('sales').get(`${path}?siteId=${randomUUID()}`).expect(403);
    const edit = { ...body, version: 0, status: 'valued', valuationCents: 1450050, valuationNotes: 'Local assessment based on condition and mileage' };
    await api('sales').patch(`${path}/${appraisal.id}`, { ...edit, valuationCents: null }).expect(400);
    await api('sales').patch(`${path}/${appraisal.id}`, { ...edit, valuationCents: 1.5 }).expect(400);
    const valued = await api('sales').patch(`${path}/${appraisal.id}`, edit).expect(200);
    expect(valued.body.appraisal).toMatchObject({ version: 1, status: 'valued', valuation_cents: 1450050 });
    await api('sales').patch(`${path}/${appraisal.id}`, edit).expect(409);
    await api('sales').patch(`${path}/${appraisal.id}`, { ...edit, version: 1, status: 'withdrawn' }).expect(400);
    await api('sales').patch(`${path}/${appraisal.id}`, { ...edit, version: 1, status: 'withdrawn', withdrawalReason: 'Customer keeping their vehicle' }).expect(200);
    const concurrent = await Promise.all([0, 1500000].map(valuationCents => api('sales').patch(`${path}/${appraisal.id}`, { ...edit, version: 2, valuationCents })));
    expect(concurrent.map(result => result.status).sort()).toEqual([200, 409]);
    const history = await api('sales').get(`sales/pipeline/${leadId}/history?siteId=${siteId}`).expect(200);
    expect(history.body.history.filter((event: { type: string }) => event.type.startsWith('sales.appraisal'))).toHaveLength(4);
    expect(history.body.history[0]).toMatchObject({ appraisalId: appraisal.id, appraisalLabel: '2020 Toyota Corolla', appraisalStatus: 'valued', author: { id: identities.sales.id } });
    expect(history.body.history[1]).toMatchObject({ appraisalStatus: 'withdrawn', appraisalValuationCents: 1450050 });
    const list = await api('sales').get(`${path}?siteId=${siteId}&limit=1`).expect(200); expect(list.body.appraisals).toHaveLength(1);
    const current = await api('sales').get(`sales/leads/${leadId}?siteId=${siteId}`).expect(200); expect(current.body.lead.version).toBe(4);
    await api('sales').patch(`sales/pipeline/${leadId}/stage`, { siteId, version: 4, stage: 'won', reason: 'Enquiry completed for testing' }).expect(200);
    await api('sales').patch(`${path}/${appraisal.id}`, { ...edit, version: 3 }).expect(400);
    await api('sales').post(path, body).set('Idempotency-Key', randomUUID()).expect(400);
    await api('sales').post(path, body).set('Idempotency-Key', key).expect(201);
    await api().patch(`sales/leads/${leadId}`, { siteId, version: 5, assignedTo: identities.admin.id }).expect(200);
    await api('sales').get(`${path}?siteId=${siteId}`).expect(404);
    await api('sales').get(`${path}/${appraisal.id}?siteId=${siteId}`).expect(404);
    await api().get(`${path}/${appraisal.id}?siteId=${siteId}`).expect(200);
    await api().get(`sales/leads/${randomUUID()}/appraisals/${appraisal.id}?siteId=${siteId}`).expect(404);
  });

  it('calculates and reviews local deal proposals with fresh snapshots, permissions, versions and brand-safe history', async () => {
    const originalSite = await mongo.sites.findOne({ id: siteId }); const membership = await mongo.memberships.findOne({ user_id: identities.sales.id, role: 'SALES' });
    const brand = await api().post('admin/brands', { organisationId, name: 'Deal Brand' }).expect(201);
    const hiddenBrand = await api().post('admin/brands', { organisationId, name: 'Deal Other Brand' }).expect(201);
    const brandId = brand.body.brand.id;
    await api().patch(`admin/sites/${siteId}`, { organisationId, brandIds: [...(originalSite!.brand_ids ?? []), brandId, hiddenBrand.body.brand.id] }).expect(200);
    await api().patch(`admin/memberships/${membership!.id}`, { organisationId, brandIds: [brandId] }).expect(200);
    const stockBody = { siteId, brandId, stockNumber: 'DEAL-001', make: 'Kia', model: 'Sportage', year: 2026, odometerKm: 0, bodyType: 'SUV', fuelType: 'Petrol', transmission: 'Automatic', priceCents: 3499000 };
    const stock = await api().post('sales/stock', stockBody).set('Idempotency-Key', randomUUID()).expect(201);
    const customer = await createCustomer('sales', { siteId, firstName: 'Deal', lastName: 'Customer', phone: '0400000077' });
    const enquiry = await api('sales').post('sales/leads', { siteId, customerId: customer.body.customer!.id, title: 'Deal enquiry', source: 'Website' }).set('Idempotency-Key', randomUUID()).expect(201);
    const leadId = enquiry.body.lead.id; const path = `sales/leads/${leadId}/deals`; const appraisalPath = `sales/leads/${leadId}/appraisals`;
    const appraisalBody = { siteId, make: 'Toyota', model: 'Corolla', year: 2020, odometerKm: 85000, conditionNotes: 'Good condition with minor wear' };
    const appraised = await api('sales').post(appraisalPath, appraisalBody).set('Idempotency-Key', randomUUID()).expect(201);
    const appraisalId = appraised.body.appraisal.id;
    const valuation = { ...appraisalBody, version: 0, status: 'valued', valuationCents: 1450050, valuationNotes: 'Internal trade-in assessment' };
    await api('sales').patch(`${appraisalPath}/${appraisalId}`, valuation).expect(200);
    const body = { siteId, stockId: stock.body.vehicle.id, appraisalId, salePriceCents: 3499000, discountCents: 100000, feesCents: 50000, notes: 'Internal vehicle proposal with assessed trade-in' };
    const key = randomUUID(); const created = await api('sales').post(path, body).set('Idempotency-Key', key).expect(201); const deal = created.body.deal;
    expect(deal).toMatchObject({ status: 'draft', trade_in_cents: 1450050, total_cents: 1998950, stock_version: 0, appraisal_version: 1 }); expect(deal).not.toHaveProperty('create_hash');
    expect((await api('sales').post(path, body).set('Idempotency-Key', key).expect(201)).body.deal.id).toBe(deal.id);
    await api('sales').post(path, { ...body, salePriceCents: 3500000 }).set('Idempotency-Key', key).expect(409);
    await api('sales').post(path, { ...body, totalCents: 1 }).set('Idempotency-Key', randomUUID()).expect(400);
    await api('service').get(`${path}?siteId=${siteId}`).expect(403);
    await api('sales').get(`${path}?siteId=${randomUUID()}`).expect(403);
    const transition = (identity: string, action: string, version: number, id = deal.id) => api(identity).patch(`${path}/${id}/status`, { siteId, version, action, note: 'Reviewed internal proposal' });
    await transition('sales', 'approve', 0).expect(403); await transition('admin', 'approve', 0).expect(409);
    await api('sales').patch(`${appraisalPath}/${appraisalId}`, { ...valuation, version: 1, valuationCents: 1500000 }).expect(200);
    await transition('sales', 'submit', 0).expect(409);
    const edit = { siteId, version: 0, appraisalId, salePriceCents: body.salePriceCents, discountCents: body.discountCents, feesCents: body.feesCents, notes: body.notes };
    const refreshed = await api('sales').patch(`${path}/${deal.id}`, edit).expect(200); expect(refreshed.body.deal.total_cents).toBe(1949000);
    await transition('sales', 'submit', 1).expect(200); await transition('sales', 'approve', 2).expect(403);
    await api('sales').patch(`${path}/${deal.id}`, { ...edit, version: 2 }).expect(409);
    await api().patch(`sales/stock/${stock.body.vehicle.id}`, { ...stockBody, brandId: undefined, version: 0, status: 'available' }).expect(200);
    await transition('admin', 'approve', 2).expect(409); await transition('admin', 'reject', 2).expect(200);
    await api('sales').patch(`${path}/${deal.id}`, { ...edit, version: 3, discountCents: 200000 }).expect(200);
    await transition('sales', 'submit', 4).expect(200); const approved = await transition('admin', 'approve', 5).expect(200);
    expect(approved.body.deal).toMatchObject({ status: 'approved', total_cents: 1849000, reviewed_by: identities.admin.id });
    await transition('sales', 'cancel', 6).expect(403); await transition('admin', 'cancel', 6).expect(200);
    await api('sales').patch(`${path}/${deal.id}`, { ...edit, version: 7 }).expect(409);
    const second = await api('sales').post(path, { ...body, appraisalId: null }).set('Idempotency-Key', randomUUID()).expect(201);
    await transition('sales', 'submit', 0, second.body.deal.id).expect(200);
    const concurrent = await Promise.all(['approve', 'reject'].map(action => transition('admin', action, 1, second.body.deal.id)));
    expect(concurrent.map(result => result.status).sort()).toEqual([200, 409]);
    expect(await mongo.auditEvents.countDocuments({ entity_id: leadId, 'metadata.deal_id': second.body.deal.id, action: { $in: ['sales.deal_approved', 'sales.deal_rejected'] } })).toBe(1);
    const history = await api('sales').get(`sales/pipeline/${leadId}/history?siteId=${siteId}&limit=100`).expect(200);
    expect(history.body.history.some((event: { dealId: string; dealStatus: string; dealTotalCents: number }) => event.dealId === deal.id && event.dealStatus === 'approved' && event.dealTotalCents === 1849000)).toBe(true);
    const stockAfter = await mongo.stockVehicles.findOne({ id: stock.body.vehicle.id }); expect(stockAfter!.status).toBe('available');
    await api().patch(`admin/memberships/${membership!.id}`, { organisationId, brandIds: [hiddenBrand.body.brand.id] }).expect(200);
    expect((await api('sales').get(`${path}?siteId=${siteId}`).expect(200)).body.deals).toEqual([]);
    await api('sales').get(`${path}/${deal.id}?siteId=${siteId}`).expect(403);
    const restricted = await api('sales').get(`sales/pipeline/${leadId}/history?siteId=${siteId}&limit=100`).expect(200);
    expect(restricted.body.history.some((event: { dealId: string | null }) => event.dealId)).toBe(false);
    await api().patch(`admin/memberships/${membership!.id}`, { organisationId, brandIds: membership!.brand_ids ?? null }).expect(200);
    const currentLead = await api().get(`sales/leads/${leadId}?siteId=${siteId}`).expect(200);
    await api().patch(`sales/leads/${leadId}`, { siteId, version: currentLead.body.lead.version, assignedTo: identities.admin.id }).expect(200);
    await api('sales').get(`${path}?siteId=${siteId}`).expect(404); await api().get(`${path}/${deal.id}?siteId=${siteId}`).expect(200);
    await api().patch(`admin/sites/${siteId}`, { organisationId, brandIds: originalSite!.brand_ids ?? [] }).expect(200);
  });

  it('reserves approved deals exclusively, expires holds, and releases them atomically on cancellation', async () => {
    const originalSite = await mongo.sites.findOne({ id: siteId }); const member = await mongo.memberships.findOne({ user_id: identities.sales.id, role: 'SALES' });
    const brand = await api().post('admin/brands', { organisationId, name: 'Reservation Brand' }).expect(201); const brandId = brand.body.brand.id;
    await api().patch(`admin/sites/${siteId}`, { organisationId, brandIds: [...(originalSite!.brand_ids ?? []), brandId] }).expect(200);
    await api().patch(`admin/memberships/${member!.id}`, { organisationId, brandIds: [brandId] }).expect(200);
    const stockBody = { siteId, brandId, stockNumber: 'RESERVATION-STOCK', make: 'Kia', model: 'Sportage', year: 2026, odometerKm: 0, bodyType: 'SUV', fuelType: 'Petrol', transmission: 'Automatic', priceCents: 3499000 };
    const stock = await api().post('sales/stock', stockBody).set('Idempotency-Key', randomUUID()).expect(201); const stockId = stock.body.vehicle.id;
    const customer = await createCustomer('sales', { siteId, firstName: 'Reserve', lastName: 'Customer', phone: '0400000044' });
    const prepare = async (title: string) => {
      const lead = await api('sales').post('sales/leads', { siteId, customerId: customer.body.customer!.id, title, source: 'Website' }).set('Idempotency-Key', randomUUID()).expect(201);
      const leadId = lead.body.lead.id; const dealPath = `sales/leads/${leadId}/deals`;
      const appraisalBody = { siteId, make: 'Toyota', model: 'Corolla', year: 2020, odometerKm: 85000, conditionNotes: 'Good condition for reservation test' };
      const appraisal = await api('sales').post(`sales/leads/${leadId}/appraisals`, appraisalBody).set('Idempotency-Key', randomUUID()).expect(201);
      await api('sales').patch(`sales/leads/${leadId}/appraisals/${appraisal.body.appraisal.id}`, { ...appraisalBody, version: 0, status: 'valued', valuationCents: 500000, valuationNotes: 'Initial internal assessment' }).expect(200);
      const deal = await api('sales').post(dealPath, { siteId, stockId, appraisalId: appraisal.body.appraisal.id, salePriceCents: 3499000, notes: 'Reservation test proposal' }).set('Idempotency-Key', randomUUID()).expect(201);
      const dealId = deal.body.deal.id; const path = `${dealPath}/${dealId}/reservations`;
      await api('sales').post(path, { siteId, dealVersion: 0, expiresAt: new Date(Date.now() + 86400000).toISOString(), note: 'Invalid draft hold' }).set('Idempotency-Key', randomUUID()).expect(409);
      await api('sales').patch(`${dealPath}/${dealId}/status`, { siteId, version: 0, action: 'submit', note: 'Ready to review' }).expect(200);
      await api().patch(`${dealPath}/${dealId}/status`, { siteId, version: 1, action: 'approve', note: 'Reviewed pricing' }).expect(200);
      return { leadId, dealId, path, dealPath, key: randomUUID(), appraisalBody, appraisalId: appraisal.body.appraisal.id };
    };
    const first = await prepare('First reservation enquiry'); const second = await prepare('Competing reservation enquiry');
    const body = { siteId, dealVersion: 2, expiresAt: new Date(Date.now() + 86400000).toISOString(), note: 'Hold requested for approved proposal' };
    await api('sales').post(first.path, { ...body, dealVersion: 1 }).set('Idempotency-Key', randomUUID()).expect(409);
    await api('sales').post(first.path, { ...body, expiresAt: new Date(Date.now() + 8 * 86400000).toISOString() }).set('Idempotency-Key', randomUUID()).expect(400);
    await api('service').get(`${first.path}?siteId=${siteId}`).expect(403);
    const concurrent = await Promise.all([first, second].map(target => api('sales').post(target.path, body).set('Idempotency-Key', target.key)));
    expect(concurrent.map(result => result.status).sort()).toEqual([201, 409]);
    const winner = concurrent[0].status === 201 ? first : second; const winning = concurrent.find(result => result.status === 201)!.body.reservation;
    expect(await mongo.reservations.countDocuments({ stock_id: stockId, status: 'active' })).toBe(1);
    const replay = await api('sales').post(winner.path, body).set('Idempotency-Key', winner.key).expect(201); expect(replay.body.reservation.id).toBe(winning.id);
    await api('sales').post(winner.path, { ...body, note: 'Different note' }).set('Idempotency-Key', winner.key).expect(409);
    const reserved = await api('sales').get(`sales/stock?siteId=${siteId}&status=reserved&limit=1`).expect(200); expect(reserved.body.vehicles[0].id).toBe(stockId);
    expect(reserved.body.vehicles[0].reservation).not.toHaveProperty('dealId');
    expect((await api('sales').get(`sales/stock?siteId=${siteId}&status=available&search=RESERVATION`).expect(200)).body.vehicles).toEqual([]);
    await api().patch(`sales/stock/${stockId}`, { ...stockBody, brandId: undefined, version: 0, status: 'sold' }).expect(409);
    await api('sales').patch(`${winner.path}/${winning.id}/release`, { siteId, version: 1, note: 'Stale release request' }).expect(409);
    await api('sales').patch(`${winner.path}/${winning.id}/release`, { siteId, version: 0, note: 'Customer requested release' }).expect(200);
    expect((await api('sales').get(`${winner.path}?siteId=${siteId}`).expect(200)).body.active).toBeNull();
    const heldAgain = await api('sales').post(first.path, body).set('Idempotency-Key', randomUUID()).expect(201);
    await api('sales').patch(`sales/leads/${first.leadId}/appraisals/${first.appraisalId}`, { ...first.appraisalBody, version: 1, status: 'valued', valuationCents: 600000, valuationNotes: 'Attempt changing held pricing' }).expect(409);
    await mongo.reservations.updateOne({ id: heldAgain.body.reservation.id }, { $set: { expires_at: new Date(Date.now() - 1000).toISOString() } });
    const effective = await api('sales').get(`${first.path}?siteId=${siteId}`).expect(200); expect(effective.body.active).toBeNull();
    expect(effective.body.reservations.find((row: { id: string }) => row.id === heldAgain.body.reservation.id).status).toBe('expired');
    const afterExpiry = await api('sales').post(second.path, body).set('Idempotency-Key', randomUUID()).expect(201);
    expect((await mongo.reservations.findOne({ id: heldAgain.body.reservation.id }))!.status).toBe('expired');
    await api().patch(`${second.dealPath}/${second.dealId}/status`, { siteId, version: 1, action: 'cancel', note: 'Stale cancellation must not release hold' }).expect(409);
    expect((await mongo.reservations.findOne({ id: afterExpiry.body.reservation.id }))!.status).toBe('active');
    await api().patch(`${second.dealPath}/${second.dealId}/status`, { siteId, version: 2, action: 'cancel', note: 'Cancel proposal and release stock' }).expect(200);
    expect((await mongo.reservations.findOne({ id: afterExpiry.body.reservation.id }))!.status).toBe('released');
    expect(await mongo.reservations.countDocuments({ stock_id: stockId, status: 'active' })).toBe(0);
    const workerHold = await api('sales').post(first.path, body).set('Idempotency-Key', randomUUID()).expect(201);
    await mongo.reservations.updateOne({ id: workerHold.body.reservation.id }, { $set: { expires_at: new Date(Date.now() - 1000).toISOString() } });
    await app.get(ReservationsService).sweep(); await app.get(ReservationsService).sweep();
    expect((await mongo.reservations.findOne({ id: workerHold.body.reservation.id }))!.status).toBe('expired');
    expect(await mongo.auditEvents.countDocuments({ action: 'sales.reservation_expired', 'metadata.reservation_id': workerHold.body.reservation.id })).toBe(1);
    const history = await api('sales').get(`sales/pipeline/${first.leadId}/history?siteId=${siteId}&limit=100`).expect(200);
    expect(history.body.history.some((row: { type: string; author: { fullName: string } }) => row.type === 'sales.reservation_expired' && row.author.fullName === 'System')).toBe(true);
    const current = await api().get(`sales/leads/${first.leadId}?siteId=${siteId}`).expect(200);
    await api().patch(`sales/leads/${first.leadId}`, { siteId, version: current.body.lead.version, assignedTo: identities.admin.id }).expect(200);
    await api('sales').get(`${first.path}?siteId=${siteId}`).expect(404); await api().get(`${first.path}?siteId=${siteId}`).expect(200);
    await api().patch(`admin/memberships/${member!.id}`, { organisationId, brandIds: member!.brand_ids ?? null }).expect(200);
    await api().patch(`admin/sites/${siteId}`, { organisationId, brandIds: originalSite!.brand_ids ?? [] }).expect(200);
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
