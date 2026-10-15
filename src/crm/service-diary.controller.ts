import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import { AccessService, grantsForBrand } from '../auth/access.service.js';
import { permissionsFor } from '../auth/permissions.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import { AuditService } from '../database/audit.service.js';
import { MongoService } from '../database/mongo.service.js';
import { publicRecord, type ServiceAppointment, type WorkshopResource } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { dayWindow } from './day-window.js';
import { withinWorkshopHours, workshopHours, WorkshopService } from './workshop.service.js';
const resourceSchema = { type: 'object' as const, properties: { siteId: { type: 'string', format: 'uuid' }, name: { type: 'string' },
  days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } }, openMinute: { type: 'integer' }, closeMinute: { type: 'integer' },
  active: { type: 'boolean' }, version: { type: 'integer' } } };
@Controller('service')
@ApiTags('Service diary and workshop')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class ServiceDiaryController {
  constructor(@Inject(AccessService) private readonly access: AccessService, @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService, @Inject(WorkshopService) private readonly workshop: WorkshopService,
    @Inject(IntegrationService) private readonly integration: IntegrationService) {}
  private resource(row: WorkshopResource) {
    const { create_key: _key, create_hash: _hash, booking_revision: _lock, ...result } = publicRecord(row); return result;
  }
  @Get('resources')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async resources(@Req() request: AuthenticatedRequest, @Query() query: Record<string, string>) {
    const siteId = uuid(query.siteId, 'siteId'); const site = await this.access.requireSite(request, siteId, 'service.read');
    const page = pagination(query.offset, query.limit);
    const result = pageResult(await this.mongo.workshopResources.find({ organisation_id: site.organisation_id, site_id: siteId })
      .sort({ name: 1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
    return { resources: result.rows.map(row => this.resource(row)), pagination: result.pagination };
  }
  @Post('resources')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: resourceSchema })
  async create(@Req() request: AuthenticatedRequest, @Headers('idempotency-key') key: string, @Body() body: Record<string, unknown>) {
    if (Object.keys(body).some(field => !['siteId', 'name', 'days', 'openMinute', 'closeMinute'].includes(field))) throw new BadRequestException('Unsupported resource field');
    const siteId = uuid(body.siteId, 'siteId'); const name = text(body.name, 'name', 2, 100); const hours = workshopHours(body);
    const createKey = text(key, 'Idempotency-Key', 8, 200); const hash = createHash('sha256').update(JSON.stringify({ siteId, name, ...hours })).digest('hex');
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'service.resources_manage', session);
      const previous = await this.mongo.workshopResources.findOne({ organisation_id: site.organisation_id, created_by: request.user!.id, create_key: createKey }, { session });
      if (previous) {
        if (previous.create_hash !== hash) throw new ConflictException('Idempotency key already used for a different resource');
        return { resource: this.resource(previous) };
      }
      const id = randomUUID(); const now = new Date().toISOString();
      const row: WorkshopResource = { _id: id, id, organisation_id: site.organisation_id, site_id: siteId, name, ...hours, active: true,
        created_at: now, updated_at: now, version: 0, booking_revision: 0, created_by: request.user!.id, create_key: createKey, create_hash: hash };
      await this.mongo.workshopResources.insertOne(row, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'service.resource_created', 'workshop_resource', id, {});
      return { resource: this.resource(row) };
    });
  }
  @Patch('resources/:id')
  @ApiBody({ schema: resourceSchema })
  async edit(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'resourceId'); const siteId = uuid(body.siteId, 'siteId');
    if (!Number.isInteger(body.version) || Number(body.version) < 0) throw new BadRequestException('Provide the current resource version');
    if (Object.keys(body).some(field => !['siteId', 'name', 'days', 'openMinute', 'closeMinute', 'active', 'version'].includes(field))) throw new BadRequestException('Unsupported resource field');
    const changes: Partial<WorkshopResource> = {};
    if (body.name !== undefined) changes.name = text(body.name, 'name', 2, 100);
    if (body.days !== undefined || body.openMinute !== undefined || body.closeMinute !== undefined) Object.assign(changes, workshopHours(body));
    if (body.active !== undefined) { if (typeof body.active !== 'boolean') throw new BadRequestException('active must be boolean'); changes.active = body.active; }
    if (!Object.keys(changes).length) throw new BadRequestException('Provide a resource change');
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'service.resources_manage', session);
      const row = await this.workshop.lock(siteId, site.organisation_id, id, session);
      if (row.version !== body.version) throw new ConflictException('Resource changed; refresh before editing');
      const future = await this.mongo.serviceAppointments.find({ site_id: siteId, organisation_id: site.organisation_id, resource_id: id,
        status: { $in: ['booked', 'confirmed'] }, ends_at: { $gt: new Date().toISOString() } }, { session }).toArray();
      const proposed = { ...row, ...changes };
      if (future.some(a => !proposed.active || !withinWorkshopHours(proposed, a.starts_at, a.ends_at, site.timezone)))
        throw new ConflictException('Reschedule or close affected bookings before changing resource availability');
      const updated = await this.mongo.workshopResources.findOneAndUpdate({ id, site_id: siteId, version: Number(body.version) },
        { $set: { ...changes, updated_at: new Date().toISOString() }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!updated) throw new ConflictException('Resource changed; refresh before editing');
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'service.resource_updated', 'workshop_resource', id, { fields: Object.keys(changes) });
      return { resource: this.resource(updated) };
    });
  }
  @Get('availability')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'resourceId', required: true })
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'durationMinutes', required: false })
  async availability(@Req() request: AuthenticatedRequest, @Query() query: Record<string, string>) {
    const siteId = uuid(query.siteId, 'siteId'); const resourceId = uuid(query.resourceId, 'resourceId');
    const site = await this.access.requireSite(request, siteId, 'service.read'); const day = dayWindow(site.timezone, query.date);
    const duration = Number(query.durationMinutes ?? '60');
    if (!Number.isInteger(duration) || duration < 15 || duration > 480 || duration % 15) throw new BadRequestException('durationMinutes must be 15 to 480 in 15-minute increments');
    const page = pagination(query.offset, query.limit);
    return this.mongo.transaction(async session => {
      const row = await this.mongo.workshopResources.findOne({ site_id: siteId, organisation_id: site.organisation_id, id: resourceId }, { session });
      if (!row) throw new NotFoundException('Resource is unavailable at this site');
      const busy = await this.mongo.serviceAppointments.find({ site_id: siteId, organisation_id: site.organisation_id, resource_id: resourceId,
        status: { $in: ['booked', 'confirmed'] }, starts_at: { $lt: day.endsAt }, ends_at: { $gt: day.startsAt } },
        { session, projection: { starts_at: 1, ends_at: 1 } }).toArray();
      const slots: { startsAt: string; endsAt: string }[] = []; const now = Date.now();
      for (let start = Date.parse(day.startsAt); row.active && start < Date.parse(day.endsAt); start += 15 * 60000) {
        const startsAt = new Date(start).toISOString(); const endsAt = new Date(start + duration * 60000).toISOString();
        if (start <= now || start > now + 365 * 86400000 || !withinWorkshopHours(row, startsAt, endsAt, site.timezone)) continue;
        if (!busy.some(a => a.starts_at < endsAt && a.ends_at > startsAt)) slots.push({ startsAt, endsAt });
      }
      const result = pageResult(slots.slice(page.offset, page.offset + page.limit + 1), page);
      return { day, resource: this.resource(row), durationMinutes: duration, slots: result.rows, pagination: result.pagination, totalSlots: slots.length };
    });
  }
  private async appointments(request: AuthenticatedRequest, query: Record<string, string>, dailyWork: boolean) {
    const siteId = uuid(query.siteId, 'siteId'); const site = await this.access.requireSite(request, siteId, 'service.read');
    await this.access.requireSite(request, siteId, 'customers.read');
    const view = query.view ?? 'own'; const bucket = query.bucket ?? 'all';
    if (!['own', 'team'].includes(view)) throw new BadRequestException('view must be own or team');
    const canViewTeam = await this.access.hasSitePermission(request, siteId, 'service.view_team');
    if (view === 'team' && !canViewTeam) throw new ForbiddenException('Team diary requires service.view_team');
    if (!['all', 'today', 'overdue'].includes(bucket)) throw new BadRequestException('Invalid appointment bucket');
    const day = dayWindow(site.timezone, query.date); const page = pagination(query.offset, query.limit);
    const grants = await this.access.memberships(request);
    const brands = (site.brand_ids ?? []).filter(id => permissionsFor(grantsForBrand(grants, site, id)).includes('service.read'));
    const filter = { ...this.integration.projectionFilter(), organisation_id: site.organisation_id, site_id: siteId, brand_id: { $in: brands },
      ...(view === 'own' ? { assigned_to: request.user!.id } : {}),
      ...(dailyWork ? { status: { $in: ['booked', 'confirmed'] }, starts_at: { $lt: day.endsAt } } :
        { starts_at: { $lt: day.endsAt }, ends_at: { $gt: day.startsAt } }),
      ...(query.resourceId ? { resource_id: uuid(query.resourceId, 'resourceId') } : {}) };
    type Row = ServiceAppointment & { customer: { id: string; first_name: string; last_name: string }[]; resource: { id: string; name: string }[]; bucket: string };
    const result = await this.mongo.serviceAppointments.aggregate<{ items: Row[]; totals: { all: number; today: number; overdue: number; unallocated: number }[] }>([
      { $match: filter },
      { $lookup: { from: 'customers', let: { customer: '$customer_id' }, pipeline: [
        { $match: { ...this.integration.projectionFilter(), organisation_id: site.organisation_id, site_id: siteId, $expr: { $eq: ['$id', '$$customer'] } } },
        { $project: { _id: 0, id: 1, first_name: 1, last_name: 1 } },
      ], as: 'customer' } },
      { $match: { 'customer.0': { $exists: true } } },
      { $lookup: { from: 'workshop_resources', let: { resource: '$resource_id' }, pipeline: [
        { $match: { organisation_id: site.organisation_id, site_id: siteId, $expr: { $eq: ['$id', '$$resource'] } } },
        { $project: { _id: 0, id: 1, name: 1 } },
      ], as: 'resource' } },
      { $addFields: { bucket: { $cond: [{ $lt: ['$starts_at', day.startsAt] }, 'overdue', 'today'] } } },
      { $facet: { totals: [{ $group: { _id: null, all: { $sum: 1 }, today: { $sum: { $cond: [{ $eq: ['$bucket', 'today'] }, 1, 0] } },
        overdue: { $sum: { $cond: [{ $eq: ['$bucket', 'overdue'] }, 1, 0] } }, unallocated: { $sum: { $cond: [{ $ifNull: ['$resource_id', false] }, 0, 1] } } } }, { $project: { _id: 0 } }],
        items: [...(bucket === 'all' ? [] : [{ $match: { bucket } }]), { $sort: { starts_at: 1, id: 1 } }, { $skip: page.offset }, { $limit: page.limit + 1 }] } },
    ]).toArray();
    const data = result[0]; const paged = pageResult(data?.items ?? [], page);
    return { day, view, bucket, canViewTeam, appointments: paged.rows.map(row => {
      const { create_key: _key, create_hash: _hash, ...record } = publicRecord(row);
      return { ...record, customer: row.customer[0], resource: row.resource[0] ?? null };
    }), totals: data?.totals[0] ?? { all: 0, today: 0, overdue: 0, unallocated: 0 }, pagination: paged.pagination, includedSources: ['service_appointments'] };
  }
  @Get('diary')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'view', required: false, enum: ['own', 'team'] })
  @ApiQuery({ name: 'resourceId', required: false })
  diary(@Req() request: AuthenticatedRequest, @Query() query: Record<string, string>) { return this.appointments(request, query, false); }
  @Get('my-day')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'view', required: false, enum: ['own', 'team'] })
  @ApiQuery({ name: 'bucket', required: false, enum: ['all', 'overdue', 'today'] })
  myDay(@Req() request: AuthenticatedRequest, @Query() query: Record<string, string>) { return this.appointments(request, query, true); }
}

