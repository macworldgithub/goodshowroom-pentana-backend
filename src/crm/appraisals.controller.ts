import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { AccessService } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import { AuditService } from '../database/audit.service.js';
import { MongoService } from '../database/mongo.service.js';
import { publicRecord, type TradeInAppraisal } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { pipelineStage } from './sales-pipeline.js';

function number(value: unknown, field: string, max: number, min = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new BadRequestException(`${field} must be an integer between ${min} and ${max}`);
  return Number(value);
}
function optional(value: unknown, field: string, max: number) { return value == null || value === '' ? null : text(value, field, 1, max); }
function vehicle(body: Record<string, unknown>) {
  const vin = optional(body.vin, 'vin', 17)?.toUpperCase() ?? null;
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new BadRequestException('VIN must contain 17 letters/digits excluding I, O and Q');
  return { make: text(body.make, 'make', 1, 100), model: text(body.model, 'model', 1, 100),
    year: number(body.year, 'year', new Date().getUTCFullYear() + 2, 1900), odometer_km: number(body.odometerKm, 'odometerKm', 5000000),
    registration: optional(body.registration, 'registration', 30)?.toUpperCase() ?? null, vin,
    condition_notes: text(body.conditionNotes, 'conditionNotes', 3, 5000) };
}
const inputFields = ['siteId', 'make', 'model', 'year', 'odometerKm', 'registration', 'vin', 'conditionNotes'];
const schema = { type: 'object' as const, properties: {
  siteId: { type: 'string', format: 'uuid' }, make: { type: 'string' }, model: { type: 'string' }, year: { type: 'integer' }, odometerKm: { type: 'integer', minimum: 0 },
  registration: { type: 'string', nullable: true }, vin: { type: 'string', nullable: true }, conditionNotes: { type: 'string', minLength: 3 },
  version: { type: 'integer', minimum: 0 }, status: { type: 'string', enum: ['draft', 'valued', 'withdrawn'] },
  valuationCents: { type: 'integer', minimum: 0, nullable: true }, valuationNotes: { type: 'string', nullable: true }, withdrawalReason: { type: 'string', nullable: true },
} };

@Controller('sales/leads')
@ApiTags('Trade-in appraisals')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class AppraisalsController {
  constructor(@Inject(AccessService) private readonly access: AccessService, @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService, @Inject(IntegrationService) private readonly integration: IntegrationService) {}
  private publicAppraisal(appraisal: TradeInAppraisal) { const { create_key: _key, create_hash: _hash, review_revision: _lock, ...record } = publicRecord(appraisal); return record; }
  private async authorisedLead(request: AuthenticatedRequest, leadId: string, siteId: string, write: boolean, session?: ClientSession) {
    const site = await this.access.requireSite(request, siteId, write ? 'sales.write' : 'sales.read', session);
    const team = await this.access.hasSitePermission(request, siteId, 'sales.view_team', session);
    const lead = await this.mongo.salesLeads.findOne({ ...this.integration.projectionFilter(), id: leadId, site_id: siteId, organisation_id: site.organisation_id,
      ...(team ? {} : { assigned_to: request.user!.id }) }, { session });
    if (!lead) throw new NotFoundException('Enquiry is unavailable'); return { lead, site };
  }

  @Get(':leadId/appraisals')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async list(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Query('siteId') siteId: string,
    @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(leadId, 'leadId'); uuid(siteId, 'siteId'); const page = pagination(offset, limit);
    return this.mongo.transaction(async session => {
      const { site } = await this.authorisedLead(request, leadId, siteId, false, session);
      const rows = await this.mongo.appraisals.find({ ...this.integration.projectionFilter(), lead_id: leadId, site_id: siteId, organisation_id: site.organisation_id }, { session })
        .sort({ updated_at: -1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray();
      const result = pageResult(rows, page); return { appraisals: result.rows.map(row => this.publicAppraisal(row)), pagination: result.pagination };
    });
  }

  @Get(':leadId/appraisals/:id')
  @ApiQuery({ name: 'siteId', required: true })
  async detail(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Param('id') id: string, @Query('siteId') siteId: string) {
    uuid(leadId, 'leadId'); uuid(id, 'appraisalId'); uuid(siteId, 'siteId');
    return this.mongo.transaction(async session => {
      const { site } = await this.authorisedLead(request, leadId, siteId, false, session);
      const row = await this.mongo.appraisals.findOne({ ...this.integration.projectionFilter(), id, lead_id: leadId, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!row) throw new NotFoundException('Appraisal is unavailable'); return { appraisal: this.publicAppraisal(row) };
    });
  }

  @Post(':leadId/appraisals')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).filter(([key]) => inputFields.includes(key))), required: ['siteId', 'make', 'model', 'year', 'odometerKm', 'conditionNotes'] } })
  @ApiOperation({ summary: 'Create a local draft trade-in appraisal', description: 'Vehicle details and condition notes required. Initial valuation is unset. This is an internal assessment and does not create an offer or source write.' })
  async create(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Headers('idempotency-key') key: string, @Body() body: Record<string, unknown>) {
    uuid(leadId, 'leadId'); const siteId = uuid(body.siteId, 'siteId'); const values = vehicle(body); const createKey = text(key, 'Idempotency-Key', 8, 200);
    if (Object.keys(body).some(field => !inputFields.includes(field))) throw new BadRequestException('Unsupported appraisal field');
    const hash = createHash('sha256').update(JSON.stringify({ leadId, siteId, ...values })).digest('hex');
    return this.mongo.transaction(async session => {
      const { lead, site } = await this.authorisedLead(request, leadId, siteId, true, session);
      const existing = await this.mongo.appraisals.findOne({ organisation_id: site.organisation_id, created_by: request.user!.id, create_key: createKey }, { session });
      if (existing) { if (existing.create_hash !== hash) throw new ConflictException('Idempotency key already used for a different appraisal'); return { appraisal: this.publicAppraisal(existing) }; }
      if (lead.status === 'closed') throw new BadRequestException('Reopen the enquiry before creating an appraisal');
      if (await this.mongo.appraisals.countDocuments({ lead_id: leadId, site_id: siteId, organisation_id: site.organisation_id }, { session }) >= 20) throw new BadRequestException('An enquiry can have at most 20 appraisals');
      const id = randomUUID(); const now = new Date().toISOString();
      const appraisal: TradeInAppraisal = { _id: id, id, ...values, organisation_id: site.organisation_id, site_id: siteId, lead_id: leadId, customer_id: lead.customer_id,
        created_by: request.user!.id, status: 'draft', valuation_cents: null, valuation_notes: null, withdrawal_reason: null, currency: 'AUD', source: 'local',
        version: 0, created_at: now, updated_at: now, create_key: createKey, create_hash: hash, ...(lead.integration_mode ? { integration_mode: lead.integration_mode } : {}) };
      await this.mongo.appraisals.insertOne(appraisal, { session });
      const updated = await this.mongo.salesLeads.findOneAndUpdate({ _id: lead._id }, { $inc: { version: 1 }, $set: { updated_at: now } }, { session, returnDocument: 'after' });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'sales.appraisal_created', 'sales_lead', leadId,
        { customer_id: lead.customer_id, appraisal_id: id, appraisal_label: `${values.year} ${values.make} ${values.model}`, appraisal_status: 'draft', appraisal_valuation_cents: null, version: updated!.version, from_stage: pipelineStage(lead), to_stage: pipelineStage(lead) });
      return { appraisal: this.publicAppraisal(appraisal) };
    });
  }

  @Patch(':leadId/appraisals/:id')
  @ApiBody({ schema: { ...schema, required: ['siteId', 'version', 'make', 'model', 'year', 'odometerKm', 'conditionNotes', 'status'] } })
  async edit(@Req() request: AuthenticatedRequest, @Param('leadId') leadId: string, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    uuid(leadId, 'leadId'); uuid(id, 'appraisalId'); const siteId = uuid(body.siteId, 'siteId'); const version = number(body.version, 'version', Number.MAX_SAFE_INTEGER);
    if (Object.keys(body).some(field => ![...inputFields, 'version', 'status', 'valuationCents', 'valuationNotes', 'withdrawalReason'].includes(field))) throw new BadRequestException('Unsupported appraisal field');
    const values = vehicle(body);
    if (!['draft', 'valued', 'withdrawn'].includes(body.status as string)) throw new BadRequestException('Choose draft, valued or withdrawn');
    const valuation = body.valuationCents == null ? null : number(body.valuationCents, 'valuationCents', 1000000000);
    const notes = optional(body.valuationNotes, 'valuationNotes', 5000);
    if (body.status === 'valued' && (valuation === null || !notes || notes.length < 3)) throw new BadRequestException('Valued appraisals require a value and valuation notes');
    const withdrawal = body.status === 'withdrawn' ? text(body.withdrawalReason, 'withdrawalReason', 3, 1000) : null;
    return this.mongo.transaction(async session => {
      const { lead, site } = await this.authorisedLead(request, leadId, siteId, true, session);
      if (lead.status === 'closed') throw new BadRequestException('Reopen the enquiry before editing an appraisal');
      const proposals = await this.mongo.salesDeals.find({ lead_id: leadId, site_id: siteId, organisation_id: site.organisation_id, appraisal_id: id }, { session, projection: { id: 1 } }).toArray();
      if (await this.mongo.reservations.findOne({ organisation_id: site.organisation_id, deal_id: { $in: proposals.map(row => row.id) }, status: 'active', expires_at: { $gt: new Date().toISOString() } }, { session })) throw new ConflictException('Release the active reservation before editing its linked appraisal');
      const row = await this.mongo.appraisals.findOneAndUpdate({ ...this.integration.projectionFilter(), id, lead_id: leadId, site_id: siteId, organisation_id: site.organisation_id, version },
        { $set: { ...values, status: body.status as TradeInAppraisal['status'], valuation_cents: valuation, valuation_notes: notes, withdrawal_reason: withdrawal, updated_at: new Date().toISOString() }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!row) {
        const exists = await this.mongo.appraisals.findOne({ ...this.integration.projectionFilter(), id, lead_id: leadId, site_id: siteId, organisation_id: site.organisation_id }, { session });
        if (!exists) throw new NotFoundException('Appraisal is unavailable'); throw new ConflictException('Appraisal changed; refresh before editing');
      }
      const updated = await this.mongo.salesLeads.findOneAndUpdate({ _id: lead._id }, { $inc: { version: 1 }, $set: { updated_at: row.updated_at } }, { session, returnDocument: 'after' });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'sales.appraisal_updated', 'sales_lead', leadId,
        { customer_id: lead.customer_id, appraisal_id: id, appraisal_label: `${row.year} ${row.make} ${row.model}`, appraisal_status: row.status,
          appraisal_valuation_cents: row.valuation_cents, reason: withdrawal ?? notes, version: updated!.version, from_stage: pipelineStage(lead), to_stage: pipelineStage(lead) });
      return { appraisal: this.publicAppraisal(row) };
    });
  }
}
