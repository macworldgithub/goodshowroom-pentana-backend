import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import { AccessService, grantsForBrand } from '../auth/access.service.js';
import { permissionsFor } from '../auth/permissions.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { text, uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord, type StockVehicle } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { pipelineStage } from './sales-pipeline.js';

const states = ['available', 'incoming', 'sold', 'unavailable'];
function integer(value: unknown, name: string, min: number, max: number) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return Number(value);
}
function optionalText(value: unknown, name: string, max = 100) { return value == null || value === '' ? null : text(value, name, 1, max); }
function vehicleInput(body: Record<string, unknown>) {
  const vin = optionalText(body.vin, 'vin', 17)?.toUpperCase() ?? null;
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new BadRequestException('VIN must contain 17 letters/digits excluding I, O and Q');
  return { stock_number: text(body.stockNumber, 'stockNumber', 1, 60).toUpperCase(),
    make: text(body.make, 'make', 1, 100), model: text(body.model, 'model', 1, 100), variant: optionalText(body.variant, 'variant'),
    year: integer(body.year, 'year', 1900, new Date().getUTCFullYear() + 2), odometer_km: integer(body.odometerKm, 'odometerKm', 0, 5000000),
    vin, colour: optionalText(body.colour, 'colour'), body_type: text(body.bodyType, 'bodyType', 1, 60),
    fuel_type: text(body.fuelType, 'fuelType', 1, 60), transmission: text(body.transmission, 'transmission', 1, 60),
    price_cents: body.priceCents == null ? null : integer(body.priceCents, 'priceCents', 0, 1000000000) };
}
const stockSchema = { type: 'object' as const, properties: {
  siteId: { type: 'string', format: 'uuid' }, brandId: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 0 },
  stockNumber: { type: 'string' }, make: { type: 'string' }, model: { type: 'string' }, variant: { type: 'string', nullable: true },
  year: { type: 'integer' }, odometerKm: { type: 'integer', minimum: 0 }, vin: { type: 'string', nullable: true }, colour: { type: 'string', nullable: true },
  bodyType: { type: 'string' }, fuelType: { type: 'string' }, transmission: { type: 'string' }, priceCents: { type: 'integer', nullable: true }, status: { type: 'string', enum: states },
} };

@Controller('sales')
@ApiTags('Stock matching')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class StockController {
  constructor(@Inject(AccessService) private readonly access: AccessService, @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService, @Inject(IntegrationService) private readonly integration: IntegrationService) {}
  private publicVehicle(vehicle: StockVehicle) {
    const { create_key: _key, create_hash: _hash, match_revision: _lock, ...result } = publicRecord(vehicle); return result;
  }
  private requireSimulation() {
    if (this.integration.config.mode !== 'simulated') throw new BadRequestException('Manual stock maintenance is available only in development simulation; real stock ingestion is not connected');
  }

  @Get('stock')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'brandId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: [...states, 'reserved'] })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'bodyType', required: false })
  @ApiQuery({ name: 'maxPriceCents', required: false, type: Number })
  async list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, string>) {
    const siteId = uuid(query.siteId, 'siteId'); const page = pagination(query.offset, query.limit);
    const site = await this.access.requireSite(request, siteId, 'sales.read');
    const grants = await this.access.memberships(request);
    const brands = (site.brand_ids ?? []).filter(id => permissionsFor(grantsForBrand(grants, site, id)).includes('sales.read'));
    if (query.brandId !== undefined) { uuid(query.brandId, 'brandId'); await this.access.requireBrand(request, siteId, query.brandId, 'sales.read'); }
    if (query.status !== undefined && ![...states, 'reserved'].includes(query.status)) throw new BadRequestException('Invalid stock status');
    const term = query.search === undefined ? undefined : text(query.search, 'search', 0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bodyType = query.bodyType === undefined ? undefined : text(query.bodyType, 'bodyType', 1, 60);
    if (query.maxPriceCents !== undefined && !/^\d+$/.test(query.maxPriceCents)) throw new BadRequestException('maxPriceCents must be a nonnegative integer');
    const maxPrice = query.maxPriceCents === undefined ? undefined : integer(Number(query.maxPriceCents), 'maxPriceCents', 0, 1000000000);
    const rows = await this.mongo.stockVehicles.aggregate<StockVehicle & { holds: { expires_at: string }[] }>([{ $match: { ...this.integration.projectionFilter(), site_id: siteId, organisation_id: site.organisation_id,
      brand_id: query.brandId ?? { $in: brands }, ...(query.status ? { status: query.status === 'reserved' ? 'available' : query.status } : {}),
      ...(bodyType ? { body_type: { $regex: '^' + bodyType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' } } : {}),
      ...(maxPrice === undefined ? {} : { price_cents: { $ne: null, $lte: maxPrice } }),
      ...(term ? { $or: ['stock_number', 'make', 'model', 'variant', 'vin'].map(field => ({ [field]: { $regex: term, $options: 'i' } })) } : {}),
    } }, { $lookup: { from: 'stock_reservations', localField: 'id', foreignField: 'stock_id', pipeline: [{ $match: { organisation_id: site.organisation_id, site_id: siteId, status: 'active', expires_at: { $gt: new Date().toISOString() } } }, { $project: { _id: 0, expires_at: 1 } }], as: 'holds' } },
      ...(query.status === 'available' || query.status === 'reserved' ? [{ $match: { 'holds.0': { $exists: query.status === 'reserved' } } }] : []),
      { $sort: { updated_at: -1, id: 1 } }, { $skip: page.offset }, { $limit: page.limit + 1 }]).toArray();
    const result = pageResult(rows, page);
    return { vehicles: result.rows.map(({ holds, ...row }) => ({ ...this.publicVehicle(row), availability: holds.length ? 'reserved' : row.status, reservation: holds[0] ? { expiresAt: holds[0].expires_at } : null })), pagination: result.pagination, integration: this.integration.config.info() };
  }

  @Get('stock/:id')
  @ApiQuery({ name: 'siteId', required: true })
  async detail(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('siteId') siteId: string) {
    uuid(id, 'stockId'); uuid(siteId, 'siteId'); const site = await this.access.requireSite(request, siteId, 'sales.read');
    const vehicle = await this.mongo.stockVehicles.findOne({ ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id });
    if (!vehicle) throw new NotFoundException('Stock vehicle is unavailable');
    await this.access.requireBrand(request, siteId, vehicle.brand_id, 'sales.read');
    const hold = await this.mongo.reservations.findOne({ organisation_id: site.organisation_id, stock_id: id, status: 'active', expires_at: { $gt: new Date().toISOString() } });
    return { vehicle: { ...this.publicVehicle(vehicle), availability: hold ? 'reserved' : vehicle.status, reservation: hold ? { expiresAt: hold.expires_at } : null } };
  }

  @Post('stock')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: stockSchema })
  async create(@Req() request: AuthenticatedRequest, @Headers('idempotency-key') key: string, @Body() body: Record<string, unknown>) {
    this.requireSimulation();
    const allowed = ['siteId', 'brandId', 'stockNumber', 'make', 'model', 'variant', 'year', 'odometerKm', 'vin', 'colour', 'bodyType', 'fuelType', 'transmission', 'priceCents'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new BadRequestException('Unsupported stock field');
    const siteId = uuid(body.siteId, 'siteId'); const brandId = uuid(body.brandId, 'brandId'); const values = vehicleInput(body);
    const createKey = text(key, 'Idempotency-Key', 8, 200); const hash = createHash('sha256').update(JSON.stringify({ siteId, brandId, ...values })).digest('hex');
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'stock.manage', session);
      await this.access.requireBrand(request, siteId, brandId, 'sales.write', session);
      const existing = await this.mongo.stockVehicles.findOne({ organisation_id: site.organisation_id, created_by: request.user!.id, create_key: createKey }, { session });
      if (existing) { if (existing.create_hash !== hash) throw new ConflictException('Idempotency key already used for different stock'); return { vehicle: this.publicVehicle(existing) }; }
      const id = randomUUID(); const now = new Date().toISOString();
      const vehicle: StockVehicle = { _id: id, id, ...values, organisation_id: site.organisation_id, site_id: siteId, brand_id: brandId,
        currency: 'AUD', status: 'available', source: 'simulated', integration_mode: 'simulated', version: 0,
        created_at: now, updated_at: now, created_by: request.user!.id, create_key: createKey, create_hash: hash };
      await this.mongo.stockVehicles.insertOne(vehicle, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'stock.created', 'stock', id, { stock_number: values.stock_number, brand_id: brandId });
      return { vehicle: this.publicVehicle(vehicle) };
    });
  }

  @Patch('stock/:id')
  @ApiBody({ schema: stockSchema })
  async edit(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    this.requireSimulation(); uuid(id, 'stockId'); const siteId = uuid(body.siteId, 'siteId'); const version = integer(body.version, 'version', 0, Number.MAX_SAFE_INTEGER);
    const allowed = ['siteId', 'version', 'stockNumber', 'make', 'model', 'variant', 'year', 'odometerKm', 'vin', 'colour', 'bodyType', 'fuelType', 'transmission', 'priceCents', 'status'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new BadRequestException('Unsupported stock field');
    const values = vehicleInput(body);
    if (!states.includes(body.status as string)) throw new BadRequestException('Invalid stock status');
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'stock.manage', session);
      const filter = { id, site_id: siteId, organisation_id: site.organisation_id, integration_mode: 'simulated' as const };
      const existing = await this.mongo.stockVehicles.findOne(filter, { session });
      if (!existing) throw new NotFoundException('Stock vehicle is unavailable');
      await this.access.requireBrand(request, siteId, existing.brand_id, 'sales.write', session);
      if (await this.mongo.reservations.findOne({ organisation_id: site.organisation_id, stock_id: id, status: 'active', expires_at: { $gt: new Date().toISOString() } }, { session })) throw new ConflictException('Release the active reservation before editing stock');
      const vehicle = await this.mongo.stockVehicles.findOneAndUpdate({ ...filter, version }, { $set: { ...values, status: body.status as StockVehicle['status'], updated_at: new Date().toISOString() }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!vehicle) throw new ConflictException('Stock changed; refresh before editing');
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'stock.updated', 'stock', id, { version: vehicle.version, status: vehicle.status });
      return { vehicle: this.publicVehicle(vehicle) };
    });
  }

  @Patch('leads/:id/stock')
  @ApiBody({ schema: { type: 'object', required: ['siteId', 'version', 'stockId', 'action', 'note'], properties: {
    siteId: { type: 'string', format: 'uuid' }, version: { type: 'integer' }, stockId: { type: 'string', format: 'uuid' }, action: { type: 'string', enum: ['add', 'remove'] }, note: { type: 'string', minLength: 3, maxLength: 1000 },
  } } })
  async match(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'leadId'); const siteId = uuid(body.siteId, 'siteId'); const stockId = uuid(body.stockId, 'stockId'); const version = integer(body.version, 'version', 0, Number.MAX_SAFE_INTEGER);
    if (Object.keys(body).some(key => !['siteId', 'version', 'stockId', 'action', 'note'].includes(key))) throw new BadRequestException('Unsupported match field');
    if (!['add', 'remove'].includes(body.action as string)) throw new BadRequestException('action must be add or remove');
    const note = text(body.note, 'note', 3, 1000);
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'sales.write', session);
      const team = await this.access.hasSitePermission(request, siteId, 'sales.view_team', session);
      const filter = { ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id, ...(team ? {} : { assigned_to: request.user!.id }) };
      const lead = await this.mongo.salesLeads.findOne(filter, { session });
      if (!lead) throw new NotFoundException('Enquiry is unavailable');
      const vehicle = await this.mongo.stockVehicles.findOne({ ...this.integration.projectionFilter(), id: stockId, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!vehicle || vehicle.integration_mode !== lead.integration_mode) throw new BadRequestException('Vehicle is unavailable for this enquiry');
      await this.access.requireBrand(request, siteId, vehicle.brand_id, 'sales.read', session);
      const ids = lead.stock_ids ?? [];
      if (body.action === 'add') {
        if (lead.status === 'closed') throw new BadRequestException('Reopen the enquiry before shortlisting stock');
        if (vehicle.status !== 'available') throw new BadRequestException('Only available vehicles can be shortlisted');
        if (await this.mongo.reservations.findOne({ organisation_id: site.organisation_id, stock_id: stockId, status: 'active', expires_at: { $gt: new Date().toISOString() } }, { session })) throw new ConflictException('Reserved vehicles cannot be added to a shortlist');
        if (ids.includes(stockId)) throw new BadRequestException('Vehicle is already shortlisted');
        if (ids.length >= 10) throw new BadRequestException('An enquiry can shortlist at most 10 vehicles');
        // Serialize availability edits with matching; a transaction retry must recheck status.
        await this.mongo.stockVehicles.updateOne({ _id: vehicle._id }, { $inc: { match_revision: 1 } }, { session });
      } else if (!ids.includes(stockId)) throw new BadRequestException('Vehicle is not shortlisted');
      const updated = await this.mongo.salesLeads.findOneAndUpdate({ ...filter, version }, { $set: { stock_ids: body.action === 'add' ? [...ids, stockId] : ids.filter(value => value !== stockId), updated_at: new Date().toISOString() }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!updated) throw new ConflictException('Enquiry changed; refresh before changing its shortlist');
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, body.action === 'add' ? 'sales.stock_matched' : 'sales.stock_removed', 'sales_lead', id,
        { customer_id: lead.customer_id, stock_id: stockId, stock_brand_id: vehicle.brand_id, stock_label: `${vehicle.stock_number} · ${vehicle.make} ${vehicle.model}`, reason: note, version: updated.version, from_stage: pipelineStage(lead), to_stage: pipelineStage(updated) });
      const { create_key: _key, create_hash: _hash, ...record } = publicRecord(updated); return { lead: record };
    });
  }
}
