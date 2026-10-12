import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IntegrationService } from '../integration/integration.service.js';
import { ApiJsonBody } from '../api-bodies.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AccessService } from '../auth/access.service.js';
import { text, uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord, type Task } from '../database/models.js';

@Controller('tasks')
@ApiTags('Tasks')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class TasksController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntegrationService) private readonly integration: IntegrationService) {}

  @Get()
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'through', required: false, type: String, format: 'date-time', description: 'Return tasks due on or before this time; defaults to now.' })
  @ApiPagination()
  async list(@Req() request: AuthenticatedRequest, @Query('siteId') siteId?: string, @Query('through') through?: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    const id = uuid(siteId, 'siteId');
    const site = await this.access.requireSite(request, id, 'tasks.read');
    if (through !== undefined && (typeof through !== 'string' || !Number.isFinite(Date.parse(through)))) throw new BadRequestException('through must be a valid date');
    const cutoff = through ? new Date(through).toISOString() : new Date().toISOString();
    const viewTeam = await this.access.hasSitePermission(request, id, 'tasks.view_team');
    const page = pagination(offset, limit);
    const rows = await this.mongo.tasks.find({ ...this.integration.projectionFilter(), site_id: id, organisation_id: site.organisation_id, due_at: { $lte: cutoff },
      ...(viewTeam ? {} : { assigned_to: request.user!.id }),
    }).sort({ completed_at: 1, due_at: 1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray();
    const result = pageResult(rows, page);
    const tasks = result.rows;
    const customers = await this.mongo.customers.find({ site_id: id, organisation_id: site.organisation_id,
      id: { $in: tasks.map(task => task.customer_id) },
    }).toArray();
    return { tasks: tasks.map(task => {
      const customer = customers.find(item => item.id === task.customer_id);
      return { ...publicRecord(task), customers: customer ? { first_name: customer.first_name, last_name: customer.last_name } : null };
    }), pagination: result.pagination };
  }

  @Post()
  @ApiJsonBody('task')
  async create(@Req() request: AuthenticatedRequest, @Body() body: {
    siteId?: unknown; customerId?: unknown; title?: unknown; details?: unknown; dueAt?: unknown; priority?: unknown; kind?: unknown;
  }) {
    const siteId = uuid(body.siteId, 'siteId');
    const customerId = uuid(body.customerId, 'customerId');
    const title = text(body.title, 'title', 2, 180);
    const details = body.details == null || body.details === '' ? null : text(body.details, 'details', 1, 5000);
    if (typeof body.dueAt !== 'string' || !Number.isFinite(Date.parse(body.dueAt))) throw new BadRequestException('A valid due date is required');
    const dueAt = new Date(body.dueAt).toISOString();
    const priority = body.priority ?? 'normal';
    const kind = body.kind ?? 'follow_up';
    if (!['follow_up', 'call'].includes(kind as string)) throw new BadRequestException('kind must be follow_up or call');
    if (!['low', 'normal', 'high'].includes(priority as string)) throw new BadRequestException('Choose a valid priority');
    await this.access.requireSite(request, siteId, 'tasks.write');
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, siteId, 'tasks.write', session);
      const customer = await this.mongo.customers.findOne({ ...this.integration.projectionFilter(), id: customerId, site_id: siteId, organisation_id: site.organisation_id }, { session });
      if (!customer) throw new BadRequestException('Customer is not available at this site');
      const id = randomUUID();
      const now = new Date().toISOString();
      const task: Task = { _id: id, id, organisation_id: site.organisation_id, site_id: siteId, customer_id: customerId,
        created_by: request.user!.id, assigned_to: request.user!.id, title, details, due_at: dueAt, kind: kind as 'follow_up' | 'call',
        ...(customer.integration_mode ? { integration_mode: customer.integration_mode } : {}), priority: priority as Task['priority'], completed_at: null, created_at: now, updated_at: now };
      await this.mongo.tasks.insertOne(task, { session });
      await this.audit.record(session, request.user!.id, site.organisation_id, siteId, 'task.created', 'task', id);
      return { task: publicRecord(task) };
    });
  }

  @Patch(':id/complete')
  @ApiQuery({ name: 'siteId', required: true, type: String, format: 'uuid' })
  async complete(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('siteId') siteId?: string) {
    const targetSite = uuid(siteId, 'siteId');
    uuid(id, 'taskId');
    await this.access.requireSite(request, targetSite, 'tasks.write');
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, targetSite, 'tasks.write', session);
      const viewTeam = await this.access.hasSitePermission(request, targetSite, 'tasks.view_team', session);
      const task = await this.mongo.tasks.findOneAndUpdate({ ...this.integration.projectionFilter(), id, site_id: targetSite, organisation_id: site.organisation_id, completed_at: null,
        ...(viewTeam ? {} : { assigned_to: request.user!.id }),
      }, { $set: { completed_at: new Date().toISOString(), updated_at: new Date().toISOString() } }, { session, returnDocument: 'after' });
      if (!task) throw new BadRequestException('Task was already completed or is not available');
      await this.audit.record(session, request.user!.id, site.organisation_id, targetSite, 'task.completed', 'task', id);
      return { task: publicRecord(task) };
    });
  }
}
