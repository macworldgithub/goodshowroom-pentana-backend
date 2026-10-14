import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AccessService, grantsForBrand } from '../auth/access.service.js';
import { permissionsFor } from '../auth/permissions.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import { AuditService } from '../database/audit.service.js';
import { MongoService } from '../database/mongo.service.js';
import { publicRecord, type SalesLead } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { enquiryStatus, pipelineStage, PIPELINE_STAGES, type PipelineStage } from './sales-pipeline.js';

@Controller('sales/pipeline')
@ApiTags('Sales pipeline')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class SalesPipelineController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntegrationService) private readonly integration: IntegrationService) {}

  @Get()
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'stage', required: false, enum: [...PIPELINE_STAGES] })
  @ApiQuery({ name: 'search', required: false })
  async list(@Req() request: AuthenticatedRequest, @Query('siteId') siteId: string, @Query('stage') stage?: string,
    @Query('search') search?: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(siteId, 'siteId'); const page = pagination(offset, limit);
    if (stage !== undefined && !PIPELINE_STAGES.includes(stage as PipelineStage)) throw new BadRequestException('Invalid pipeline stage');
    if (search !== undefined && typeof search !== 'string') throw new BadRequestException('search must be text');
    const term = search?.trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const site = await this.access.requireSite(request, siteId, 'sales.read');
    const team = await this.access.hasSitePermission(request, siteId, 'sales.view_team');
    const result = await this.mongo.salesLeads.aggregate<{ counts: { _id: PipelineStage; total: number }[]; rows: SalesLead[] }>([
      { $match: { ...this.integration.projectionFilter(), site_id: siteId, organisation_id: site.organisation_id,
        ...(team ? {} : { assigned_to: request.user!.id }), ...(term ? { title: { $regex: term, $options: 'i' } } : {}) } },
      { $addFields: { pipeline_stage: { $ifNull: ['$pipeline_stage', '$status'] } } },
      { $facet: { counts: [{ $group: { _id: '$pipeline_stage', total: { $sum: 1 } } }], rows: [
        ...(stage ? [{ $match: { pipeline_stage: stage } }] : []), { $sort: { updated_at: -1, id: 1 } }, { $skip: page.offset }, { $limit: page.limit + 1 },
      ] } },
    ]).toArray();
    const data = result[0]; const paged = pageResult(data.rows, page);
    return { leads: paged.rows.map(lead => this.publicLead(lead)), pagination: paged.pagination, visibility: team ? 'team' : 'own',
      stages: PIPELINE_STAGES.map(id => ({ id, count: data.counts.find(item => item._id === id)?.total ?? 0 })) };
  }

  private publicLead(lead: SalesLead) {
    const { create_key: _key, create_hash: _hash, ...record } = publicRecord(lead);
    return { ...record, pipeline_stage: pipelineStage(lead) };
  }

  @Patch(':id/stage')
  @ApiOperation({ summary: 'Move an enquiry stage and record progress', description: 'Version checked. A reason is required for every move, including reopening. Won records an enquiry outcome only; it does not create a deal, reservation or source write.' })
  @ApiBody({ schema: { type: 'object', required: ['siteId', 'version', 'stage', 'reason'], properties: {
    siteId: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 0 },
    stage: { type: 'string', enum: PIPELINE_STAGES.filter(stage => stage !== 'closed') }, reason: { type: 'string', minLength: 3, maxLength: 1000 },
  } } })
  async move(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(id, 'leadId'); const siteId = uuid(body.siteId, 'siteId');
    if (Object.keys(body).some(key => !['siteId', 'version', 'stage', 'reason'].includes(key))) throw new BadRequestException('Unsupported stage field');
    if (!Number.isInteger(body.version) || Number(body.version) < 0) throw new BadRequestException('Provide the current version');
    if (!PIPELINE_STAGES.includes(body.stage as PipelineStage) || body.stage === 'closed') throw new BadRequestException('Choose a valid stage; use won or lost to close an enquiry');
    const stage = body.stage as PipelineStage; const reason = text(body.reason, 'reason', 3, 1000);
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'sales.write', session);
      const team = await this.access.hasSitePermission(request, siteId, 'sales.view_team', session);
      const filter = { ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id, ...(team ? {} : { assigned_to: request.user!.id }) };
      const lead = await this.mongo.salesLeads.findOne(filter, { session });
      if (!lead) throw new NotFoundException('Enquiry is unavailable');
      if (pipelineStage(lead) === stage) throw new BadRequestException('Enquiry is already in this stage');
      const updated = await this.mongo.salesLeads.findOneAndUpdate({ ...filter, version: Number(body.version) }, {
        $set: { pipeline_stage: stage, status: enquiryStatus(stage), updated_at: new Date().toISOString() }, $inc: { version: 1 },
      }, { session, returnDocument: 'after' });
      if (!updated) throw new ConflictException('Enquiry changed; refresh before moving it');
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'sales.stage_changed', 'sales_lead', id,
        { customer_id: lead.customer_id, from_stage: pipelineStage(lead), to_stage: stage, reason, version: updated.version });
      return { lead: this.publicLead(updated) };
    });
  }

  @Get(':id/history')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async history(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('siteId') siteId: string,
    @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(id, 'leadId'); uuid(siteId, 'siteId'); const page = pagination(offset, limit);
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'sales.read', session);
      const team = await this.access.hasSitePermission(request, siteId, 'sales.view_team', session);
      const lead = await this.mongo.salesLeads.findOne({ ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id, ...(team ? {} : { assigned_to: request.user!.id }) }, { session });
      if (!lead) throw new NotFoundException('Enquiry is unavailable');
      const grants = await this.access.memberships(request, session);
      const brands = (site.brand_ids ?? []).filter(brand => permissionsFor(grantsForBrand(grants, site, brand)).includes('sales.read'));
      const rows = await this.mongo.auditEvents.find({ organisation_id: site.organisation_id, site_id: siteId, entity_type: 'sales_lead', entity_id: id,
        $or: [{ action: { $nin: ['sales.stock_matched', 'sales.stock_removed', 'sales.deal_created', 'sales.deal_updated', 'sales.deal_submitted', 'sales.deal_approved', 'sales.deal_rejected', 'sales.deal_cancelled', 'sales.reservation_created', 'sales.reservation_released', 'sales.reservation_expired'] } }, { 'metadata.stock_brand_id': { $in: brands } }],
        action: { $in: ['sales.lead_created', 'sales.lead_updated', 'sales.stage_changed', 'sales.stock_matched', 'sales.stock_removed', 'sales.appraisal_created', 'sales.appraisal_updated', 'sales.deal_created', 'sales.deal_updated', 'sales.deal_submitted', 'sales.deal_approved', 'sales.deal_rejected', 'sales.deal_cancelled', 'sales.reservation_created', 'sales.reservation_released', 'sales.reservation_expired'] } }, { session }).sort({ 'metadata.version': -1, created_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray();
      const result = pageResult(rows, page);
      const profiles = await this.mongo.users.find({ _id: { $in: result.rows.map(row => row.actor_user_id) } }, { session, projection: { full_name: 1 } }).toArray();
      return { lead: this.publicLead(lead), history: result.rows.map(event => ({ id: event.id, type: event.action, occurredAt: event.created_at,
        author: { id: event.actor_user_id, fullName: event.actor_user_id === 'system' ? 'System' : profiles.find(profile => profile._id === event.actor_user_id)?.full_name ?? null },
        fromStage: event.metadata.from_stage ?? null, toStage: event.metadata.to_stage ?? null, reason: event.metadata.reason ?? null,
        fields: event.metadata.fields ?? [], version: event.metadata.version ?? null,
        stockId: event.metadata.stock_id ?? null, stockLabel: event.metadata.stock_label ?? null,
        appraisalId: event.metadata.appraisal_id ?? null, appraisalLabel: event.metadata.appraisal_label ?? null, appraisalStatus: event.metadata.appraisal_status ?? null,
        appraisalValuationCents: event.metadata.appraisal_valuation_cents ?? null,
        dealId: event.metadata.deal_id ?? null, dealStatus: event.metadata.deal_status ?? null, dealTotalCents: event.metadata.deal_total_cents ?? null,
        reservationId: event.metadata.reservation_id ?? null, reservationStatus: event.metadata.reservation_status ?? null, reservationExpiresAt: event.metadata.reservation_expires_at ?? null,
      })), pagination: result.pagination };
    });
  }
}
