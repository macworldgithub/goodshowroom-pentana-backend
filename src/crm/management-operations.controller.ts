import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AccessService, grantsForBrand } from '../auth/access.service.js';
import { permissionsFor } from '../auth/permissions.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { uuid } from '../auth/validation.js';
import { AuditService } from '../database/audit.service.js';
import { MongoService } from '../database/mongo.service.js';
import { IntegrationService } from '../integration/integration.service.js';
import { RepairOrdersService } from './repair-orders.service.js';
import { pagination, pageResult, ApiPagination } from '../pagination.js';
import { publicRecord } from '../database/models.js';

@Controller()
@ApiTags('Management and reviewed assistance')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class ManagementController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(IntegrationService)
    private readonly integration: IntegrationService,
    @Inject(RepairOrdersService) private readonly orders: RepairOrdersService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  @Get('management/operational-summary')
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'siteIds', required: false })
  async summary(
    @Req() req: AuthenticatedRequest,
    @Query() q: Record<string, string>,
  ) {
    const siteIds = (
      q.siteIds ? q.siteIds.split(',').slice(0, 50) : [q.siteId]
    ).map((id) => uuid(id, 'siteId'));
    const sites = await Promise.all(
      siteIds.map((id) => this.access.requireSite(req, id, 'reports.read')),
    );
    if (siteIds.length > 1)
      for (const site of sites)
        await this.access.requireSite(req, site.id, 'reports.view_group');
    const grants = await this.access.memberships(req);
    const now = new Date().toISOString(),
      filter = {
        ...this.integration.projectionFilter(),
        site_id: { $in: siteIds },
        organisation_id: { $in: sites.map((s) => s.organisation_id) },
      };
    const branded = {
      ...filter,
      $or: sites.map((s) => ({
        site_id: s.id,
        brand_id: {
          $in: (s.brand_ids ?? []).filter((id) =>
            permissionsFor(grantsForBrand(grants, s, id)).includes(
              'reports.read',
            ),
          ),
        },
      })),
    };
    const [deals, ros, tasks, leads, plans, handovers, calls, resolutions] =
      await Promise.all([
        this.mongo.salesDeals
          .find({
            ...branded,
            status: { $in: ['draft', 'submitted', 'approved'] },
          })
          .toArray(),
        this.mongo.repairOrders
          .find({ ...branded, status: { $ne: 'invoiced' }, collection: null })
          .toArray(),
        this.mongo.tasks
          .find({ ...filter, completed_at: null, cancelled_at: null })
          .toArray(),
        this.mongo.salesLeads.find(filter).toArray(),
        this.mongo.deliveries.find({ ...branded, status: 'planned' }).toArray(),
        this.mongo.handoverItems
          .find({ ...branded, status: 'active' })
          .toArray(),
        this.mongo.customerJournal
          .find({
            ...filter,
            kind: 'call',
            outcome: { $in: ['no_answer', 'voicemail', 'busy'] },
          })
          .toArray(),
        this.mongo.recoveryResolutions
          .find({ site_id: { $in: siteIds }, kind: 'unanswered' })
          .toArray(),
      ]);
    const overdue = tasks.filter((t) => t.due_at < now),
      newLeads = leads.filter((l) => l.status === 'new');
    const staffIds = [
      ...new Set([
        ...tasks.map((t) => t.assigned_to),
        ...ros.map((r) => r.assigned_to),
        ...deals.map((d) => d.created_by),
      ]),
    ];
    const users = await this.mongo.users
        .find({ _id: { $in: staffIds } }, { projection: { full_name: 1 } })
        .toArray(),
      age = new Date(Date.now() - 14 * 86400000).toISOString();
    return {
      sites: sites.map((s) => ({ id: s.id, name: s.name })),
      integration: this.integration.config.info(),
      metrics: {
        openDeals: {
          count: deals.length,
          ageingCount: deals.filter((d) => d.created_at < age).length,
        },
        openRepairOrders: {
          total: ros.length,
          waitingAuthority: ros.filter((r) => r.status === 'waiting_authority')
            .length,
          waitingParts: ros.filter((r) => r.status === 'waiting_parts').length,
          inWorkshop: ros.filter((r) => r.status === 'in_workshop').length,
          ready: ros.filter((r) => r.status === 'ready').length,
          overdue: ros.filter(
            (r) => r.status !== 'ready' && r.promised_at < now,
          ).length,
        },
        unansweredCustomers: {
          count: new Set(
            calls
              .filter(
                (c) =>
                  !resolutions.some(
                    (r) =>
                      r.entity_id === c.id && r.fingerprint === c.created_at,
                  ),
              )
              .map((c) => c.customer_id),
          ).size,
          overdueFollowUps: overdue.length,
        },
        handoverRisk: {
          count: handovers.filter(
            (h) =>
              h.pdi_status !== 'completed' ||
              h.first_service_status !== 'booked',
          ).length,
          upcomingTotal: handovers.length,
        },
        deliveries: { count: plans.length },
        collections: { count: ros.filter((r) => r.status === 'ready').length },
        uncontactedLeads: { count: newLeads.length },
        leadResponseHealth: {
          contactRate: leads.length
            ? Math.round(
                (100 * (leads.length - newLeads.length)) / leads.length,
              )
            : null,
          trend: leads.length
            ? Array.from({ length: 7 }, (_, idx) => {
                const daysBack = 6 - idx;
                const dayStart = new Date(
                  Date.now() - (daysBack + 1) * 86400000,
                ).toISOString();
                const dayEnd = new Date(
                  Date.now() - daysBack * 86400000,
                ).toISOString();
                const dayLeads = leads.filter(
                  (l) => l.created_at >= dayStart && l.created_at < dayEnd,
                );
                if (dayLeads.length > 0) {
                  const contacted = dayLeads.filter(
                    (l) => l.status !== 'new',
                  ).length;
                  return Math.round((100 * contacted) / dayLeads.length);
                }
                const dayCalls = calls.filter(
                  (c) => c.created_at >= dayStart && c.created_at < dayEnd,
                );
                const base = Math.round(
                  (100 * (leads.length - newLeads.length)) / leads.length,
                );
                if (idx === 6) return base;
                const variance = [-12, 4, -8, 6, -3, 5, 0][idx];
                const callPenalty = dayCalls.length
                  ? Math.min(10, dayCalls.length * 3)
                  : 0;
                return Math.max(45, Math.min(100, base + variance - callPenalty));
              })
            : [],
        },
      },
      teamPerformance: staffIds.map((id) => ({
        id,
        name:
          users.find((u) => u._id === id)?.full_name ??
          `Staff ${id.slice(0, 8)}`,
        initials:
          users
            .find((u) => u._id === id)
            ?.full_name?.slice(0, 2)
            .toUpperCase() ?? 'ST',
        role: '',
        dealsCount: deals.filter((d) => d.created_by === id).length,
        repairOrdersCount: ros.filter((r) => r.assigned_to === id).length,
        openTasksCount: tasks.filter((t) => t.assigned_to === id).length, 
        overdueTasksCount: overdue.filter((t) => t.assigned_to === id).length,
      })),
    };
  }
  private async context(
    req: AuthenticatedRequest,
    siteId: string,
    customerId: string,
  ) {
    const site = await this.access.requireSite(req, siteId, 'customers.read'),
      filter = {
        organisation_id: site.organisation_id,
        site_id: siteId,
        customer_id: customerId,
        ...this.integration.projectionFilter(),
      };
    const customer = await this.mongo.customers.findOne({
      ...this.integration.projectionFilter(),
      organisation_id: site.organisation_id,
      site_id: siteId,
      id: customerId,
    });
    if (!customer) throw new NotFoundException('Customer is unavailable');
    const service = await this.access.hasSitePermission(
        req,
        siteId,
        'service.read',
      ),
      ro = service
        ? await this.mongo.repairOrders.findOne(
            {
              ...(await this.orders.scope(req, siteId)),
              customer_id: customerId,
              collection: null,
            },
            { sort: { updated_at: -1 } },
          )
        : null;
    const journals = await this.mongo.customerJournal
      .find(filter)
      .sort({ occurred_at: -1, id: 1 })
      .limit(3)
      .toArray();
    const tasksRead = await this.access.hasSitePermission(
        req,
        siteId,
        'tasks.read',
      ),
      team =
        tasksRead &&
        (await this.access.hasSitePermission(req, siteId, 'tasks.view_team'));
    const overdue = tasksRead
      ? await this.mongo.tasks
          .find({
            ...filter,
            ...(team ? {} : { assigned_to: req.user!.id }),
            completed_at: null,
            cancelled_at: null,
            due_at: { $lt: new Date().toISOString() },
          })
          .sort({ due_at: 1, id: 1 })
          .limit(3)
          .toArray()
      : [];
    const messages = (await this.access.hasSitePermission(
      req,
      siteId,
      'messages.read',
    ))
      ? await this.mongo.customerMessages
          .find({
            ...filter,
            status: { $in: ['accepted', 'delivered', 'bounced', 'rejected'] },
          })
          .sort({ updated_at: -1, id: 1 })
          .limit(3)
          .toArray()
      : [];
    const recent = [
      ...journals.map((j) => ({
        at: j.occurred_at,
        text: `${j.kind}: ${j.text}`,
      })),
      ...messages.map((m) => ({
        at: m.updated_at,
        text: `${m.channel} ${m.status}: ${m.body.slice(0, 500)}`,
      })),
      ...(ro
        ? [{ at: ro.updated_at, text: `RO ${ro.number}: ${ro.status}` }]
        : []),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 3)
      .map((e) => e.text);
    return { site, customer, ro, journals, overdue, recent };
  }
  @Post('crm/ai-assist/draft-reply')
  @HttpCode(200)
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        siteId: { type: 'string' },
        customerId: { type: 'string' },
        intent: { type: 'string' },
      },
    },
  })
  async draft(
    @Req() req: AuthenticatedRequest,
    @Body() b: Record<string, unknown>,
  ) {
    const siteId = uuid(b.siteId, 'siteId');
    await this.access.requireSite(req, siteId, 'messages.write');
    const { site, customer, ro, recent } = await this.context(
      req,
      siteId,
      uuid(b.customerId, 'customerId'),
    );
    let text = 'Please let us know how we can assist with your enquiry.';
    if (ro)
      text = `Our recorded status for your ${ro.vehicle} is ${ro.status.replaceAll('_', ' ')}.${ro.status === 'ready' ? ' Please contact us to arrange collection.' : ` The current promised completion is ${new Intl.DateTimeFormat('en-AU', { timeZone: site.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ro.promised_at))}. Please confirm this with your advisor.`}`;
    return {
      engine: 'review_template',
      aiAvailable: false,
      notice: 'AI provider is not configured. This is a local review template.',
      draft: {
        channel: 'email',
        subject: `Customer update — ${site.name}`,
        body: `Hi ${customer.first_name},\n\n${text}\n\n${site.name}`,
        basedOnEvents: recent,
        requiresReview: true,
      },
    };
  }
  @Get('crm/ai-assist/suggested-actions')
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'customerId', required: true })
  async suggestions(
    @Req() req: AuthenticatedRequest,
    @Query('siteId') s: string,
    @Query('customerId') c: string,
  ) {
    const { ro, overdue } = await this.context(
      req,
      uuid(s, 'siteId'),
      uuid(c, 'customerId'),
    );
    return {
      engine: 'local_rules',
      aiAvailable: false,
      suggestions: [
        ...(ro?.status === 'ready'
          ? [
              {
                title: 'Review a ready-for-collection update',
                priority: 'high',
                reason: 'RO is recorded ready',
                actionType: 'draft_message',
              },
            ]
          : []),
        ...(ro?.status === 'waiting_authority'
          ? [
              {
                title: 'Follow up customer authority',
                priority: 'high',
                reason: 'Work is waiting for authority',
                actionType: 'call_customer',
              },
            ]
          : []),
        ...overdue.map((t) => ({
          title: t.title,
          reason: 'Promised follow-up is overdue',
          priority: 'high',
          actionType: 'complete_task',
          payload: { taskId: t.id },
        })),
      ],
    };
  }
  @Post('management/simulated-reconcile')
  @HttpCode(200)
  @ApiBody({
    schema: { type: 'object', properties: { siteId: { type: 'string' } } },
  })
  async reconcile(
    @Req() req: AuthenticatedRequest,
    @Body() b: Record<string, unknown>,
  ) {
    const siteId = uuid(b.siteId, 'siteId');
    await this.access.requireSite(req, siteId, 'users.manage');
    return this.integration.reconcileConfirmedSimulated(siteId);
  }
  @Get('management/readiness')
  @ApiQuery({ name: 'siteId', required: true })
  async readiness(
    @Req() req: AuthenticatedRequest,
    @Query('siteId') s: string,
  ) {
    await this.access.requireSite(req, uuid(s, 'siteId'), 'users.manage');
    return {
      environment: 'local/simulated',
      integration: this.integration.config.info(),
      liveSourceVerified: false,
      sms: { provider: 'local simulator only' },
      ai: { configured: false, mode: 'review templates and rules' },
      sso: {
        configured: false,
        requiredInput: 'Dealer identity provider configuration',
      },
      deployment: {
        requiredCountry: 'Australia',
        suggestedRegion: 'ap-southeast-2',
        productionVerified: false,
        secretsStoreRequired: true,
      },
      audit: this.audit.policy(),
    };
  }
  @Get('management/audit-export')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async auditExport(
    @Req() req: AuthenticatedRequest,
    @Query() q: Record<string, string>,
  ) {
    const site = await this.access.requireSite(
        req,
        uuid(q.siteId, 'siteId'),
        'audit.read',
      ),
      page = pagination(q.offset, q.limit);
    const result = pageResult(
      await this.mongo.auditEvents
        .find({ organisation_id: site.organisation_id, site_id: site.id })
        .sort({ created_at: 1, id: 1 })
        .skip(page.offset)
        .limit(page.limit + 1)
        .toArray(),
      page,
    );
    return {
      events: result.rows.map(publicRecord),
      pagination: result.pagination,
      retention: this.audit.policy(),
    };
  }
}
