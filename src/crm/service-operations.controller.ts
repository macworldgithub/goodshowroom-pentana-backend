import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AccessService } from '../auth/access.service.js';
import { text, uuid } from '../auth/validation.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord, type Task } from '../database/models.js';
import { pagination, pageResult, ApiPagination } from '../pagination.js';
import { RepairOrdersService } from './repair-orders.service.js';
import { repairOrderPromise } from './repair-order-lifecycle.js';

@Controller('service')
@ApiTags('Service operations')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class ServiceOperationsController {
  constructor(
    @Inject(RepairOrdersService) private readonly orders: RepairOrdersService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  @Get('repair-orders/loan-cars')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async loans(
    @Req() req: AuthenticatedRequest,
    @Query() q: Record<string, string>,
  ) {
    const scope = await this.orders.scope(req, uuid(q.siteId, 'siteId'));
    const { assigned_to: _own, ...filter } = scope;
    const page = pagination(q.offset, q.limit);
    const result = pageResult(
      await this.orders.mongo.loanCars
        .find(filter)
        .sort({ registration: 1, id: 1 })
        .skip(page.offset)
        .limit(page.limit + 1)
        .toArray(),
      page,
    );
    return {
      loanCars: result.rows.map(publicRecord),
      pagination: result.pagination,
    };
  }
  @Post('repair-orders/loan-cars')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        siteId: { type: 'string' },
        brandId: { type: 'string' },
        make: { type: 'string' },
        model: { type: 'string' },
        year: { type: 'integer' },
        registration: { type: 'string' },
      },
    },
  })
  async seedLoan(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() b: Record<string, unknown>,
  ) {
    if (!this.orders.capabilities().writesEnabled)
      throw new ServiceUnavailableException(
        'Loan-car fixtures are simulation only',
      );
    const siteId = uuid(b.siteId, 'siteId'),
      brandId = uuid(b.brandId, 'brandId'),
      createKey = text(key, 'Idempotency-Key', 8, 200);
    return this.orders.mongo.transaction(async (session) => {
      const site = await this.access.requireSite(
        req,
        siteId,
        'users.manage',
        session,
      );
      await this.access.requireBrand(
        req,
        siteId,
        brandId,
        'service.write',
        session,
      );
      if (
        !Number.isInteger(b.year) ||
        Number(b.year) < 1900 ||
        Number(b.year) > 2100
      )
        throw new BadRequestException('Invalid year');
      const data = {
        brand_id: brandId,
        make: text(b.make, 'make', 1, 50),
        model: text(b.model, 'model', 1, 50),
        year: Number(b.year),
        registration: text(b.registration, 'registration', 1, 20).toUpperCase(),
      };
      await this.orders.mongo.organisations.updateOne(
        { id: site.organisation_id },
        { $inc: { access_revision: 1 } },
        { session },
      );
      const previous = await this.orders.mongo.loanCars.findOne(
        { site_id: siteId, create_key: createKey },
        { session },
      );
      if (previous) {
        if (
          Object.entries(data).some(
            ([k, v]) => previous[k as keyof typeof previous] !== v,
          )
        )
          throw new ConflictException('Fixture key reused');
        return { loanCar: publicRecord(previous) };
      }
      const id = randomUUID(),
        now = new Date().toISOString();
      const row = {
        _id: id,
        id,
        organisation_id: site.organisation_id,
        site_id: siteId,
        ...data,
        status: 'available' as const,
        integration_mode: 'simulated' as const,
        create_key: createKey,
        created_at: now,
        updated_at: now,
      };
      await this.orders.mongo.loanCars.insertOne(row, { session });
      await this.audit.record(
        session,
        req.user!.id,
        site.organisation_id,
        siteId,
        'service.loan_fixture_created',
        'loan_car',
        id,
        { mode: 'simulated' },
      );
      return { loanCar: publicRecord(row) };
    });
  }
  private async candidates(
    req: AuthenticatedRequest,
    siteId: string,
    session?: ClientSession,
  ) {
    const scope = await this.orders.scope(req, siteId, 'service.read', session);
    const serviceTeam = await this.access.hasSitePermission(
      req,
      siteId,
      'service.view_team',
      session,
    );
    const now = new Date().toISOString();
    const tasksRead = await this.access.hasSitePermission(
      req,
      siteId,
      'tasks.read',
      session,
    );
    const tasksTeam =
      tasksRead &&
      (await this.access.hasSitePermission(
        req,
        siteId,
        'tasks.view_team',
        session,
      ));
    const [appointments, ros, tasks, calls] = await Promise.all([
      this.orders.mongo.serviceAppointments
        .find(
          {
            ...scope,
            status: { $in: ['booked', 'confirmed', 'no_show'] },
            starts_at: {
              $lte: new Date(Date.now() + 7 * 86400000).toISOString(),
            },
          },
          { session },
        )
        .toArray(),
      this.orders.mongo.repairOrders
        .find(
          { ...scope, collection: null, status: { $ne: 'invoiced' } },
          { session },
        )
        .toArray(),
      tasksRead
        ? this.orders.mongo.tasks
            .find(
              {
                organisation_id: scope.organisation_id,
                site_id: siteId,
                ...this.orders.integration.projectionFilter(),
                ...(tasksTeam ? {} : { assigned_to: req.user!.id }),
                completed_at: null,
                cancelled_at: null,
                due_at: { $lt: now },
              },
              { session },
            )
            .toArray()
        : [],
      this.orders.mongo.customerJournal
        .find(
          {
            organisation_id: scope.organisation_id,
            site_id: siteId,
            ...this.orders.integration.projectionFilter(),
            ...(serviceTeam ? {} : { created_by: req.user!.id }),
            kind: 'call',
            outcome: { $in: ['no_answer', 'voicemail', 'busy'] },
          },
          { session },
        )
        .toArray(),
    ]);
    const rows: {
      kind: string;
      entityId: string;
      customerId: string;
      title: string;
      dueAt: string;
      fingerprint: string;
      repairOrderId?: string;
    }[] = [];
    const add = (
      kind: string,
      id: string,
      customerId: string,
      title: string,
      dueAt: string,
      fingerprint: string,
      repairOrderId?: string,
    ) =>
      rows.push({
        kind,
        entityId: id,
        customerId,
        title,
        dueAt,
        fingerprint,
        repairOrderId,
      });
    for (const a of appointments) {
      if (a.status === 'no_show')
        add('no_show', a.id, a.customer_id, a.title, a.starts_at, a.updated_at);
      else if (a.starts_at < now)
        add(
          'missed_booking',
          a.id,
          a.customer_id,
          a.title,
          a.starts_at,
          a.updated_at,
        );
      else if (a.status === 'booked')
        add(
          'unconfirmed',
          a.id,
          a.customer_id,
          a.title,
          a.starts_at,
          a.updated_at,
        );
    }
    for (const ro of ros) {
      if (ro.status === 'waiting_authority')
        add(
          'authority',
          ro.id,
          ro.customer_id,
          ro.number,
          ro.promised_at,
          ro.updated_at,
          ro.id,
        );
      if (ro.promised_at < now && ro.status !== 'ready')
        add(
          'missed_promise',
          ro.id,
          ro.customer_id,
          ro.number,
          ro.promised_at,
          ro.updated_at,
          ro.id,
        );
      if (ro.authority_request?.status === 'declined')
        add(
          'declined_work',
          ro.id,
          ro.customer_id,
          ro.authority_request.description,
          ro.promised_at,
          ro.updated_at,
          ro.id,
        );
    }
    for (const t of tasks)
      add(
        'missed_promise',
        t.id,
        t.customer_id,
        t.title,
        t.due_at,
        t.updated_at,
      );
    for (const c of calls)
      add(
        'unanswered',
        c.id,
        c.customer_id,
        c.text,
        c.occurred_at,
        c.created_at,
      );
    const customers = await this.orders.mongo.customers
      .find({
        organisation_id: scope.organisation_id,
        site_id: siteId,
        ...this.orders.integration.projectionFilter(),
        id: { $in: rows.map((r) => r.customerId) },
      })
      .toArray();
    return rows
      .filter((r) => customers.some((c) => c.id === r.customerId))
      .map((r) => ({
        ...r,
        customerName: customers
          .filter((c) => c.id === r.customerId)
          .map((c) => `${c.first_name} ${c.last_name}`)[0],
      }));
  }
  @Get('recovery')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'kind', required: false })
  async recovery(
    @Req() req: AuthenticatedRequest,
    @Query() q: Record<string, string>,
  ) {
    const siteId = uuid(q.siteId, 'siteId');
    const rows = await this.candidates(req, siteId);
    const page = pagination(q.offset, q.limit);
    const resolved = await this.orders.mongo.recoveryResolutions
      .find({
        site_id: siteId,
        entity_id: { $in: rows.map((r) => r.entityId) },
      })
      .toArray();
    const open = rows
      .filter(
        (r) =>
          (!q.kind || r.kind === q.kind) &&
          !resolved.some(
            (s) =>
              s.entity_id === r.entityId &&
              s.kind === r.kind &&
              s.fingerprint === r.fingerprint,
          ),
      )
      .sort(
        (a, b) =>
          a.dueAt.localeCompare(b.dueAt) ||
          a.entityId.localeCompare(b.entityId) ||
          a.kind.localeCompare(b.kind),
      );
    const result = pageResult(
      open.slice(page.offset, page.offset + page.limit + 1),
      page,
    );
    return {
      items: result.rows,
      pagination: result.pagination,
      total: open.length,
    };
  }
  @Get('recovery/history')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async recoveryHistory(
    @Req() req: AuthenticatedRequest,
    @Query() q: Record<string, string>,
  ) {
    const siteId = uuid(q.siteId, 'siteId');
    const site = await this.access.requireSite(req, siteId, 'service.read');
    const team = await this.access.hasSitePermission(
        req,
        siteId,
        'service.view_team',
      ),
      page = pagination(q.offset, q.limit);
    const result = pageResult(
      await this.orders.mongo.recoveryResolutions
        .find({
          organisation_id: site.organisation_id,
          site_id: siteId,
          ...this.orders.integration.projectionFilter(),
          ...(team ? {} : { resolved_by: req.user!.id }),
          ...(q.customerId
            ? { customer_id: uuid(q.customerId, 'customerId') }
            : {}),
        })
        .sort({ created_at: -1, id: 1 })
        .skip(page.offset)
        .limit(page.limit + 1)
        .toArray(),
      page,
    );
    return {
      resolutions: result.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        customerId: r.customer_id,
        note: r.note,
        resolvedAt: r.created_at,
        resolvedBy: r.resolved_by,
      })),
      pagination: result.pagination,
    };
  }
  @Post('recovery/:kind/:id/resolve')
  @HttpCode(201)
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        siteId: { type: 'string' },
        fingerprint: { type: 'string' },
        note: { type: 'string' },
        followUpAt: { type: 'string' },
      },
    },
  })
  async resolve(
    @Req() req: AuthenticatedRequest,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() b: Record<string, unknown>,
  ) {
    const siteId = uuid(b.siteId, 'siteId');
    uuid(id, 'entityId');
    const note = text(b.note, 'note', 3, 2000);
    const fingerprint = text(b.fingerprint, 'fingerprint', 1, 100);
    const item = (await this.candidates(req, siteId)).find(
      (r) =>
        r.kind === kind && r.entityId === id && r.fingerprint === fingerprint,
    );
    if (!item)
      throw new ConflictException('Recovery item changed or is unavailable');
    return this.orders.mongo.transaction(async (session) => {
      const site = await this.access.requireSite(
        req,
        siteId,
        'service.write',
        session,
      );
      await this.orders.mongo.organisations.updateOne(
        { id: site.organisation_id },
        { $inc: { access_revision: 1 } },
        { session },
      );
      const current = (await this.candidates(req, siteId, session)).find(
        (r) =>
          r.kind === kind && r.entityId === id && r.fingerprint === fingerprint,
      );
      if (!current)
        throw new ConflictException('Recovery item changed; refresh');
      const filter = {
        organisation_id: site.organisation_id,
        site_id: siteId,
        kind,
        entity_id: id,
        fingerprint,
      };
      const prior = await this.orders.mongo.recoveryResolutions.findOne(
        filter,
        { session },
      );
      if (prior) return { resolution: publicRecord(prior), replayed: true };
      let taskId: string | undefined;
      const now = new Date().toISOString();
      if (b.followUpAt) {
        await this.access.requireSite(req, siteId, 'tasks.write', session);
        taskId = randomUUID();
        const task: Task = {
          _id: taskId,
          id: taskId,
          organisation_id: site.organisation_id,
          site_id: siteId,
          customer_id: item.customerId,
          created_by: req.user!.id,
          assigned_to: req.user!.id,
          title: `Recovery: ${item.title}`.slice(0, 180),
          details: note,
          due_at: repairOrderPromise(b.followUpAt),
          priority: 'high',
          kind: 'follow_up',
          completed_at: null,
          created_at: now,
          updated_at: now,
          version: 0,
          ...(this.orders.integration.config.mode === 'simulated'
            ? { integration_mode: 'simulated' as const }
            : {}),
          ...(item.repairOrderId
            ? { repair_order_id: item.repairOrderId }
            : {}),
        };
        await this.orders.mongo.tasks.insertOne(task, { session });
        await this.audit.record(
          session,
          req.user!.id,
          site.organisation_id,
          siteId,
          'task.created',
          'task',
          taskId,
        );
      }
      const rowId = randomUUID();
      const row = {
        _id: rowId,
        id: rowId,
        ...filter,
        ...(this.orders.integration.config.mode === 'simulated'
          ? { integration_mode: 'simulated' as const }
          : this.orders.integration.config.mode === 'scraping'
            ? { integration_mode: 'scraping' as const }
            : {}),
        customer_id: item.customerId,
        note,
        resolved_by: req.user!.id,
        created_at: now,
        ...(taskId ? { follow_up_task_id: taskId } : {}),
      };
      await this.orders.mongo.recoveryResolutions.insertOne(row, { session });
      await this.audit.record(
        session,
        req.user!.id,
        site.organisation_id,
        siteId,
        'customer.service_recovery_resolved',
        'customer',
        item.customerId,
        { kind, entity_id: id, note },
      );
      return { resolution: publicRecord(row), replayed: false };
    });
  }
  @Post('repair-orders/:id/tasks')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        siteId: { type: 'string' },
        title: { type: 'string' },
        dueAt: { type: 'string' },
      },
    },
  })
  async task(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() b: Record<string, unknown>,
  ) {
    const siteId = uuid(b.siteId, 'siteId');
    const row = await this.orders.order(req, siteId, uuid(id, 'repairOrderId'));
    await this.access.requireSite(req, siteId, 'tasks.write');
    const title = text(b.title, 'title', 2, 180),
      due = repairOrderPromise(b.dueAt);
    return this.orders.mongo.transaction(async (session) => {
      await this.orders.order(req, siteId, id, 'service.read', session);
      await this.access.requireSite(req, siteId, 'tasks.write', session);
      const taskId = randomUUID(),
        now = new Date().toISOString();
      const task: Task = {
        _id: taskId,
        id: taskId,
        organisation_id: row.organisation_id,
        site_id: siteId,
        customer_id: row.customer_id,
        created_by: req.user!.id,
        assigned_to: req.user!.id,
        title,
        details: row.number,
        repair_order_id: id,
        due_at: due,
        priority: 'high',
        completed_at: null,
        created_at: now,
        updated_at: now,
        version: 0,
        integration_mode: row.integration_mode,
      };
      await this.orders.mongo.tasks.insertOne(task, { session });
      await this.audit.record(
        session,
        req.user!.id,
        row.organisation_id,
        siteId,
        'task.created',
        'task',
        taskId,
      );
      return { task: publicRecord(task) };
    });
  }
}
