import { BadRequestException, Controller, ForbiddenException, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AccessService } from '../auth/access.service.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { publicRecord, type Task } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { dayWindow } from './day-window.js';

type QueueRow = Task & { bucket: 'overdue' | 'today'; customer: { id: string; first_name: string; last_name: string }[] };
type Totals = { all: number; overdue: number; today: number; scheduledCalls: number };
@Controller('my-day')
@ApiTags('My Day')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class MyDayController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(IntegrationService) private readonly integration: IntegrationService) {}

  @Get()
  @ApiOperation({ summary: 'Personal/team daily work queue', description: 'Open tasks and scheduled call tasks through the selected site-local day. Overdue means due before this day begins; today includes the full selected day. Counts cover the full authorized queue, not just the page. Existing tasks default to follow_up. No appointment, delivery, or collection modules exist yet.' })
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'date', required: false, type: String, example: '2026-10-12', description: 'YYYY-MM-DD; defaults to today in the site timezone.' })
  @ApiQuery({ name: 'view', required: false, enum: ['own', 'team'], description: 'Default own, including ADMIN. team requires tasks.view_team.' })
  @ApiQuery({ name: 'bucket', required: false, enum: ['all', 'overdue', 'today', 'calls'] })
  @ApiPagination()
  async get(@Req() request: AuthenticatedRequest, @Query('siteId') siteId?: string,
    @Query('date') date?: string, @Query('view') requestedView?: string, @Query('bucket') requestedBucket?: string,
    @Query('offset') offset?: string, @Query('limit') limit?: string) {
    const targetSite = uuid(siteId, 'siteId');
    const view = requestedView ?? 'own';
    const bucket = requestedBucket ?? 'all';
    if (!['own', 'team'].includes(view)) throw new BadRequestException('view must be own or team');
    if (!['all', 'overdue', 'today', 'calls'].includes(bucket)) throw new BadRequestException('bucket must be all, overdue, today, or calls');
    const page = pagination(offset, limit);
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, targetSite, 'tasks.read', session);
      await this.access.requireSite(request, targetSite, 'customers.read', session);
      const canViewTeam = await this.access.hasSitePermission(request, targetSite, 'tasks.view_team', session);
      if (view === 'team' && !canViewTeam) throw new ForbiddenException('Team queue requires tasks.view_team');
      const day = dayWindow(site.timezone, date);
      const result = await this.mongo.tasks.aggregate<{ items: QueueRow[]; totals: Totals[] }>([
        { $match: { ...this.integration.projectionFilter(), organisation_id: site.organisation_id, site_id: targetSite,
          completed_at: null, cancelled_at: null, due_at: { $lt: day.endsAt }, ...(view === 'own' ? { assigned_to: request.user!.id } : {}) } },
        { $lookup: { from: 'customers', let: { customerId: '$customer_id' }, pipeline: [
          { $match: { ...this.integration.projectionFilter(), organisation_id: site.organisation_id, site_id: targetSite, $expr: { $eq: ['$id', '$$customerId'] } } },
          { $project: { _id: 0, id: 1, first_name: 1, last_name: 1 } },
        ], as: 'customer' } },
        { $match: { 'customer.0': { $exists: true } } },
        { $addFields: { kind: { $ifNull: ['$kind', 'follow_up'] }, bucket: { $cond: [{ $lt: ['$due_at', day.startsAt] }, 'overdue', 'today'] } } },
        { $facet: {
          totals: [{ $group: { _id: null, all: { $sum: 1 }, overdue: { $sum: { $cond: [{ $eq: ['$bucket', 'overdue'] }, 1, 0] } },
            today: { $sum: { $cond: [{ $eq: ['$bucket', 'today'] }, 1, 0] } }, scheduledCalls: { $sum: { $cond: [{ $eq: ['$kind', 'call'] }, 1, 0] } } } }, { $project: { _id: 0 } }],
          items: [...(bucket === 'all' ? [] : [{ $match: bucket === 'calls' ? { kind: 'call' } : { bucket } }]),
            { $sort: { due_at: 1, id: 1 } }, { $skip: page.offset }, { $limit: page.limit + 1 }],
        } },
      ], { session }).toArray();
      const data = result[0];
      const paged = pageResult(data?.items ?? [], page);
      return { day, view, bucket, canViewTeam, items: paged.rows.map(row => ({ ...publicRecord(row), customer: row.customer[0] })),
        totals: data?.totals[0] ?? { all: 0, overdue: 0, today: 0, scheduledCalls: 0 }, pagination: paged.pagination,
        includedSources: ['follow_up_tasks', 'scheduled_call_tasks'], integration: this.integration.config.info() };
    });
  }
}
