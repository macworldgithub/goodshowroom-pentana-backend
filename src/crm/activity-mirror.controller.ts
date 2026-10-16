import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AccessService } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { text, uuid } from '../auth/validation.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';
import { ActivityMirrorService } from './activity-mirror.service.js';
@Controller()
@ApiTags('Simulated activity mirroring')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class ActivityMirrorController {
  constructor(
    @Inject(ActivityMirrorService)
    private readonly mirrors: ActivityMirrorService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}
  @Get('customers/:id/activity-mirrors')
  @ApiPagination()
  @ApiQuery({ name: 'siteId', required: true })
  async list(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() q: Record<string, string>,
  ) {
    const siteId = uuid(q.siteId, 'siteId'),
      site = await this.access.requireSite(req, siteId, 'customers.read'),
      page = pagination(q.offset, q.limit);
    const customer = await this.mirrors.mongo.customers.findOne({
      id: uuid(id, 'customerId'),
      site_id: siteId,
      organisation_id: site.organisation_id,
      ...this.mirrors.integration.projectionFilter(),
    });
    if (!customer) throw new NotFoundException('Customer unavailable');
    const rows =
      this.mirrors.integration.config.mode === 'simulated'
        ? await this.mirrors.mongo.activityMirrors
            .find({
              site_id: siteId,
              organisation_id: site.organisation_id,
              customer_id: id,
              integration_mode: 'simulated',
            })
            .sort({ created_at: -1, id: 1 })
            .skip(page.offset)
            .limit(page.limit + 1)
            .toArray()
        : [];
    const result = pageResult(rows, page);
    return {
      commands: result.rows.map((c) => this.mirrors.publicCommand(c)),
      pagination: result.pagination,
    };
  }
  @Post('management/activity-mirrors/:id/process')
  @HttpCode(200)
  @ApiBody({
    schema: { type: 'object', properties: { siteId: { type: 'string' } } },
  })
  async process(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() b: Record<string, unknown>,
  ) {
    const siteId = uuid(b.siteId, 'siteId'),
      site = await this.access.requireSite(req, siteId, 'users.manage');
    uuid(id, 'mirrorId');
    const c = await this.mirrors.mongo.activityMirrors.findOne({
      id,
      site_id: siteId,
      organisation_id: site.organisation_id,
    });
    if (!c) throw new NotFoundException('Mirror unavailable');
    return (
      (await this.mirrors.processOne(id)) ?? {
        command: this.mirrors.publicCommand(c),
      }
    );
  }
  @Post('management/activity-mirrors/:id/retry')
  @HttpCode(202)
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        siteId: { type: 'string' },
        note: { type: 'string' },
        confirmedNotApplied: { type: 'boolean' },
      },
    },
  })
  retry(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() b: Record<string, unknown>,
  ) {
    if (b.confirmedNotApplied !== true)
      throw new BadRequestException('Confirm non-application before retry');
    return this.mirrors.retry(
      req,
      uuid(id, 'mirrorId'),
      uuid(b.siteId, 'siteId'),
      text(b.note, 'note', 5, 2000),
    );
  }
}
