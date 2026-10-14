import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { AccessService, grantsForBrand } from '../auth/access.service.js';
import { permissionsFor } from '../auth/permissions.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import { AuditService } from '../database/audit.service.js';
import { MongoService } from '../database/mongo.service.js';
import { publicRecord, type SalesDeal, type SalesLead, type Site } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { dealPricing } from './deal-pricing.js';
import { pipelineStage } from './sales-pipeline.js';
import { ReservationsService } from './reservations.service.js';

const schema = { type: 'object' as const, properties: {
  siteId: { type: 'string', format: 'uuid' }, stockId: { type: 'string', format: 'uuid' }, appraisalId: { type: 'string', format: 'uuid', nullable: true },
  salePriceCents: { type: 'integer', minimum: 0 }, discountCents: { type: 'integer', minimum: 0 }, feesCents: { type: 'integer', minimum: 0 }, notes: { type: 'string', minLength: 3 }, version: { type: 'integer', minimum: 0 },
} };
function version(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new BadRequestException('Provide the current nonnegative integer version'); return Number(value); }

@Controller('sales/leads')
@ApiTags('Sales deals')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class DealsController {
  constructor(@Inject(AccessService) private readonly access: AccessService, @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService, @Inject(IntegrationService) private readonly integration: IntegrationService,
    @Inject(ReservationsService) private readonly reservations: ReservationsService) {}
  private publicDeal(row: SalesDeal) { const { create_key: _key, create_hash: _hash, reservation_revision: _lock, ...record } = publicRecord(row); return record; }
  private async lead(request: AuthenticatedRequest, leadId: string, siteId: string, write: boolean, session: ClientSession) {
    const site = await this.access.requireSite(request, siteId, write ? 'sales.write' : 'sales.read', session);
    const team = await this.access.hasSitePermission(request, siteId, 'sales.view_team', session);
    const lead = await this.mongo.salesLeads.findOne({ ...this.integration.projectionFilter(), id: leadId, site_id: siteId, organisation_id: site.organisation_id,
      ...(team ? {} : { assigned_to: request.user!.id }) }, { session });
    if (!lead) throw new NotFoundException('Enquiry is unavailable'); return { lead, site };
  }
  private async snapshot(request: AuthenticatedRequest, lead: SalesLead, stockId: string, appraisalId: string | null, session: ClientSession, expected?: SalesDeal) {
    const stock = await this.mongo.stockVehicles.findOne({ ...this.integration.projectionFilter(), id: stockId, site_id: lead.site_id, organisation_id: lead.organisation_id }, { session });
    if (!stock || stock.integration_mode !== lead.integration_mode || stock.status !== 'available') throw new BadRequestException('Select an available vehicle at this site in the enquiry integration mode');
    await this.access.requireBrand(request, lead.site_id, stock.brand_id, 'sales.read', session);
    if (await this.mongo.reservations.findOne({ organisation_id: lead.organisation_id, stock_id: stockId, status: 'active', expires_at: { $gt: new Date().toISOString() }, ...(expected ? { deal_id: { $ne: expected.id } } : {}) }, { session })) throw new ConflictException('Vehicle is reserved for another proposal');
    if (expected && stock.version !== expected.stock_version) throw new ConflictException('Vehicle changed; edit the deal to refresh its stock snapshot before submitting or approving');
    const appraisal = appraisalId ? await this.mongo.appraisals.findOne({ ...this.integration.projectionFilter(), id: appraisalId, lead_id: lead.id, site_id: lead.site_id, organisation_id: lead.organisation_id }, { session }) : null;
    if (appraisalId && (!appraisal || appraisal.status !== 'valued' || appraisal.valuation_cents === null || appraisal.integration_mode !== lead.integration_mode)) throw new BadRequestException('Select a currently valued appraisal from this enquiry');
    if (expected && appraisal && (appraisal.version !== expected.appraisal_version || appraisal.valuation_cents !== expected.trade_in_cents)) throw new ConflictException('Appraisal changed; edit the deal to refresh its valuation before submitting or approving');
    await this.mongo.stockVehicles.updateOne({ _id: stock._id }, { $inc: { match_revision: 1 } }, { session });
    if (appraisal) await this.mongo.appraisals.updateOne({ _id: appraisal._id }, { $inc: { review_revision: 1 } }, { session });
    return { stock, appraisal };
  }
  private async record(request: AuthenticatedRequest, lead: SalesLead, row: SalesDeal, action: string, reason: string, session: ClientSession) {
    const changed = await this.mongo.salesLeads.findOneAndUpdate({ _id: lead._id }, { $inc: { version: 1 }, $set: { updated_at: row.updated_at } }, { session, returnDocument: 'after' });
    await this.audit.record(session, request.user!.id, lead.organisation_id, lead.site_id, action, 'sales_lead', lead.id,
      { customer_id: lead.customer_id, deal_id: row.id, deal_status: row.status, deal_total_cents: row.total_cents, stock_brand_id: row.brand_id, stock_label: row.stock_label,
        reason, version: changed!.version, from_stage: pipelineStage(lead), to_stage: pipelineStage(lead) });
  }
  private async deal(lead: SalesLead, site: Site, id: string, request: AuthenticatedRequest, session: ClientSession) {
    const row = await this.mongo.salesDeals.findOne({ ...this.integration.projectionFilter(), id, lead_id: lead.id, site_id: site.id, organisation_id: site.organisation_id }, { session });
    if (!row) throw new NotFoundException('Deal is unavailable'); await this.access.requireBrand(request, site.id, row.brand_id, 'sales.read', session); return row;
  }

  @Get(':leadId/deals')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async list(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Query('siteId') siteId: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(leadId, 'leadId'); uuid(siteId, 'siteId'); const page = pagination(offset, limit);
    return this.mongo.transaction(async session => {
      const { site } = await this.lead(request, leadId, siteId, false, session); const grants = await this.access.memberships(request, session);
      const brands = (site.brand_ids ?? []).filter(brand => permissionsFor(grantsForBrand(grants, site, brand)).includes('sales.read'));
      const rows = await this.mongo.salesDeals.find({ ...this.integration.projectionFilter(), lead_id: leadId, site_id: siteId, organisation_id: site.organisation_id, brand_id: { $in: brands } }, { session })
        .sort({ updated_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray();
      const result = pageResult(rows, page);
      const holds = await this.mongo.reservations.find({ organisation_id: site.organisation_id, deal_id: { $in: result.rows.map(row => row.id) }, status: 'active', expires_at: { $gt: new Date().toISOString() } }, { session }).toArray();
      return { deals: result.rows.map(row => ({ ...this.publicDeal(row), reservation: holds.find(hold => hold.deal_id === row.id) ? { expiresAt: holds.find(hold => hold.deal_id === row.id)!.expires_at } : null })), pagination: result.pagination };
    });
  }

  @Get(':leadId/deals/:id')
  @ApiQuery({ name: 'siteId', required: true })
  async detail(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Param('id') id: string, @Query('siteId') siteId: string) {
    uuid(leadId, 'leadId'); uuid(id, 'dealId'); uuid(siteId, 'siteId');
    return this.mongo.transaction(async session => { const { lead, site } = await this.lead(request, leadId, siteId, false, session); return { deal: this.publicDeal(await this.deal(lead, site, id, request, session)) }; });
  }

  @Post(':leadId/deals')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: { ...schema, required: ['siteId', 'stockId', 'salePriceCents', 'notes'] } })
  @ApiOperation({ summary: 'Create an internal deal proposal', description: 'No binding agreement, payment, stock reservation or source write occurs. An optional valued appraisal supplies the trade-in credit.' })
  async create(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Headers('idempotency-key') key: string, @Body() body: Record<string, unknown>) {
    uuid(leadId, 'leadId'); const siteId = uuid(body.siteId, 'siteId'); const stockId = uuid(body.stockId, 'stockId');
    const appraisalId = body.appraisalId == null || body.appraisalId === '' ? null : uuid(body.appraisalId, 'appraisalId');
    if (Object.keys(body).some(field => !['siteId', 'stockId', 'appraisalId', 'salePriceCents', 'discountCents', 'feesCents', 'notes'].includes(field))) throw new BadRequestException('Unsupported deal field');
    const notes = text(body.notes, 'notes', 3, 5000); const base = dealPricing(body.salePriceCents, body.discountCents ?? 0, body.feesCents ?? 0, 0);
    const createKey = text(key, 'Idempotency-Key', 8, 200); const hash = createHash('sha256').update(JSON.stringify({ siteId, leadId, stockId, appraisalId, ...base, notes })).digest('hex');
    return this.mongo.transaction(async session => {
      const { lead, site } = await this.lead(request, leadId, siteId, true, session);
      const existing = await this.mongo.salesDeals.findOne({ organisation_id: site.organisation_id, created_by: request.user!.id, create_key: createKey }, { session });
      if (existing) { if (existing.create_hash !== hash) throw new ConflictException('Idempotency key already used for another proposal'); await this.access.requireBrand(request, siteId, existing.brand_id, 'sales.read', session); return { deal: this.publicDeal(existing) }; }
      if (lead.status === 'closed') throw new BadRequestException('Reopen the enquiry before creating a deal');
      if (await this.mongo.salesDeals.countDocuments({ lead_id: lead.id, site_id: siteId, organisation_id: site.organisation_id }, { session }) >= 20) throw new BadRequestException('An enquiry can have at most 20 proposals');
      const { stock, appraisal } = await this.snapshot(request, lead, stockId, appraisalId, session);
      const pricing = dealPricing(base.sale_price_cents, base.discount_cents, base.fees_cents, appraisal?.valuation_cents ?? 0);
      const id = randomUUID(); const now = new Date().toISOString();
      const row: SalesDeal = { _id: id, id, organisation_id: site.organisation_id, site_id: siteId, lead_id: leadId, customer_id: lead.customer_id,
        stock_id: stockId, brand_id: stock.brand_id, stock_label: `${stock.stock_number} · ${stock.make} ${stock.model}`, stock_version: stock.version,
        appraisal_id: appraisalId, appraisal_version: appraisal?.version ?? null, ...pricing, currency: 'AUD', status: 'draft', notes, reviewed_by: null, reviewed_at: null, review_note: null,
        created_by: request.user!.id, created_at: now, updated_at: now, version: 0, source: 'local', create_key: createKey, create_hash: hash,
        ...(lead.integration_mode ? { integration_mode: lead.integration_mode } : {}) };
      await this.mongo.salesDeals.insertOne(row, { session }); await this.record(request, lead, row, 'sales.deal_created', notes, session); return { deal: this.publicDeal(row) };
    });
  }

  @Patch(':leadId/deals/:id')
  @ApiBody({ schema: { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).filter(([key]) => key !== 'stockId')), required: ['siteId', 'version', 'appraisalId', 'salePriceCents', 'discountCents', 'feesCents', 'notes'] } })
  async edit(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(leadId, 'leadId'); uuid(id, 'dealId'); const siteId = uuid(body.siteId, 'siteId'); const currentVersion = version(body.version);
    if (Object.keys(body).some(field => !['siteId', 'version', 'appraisalId', 'salePriceCents', 'discountCents', 'feesCents', 'notes'].includes(field))) throw new BadRequestException('Unsupported deal field');
    const notes = text(body.notes, 'notes', 3, 5000); const base = dealPricing(body.salePriceCents, body.discountCents, body.feesCents, 0);
    if (body.appraisalId === undefined) throw new BadRequestException('Provide appraisalId, or null for no trade-in');
    const appraisalId = body.appraisalId == null || body.appraisalId === '' ? null : uuid(body.appraisalId, 'appraisalId');
    return this.mongo.transaction(async session => {
      const { lead, site } = await this.lead(request, leadId, siteId, true, session); const existing = await this.deal(lead, site, id, request, session);
      if (lead.status === 'closed') throw new BadRequestException('Reopen the enquiry before editing a deal');
      if (!['draft', 'rejected'].includes(existing.status)) throw new ConflictException('Only draft or rejected proposals can be edited');
      const { stock, appraisal } = await this.snapshot(request, lead, existing.stock_id, appraisalId, session);
      const pricing = dealPricing(base.sale_price_cents, base.discount_cents, base.fees_cents, appraisal?.valuation_cents ?? 0);
      const row = await this.mongo.salesDeals.findOneAndUpdate({ _id: existing._id, version: currentVersion }, { $set: { ...pricing, notes, status: 'draft',
        stock_version: stock.version, stock_label: `${stock.stock_number} · ${stock.make} ${stock.model}`, appraisal_id: appraisalId, appraisal_version: appraisal?.version ?? null, reviewed_by: null, reviewed_at: null, review_note: null, updated_at: new Date().toISOString() }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!row) throw new ConflictException('Deal changed; refresh before editing'); await this.record(request, lead, row, 'sales.deal_updated', notes, session); return { deal: this.publicDeal(row) };
    });
  }

  @Patch(':leadId/deals/:id/status')
  @ApiBody({ schema: { type: 'object', required: ['siteId', 'version', 'action', 'note'], properties: { siteId: { type: 'string', format: 'uuid' }, version: { type: 'integer' }, action: { type: 'string', enum: ['submit', 'approve', 'reject', 'cancel'] }, note: { type: 'string', minLength: 3, maxLength: 1000 } } } })
  async transition(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(leadId, 'leadId'); uuid(id, 'dealId'); const siteId = uuid(body.siteId, 'siteId'); const currentVersion = version(body.version); const note = text(body.note, 'note', 3, 1000);
    if (Object.keys(body).some(field => !['siteId', 'version', 'action', 'note'].includes(field)) || !['submit', 'approve', 'reject', 'cancel'].includes(body.action as string)) throw new BadRequestException('Choose a valid proposal action');
    return this.mongo.transaction(async session => {
      const { lead, site } = await this.lead(request, leadId, siteId, true, session); const existing = await this.deal(lead, site, id, request, session);
      if (body.action === 'approve' || body.action === 'reject' || (body.action === 'cancel' && existing.status === 'approved')) await this.access.requireSite(request, siteId, 'sales.approve_deals', session);
      if (existing.status === 'cancelled') throw new ConflictException('Cancelled proposals cannot change');
      if ((body.action === 'submit' && existing.status !== 'draft') || (['approve', 'reject'].includes(body.action as string) && existing.status !== 'submitted')) throw new ConflictException('Proposal is not in the required state for this action');
      if (['submit', 'approve'].includes(body.action as string)) {
        if (lead.status === 'closed') throw new BadRequestException('Reopen the enquiry before submitting or approving a deal');
        await this.snapshot(request, lead, existing.stock_id, existing.appraisal_id, session, existing);
      }
      const status = { submit: 'submitted', approve: 'approved', reject: 'rejected', cancel: 'cancelled' }[body.action as string] as SalesDeal['status'];
      const now = new Date().toISOString(); const review = ['approve', 'reject'].includes(body.action as string);
      if (body.action === 'cancel') await this.reservations.releaseDeal(site.organisation_id, existing.id, request.user!.id, session);
      const row = await this.mongo.salesDeals.findOneAndUpdate({ _id: existing._id, version: currentVersion }, { $set: { status, updated_at: now,
        ...(review ? { reviewed_by: request.user!.id, reviewed_at: now, review_note: note } : {}) }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!row) throw new ConflictException('Deal changed; refresh before changing status'); await this.record(request, lead, row, `sales.deal_${status}`, note, session); return { deal: this.publicDeal(row) };
    });
  }
}
