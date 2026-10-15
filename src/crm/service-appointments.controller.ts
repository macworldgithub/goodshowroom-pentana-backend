import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { AccessService, grantsForBrand } from '../auth/access.service.js';
import { permissionsFor } from '../auth/permissions.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord, type ServiceAppointment } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { WorkshopService } from './workshop.service.js';

const states = ['booked', 'confirmed', 'cancelled', 'attended', 'no_show'];
const schema = { type: 'object' as const, properties: {
  siteId: { type: 'string', format: 'uuid' }, customerId: { type: 'string', format: 'uuid' },
  brandId: { type: 'string', format: 'uuid' }, assignedTo: { type: 'string', format: 'uuid' },
  resourceId: { type: 'string', format: 'uuid' },
  title: { type: 'string' }, vehicle: { type: 'string' }, notes: { type: 'string' },
  startsAt: { type: 'string', format: 'date-time' }, endsAt: { type: 'string', format: 'date-time' },
  version: { type: 'integer', minimum: 0 }, status: { type: 'string', enum: states }, outcomeNote: { type: 'string' },
} };
export function appointmentWindow(start: unknown, end: unknown) {
  const parse = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
      throw new BadRequestException('Appointment times must be timestamps with a timezone');
    return new Date(value).toISOString();
  };
  const starts_at = parse(start); const ends_at = parse(end);
  const minutes = (Date.parse(ends_at) - Date.parse(starts_at)) / 60000;
  if (minutes < 15 || minutes > 480) throw new BadRequestException('Appointment duration must be between 15 minutes and 8 hours');
  return { starts_at, ends_at };
}
function future(start: string) {
  if (Date.parse(start) <= Date.now() || Date.parse(start) > Date.now() + 365 * 86400000) throw new BadRequestException('Book within the next 365 days');
}
@Controller('service/appointments')
@ApiTags('Service appointments')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class ServiceAppointmentsController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(WorkshopService) private readonly workshop: WorkshopService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntegrationService) private readonly integration: IntegrationService) {}
  private publicAppointment(row: ServiceAppointment) {
    const { create_key: _key, create_hash: _hash, ...result } = publicRecord(row); return result;
  }
  private async scope(request: AuthenticatedRequest, siteId: string, permission: string, session?: ClientSession) {
    const site = await this.access.requireSite(request, siteId, permission, session);
    const grants = await this.access.memberships(request, session);
    const brands = (site.brand_ids ?? []).filter(id => permissionsFor(grantsForBrand(grants, site, id)).includes(permission));
    const team = await this.access.hasSitePermission(request, siteId, 'service.view_team', session);
    return { organisation_id: site.organisation_id, site_id: siteId, ...this.integration.projectionFilter(),
      brand_id: { $in: brands }, ...(team ? {} : { assigned_to: request.user!.id }) };
  }
  private async assignee(request: AuthenticatedRequest, userId: string, siteId: string, brandId: string, session: ClientSession) {
    await this.access.requireBrand({ user: { id: userId } } as AuthenticatedRequest, siteId, brandId, 'service.write', session);
    if (userId !== request.user!.id) await this.access.requireSite(request, siteId, 'service.assign_work', session);
  }
  @Get()
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'status', required: false, enum: states })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive ISO timestamp' })
  @ApiQuery({ name: 'to', required: false, description: 'Exclusive ISO timestamp' })
  async list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, string>) {
    const siteId = uuid(query.siteId, 'siteId'); const scope = await this.scope(request, siteId, 'service.read');
    if (query.status && !states.includes(query.status)) throw new BadRequestException('Invalid appointment status');
    const range: Record<string, string> = {};
    for (const [field, operator] of [['from', '$gte'], ['to', '$lt']]) {
      if (query[field] !== undefined) {
        if (!Number.isFinite(Date.parse(query[field]))) throw new BadRequestException('Invalid date range');
        range[operator] = new Date(query[field]).toISOString();
      }
    }
    if (range.$gte && range.$lt && range.$gte >= range.$lt) throw new BadRequestException('from must precede to');
    const page = pagination(query.offset, query.limit);
    const rows = await this.mongo.serviceAppointments.find({ ...scope,
      ...(query.status ? { status: query.status as ServiceAppointment['status'] } : {}),
      ...(query.customerId ? { customer_id: uuid(query.customerId, 'customerId') } : {}),
      ...(Object.keys(range).length ? { starts_at: range } : {}),
    }).sort({ starts_at: 1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray();
    const result = pageResult(rows, page);
    return { appointments: result.rows.map(row => this.publicAppointment(row)), pagination: result.pagination,
      visibility: await this.access.hasSitePermission(request, siteId, 'service.view_team') ? 'team' : 'own' };
  }
  @Get(':id')
  @ApiQuery({ name: 'siteId', required: true })
  async detail(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('siteId') siteId: string) {
    const row = await this.mongo.serviceAppointments.findOne({ ...await this.scope(request, uuid(siteId, 'siteId'), 'service.read'), id: uuid(id, 'appointmentId') });
    if (!row) throw new NotFoundException('Appointment is unavailable');
    return { appointment: this.publicAppointment(row) };
  }
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema })
  async create(@Req() request: AuthenticatedRequest, @Headers('idempotency-key') key: string, @Body() body: Record<string, unknown>) {
    if (Object.keys(body).some(field => !['siteId', 'customerId', 'brandId', 'resourceId', 'assignedTo', 'title', 'vehicle', 'notes', 'startsAt', 'endsAt'].includes(field))) throw new BadRequestException('Unsupported appointment field');
    const siteId = uuid(body.siteId, 'siteId'); const customerId = uuid(body.customerId, 'customerId');
    const brandId = uuid(body.brandId, 'brandId'); const assignedTo = body.assignedTo === undefined ? request.user!.id : uuid(body.assignedTo, 'assignedTo');
    const resourceId = uuid(body.resourceId, 'resourceId');
    const fields = { title: text(body.title, 'title', 2, 180), vehicle: text(body.vehicle, 'vehicle', 2, 300),
      notes: body.notes == null || body.notes === '' ? '' : text(body.notes, 'notes', 1, 2000), ...appointmentWindow(body.startsAt, body.endsAt) };
    const createKey = text(key, 'Idempotency-Key', 8, 200);
    const hash = createHash('sha256').update(JSON.stringify({ siteId, customerId, brandId, resourceId, assignedTo, ...fields })).digest('hex');
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'service.write', session);
      await this.access.requireBrand(request, siteId, brandId, 'service.write', session);
      const existing = await this.mongo.serviceAppointments.findOne({ organisation_id: site.organisation_id, created_by: request.user!.id, create_key: createKey }, { session });
      if (existing) {
        if (existing.create_hash !== hash) throw new ConflictException('Idempotency key already used for a different appointment');
        const visible = await this.mongo.serviceAppointments.findOne({ ...await this.scope(request, siteId, 'service.read', session), id: existing.id }, { session });
        if (!visible) throw new NotFoundException('Appointment is unavailable');
        return { appointment: this.publicAppointment(existing) };
      }
      future(fields.starts_at);
      await this.assignee(request, assignedTo, siteId, brandId, session);
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id: customerId, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!customer) throw new BadRequestException('Customer is unavailable at this site');
      await this.workshop.reserve(siteId, site.organisation_id, resourceId, fields.starts_at, fields.ends_at, site.timezone, session);
      const now = new Date().toISOString(); const id = randomUUID();
      const row: ServiceAppointment = { _id: id, id, organisation_id: site.organisation_id, site_id: siteId, customer_id: customerId,
        brand_id: brandId, resource_id: resourceId, assigned_to: assignedTo, created_by: request.user!.id, ...fields, status: 'booked', outcome_note: null,
        version: 0, created_at: now, updated_at: now, create_key: createKey, create_hash: hash,
        ...(customer.integration_mode ? { integration_mode: customer.integration_mode } : {}) };
      await this.mongo.serviceAppointments.insertOne(row, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'service.appointment_created', 'service_appointment', id, { customer_id: customerId });
      return { appointment: this.publicAppointment(row) };
    });
  }
  @Patch(':id')
  @ApiBody({ schema })
  async edit(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'appointmentId'); const siteId = uuid(body.siteId, 'siteId');
    if (Object.keys(body).some(field => !['siteId', 'version', 'resourceId', 'assignedTo', 'title', 'vehicle', 'notes', 'startsAt', 'endsAt', 'status', 'outcomeNote'].includes(field))) throw new BadRequestException('Unsupported appointment field');
    if (!Number.isInteger(body.version) || Number(body.version) < 0) throw new BadRequestException('Provide the current version');
    return this.mongo.transaction(async session => {
      const scope = await this.scope(request, siteId, 'service.write', session);
      const row = await this.mongo.serviceAppointments.findOne({ ...scope, id }, { session });
      if (!row) throw new NotFoundException('Appointment is unavailable');
      if (row.version !== body.version) throw new ConflictException('Appointment changed; refresh before editing');
      if (['cancelled', 'attended', 'no_show'].includes(row.status)) throw new ConflictException('Closed appointments cannot be edited; book a new appointment');
      const changes: Partial<ServiceAppointment> = {};
      if (body.resourceId !== undefined) { changes.resource_id = uuid(body.resourceId, 'resourceId'); changes.status = 'booked'; }
      if (body.title !== undefined) changes.title = text(body.title, 'title', 2, 180);
      if (body.vehicle !== undefined) changes.vehicle = text(body.vehicle, 'vehicle', 2, 300);
      if (body.notes !== undefined) changes.notes = body.notes === '' ? '' : text(body.notes, 'notes', 1, 2000);
      if (body.startsAt !== undefined || body.endsAt !== undefined) {
        Object.assign(changes, appointmentWindow(body.startsAt, body.endsAt)); future(changes.starts_at!);
        changes.status = 'booked';
      }
      if (body.assignedTo !== undefined) {
        changes.assigned_to = uuid(body.assignedTo, 'assignedTo');
        await this.assignee(request, changes.assigned_to, siteId, row.brand_id, session);
        if (changes.assigned_to !== row.assigned_to) await this.access.requireSite(request, siteId, 'service.assign_work', session);
      }
      if (body.status !== undefined) {
        if (!states.includes(body.status as string) || body.status === 'booked') throw new BadRequestException('Use rescheduling to return to booked');
        if (changes.starts_at || changes.resource_id) throw new BadRequestException('Reschedule separately from changing status');
        changes.status = body.status as ServiceAppointment['status'];
        if (['attended', 'no_show'].includes(changes.status) && Date.parse(row.starts_at) > Date.now()) throw new BadRequestException('Attendance cannot be recorded before the appointment starts');
        if (changes.status !== 'confirmed') changes.outcome_note = text(body.outcomeNote, 'outcomeNote', 3, 2000);
      } else if (body.outcomeNote !== undefined) throw new BadRequestException('outcomeNote requires an outcome status');
      if (!Object.keys(changes).length) throw new BadRequestException('Provide an appointment change');
      const site = await this.access.requireSite(request, siteId, 'service.write', session);
      const resourceId = changes.resource_id ?? row.resource_id;
      const closing = changes.status && ['cancelled', 'attended', 'no_show'].includes(changes.status);
      if (row.resource_id && (closing || changes.resource_id && changes.resource_id !== row.resource_id)) await this.workshop.lock(siteId, row.organisation_id, row.resource_id, session);
      if (!closing && (changes.starts_at || changes.resource_id || changes.status === 'confirmed')) {
        if (!resourceId) throw new BadRequestException('Assign a workshop resource before confirming or rescheduling this legacy booking');
        await this.workshop.reserve(siteId, row.organisation_id, resourceId, changes.starts_at ?? row.starts_at, changes.ends_at ?? row.ends_at, site.timezone, session, id);
      }
      changes.updated_at = new Date().toISOString();
      const updated = await this.mongo.serviceAppointments.findOneAndUpdate({ ...scope, id, version: Number(body.version) },
        { $set: changes, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!updated) throw new ConflictException('Appointment changed; refresh before editing');
      const action = changes.starts_at || changes.resource_id ? 'service.appointment_rescheduled' : changes.status && changes.status !== row.status ? 'service.appointment_' + changes.status : 'service.appointment_updated';
      await this.audit.record(session, request.user!.id, row.organisation_id, siteId, action, 'service_appointment', id, { customer_id: row.customer_id });
      return { appointment: this.publicAppointment(updated) };
    });
  }
}


