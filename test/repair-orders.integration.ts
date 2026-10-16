import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { SupabaseAuthGuard } from '../src/auth/supabase-auth.guard.js';
import { MongoService } from '../src/database/mongo.service.js';
import { AuditService } from '../src/database/audit.service.js';
import { IntegrationConfig } from '../src/integration/integration.config.js';
import { RepairOrdersService } from '../src/crm/repair-orders.service.js';
import { emptyChecklist } from '../src/crm/delivery-checklist.js';
import { ActivityMirrorService } from '../src/crm/activity-mirror.service.js';
import { IntegrationService } from '../src/integration/integration.service.js';

describe('Repair orders, simulated source commands and customer visibility', () => {
  let replica: MongoMemoryReplSet;
  let app: INestApplication;
  let mongo: MongoService;
  let orders: RepairOrdersService;
  const org = randomUUID(),
    site = randomUUID(),
    otherSite = randomUUID(),
    brand = randomUUID(),
    otherBrand = randomUUID();
  const admin = randomUUID(),
    advisor = randomUUID(),
    peer = randomUUID(),
    sales = randomUUID(),
    membership = randomUUID();
  const customer = randomUUID(),
    appointment = randomUUID();
  const get = (path: string, actor = advisor) =>
    request(app.getHttpServer())
      .get('/api/' + path)
      .set('Authorization', 'Bearer ' + actor);
  const post = (
    path: string,
    body: object,
    actor = advisor,
    key = randomUUID(),
  ) =>
    request(app.getHttpServer())
      .post('/api/' + path)
      .set('Authorization', 'Bearer ' + actor)
      .set('Idempotency-Key', key)
      .send(body);
  const simulate = (key = randomUUID()) =>
    post(
      'service/repair-orders/simulate-from-appointment',
      {
        siteId: site,
        appointmentId: appointment,
        promisedAt: '2026-01-01T02:00:00Z',
      },
      advisor,
      key,
    );
  const confirmed = async () => {
    const queued = await simulate().expect(202);
    expect(
      (await orders.processOne(queued.body.command.id))!.command.status,
    ).toBe('succeeded');
    return queued.body.command.repair_order_id;
  };
  const transition = (
    id: string,
    version: number,
    status: string,
    key = randomUUID(),
  ) =>
    post(
      `service/repair-orders/${id}/transitions`,
      {
        siteId: site,
        version,
        status,
        note: 'Customer approved the work by phone',
      },
      advisor,
      key,
    );
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    vi.stubEnv('MONGODB_URI', replica.getUri());
    vi.stubEnv('MONGODB_DATABASE', 'repair_orders_test');
    vi.stubEnv('INTEGRATION_MODE', 'simulated');
    vi.stubEnv('ALLOW_SIMULATED_INTEGRATION', 'true');
    vi.stubEnv('INTEGRATION_WORKER_ENABLED', 'false');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          const id = req.headers.authorization?.replace('Bearer ', '');
          if (![admin, advisor, peer, sales].includes(id)) return false;
          req.user = {
            id,
            email: 'test@example.test',
            email_confirmed_at: '2026-01-01',
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    mongo = app.get(MongoService);
    orders = app.get(RepairOrdersService);
    const now = new Date().toISOString();
    await mongo.organisations.insertOne({
      _id: org,
      id: org,
      name: 'Test Dealer',
      access_revision: 0,
      created_at: now,
    });
    for (const id of [brand, otherBrand])
      await mongo.brands.insertOne({
        _id: id,
        id,
        organisation_id: org,
        name: id,
        created_at: now,
        updated_at: now,
      });
    for (const id of [site, otherSite])
      await mongo.sites.insertOne({
        _id: id,
        id,
        organisation_id: org,
        name: id,
        timezone: 'Australia/Sydney',
        brand_ids: [brand, otherBrand],
        created_at: now,
      });
    for (const [id, user_id, role, brand_ids] of [
      [randomUUID(), admin, 'ADMIN', null],
      [membership, advisor, 'SERVICE', [brand]],
      [randomUUID(), peer, 'SERVICE', [otherBrand]],
      [randomUUID(), sales, 'SALES', null],
    ] as const)
      await mongo.memberships.insertOne({
        _id: id,
        id,
        user_id,
        role,
        brand_ids: brand_ids ? [...brand_ids] : null,
        organisation_id: org,
        site_id: role === 'ADMIN' ? null : site,
        status: 'active',
        extra_permissions: [],
        created_at: now,
      });
  });
  beforeEach(async () => {
    app.get(IntegrationConfig).mode = 'simulated';
    app.get(IntegrationConfig).writesEnabled = true;
    await Promise.all([
      mongo.repairOrders.deleteMany({}),
      mongo.repairOrderCommands.deleteMany({}),
      mongo.customers.deleteMany({}),
      mongo.serviceAppointments.deleteMany({}),
      mongo.auditEvents.deleteMany({}),
      mongo.simulatorBehaviors.deleteMany({}),
    ]);
    await mongo.memberships.updateOne(
      { id: membership },
      { $set: { status: 'active', brand_ids: [brand], extra_permissions: [] } },
    );
    const now = new Date().toISOString();
    await mongo.customers.insertOne({
      _id: customer,
      id: customer,
      organisation_id: org,
      site_id: site,
      created_by: advisor,
      assigned_to: advisor,
      first_name: 'RO',
      last_name: 'Customer',
      email: null,
      phone: null,
      source: 'simulated',
      external_ids: {},
      integration_mode: 'simulated',
      created_at: now,
      updated_at: now,
    });
    await mongo.serviceAppointments.insertOne({
      _id: appointment,
      id: appointment,
      organisation_id: org,
      site_id: site,
      brand_id: brand,
      customer_id: customer,
      assigned_to: advisor,
      created_by: advisor,
      title: 'Scheduled service',
      vehicle: 'TEST rego — vehicle description',
      starts_at: '2026-01-01T00:00:00Z',
      ends_at: '2026-01-01T01:00:00Z',
      status: 'attended',
      notes: '',
      outcome_note: 'Arrived',
      version: 0,
      integration_mode: 'simulated',
      created_at: now,
      updated_at: now,
      create_key: randomUUID(),
      create_hash: 'test',
    });
  });
  afterEach(() => vi.restoreAllMocks());
  const action = (
    id: string,
    version: number,
    name: string,
    body: object = {},
    actor = advisor,
    key = randomUUID(),
  ) =>
    post(
      `service/repair-orders/${id}/actions/${name}`,
      { siteId: site, version, ...body },
      actor,
      key,
    );
  const acceptedAction = async (
    id: string,
    name: string,
    body: object = {},
    actor = advisor,
  ) => {
    const row = await mongo.repairOrders.findOne({ id });
    const queued = await action(id, row!.version, name, body, actor).expect(
      202,
    );
    const result = await orders.processOne(queued.body.command.id);
    expect(result!.command.status).toBe('succeeded');
    return (await mongo.repairOrders.findOne({ id }))!;
  };
  afterAll(async () => {
    await app?.close();
    await replica?.stop();
    vi.unstubAllEnvs();
  });

  it('queues a simulation, projects only after acknowledgement and preserves appointment/customer/vehicle links', async () => {
    const key = randomUUID();
    const first = await simulate(key).expect(202);
    expect(await mongo.repairOrders.countDocuments()).toBe(0);
    const replay = await simulate(key).expect(202);
    expect(replay.body.command.id).toBe(first.body.command.id);
    const [a, b] = await Promise.all([
      orders.processOne(first.body.command.id),
      orders.processOne(first.body.command.id),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await mongo.repairOrders.countDocuments()).toBe(1);
    const detail = await get(
      `service/repair-orders/${first.body.command.repair_order_id}?siteId=${site}`,
    ).expect(200);
    expect(detail.body.repairOrder).toMatchObject({
      customer_id: customer,
      appointment_id: appointment,
      brand_id: brand,
      assigned_to: advisor,
      vehicle: 'TEST rego — vehicle description',
      vehicle_external_id: null,
      status: 'waiting_authority',
      integration_mode: 'simulated',
    });
    expect(detail.body.repairOrder.external_id).toMatch(/^simulated-ro-/);
    expect(detail.body.commands[0].status).toBe('succeeded');
    expect(JSON.stringify(detail.body)).not.toContain(key);
    expect(detail.body.commands[0]).not.toHaveProperty('payload');
    await simulate(key).expect(202);
    await simulate().expect(409);
    await post(
      'service/repair-orders/simulate-from-appointment',
      {
        siteId: site,
        appointmentId: appointment,
        promisedAt: '2026-01-02T02:00:00Z',
      },
      advisor,
      key,
    ).expect(409);
  });
  it('enforces the lifecycle, records reasons separately from authority, and keeps invoices read-only', async () => {
    const id = await confirmed();
    await transition(id, 0, 'ready').expect(409);
    await transition(id, 0, 'invoiced').expect(409);
    await acceptedAction(id, 'check-in', {
      mileageIn: 100,
      fuelLevel: 'full',
      signatureConfirmed: true,
    });
    let version = 1;
    for (const status of [
      'in_workshop',
      'waiting_parts',
      'in_workshop',
      'ready',
      'in_workshop',
    ]) {
      const key = randomUUID();
      const command = await transition(id, version, status, key).expect(202);
      expect((await mongo.repairOrders.findOne({ id }))!.version).toBe(version);
      await orders.processOne(command.body.command.id);
      await transition(id, version, status, key).expect(202);
      version++;
    }
    const note = await post(`service/repair-orders/${id}/authority-notes`, {
      siteId: site,
      version,
      note: 'Customer authorised service only',
    }).expect(202);
    await orders.processOne(note.body.command.id);
    const row = await mongo.repairOrders.findOne({ id });
    expect(row!.authority_notes).toHaveLength(1);
    expect(row!.status_history).toHaveLength(6);
    await transition(id, 0, 'waiting_parts').expect(409);
    await post(`service/repair-orders/${id}/authority-notes`, {
      siteId: site,
      version: version + 1,
      note: 'valid note',
      total_cents: 1,
    }).expect(400);
  });
  it('isolates site, brand, assignment, mode and suspended membership in list/detail/commands/timeline', async () => {
    const id = await confirmed();
    const commands = await mongo.repairOrderCommands.findOne({
      repair_order_id: id,
    });
    await get(`service/repair-orders?siteId=${site}`, sales).expect(403);
    expect(
      (await get(`service/repair-orders?siteId=${site}`, peer).expect(200)).body
        .repairOrders,
    ).toEqual([]);
    await get(`service/repair-orders/${id}?siteId=${site}`, peer).expect(404);
    await get(
      `service/repair-orders/commands/${commands!.id}?siteId=${site}`,
      peer,
    ).expect(404);
    await get(`service/repair-orders/${id}?siteId=${otherSite}`, admin).expect(
      404,
    );
    const shared = await get(
      `customers/${customer}/activity?siteId=${site}`,
      peer,
    ).expect(200);
    expect(
      shared.body.activities.some(
        (e: { repairOrderId?: string }) => e.repairOrderId === id,
      ),
    ).toBe(false);
    const own = await get(
      `customers/${customer}/activity?siteId=${site}`,
    ).expect(200);
    expect(
      own.body.activities.find(
        (e: { repairOrderId?: string }) => e.repairOrderId === id,
      ).type,
    ).toBe('service.repair_order_imported');
    await mongo.repairOrders.updateOne(
      { id },
      { $set: { assigned_to: admin } },
    );
    await get(`service/repair-orders/${id}?siteId=${site}`).expect(404);
    await mongo.repairOrders.updateOne(
      { id },
      { $set: { assigned_to: advisor } },
    );
    app.get(IntegrationConfig).mode = 'scraping';
    expect(
      (await get(`service/repair-orders?siteId=${site}`).expect(200)).body
        .repairOrders,
    ).toEqual([]);
    await get(
      `service/repair-orders/commands/${commands!.id}?siteId=${site}`,
    ).expect(404);
    app.get(IntegrationConfig).mode = 'simulated';
    await mongo.memberships.updateOne(
      { id: membership },
      { $set: { status: 'suspended' } },
    );
    await get(`service/repair-orders/${id}?siteId=${site}`).expect(403);
  });
  it('offers own/team My Day exceptions, search and stable pagination', async () => {
    const id = await confirmed();
    const queue = await get(
      `service/repair-orders/my-day?siteId=${site}&date=2026-10-16`,
    ).expect(200);
    expect(queue.body.repairOrders[0]).toMatchObject({ id, overdue: true });
    await get(`service/repair-orders/my-day?siteId=${site}&view=team`).expect(
      403,
    );
    await get(
      `service/repair-orders/my-day?siteId=${site}&view=team`,
      admin,
    ).expect(200);
    const weekly = await get(`service/diary?siteId=${site}&date=2026-01-01&range=week`).expect(200);
    expect(weekly.body.day.date).toBe('2025-12-29');
    expect(weekly.body.appointments.some((a: { id: string }) => a.id === appointment)).toBe(true);
    await get(`service/diary?siteId=${site}&range=invalid`).expect(400);
    await get(`service/diary?siteId=${site}&advisorId=${admin}`).expect(403);
    await get(`service/repair-orders?siteId=${site}&limit=0`).expect(400);
    await get(`service/repair-orders?siteId=${site}&status=invalid`).expect(
      400,
    );
    const found = await get(
      `service/repair-orders?siteId=${site}&search=TEST%20rego&limit=1`,
    ).expect(200);
    expect(found.body.repairOrders[0].id).toBe(id);
    expect(found.body.pagination.hasMore).toBe(false);
    expect(
      (await get(`service/repair-orders?siteId=${site}&offset=1`).expect(200))
        .body.repairOrders,
    ).toEqual([]);
    expect(
      (await get(`service/repair-orders?siteId=${site}&search=%5B`).expect(200))
        .body.repairOrders,
    ).toEqual([]);
    await mongo.repairOrders.updateOne(
      { id },
      { $set: { status: 'invoiced' } },
    );
    expect(
      (await get(`service/repair-orders/my-day?siteId=${site}`).expect(200))
        .body.repairOrders,
    ).toEqual([]);
  });
  it('rechecks current access, appointment and RO versions at acknowledgement', async () => {
    const first = await simulate().expect(202);
    await mongo.memberships.updateOne(
      { id: membership },
      { $set: { status: 'suspended' } },
    );
    expect(
      (await orders.processOne(first.body.command.id))!.command.status,
    ).toBe('rejected');
    expect(await mongo.repairOrders.countDocuments()).toBe(0);
    await mongo.memberships.updateOne(
      { id: membership },
      { $set: { status: 'active' } },
    );
    const id = await confirmed();
    const queued = await transition(id, 0, 'in_workshop').expect(202);
    await mongo.repairOrders.updateOne({ id }, { $inc: { version: 1 } });
    expect(
      (await orders.processOne(queued.body.command.id))!.command.status,
    ).toBe('rejected');
    expect((await mongo.repairOrders.findOne({ id }))!.status).toBe(
      'waiting_authority',
    );
  });
  it('bounds outage retries, retains rejection and unknown outcomes without applying changes', async () => {
    const queued = await simulate().expect(202);
    await mongo.simulatorBehaviors.insertOne({
      organisation_id: org,
      site_id: site,
      behavior: 'outage',
      remaining: 3,
    });
    for (let i = 0; i < 3; i++) {
      await mongo.repairOrderCommands.updateOne(
        { id: queued.body.command.id },
        { $set: { available_at: '2020-01-01' } },
      );
      expect(
        (await orders.processOne(queued.body.command.id))!.command.status,
      ).toBe(i === 2 ? 'failed' : 'retry_wait');
    }
    expect(await mongo.repairOrders.countDocuments()).toBe(0);
    await mongo.simulatorBehaviors.updateOne(
      { site_id: site },
      { $set: { behavior: 'unknown', remaining: 1 } },
    );
    const unknown = await simulate().expect(202);
    expect(
      (await orders.processOne(unknown.body.command.id))!.command.status,
    ).toBe('needs_review');
    await simulate().expect(409);
    expect(await orders.processOne(unknown.body.command.id)).toBeNull();
  });
  it('rolls back projection, receipt and accepted timeline if audit fails', async () => {
    const queued = await simulate().expect(202);
    vi.spyOn(app.get(AuditService), 'record').mockRejectedValueOnce(
      new Error('Audit failure'),
    );
    await expect(orders.processOne(queued.body.command.id)).rejects.toThrow();
    expect(await mongo.repairOrders.countDocuments()).toBe(0);
    expect(
      (await mongo.repairOrderCommands.findOne({ id: queued.body.command.id }))!
        .status,
    ).toBe('queued');
    expect(
      await mongo.auditEvents.countDocuments({ entity_type: 'repair_order' }),
    ).toBe(0);
    vi.restoreAllMocks();
    await orders.processOne(queued.body.command.id);
    expect(await mongo.repairOrders.countDocuments()).toBe(1);
  });
  it('allows an audited administrator retry only after explicit non-application review', async () => {
    await mongo.simulatorBehaviors.insertOne({
      organisation_id: org,
      site_id: site,
      behavior: 'unknown',
      remaining: 1,
    });
    const queued = await simulate().expect(202);
    const commandId = queued.body.command.id;
    await orders.processOne(commandId);
    const list = await get(
      `service/repair-orders/commands?siteId=${site}`,
    ).expect(200);
    expect(list.body.commands[0].status).toBe('needs_review');
    const path = `service/repair-orders/commands/${commandId}/retry`;
    await post(path, {
      siteId: site,
      note: 'Verified not applied',
      confirmedNotApplied: true,
    }).expect(403);
    await post(
      path,
      {
        siteId: site,
        note: 'Verified not applied',
        confirmedNotApplied: 'true',
      },
      admin,
    ).expect(400);
    await post(
      path,
      { siteId: site, note: 'Verified not applied', confirmedNotApplied: true },
      admin,
    ).expect(202);
    await post(
      `service/repair-orders/commands/${commandId}/process-simulated`,
      { siteId: site },
      admin,
    ).expect(200);
    expect(await mongo.repairOrders.countDocuments()).toBe(1);
    await post(
      path,
      { siteId: site, note: 'Already succeeded', confirmedNotApplied: true },
      admin,
    ).expect(409);
    expect(
      await mongo.auditEvents.countDocuments({
        action: 'service.repair_order_command_retried',
      }),
    ).toBe(1);
  });
  it('rejects unsupported creation, invalid links, financial writes and live mode simulation', async () => {
    await post('service/repair-orders', { siteId: site }).expect(404);
    await post('service/repair-orders/simulate-from-appointment', {
      siteId: site,
      appointmentId: randomUUID(),
      promisedAt: '2026-01-01T00:00:00Z',
    }).expect(404);
    await post('service/repair-orders/simulate-from-appointment', {
      siteId: site,
      appointmentId: appointment,
      promisedAt: '2026-01-01',
    }).expect(400);
    await mongo.serviceAppointments.updateOne(
      { id: appointment },
      { $set: { status: 'cancelled' } },
    );
    await simulate().expect(409);
    await mongo.serviceAppointments.updateOne(
      { id: appointment },
      { $set: { status: 'booked', integration_mode: 'scraping' } },
    );
    app.get(IntegrationConfig).mode = 'scraping';
    await simulate().expect(503);
    expect(await mongo.repairOrderCommands.countDocuments()).toBe(0);
  });

  it('runs check-in, authority, progress, road-test readiness and collection through acknowledgement without invoicing', async () => {
    const id = await confirmed();
    await action(id, 0, 'check-in', {
      mileageIn: -1,
      fuelLevel: 'half',
      signatureConfirmed: true,
    }).expect(400);
    const key = randomUUID();
    const queued = await action(
      id,
      0,
      'check-in',
      { mileageIn: 42000, fuelLevel: 'half', signatureConfirmed: true },
      advisor,
      key,
    ).expect(202);
    expect(
      (await mongo.repairOrders.findOne({ id }))!.check_in,
    ).toBeUndefined();
    await orders.processOne(queued.body.command.id);
    expect(
      (await mongo.repairOrders.findOne({ id }))!.check_in!.mileage_in,
    ).toBe(42000);
    expect(
      (await mongo.serviceAppointments.findOne({ id: appointment }))!.status,
    ).toBe('attended');
    await action(
      id,
      0,
      'check-in',
      { mileageIn: 42000, fuelLevel: 'half', signatureConfirmed: true },
      advisor,
      key,
    ).expect(202);
    let row = await acceptedAction(id, 'request-authority', {
      description: 'Inspect the source-listed operation',
    });
    await action(id, row.version, 'progress', { stage: 'in_progress' }).expect(
      409,
    );
    row = await acceptedAction(id, 'respond-authority', {
      approved: false,
      responseNote: 'Customer declined by phone',
    });
    expect(row.status).toBe('waiting_authority');
    await transition(id, row.version, 'in_workshop').expect(409);
    await acceptedAction(id, 'request-authority', {
      description: 'Revised operation scope',
    });
    row = await acceptedAction(id, 'respond-authority', {
      approved: true,
      responseNote: 'Customer approved revised scope by phone',
    });
    row = await acceptedAction(id, 'progress', {
      stage: 'road_test_ready',
      roadTestStatus: 'pending',
    });
    await action(id, row.version, 'progress', {
      stage: 'completed',
      markReady: true,
    }).expect(409);
    row = await acceptedAction(id, 'progress', {
      stage: 'completed',
      roadTestStatus: 'passed',
      markReady: true,
    });
    expect(row.status).toBe('ready');
    await action(id, row.version, 'collect', {
      keysReturned: true,
      paymentStatus: 'paid',
    }).expect(400);
    row = await acceptedAction(id, 'collect', {
      keysReturned: true,
      loanReturned: false,
      notes: 'Customer collected vehicle',
    });
    expect(row.status).toBe('ready');
    expect(row.invoiced_at).toBeNull();
    expect(row.collection!.collected_by_staff_id).toBe(advisor);
    await action(id, row.version, 'progress', { stage: 'in_progress' }).expect(
      409,
    );
    const queue = await get(
      `service/repair-orders/my-day?siteId=${site}`,
    ).expect(200);
    expect(
      queue.body.repairOrders.some((r: { id: string }) => r.id === id),
    ).toBe(false);
    const history = await get(
      `customers/${customer}/activity?siteId=${site}&desk=service&limit=100`,
    ).expect(200);
    expect(
      history.body.activities.some(
        (e: { type: string }) => e.type === 'service.repair_order_collect',
      ),
    ).toBe(true);
  });
  it('protects simulated loan allocation, return and advisor assignments', async () => {
    const fixture = await post(
      'service/repair-orders/loan-cars',
      {
        siteId: site,
        brandId: brand,
        make: 'Simulated',
        model: 'Loan',
        year: 2026,
        registration: 'SIM-LOAN',
      },
      admin,
    ).expect(201);
    const id = await confirmed();
    let row = await acceptedAction(id, 'check-in', {
      mileageIn: 100,
      fuelLevel: 'full',
      signatureConfirmed: true,
      loanCarId: fixture.body.loanCar.id,
    });
    expect(
      (await mongo.loanCars.findOne({ id: fixture.body.loanCar.id }))!.status,
    ).toBe('allocated');
    await action(id, row.version, 'reassign', {
      assignedTo: admin,
      reason: 'Handover to controller',
    }).expect(403);
    await acceptedAction(id, 'request-authority', {
      description: 'Standard work',
    });
    await acceptedAction(id, 'respond-authority', {
      approved: true,
      responseNote: 'Customer approved by phone',
    });
    row = await acceptedAction(id, 'progress', {
      stage: 'completed',
      roadTestStatus: 'not_required',
    });
    await action(id, row.version, 'collect', { keysReturned: true }).expect(
      409,
    );
    await acceptedAction(id, 'collect', {
      keysReturned: true,
      loanReturned: true,
    });
    expect(
      (await mongo.loanCars.findOne({ id: fixture.body.loanCar.id }))!.status,
    ).toBe('available');
  });
  it('links SMS/email drafts to authorised records, blocks privacy and requires explicit simulated sending', async () => {
    vi.stubEnv('MESSAGE_TRANSPORT', 'simulated');
    const id = await confirmed();
    await mongo.customers.updateOne(
      { id: customer },
      {
        $set: {
          phone: '+61000000000',
          privacy: {
            do_not_contact: false,
            email: 'unknown',
            sms: 'denied',
            call: 'unknown',
          },
        },
      },
    );
    const draft = await post(`customers/${customer}/messages`, {
      siteId: site,
      channel: 'sms',
      body: 'SIMULATED test only',
      repairOrderId: id,
    }).expect(201);
    const path = `messages/${draft.body.message.id}/send`,
      key = randomUUID();
    await post(path, { siteId: site, version: 0 }, advisor, key).expect(403);
    await mongo.customers.updateOne(
      { id: customer },
      { $set: { 'privacy.sms': 'granted' } },
    );
    const sent = await post(
      path,
      { siteId: site, version: 0 },
      advisor,
      key,
    ).expect(202);
    expect(sent.body.message.status).toBe('accepted');
    expect(sent.body.message.transport).toBe('simulated');
    expect(
      (await post(path, { siteId: site, version: 0 }, advisor, key).expect(202))
        .body.replayed,
    ).toBe(true);
    await post(path, { siteId: site, version: 0 }).expect(409);
    await post(`customers/${customer}/messages`, {
      siteId: site,
      channel: 'sms',
      body: 'Wrong link',
      repairOrderId: randomUUID(),
    }).expect(404);
    const another = await post(`customers/${customer}/messages`, {
      siteId: site,
      channel: 'sms',
      body: 'Do not dispatch',
    }).expect(201);
    vi.stubEnv('MESSAGE_TRANSPORT', 'disabled');
    await post(`messages/${another.body.message.id}/send`, {
      siteId: site,
      version: 0,
    }).expect(503);
  });
  it('persists recovery resolutions and RO follow-ups without exposing other staff tasks', async () => {
    const id = await confirmed();
    await mongo.tasks.deleteMany({});
    await mongo.recoveryResolutions.deleteMany({});
    const task = await post(`service/repair-orders/${id}/tasks`, {
      siteId: site,
      title: 'Follow authority',
      dueAt: '2026-01-01T00:00:00Z',
    }).expect(201);
    expect(task.body.task.repair_order_id).toBe(id);
    const queue = await get(`service/recovery?siteId=${site}&limit=100`).expect(
      200,
    );
    const item = queue.body.items.find(
      (r: { kind: string; entityId: string }) =>
        r.kind === 'authority' && r.entityId === id,
    );
    expect(item).toBeDefined();
    const path = `service/recovery/authority/${id}/resolve`;
    await post(path, {
      siteId: site,
      fingerprint: item.fingerprint,
      note: 'Customer contacted',
      followUpAt: '2026-01-01T00:00:00Z',
    }).expect(201);
    expect(
      (await get(`service/recovery?siteId=${site}&kind=authority`).expect(200))
        .body.items,
    ).toEqual([]);
    expect(await mongo.tasks.countDocuments({ customer_id: customer })).toBe(2);
    await get(`service/recovery?siteId=${otherSite}`).expect(403);
  });
  it('isolates reports and template assistance by site, mode and desk permission', async () => {
    await confirmed();
    await get(`management/operational-summary?siteId=${site}`).expect(403);
    const summary = await get(
      `management/operational-summary?siteId=${site}`,
      admin,
    ).expect(200);
    expect(summary.body.metrics.openRepairOrders.total).toBe(1);
    expect(summary.body.metrics.openDeals).not.toHaveProperty('valueCents');
    expect(summary.body.metrics.leadResponseHealth.trend).toEqual([]);
    const template = await post(
      'crm/ai-assist/draft-reply',
      { siteId: site, customerId: customer },
      sales,
    ).expect(200);
    expect(template.body.aiAvailable).toBe(false);
    expect(template.body.draft.body).not.toContain('SIM-RO-');
    await get(`management/audit-export?siteId=${site}`).expect(403);
    const audit = await get(
      `management/audit-export?siteId=${site}&limit=1`,
      admin,
    ).expect(200);
    expect(audit.body.retention.minimumYears).toBe(7);
    await get(
      `customers/${customer}/activity?siteId=${site}&desk=invalid`,
    ).expect(400);
  });
  it('creates simulation-only customer vehicles/relationships with validated site links', async () => {
    const vehicle = {
      siteId: site,
      make: 'SIM',
      model: 'Test',
      year: 2026,
      registration: 'SIM-123',
      vin: 'SIMULATEDVIN000001',
      ownership: 'owned',
    };
    await post(`customers/${customer}/vehicles`, vehicle).expect(403);
    const result = await post(
      `customers/${customer}/vehicles`,
      vehicle,
      admin,
    ).expect(201);
    expect(result.body.vehicle.integration_mode).toBe('simulated');
    const queued = await post(
      'service/repair-orders/simulate-from-appointment',
      {
        siteId: site,
        appointmentId: appointment,
        customerVehicleId: result.body.vehicle.id,
        promisedAt: '2026-01-01T02:00:00Z',
      },
    ).expect(202);
    await orders.processOne(queued.body.command.id);
    expect(
      (await mongo.repairOrders.findOne({
        id: queued.body.command.repair_order_id,
      }))!.vehicle_external_id,
    ).toBe(result.body.vehicle.external_id);
    await post(
      `customers/${customer}/relationships`,
      {
        siteId: site,
        relatedCustomerId: randomUUID(),
        relationType: 'company',
      },
      admin,
    ).expect(404);
    app.get(IntegrationConfig).mode = 'scraping';
    await post(`customers/${customer}/vehicles`, vehicle, admin).expect(503);
    expect(
      (await get(`customers/${customer}/vehicles?siteId=${site}`, admin))
        .status,
    ).toBe(404);
  });
  it('extends delivery preparation with versioned PDI, capacity-safe first service and final handover', async () => {
    const now = new Date().toISOString(),
      leadId = randomUUID(),
      stockId = randomUUID(),
      dealId = randomUUID(),
      planId = randomUUID(),
      bayId = randomUUID();
    let handoverId: string;
    await mongo.salesLeads.insertOne({
      _id: leadId,
      id: leadId,
      organisation_id: org,
      site_id: site,
      customer_id: customer,
      assigned_to: sales,
      created_by: sales,
      title: 'SIM handover',
      source: 'simulated',
      vehicle_interest: null,
      status: 'qualified',
      pipeline_stage: 'quote',
      version: 0,
      created_at: now,
      updated_at: now,
      create_key: randomUUID(),
      create_hash: 'test',
      integration_mode: 'simulated',
    });
    await mongo.stockVehicles.insertOne({
      _id: stockId,
      id: stockId,
      organisation_id: org,
      site_id: site,
      brand_id: brand,
      stock_number: 'SIM-' + stockId,
      make: 'SIM',
      model: 'TEST',
      variant: null,
      year: 2026,
      odometer_km: 0,
      vin: null,
      colour: null,
      body_type: 'sedan',
      fuel_type: 'petrol',
      transmission: 'auto',
      price_cents: null,
      currency: 'AUD',
      status: 'available',
      source: 'simulated',
      integration_mode: 'simulated',
      version: 0,
      created_by: admin,
      created_at: now,
      updated_at: now,
      create_key: randomUUID(),
      create_hash: 'test',
    });
    await mongo.salesDeals.insertOne({
      _id: dealId,
      id: dealId,
      organisation_id: org,
      site_id: site,
      lead_id: leadId,
      customer_id: customer,
      stock_id: stockId,
      brand_id: brand,
      stock_label: 'SIM TEST',
      stock_version: 0,
      appraisal_id: null,
      appraisal_version: null,
      sale_price_cents: 0,
      discount_cents: 0,
      fees_cents: 0,
      trade_in_cents: 0,
      total_cents: 0,
      currency: 'AUD',
      status: 'approved',
      notes: 'Simulation fixture',
      reviewed_by: admin,
      reviewed_at: now,
      review_note: 'Fixture',
      created_by: sales,
      created_at: now,
      updated_at: now,
      version: 0,
      source: 'local',
      integration_mode: 'simulated',
      create_key: randomUUID(),
      create_hash: 'test',
    });
    const checklist = emptyChecklist();
    for (const value of Object.values(checklist)) value.complete = true;
    checklist.vehicle_preparation.complete = false;
    await mongo.deliveries.insertOne({
      _id: planId,
      id: planId,
      organisation_id: org,
      site_id: site,
      lead_id: leadId,
      customer_id: customer,
      deal_id: dealId,
      deal_version: 0,
      stock_id: stockId,
      stock_label: 'SIM TEST',
      brand_id: brand,
      scheduled_at: now,
      notes: 'Simulation fixture',
      status: 'planned',
      checklist,
      created_by: sales,
      created_at: now,
      updated_at: now,
      version: 0,
      integration_mode: 'simulated',
      create_key: randomUUID(),
      create_hash: 'test',
    });
    const holdId = randomUUID();
    await mongo.reservations.insertOne({
      _id: holdId,
      id: holdId,
      organisation_id: org,
      site_id: site,
      lead_id: leadId,
      customer_id: customer,
      deal_id: dealId,
      stock_id: stockId,
      brand_id: brand,
      status: 'active',
      expires_at: '2099-01-01T00:00:00Z',
      ended_at: null,
      reason: 'Fixture',
      created_by: sales,
      version: 0,
      created_at: now,
      updated_at: now,
      integration_mode: 'simulated',
      create_key: randomUUID(),
      create_hash: 'test',
    });
    await request(app.getHttpServer())
      .patch(`/api/sales/pipeline/${leadId}/stage`)
      .set('Authorization', 'Bearer ' + sales)
      .send({
        siteId: site,
        version: 0,
        stage: 'order',
        reason: 'SIM approved order ready for Service preparation',
      })
      .expect(200);
    const automatic = await mongo.handoverItems.findOne({ deal_id: dealId });
    expect(automatic).not.toBeNull();
    handoverId = automatic!.id;
    expect(automatic!.pdi_task_id).toBeTruthy();
    await mongo.workshopResources.insertOne({
      _id: bayId,
      id: bayId,
      organisation_id: org,
      site_id: site,
      name: 'Handover test ' + bayId,
      active: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      open_minute: 0,
      close_minute: 1440,
      version: 0,
      booking_revision: 0,
      created_by: admin,
      created_at: now,
      updated_at: now,
      create_key: randomUUID(),
      create_hash: 'test',
    });
    const path = `service/handover-lane/${handoverId}`;
    await post(
      path + '/pdi',
      { siteId: site, version: 0, status: 'completed' },
      peer,
    ).expect(403);
    await post(
      path + '/complete',
      { siteId: site, version: 0, notes: 'Premature handover' },
      sales,
    ).expect(409);
    await post(path + '/pdi', {
      siteId: site,
      version: 0,
      status: 'invalid',
    }).expect(400);
    await post(path + '/pdi', {
      siteId: site,
      version: 0,
      status: 'completed',
      notes: 'Inspection passed',
    }).expect(200);
    await post(path + '/accessories', {
      siteId: site,
      version: 1,
      status: 'ready',
    }).expect(200);
    expect(
      (await mongo.deliveries.findOne({ id: planId }))!.checklist
        .vehicle_preparation.complete,
    ).toBe(true);
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 3);
    start.setUTCHours(0, 0, 0, 0);
    const body = {
      siteId: site,
      version: 2,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 30 * 60000).toISOString(),
      resourceId: bayId,
    };
    const key = randomUUID();
    await post(path + '/first-service-booking', body, advisor, key).expect(200);
    await post(path + '/first-service-booking', body, advisor, key).expect(200);
    expect(
      await mongo.serviceAppointments.countDocuments({ create_key: key }),
    ).toBe(1);
    await post(
      path + '/complete',
      { siteId: site, version: 3, notes: 'Vehicle handed over to customer' },
      sales,
    ).expect(200);
    expect(
      (await mongo.handoverItems.findOne({ id: handoverId }))!.status,
    ).toBe('completed');
    expect(
      (await mongo.deliveries.findOne({ id: planId }))!.handed_over_at,
    ).toBeTruthy();
    await post(path + '/pdi', {
      siteId: site,
      version: 4,
      status: 'pending',
    }).expect(409);
    expect(
      (await mongo.salesLeads.findOne({ id: leadId }))!.pipeline_stage,
    ).toBe('delivered');
  });
  it('mirrors internal activity idempotently and exposes uncertain/rejected source outcomes', async () => {
    const key = randomUUID();
    const note = await post(
      `customers/${customer}/notes`,
      { siteId: site, text: 'SIM internal note for source mirroring' },
      advisor,
      key,
    ).expect(201);
    await post(
      `customers/${customer}/notes`,
      { siteId: site, text: 'SIM internal note for source mirroring' },
      advisor,
      key,
    ).expect(201);
    expect(
      await mongo.activityMirrors.countDocuments({ id: note.body.entry.id }),
    ).toBe(1);
    expect(
      (await app.get(ActivityMirrorService).processOne(note.body.entry.id))!
        .command.status,
    ).toBe('succeeded');
    expect(
      await mongo.simulatedActivities.countDocuments({
        _id: note.body.entry.id,
      }),
    ).toBe(1);
    expect(
      await app.get(ActivityMirrorService).processOne(note.body.entry.id),
    ).toBeNull();
    const unknown = await post(`customers/${customer}/notes`, {
      siteId: site,
      text: 'SIM uncertain mirror',
    }).expect(201);
    await mongo.simulatorBehaviors.insertOne({
      organisation_id: org,
      site_id: site,
      behavior: 'unknown',
      remaining: 1,
    });
    await app.get(ActivityMirrorService).processOne(unknown.body.entry.id);
    await post(`management/activity-mirrors/${unknown.body.entry.id}/retry`, {
      siteId: site,
      note: 'Verified not applied',
      confirmedNotApplied: true,
    }).expect(403);
    await post(
      `management/activity-mirrors/${unknown.body.entry.id}/retry`,
      { siteId: site, note: 'Verified not applied', confirmedNotApplied: true },
      admin,
    ).expect(202);
    await post(
      `management/activity-mirrors/${unknown.body.entry.id}/process`,
      { siteId: site },
      admin,
    ).expect(200);
    const list = await get(
      `customers/${customer}/activity-mirrors?siteId=${site}`,
    ).expect(200);
    expect(list.body.commands.every((c: object) => !('request' in c))).toBe(
      true,
    );
  });
  it('reconciles only accepted simulated customer receipts and reports field conflicts', async () => {
    const queued = await post('customers', {
      siteId: site,
      firstName: 'SIM',
      lastName: 'Reconcile',
      email: 'reconcile@example.test',
    }).expect(202);
    const integration = app.get(IntegrationService);
    const done = await integration.processOne(queued.body.command.id);
    expect(done!.command.status).toBe('succeeded');
    const result = await post(
      'management/simulated-reconcile',
      { siteId: site },
      admin,
    ).expect(200);
    expect(result.body.checked).toBeGreaterThan(0);
    await mongo.customers.updateOne(
      { id: done!.customer!.id },
      { $set: { first_name: 'Conflicting cache edit' } },
    );
    const conflict = await post(
      'management/simulated-reconcile',
      { siteId: site },
      admin,
    ).expect(200);
    expect(conflict.body.conflicts).toBeGreaterThan(0);
    expect(
      await mongo.auditEvents.countDocuments({
        action: 'integration.reconciliation_conflict',
      }),
    ).toBeGreaterThan(0);
  });
  it('keeps local warm customer-profile responses within the two-second target', async () => {
    await get(`customers/${customer}?siteId=${site}`).expect(200);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await get(`customers/${customer}?siteId=${site}`).expect(200);
      samples.push(performance.now() - start);
    }
    const max = Math.max(...samples);
    expect(max).toBeLessThan(2000);
    console.info(
      `Local warm customer-profile API: maximum ${Math.round(max)}ms over 5 reads; excludes browser rendering and production network latency.`,
    );
  });
});
