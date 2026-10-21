import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import { AccessService, grantsForBrand } from '../auth/access.service.js';
import { permissionsFor } from '../auth/permissions.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import type { DeliveryPlan } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { DeliveriesService } from './deliveries.service.js';
import { DELIVERY_ITEMS, DELIVERY_LABELS, emptyChecklist, type DeliveryItem } from './delivery-checklist.js';
function version(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new BadRequestException('Provide the current nonnegative integer version'); return Number(value); }
function scheduled(value: unknown) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new BadRequestException('scheduledAt must be a valid timestamp');
  const delta = Date.parse(value) - Date.now(); if (delta <= 0 || delta > 365 * 86400000) throw new BadRequestException('Schedule delivery in the future, within one year');
  return new Date(value).toISOString();
}
@Controller('sales/deliveries')
@ApiTags('Delivery readiness')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class DeliveriesController {
  constructor(@Inject(AccessService) private readonly access: AccessService, @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(IntegrationService) private readonly integration: IntegrationService, @Inject(DeliveriesService) private readonly deliveries: DeliveriesService) {}
  @Get()
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'status', required: false, enum: ['planned', 'cancelled', 'handed_over'] })
  @ApiQuery({ name: 'dealId', required: false })
  async list(@Req() request: AuthenticatedRequest, @Query('siteId') siteId: string, @Query('status') status?: string, @Query('offset') offset?: string, @Query('limit') limit?: string, @Query('dealId') dealId?: string) {
    uuid(siteId, 'siteId'); const page = pagination(offset, limit); if (status !== undefined && !['planned', 'cancelled', 'handed_over'].includes(status)) throw new BadRequestException('Invalid delivery status');
    if (dealId !== undefined) uuid(dealId, 'dealId');
    return this.mongo.transaction(async session => {
      const { site, ownOnly } = await this.deliveries.scope(request, siteId, 'deliveries.read', session); const grants = await this.access.memberships(request, session);
      const brands = (site.brand_ids ?? []).filter(brand => permissionsFor(grantsForBrand(grants, site, brand)).includes('deliveries.read'));
      const rows = await this.mongo.deliveries.aggregate<DeliveryPlan>([
        { $match: { ...this.integration.projectionFilter(), site_id: siteId, organisation_id: site.organisation_id, brand_id: { $in: brands }, ...(status ? { status } : {}), ...(dealId ? { deal_id: dealId } : {}) } },
        { $lookup: { from: 'sales_leads', localField: 'lead_id', foreignField: 'id', pipeline: [{ $match: { ...this.integration.projectionFilter(), site_id: siteId, organisation_id: site.organisation_id, ...(ownOnly ? { assigned_to: request.user!.id } : {}) } }, { $project: { _id: 0, id: 1 } }], as: 'permitted_lead' } },
        { $match: { 'permitted_lead.0': { $exists: true } } }, { $unset: 'permitted_lead' }, { $sort: { scheduled_at: 1, id: 1 } }, { $skip: page.offset }, { $limit: page.limit + 1 },
      ], { session }).toArray(); const result = pageResult(rows, page);
      return { deliveries: await this.deliveries.viewMany(request, result.rows, session), pagination: result.pagination };
    });
  }
  @Get(':id')
  @ApiQuery({ name: 'siteId', required: true })
  async detail(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('siteId') siteId: string) {
    uuid(id, 'deliveryId'); uuid(siteId, 'siteId'); return this.mongo.transaction(async session => {
      const { plan } = await this.deliveries.context(request, siteId, id, 'deliveries.read', session); return { delivery: await this.deliveries.view(request, plan, session) };
    });
  }
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: { type: 'object', required: ['siteId', 'leadId', 'dealId', 'scheduledAt', 'notes'], properties: { siteId: { type: 'string', format: 'uuid' }, leadId: { type: 'string', format: 'uuid' }, dealId: { type: 'string', format: 'uuid' }, scheduledAt: { type: 'string', format: 'date-time' }, notes: { type: 'string', minLength: 3, maxLength: 2000 } } } })
  async create(@Req() request: AuthenticatedRequest, @Headers('idempotency-key') key: string, @Body() body: Record<string, unknown>) {
    const siteId = uuid(body.siteId, 'siteId'); const leadId = uuid(body.leadId, 'leadId'); const dealId = uuid(body.dealId, 'dealId'); const notes = text(body.notes, 'notes', 3, 2000); const createKey = text(key, 'Idempotency-Key', 8, 200);
    if (Object.keys(body).some(field => !['siteId', 'leadId', 'dealId', 'scheduledAt', 'notes'].includes(field))) throw new BadRequestException('Unsupported delivery field');
    if (typeof body.scheduledAt !== 'string' || !Number.isFinite(Date.parse(body.scheduledAt))) throw new BadRequestException('scheduledAt must be a timestamp');
    const date = new Date(body.scheduledAt).toISOString(); const hash = createHash('sha256').update(JSON.stringify({ siteId, leadId, dealId, date, notes })).digest('hex');
    return this.mongo.transaction(async session => {
      const { site, ownOnly } = await this.deliveries.scope(request, siteId, 'deliveries.write', session);
      const lead = await this.mongo.salesLeads.findOne({ ...this.integration.projectionFilter(), id: leadId, site_id: siteId, organisation_id: site.organisation_id, ...(ownOnly ? { assigned_to: request.user!.id } : {}) }, { session });
      if (!lead) throw new NotFoundException('Enquiry is unavailable'); const deal = await this.deliveries.validateDeal(lead, dealId, session);
      if (!deal) throw new NotFoundException('Deal is unavailable'); await this.access.requireBrand(request, siteId, deal.brand_id, 'deliveries.write', session);
      const existing = await this.mongo.deliveries.findOne({ organisation_id: site.organisation_id, created_by: request.user!.id, create_key: createKey }, { session });
      if (existing) { if (existing.create_hash !== hash) throw new ConflictException('Idempotency key already used for a different delivery'); return { delivery: await this.deliveries.view(request, existing, session) }; }
      if (deal.status !== 'approved') throw new ConflictException('Delivery planning requires an approved deal'); scheduled(date);
      const stock = await this.mongo.stockVehicles.findOne({ ...this.integration.projectionFilter(), id: deal.stock_id, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!stock || stock.status !== 'available' || stock.version !== deal.stock_version || stock.integration_mode !== deal.integration_mode) throw new ConflictException('Approved vehicle snapshot changed');
      await this.mongo.stockVehicles.updateOne({ _id: stock._id }, { $inc: { match_revision: 1 } }, { session });
      await this.mongo.salesDeals.updateOne({ _id: deal._id }, { $inc: { reservation_revision: 1 } }, { session });
      const id = randomUUID(); const now = new Date().toISOString();
      const plan: DeliveryPlan = { _id: id, id, organisation_id: site.organisation_id, site_id: siteId, lead_id: leadId, customer_id: lead.customer_id, deal_id: dealId, deal_version: deal.version, stock_id: stock.id, stock_label: deal.stock_label, brand_id: deal.brand_id,
        scheduled_at: date, notes, status: 'planned', checklist: emptyChecklist(), created_by: request.user!.id, updated_at: now, created_at: now, version: 0, create_key: createKey, create_hash: hash, ...(deal.integration_mode ? { integration_mode: deal.integration_mode } : {}) };
      await this.mongo.deliveries.insertOne(plan, { session });

      const handoverId = randomUUID();
      const pdiDueDate = new Date(Date.parse(date) - 2 * 86400000).toISOString();
      const handoverItem: import('../database/models.js').HandoverItem = {
        _id: handoverId,
        id: handoverId,
        organisation_id: site.organisation_id,
        site_id: siteId,
        brand_id: deal.brand_id,
        deal_id: dealId,
        lead_id: leadId,
        delivery_plan_id: id,
        customer_id: lead.customer_id,
        stock_id: stock.id,
        vehicle_label: deal.stock_label,
        scheduled_delivery_at: date,
        pdi_due_date: pdiDueDate,
        integration_mode: deal.integration_mode, version: 0,
        pdi_status: 'pending',
        pdi_appointment_id: null,
        accessories_status: 'pending',
        accessories_notes: null,
        first_service_status: 'not_booked',
        first_service_appointment_id: null,
        notes,
        status: 'active',
        created_by: request.user!.id,
        updated_at: now,
        created_at: now,
      };
      const priorHandover=await this.mongo.handoverItems.findOne({organisation_id:site.organisation_id,deal_id:dealId},{session});
      if(priorHandover){await this.mongo.handoverItems.updateOne({id:priorHandover.id},{$set:{delivery_plan_id:id,lead_id:leadId,scheduled_delivery_at:date,pdi_due_date:priorHandover.pdi_due_date||pdiDueDate,updated_at:now},$inc:{version:1}},{session});}
      else await this.mongo.handoverItems.insertOne(handoverItem, { session });

      await this.deliveries.record(plan, request.user!.id, 'sales.delivery_planned', notes, session); return { delivery: await this.deliveries.view(request, plan, session) };
    });
  }
  @Patch(':id')
  @ApiBody({ schema: { type: 'object', required: ['siteId', 'version', 'scheduledAt', 'notes'], properties: { siteId: { type: 'string', format: 'uuid' }, version: { type: 'integer' }, scheduledAt: { type: 'string', format: 'date-time' }, notes: { type: 'string', minLength: 3, maxLength: 2000 } } } })
  async schedule(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'deliveryId'); const siteId = uuid(body.siteId, 'siteId'); const currentVersion = version(body.version); const date = scheduled(body.scheduledAt); const notes = text(body.notes, 'notes', 3, 2000);
    if (Object.keys(body).some(field => !['siteId', 'version', 'scheduledAt', 'notes'].includes(field))) throw new BadRequestException('Unsupported delivery field');
    return this.mongo.transaction(async session => {
      const { plan, lead } = await this.deliveries.context(request, siteId, id, 'deliveries.write', session); const deal = await this.deliveries.validateDeal(lead, plan.deal_id, session);
      if (!deal || deal.status !== 'approved') throw new ConflictException('A current approved deal is required');
      await this.mongo.salesDeals.updateOne({ _id: deal._id }, { $inc: { reservation_revision: 1 } }, { session });
      const row = await this.mongo.deliveries.findOneAndUpdate({ _id: plan._id, version: currentVersion }, { $set: { scheduled_at: date, notes, status: 'planned', updated_at: new Date().toISOString(), ...(plan.status === 'cancelled' ? { checklist: emptyChecklist() } : {}) }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!row) throw new ConflictException('Delivery changed; refresh before rescheduling'); await this.mongo.handoverItems.updateOne({delivery_plan_id:id},{$set:{scheduled_delivery_at:date,status:'active',updated_at:row.updated_at},$inc:{version:1}},{session}); await this.deliveries.record(row, request.user!.id, plan.status === 'cancelled' ? 'sales.delivery_reopened' : 'sales.delivery_rescheduled', notes, session); return { delivery: await this.deliveries.view(request, row, session) };
    });
  }
  @Patch(':id/checklist')
  @ApiBody({ schema: { type: 'object', required: ['siteId', 'version', 'item', 'complete', 'note'], properties: { siteId: { type: 'string', format: 'uuid' }, version: { type: 'integer' }, item: { type: 'string', enum: [...DELIVERY_ITEMS] }, complete: { type: 'boolean' }, note: { type: 'string', minLength: 3, maxLength: 2000 } } } })
  async check(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'deliveryId'); const siteId = uuid(body.siteId, 'siteId'); const currentVersion = version(body.version); const note = text(body.note, 'note', 3, 2000);
    if (!DELIVERY_ITEMS.includes(body.item as DeliveryItem) || typeof body.complete !== 'boolean' || Object.keys(body).some(field => !['siteId', 'version', 'item', 'complete', 'note'].includes(field))) throw new BadRequestException('Choose a valid checklist item and completion flag');
    const item = body.item as DeliveryItem; const permission = item === 'payment_verified' ? 'deliveries.confirm_payment' : item === 'vehicle_preparation' ? 'deliveries.prepare' : 'deliveries.write';
    return this.mongo.transaction(async session => {
      const { plan, lead } = await this.deliveries.context(request, siteId, id, permission, session); const deal = await this.deliveries.validateDeal(lead, plan.deal_id, session);
      if (plan.status !== 'planned' || !deal || deal.status !== 'approved') throw new ConflictException('Only a planned delivery with an approved deal can be updated');
      await this.mongo.salesDeals.updateOne({ _id: deal._id }, { $inc: { reservation_revision: 1 } }, { session });
      const now = new Date().toISOString();
      const row = await this.mongo.deliveries.findOneAndUpdate({ _id: plan._id, version: currentVersion }, { $set: { [`checklist.${item}`]: { complete: body.complete, note, updated_by: request.user!.id, updated_at: now }, updated_at: now }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!row) throw new ConflictException('Delivery changed; refresh before updating the checklist');
      await this.deliveries.record(row, request.user!.id, 'sales.delivery_checked', `${DELIVERY_LABELS[item]} ${body.complete ? 'confirmed' : 'reopened'}`, session,
        { item, complete: body.complete, ...(item === 'payment_verified' ? { private_payment_note: note } : { check_note: note }) }); return { delivery: await this.deliveries.view(request, row, session) };
    });
  }
  @Patch(':id/cancel')
  @ApiBody({ schema: { type: 'object', required: ['siteId', 'version', 'note'], properties: { siteId: { type: 'string', format: 'uuid' }, version: { type: 'integer' }, note: { type: 'string', minLength: 3, maxLength: 2000 } } } })
  async cancel(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'deliveryId'); const siteId = uuid(body.siteId, 'siteId'); const currentVersion = version(body.version); const note = text(body.note, 'note', 3, 2000);
    if (Object.keys(body).some(field => !['siteId', 'version', 'note'].includes(field))) throw new BadRequestException('Unsupported cancellation field');
    return this.mongo.transaction(async session => {
      const { plan } = await this.deliveries.context(request, siteId, id, 'deliveries.write', session);
      const row = await this.mongo.deliveries.findOneAndUpdate({ _id: plan._id, version: currentVersion, status: 'planned' }, { $set: { status: 'cancelled', updated_at: new Date().toISOString() }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!row) throw new ConflictException('Delivery changed or is already cancelled'); await this.deliveries.record(row, request.user!.id, 'sales.delivery_cancelled', note, session); return { delivery: await this.deliveries.view(request, row, session) };
    });
  }
}
