import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { AccessService } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { publicRecord, type DeliveryPlan, type SalesLead } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { deliveryReadiness } from './delivery-checklist.js';

@Injectable()
export class DeliveriesService {
  constructor(@Inject(MongoService) private readonly mongo: MongoService, @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService, @Inject(IntegrationService) private readonly integration: IntegrationService) {}
  async scope(request: AuthenticatedRequest, siteId: string, permission: string, session: ClientSession) {
    const site = await this.access.requireSite(request, siteId, permission, session);
    const team = await this.access.hasSitePermission(request, siteId, 'sales.view_team', session);
    const serviceView = permission === 'deliveries.read' || permission === 'deliveries.prepare'
      ? await this.access.hasSitePermission(request, siteId, 'service.read', session) : false;
    return { site, ownOnly: !team && !serviceView };
  }
  async context(request: AuthenticatedRequest, siteId: string, id: string, permission: string, session: ClientSession) {
    const { site, ownOnly } = await this.scope(request, siteId, permission, session);
    const plan = await this.mongo.deliveries.findOne({ ...this.integration.projectionFilter(), id, site_id: siteId, organisation_id: site.organisation_id }, { session });
    if (!plan) throw new NotFoundException('Delivery plan is unavailable');
    if (plan.handed_over_at && permission !== 'deliveries.read') throw new ConflictException('Completed handovers are read-only');
    await this.access.requireBrand(request, siteId, plan.brand_id, permission, session);
    const lead = await this.mongo.salesLeads.findOne({ ...this.integration.projectionFilter(), id: plan.lead_id, site_id: siteId, organisation_id: site.organisation_id,
      ...(ownOnly ? { assigned_to: request.user!.id } : {}) }, { session });
    if (!lead) throw new NotFoundException('Delivery plan is unavailable'); return { site, plan, lead };
  }
  async view(request: AuthenticatedRequest, plan: DeliveryPlan, session: ClientSession) {
    return (await this.viewMany(request, [plan], session))[0];
  }
  async viewMany(request: AuthenticatedRequest, plans: DeliveryPlan[], session: ClientSession) {
    if (!plans.length) return [];
    const first = plans[0]; const filter = { ...this.integration.projectionFilter(), organisation_id: first.organisation_id, site_id: first.site_id };
    const deals = await this.mongo.salesDeals.find({ ...filter, id: { $in: plans.map(plan => plan.deal_id) } }, { session }).toArray();
    const stocks = await this.mongo.stockVehicles.find({ ...filter, id: { $in: plans.map(plan => plan.stock_id) } }, { session }).toArray();
    const holds = await this.mongo.reservations.find({ ...filter, deal_id: { $in: plans.map(plan => plan.deal_id) }, status: 'active', expires_at: { $gt: new Date().toISOString() } }, { session }).toArray();
    const appraisals = await this.mongo.appraisals.find({ ...filter, id: { $in: deals.map(deal => deal.appraisal_id).filter((id): id is string => !!id) } }, { session }).toArray();
    const privatePayment = await this.access.hasSitePermission(request, first.site_id, 'deliveries.confirm_payment', session);
    const profiles = await this.mongo.users.find({ _id: { $in: plans.flatMap(plan => Object.values(plan.checklist).map(check => check.updated_by).filter((id): id is string => !!id)) } }, { session, projection: { full_name: 1 } }).toArray();
    return plans.map(plan => {
      const deal = deals.find(row => row.id === plan.deal_id && row.lead_id === plan.lead_id) ?? null;
      const stock = stocks.find(row => row.id === plan.stock_id) ?? null;
      const hold = holds.find(row => row.deal_id === plan.deal_id && row.stock_id === plan.stock_id) ?? null;
      const appraisal = appraisals.find(row => row.id === deal?.appraisal_id && row.lead_id === plan.lead_id) ?? null;
      const { create_key: _key, create_hash: _hash, ...record } = publicRecord(plan);
      return { ...record, checklist: Object.fromEntries(Object.entries(record.checklist).map(([key, check]) => [key, { ...check, note: key === 'payment_verified' && !privatePayment ? null : check.note,
        author: check.updated_by ? profiles.find(profile => profile._id === check.updated_by)?.full_name ?? 'Staff member' : null }])),
        readiness: deliveryReadiness(plan, deal, stock, hold, appraisal), reservation: hold ? { expiresAt: hold.expires_at } : null };
    });
  }
  async record(plan: DeliveryPlan, actor: string, action: string, reason: string, session: ClientSession, metadata: Record<string, unknown> = {}) {
    if(plan.status==='cancelled')await this.mongo.handoverItems.updateMany({delivery_plan_id:plan.id,status:'active'},{$set:{status:'cancelled',updated_at:plan.updated_at},$inc:{version:1}},{session});
    const lead = await this.mongo.salesLeads.findOneAndUpdate({ id: plan.lead_id, organisation_id: plan.organisation_id, site_id: plan.site_id },
      { $inc: { version: 1 }, $set: { updated_at: plan.updated_at } }, { session, returnDocument: 'after' });
    await this.audit.record(session, actor, plan.organisation_id, plan.site_id, action, 'sales_lead', plan.lead_id,
      { delivery_id: plan.id, deal_id: plan.deal_id, delivery_status: plan.status, delivery_scheduled_at: plan.scheduled_at, stock_brand_id: plan.brand_id, stock_label: plan.stock_label, version: lead?.version ?? null, reason, ...metadata });
  }
  async cancelDeal(organisationId: string, dealId: string, actor: string, session: ClientSession) {
    await this.mongo.handoverItems.updateMany({organisation_id:organisationId,deal_id:dealId,status:'active'},{$set:{status:'cancelled',updated_at:new Date().toISOString()},$inc:{version:1}},{session});
    const plan = await this.mongo.deliveries.findOneAndUpdate({ organisation_id: organisationId, deal_id: dealId, status: 'planned' },
      { $set: { status: 'cancelled', updated_at: new Date().toISOString() }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
    if (plan) await this.record(plan, actor, 'sales.delivery_cancelled', 'Deal cancelled', session);
  }
  async validateDeal(lead: SalesLead, dealId: string, session: ClientSession) {
    const deal = await this.mongo.salesDeals.findOne({ ...this.integration.projectionFilter(), id: dealId, lead_id: lead.id, site_id: lead.site_id, organisation_id: lead.organisation_id }, { session });
    return deal;
  }
}
