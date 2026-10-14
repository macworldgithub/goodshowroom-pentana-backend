import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { AccessService } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import type { StockReservation } from '../database/models.js';
import { ReservationsService } from './reservations.service.js';
function version(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new BadRequestException('Provide the current nonnegative integer version'); return Number(value); }

@Controller('sales/leads/:leadId/deals/:dealId/reservations')
@ApiTags('Stock reservations')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class ReservationsController {
  constructor(@Inject(AccessService) private readonly access: AccessService, @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(IntegrationService) private readonly integration: IntegrationService, @Inject(ReservationsService) private readonly reservations: ReservationsService) {}
  private async context(request: AuthenticatedRequest, leadId: string, dealId: string, siteId: string, write: boolean, session: ClientSession) {
    const site = await this.access.requireSite(request, siteId, write ? 'sales.write' : 'sales.read', session);
    const team = await this.access.hasSitePermission(request, siteId, 'sales.view_team', session);
    const lead = await this.mongo.salesLeads.findOne({ ...this.integration.projectionFilter(), id: leadId, site_id: siteId, organisation_id: site.organisation_id, ...(team ? {} : { assigned_to: request.user!.id }) }, { session });
    if (!lead) throw new NotFoundException('Enquiry is unavailable');
    const deal = await this.mongo.salesDeals.findOne({ ...this.integration.projectionFilter(), id: dealId, lead_id: leadId, site_id: siteId, organisation_id: site.organisation_id }, { session });
    if (!deal) throw new NotFoundException('Deal is unavailable'); await this.access.requireBrand(request, siteId, deal.brand_id, 'sales.read', session);
    return { site, lead, deal };
  }
  @Get()
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async list(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Param('dealId') dealId: string, @Query('siteId') siteId: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(leadId, 'leadId'); uuid(dealId, 'dealId'); uuid(siteId, 'siteId'); const page = pagination(offset, limit);
    return this.mongo.transaction(async session => {
      const { site } = await this.context(request, leadId, dealId, siteId, false, session);
      const rows = await this.mongo.reservations.find({ ...this.integration.projectionFilter(), deal_id: dealId, lead_id: leadId, site_id: siteId, organisation_id: site.organisation_id }, { session }).sort({ created_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray();
      const result = pageResult(rows, page);
      const active = await this.mongo.reservations.findOne({ deal_id: dealId, organisation_id: site.organisation_id, status: 'active', expires_at: { $gt: new Date().toISOString() } }, { session });
      return { reservations: result.rows.map(row => this.reservations.publicReservation(row)), active: active ? this.reservations.publicReservation(active) : null, pagination: result.pagination };
    });
  }
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: { type: 'object', required: ['siteId', 'dealVersion', 'expiresAt', 'note'], properties: { siteId: { type: 'string', format: 'uuid' }, dealVersion: { type: 'integer' }, expiresAt: { type: 'string', format: 'date-time' }, note: { type: 'string', minLength: 3, maxLength: 1000 } } } })
  async create(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Param('dealId') dealId: string, @Headers('idempotency-key') key: string, @Body() body: Record<string, unknown>) {
    uuid(leadId, 'leadId'); uuid(dealId, 'dealId'); const siteId = uuid(body.siteId, 'siteId'); const dealVersion = version(body.dealVersion); const note = text(body.note, 'note', 3, 1000); const createKey = text(key, 'Idempotency-Key', 8, 200);
    if (Object.keys(body).some(field => !['siteId', 'dealVersion', 'expiresAt', 'note'].includes(field))) throw new BadRequestException('Unsupported reservation field');
    if (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))) throw new BadRequestException('expiresAt must be a valid timestamp');
    const expiresAt = new Date(body.expiresAt).toISOString(); const hash = createHash('sha256').update(JSON.stringify({ siteId, leadId, dealId, dealVersion, expiresAt, note })).digest('hex');
    return this.mongo.transaction(async session => {
      const { site, lead, deal } = await this.context(request, leadId, dealId, siteId, true, session);
      const existing = await this.mongo.reservations.findOne({ organisation_id: site.organisation_id, created_by: request.user!.id, create_key: createKey }, { session });
      if (existing) { if (existing.create_hash !== hash) throw new ConflictException('Idempotency key already used for another reservation'); return { reservation: this.reservations.publicReservation(existing) }; }
      if (deal.status !== 'approved' || deal.version !== dealVersion) throw new ConflictException('A current approved deal is required; refresh the proposal');
      if (lead.status === 'closed') throw new BadRequestException('Reopen the enquiry before reserving a vehicle');
      const now = new Date().toISOString(); const delta = Date.parse(expiresAt) - Date.now();
      if (delta <= 0 || delta > 7 * 86400000) throw new BadRequestException('Reservation expiry must be in the future and within 7 days');
      const stock = await this.mongo.stockVehicles.findOne({ ...this.integration.projectionFilter(), id: deal.stock_id, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!stock || stock.status !== 'available' || stock.integration_mode !== deal.integration_mode || stock.brand_id !== deal.brand_id || stock.version !== deal.stock_version) throw new ConflictException('Vehicle changed or is unavailable; refresh and reapprove a proposal before reserving');
      await this.mongo.stockVehicles.updateOne({ _id: stock._id }, { $inc: { match_revision: 1 } }, { session });
      await this.reservations.expireStock(site.organisation_id, stock.id, session);
      if (await this.mongo.reservations.findOne({ organisation_id: site.organisation_id, stock_id: stock.id, status: 'active' }, { session })) throw new ConflictException('Vehicle already has an active reservation');
      if (deal.appraisal_id) {
        const appraisal = await this.mongo.appraisals.findOne({ ...this.integration.projectionFilter(), id: deal.appraisal_id, lead_id: leadId, site_id: siteId, organisation_id: site.organisation_id }, { session });
        if (!appraisal || appraisal.status !== 'valued' || appraisal.version !== deal.appraisal_version || appraisal.valuation_cents !== deal.trade_in_cents) throw new ConflictException('Appraisal changed; reapprove updated pricing before reserving');
        await this.mongo.appraisals.updateOne({ _id: appraisal._id }, { $inc: { review_revision: 1 } }, { session });
      }
      await this.mongo.salesDeals.updateOne({ _id: deal._id }, { $inc: { reservation_revision: 1 } }, { session });
      const id = randomUUID(); const row: StockReservation = { _id: id, id, organisation_id: site.organisation_id, site_id: siteId, lead_id: leadId, customer_id: lead.customer_id, deal_id: dealId, stock_id: stock.id, brand_id: stock.brand_id,
        status: 'active', expires_at: expiresAt, ended_at: null, reason: note, created_by: request.user!.id, version: 0, created_at: now, updated_at: now, create_key: createKey, create_hash: hash, ...(deal.integration_mode ? { integration_mode: deal.integration_mode } : {}) };
      await this.mongo.reservations.insertOne(row, { session }); await this.reservations.record(row, request.user!.id, 'sales.reservation_created', note, session);
      return { reservation: this.reservations.publicReservation(row) };
    });
  }
  @Patch(':id/release')
  @ApiBody({ schema: { type: 'object', required: ['siteId', 'version', 'note'], properties: { siteId: { type: 'string', format: 'uuid' }, version: { type: 'integer' }, note: { type: 'string', minLength: 3, maxLength: 1000 } } } })
  async release(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Param('dealId') dealId: string, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(leadId, 'leadId'); uuid(dealId, 'dealId'); uuid(id, 'reservationId'); const siteId = uuid(body.siteId, 'siteId'); const currentVersion = version(body.version); const note = text(body.note, 'note', 3, 1000);
    if (Object.keys(body).some(field => !['siteId', 'version', 'note'].includes(field))) throw new BadRequestException('Unsupported release field');
    return this.mongo.transaction(async session => {
      const { site } = await this.context(request, leadId, dealId, siteId, true, session);
      const row = await this.mongo.reservations.findOne({ ...this.integration.projectionFilter(), id, deal_id: dealId, lead_id: leadId, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!row) throw new NotFoundException('Reservation is unavailable');
      if (row.status !== 'active' || row.version !== currentVersion || row.expires_at <= new Date().toISOString()) throw new ConflictException('Reservation changed or has ended; refresh before releasing');
      const changed = await this.reservations.end(row, 'released', request.user!.id, note, session);
      if (!changed) throw new ConflictException('Reservation changed; refresh before releasing'); return { reservation: this.reservations.publicReservation(changed) };
    });
  }
}
