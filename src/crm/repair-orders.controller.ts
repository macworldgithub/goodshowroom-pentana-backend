import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AccessService } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import type { RepairOrder } from '../database/models.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { dayWindow } from './day-window.js';
import { repairOrderStates } from './repair-order-lifecycle.js';
import { RepairOrdersService } from './repair-orders.service.js';

const schema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    appointmentId: { type: 'string', format: 'uuid' },
    promisedAt: { type: 'string', format: 'date-time' },
    version: { type: 'integer', minimum: 0 },
    status: { type: 'string', enum: repairOrderStates },
    note: { type: 'string', minLength: 3, maxLength: 2000 },
  },
};
@Controller('service/repair-orders')
@ApiTags('Repair orders')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class RepairOrdersController {
  constructor(
    @Inject(RepairOrdersService) private readonly orders: RepairOrdersService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}
  @Get()
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'status', required: false, enum: repairOrderStates })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiQuery({ name: 'appointmentId', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'brandId', required: false })
  @ApiQuery({ name: 'assignedTo', required: false })
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, string>,
  ) {
    const siteId = uuid(query.siteId, 'siteId');
    const scope = await this.orders.scope(request, siteId);
    if (
      query.status &&
      !repairOrderStates.includes(query.status as RepairOrder['status'])
    )
      throw new BadRequestException('Invalid repair order status');
    const search =
      query.search === undefined || query.search === ''
        ? ''
        : text(query.search, 'search', 1, 100).replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
          );
    if (query.brandId)
      await this.access.requireBrand(
        request,
        siteId,
        uuid(query.brandId, 'brandId'),
        'service.read',
      );
    if (
      query.assignedTo &&
      query.assignedTo !== request.user!.id &&
      !(await this.access.hasSitePermission(
        request,
        siteId,
        'service.view_team',
      ))
    )
      throw new ForbiddenException('Team RO access is required');
    const page = pagination(query.offset, query.limit);
    const rows = await this.orders.mongo.repairOrders
      .find({
        ...scope,
        ...(query.status
          ? { status: query.status as RepairOrder['status'] }
          : {}),
        ...(query.brandId ? { brand_id: query.brandId } : {}),
        ...(query.assignedTo
          ? { assigned_to: uuid(query.assignedTo, 'assignedTo') }
          : {}),
        ...(query.customerId
          ? { customer_id: uuid(query.customerId, 'customerId') }
          : {}),
        ...(query.appointmentId
          ? { appointment_id: uuid(query.appointmentId, 'appointmentId') }
          : {}),
        ...(search
          ? {
              $or: [
                'number',
                'external_id',
                'vehicle',
                'operations_summary',
              ].map((field) => ({
                [field]: { $regex: search, $options: 'i' },
              })),
            }
          : {}),
      })
      .sort({ promised_at: 1, id: 1 })
      .skip(page.offset)
      .limit(page.limit + 1)
      .toArray();
    const result = pageResult(rows, page);
    return {
      repairOrders: result.rows.map((row) => this.orders.publicOrder(row)),
      pagination: result.pagination,
      integration: this.orders.capabilities(),
    };
  }
  @Get('my-day')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'view', required: false, enum: ['own', 'team'] })
  async myDay(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, string>,
  ) {
    const siteId = uuid(query.siteId, 'siteId');
    const scope = await this.orders.scope(request, siteId);
    const site = await this.access.requireSite(request, siteId, 'service.read');
    const view = query.view ?? 'own';
    if (!['own', 'team'].includes(view))
      throw new BadRequestException('Invalid queue view');
    if (
      view === 'team' &&
      !(await this.access.hasSitePermission(
        request,
        siteId,
        'service.view_team',
      ))
    )
      throw new ForbiddenException('Team RO access is required');
    const day = dayWindow(site.timezone, query.date);
    const page = pagination(query.offset, query.limit);
    const result = pageResult(
      await this.orders.mongo.repairOrders
        .find({
          ...scope,
          ...(view === 'own' ? { assigned_to: request.user!.id } : {}),
          status: { $ne: 'invoiced' },
          collection: null,
          $or: [
            {
              status: { $in: ['waiting_authority', 'waiting_parts', 'ready'] },
            },
            { promised_at: { $lt: day.endsAt } },
          ],
        })
        .sort({ promised_at: 1, id: 1 })
        .skip(page.offset)
        .limit(page.limit + 1)
        .toArray(),
      page,
    );
    return {
      day,
      view,
      repairOrders: result.rows.map((row) => ({
        ...this.orders.publicOrder(row),
        overdue: row.status !== 'ready' && row.promised_at < day.startsAt,
      })),
      pagination: result.pagination,
    };
  }
  @Get('commands/:id')
  @ApiQuery({ name: 'siteId', required: true })
  async command(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('siteId') site: string,
  ) {
    const scope = await this.orders.scope(request, uuid(site, 'siteId'));
    uuid(id, 'commandId');
    if (this.orders.integration.config.mode !== 'simulated')
      throw new NotFoundException('Repair order command is unavailable');
    const row = await this.orders.mongo.repairOrderCommands.findOne({
      ...scope,
      id,
      mode: 'simulated',
    });
    if (!row)
      throw new NotFoundException('Repair order command is unavailable');
    return {
      command: this.orders.publicCommand(row),
      integration: this.orders.capabilities(),
    };
  }
  @Get('commands')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async commands(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, string>,
  ) {
    const scope = await this.orders.scope(
      request,
      uuid(query.siteId, 'siteId'),
    );
    const page = pagination(query.offset, query.limit);
    const rows =
      this.orders.integration.config.mode === 'simulated'
        ? await this.orders.mongo.repairOrderCommands
            .find({
              ...scope,
              mode: 'simulated',
              ...(query.appointmentId
                ? { appointment_id: uuid(query.appointmentId, 'appointmentId') }
                : {}),
            })
            .sort({ created_at: -1, id: 1 })
            .skip(page.offset)
            .limit(page.limit + 1)
            .toArray()
        : [];
    const result = pageResult(rows, page);
    return {
      commands: result.rows.map((row) => this.orders.publicCommand(row)),
      pagination: result.pagination,
    };
  }
  @Post('commands/:id/retry')
  @HttpCode(202)
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        siteId: { type: 'string', format: 'uuid' },
        note: { type: 'string' },
        confirmedNotApplied: { type: 'boolean' },
      },
    },
  })
  retry(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.orders.retry(request, uuid(id, 'commandId'), body);
  }
  @Post('commands/:id/process-simulated')
  @HttpCode(200)
  @ApiBody({
    schema: {
      type: 'object',
      properties: { siteId: { type: 'string', format: 'uuid' } },
    },
  })
  async process(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const siteId = uuid(body.siteId, 'siteId');
    await this.access.requireSite(request, siteId, 'users.manage');
    await this.command(request, id, siteId);
    const result = await this.orders.processOne(id);
    return result ?? this.command(request, id, siteId);
  }
  @Post('simulate-from-appointment')
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema })
  simulate(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.orders.enqueue(
      request,
      null,
      'repair_order.simulate',
      body,
      key,
    );
  }
  @Get(':id')
  @ApiQuery({ name: 'siteId', required: true })
  async detail(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('siteId') site: string,
  ) {
    const siteId = uuid(site, 'siteId');
    const row = await this.orders.order(
      request,
      siteId,
      uuid(id, 'repairOrderId'),
    );
    const scope = await this.orders.scope(request, siteId);
    const customer = await this.orders.mongo.customers.findOne({
      organisation_id: row.organisation_id,
      site_id: siteId,
      id: row.customer_id,
      ...this.orders.integration.projectionFilter(),
    });
    const appointment = await this.orders.mongo.serviceAppointments.findOne({
      ...scope,
      id: row.appointment_id,
    });
    const advisor = await this.orders.mongo.users.findOne(
      { _id: row.assigned_to },
      { projection: { full_name: 1 } },
    );
    const commands =
      this.orders.integration.config.mode === 'simulated'
        ? await this.orders.mongo.repairOrderCommands
            .find({ ...scope, mode: 'simulated', repair_order_id: row.id })
            .sort({ created_at: -1, id: 1 })
            .limit(20)
            .toArray()
        : [];
    const driveOpportunities =
      row.check_in && !row.collection
        ? await this.orders.mongo.salesLeads
            .find(
              {
                ...this.orders.integration.projectionFilter(),
                organisation_id: row.organisation_id,
                site_id: siteId,
                customer_id: row.customer_id,
                status: { $ne: 'closed' },
              },
              {
                projection: {
                  _id: 0,
                  title: 1,
                  vehicle_interest: 1,
                  status: 1,
                },
              },
            )
            .limit(10)
            .toArray()
        : [];
    return {
      driveOpportunities,
      repairOrder: this.orders.publicOrder(row),
      customer: customer
        ? {
            id: customer.id,
            first_name: customer.first_name,
            last_name: customer.last_name,
          }
        : null,
      appointment: appointment
        ? {
            id: appointment.id,
            status: appointment.status,
            starts_at: appointment.starts_at,
            ends_at: appointment.ends_at,
          }
        : null,
      advisor: { id: row.assigned_to, fullName: advisor?.full_name ?? null },
      commands: commands.map((command) => this.orders.publicCommand(command)),
      integration: this.orders.capabilities(),
    };
  }
  @Post(':id/transitions')
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema })
  transition(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.orders.enqueue(
      request,
      uuid(id, 'repairOrderId'),
      'repair_order.transition',
      body,
      key,
    );
  }
  @Post(':id/authority-notes')
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema })
  note(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.orders.enqueue(
      request,
      uuid(id, 'repairOrderId'),
      'repair_order.authority_note',
      body,
      key,
    );
  }

  @Post(':id/actions/:action')
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        siteId: { type: 'string', format: 'uuid' },
        version: { type: 'integer' },
      },
      additionalProperties: true,
    },
  })
  workflow(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('action') action: string,
    @Headers('idempotency-key') key: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.orders.enqueue(
      request,
      uuid(id, 'repairOrderId'),
      'repair_order.workflow',
      { ...body, action },
      key,
    );
  }
}
