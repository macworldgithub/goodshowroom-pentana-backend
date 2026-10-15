import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { ClientSession } from 'mongodb';
import { AccessService, grantsForBrand, grantsForSite } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { identifiers, text, timezone, uuid } from '../auth/validation.js';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord, type Site, type Brand } from '../database/models.js';
import { permissionsFor } from '../auth/permissions.js';
import { ApiJsonBody } from '../api-bodies.js';
import { ApiPagination, pagination, pageResult } from '../pagination.js';

type SiteBody = { organisationId?: unknown; name?: unknown; timezone?: unknown; brandIds?: unknown };
type BrandBody = { organisationId?: unknown; name?: unknown };
@Controller()
@ApiTags('Sites and brands')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class SitesController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  private async lockAdmin(request: AuthenticatedRequest, organisationId: string, session: ClientSession) {
    const result = await this.mongo.organisations.updateOne({ id: organisationId }, { $inc: { access_revision: 1 } }, { session });
    if (!result.matchedCount) throw new NotFoundException('Organisation is unavailable');
    await this.access.requireAdmin(request, organisationId, session);
  }
  private async mappedBrands(organisationId: string, brandIds: string[], session: ClientSession) {
    if (!brandIds.length) return;
    const brands = await this.mongo.brands.find({ organisation_id: organisationId, id: { $in: brandIds } }, { session }).toArray();
    if (brands.length !== brandIds.length) throw new BadRequestException('Every brand must belong to this organisation');
  }

  @Get('sites/:id/staff')
  @ApiPagination()
  async staff(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(id, 'siteId'); const page = pagination(offset, limit);
    return this.mongo.transaction(async session => {
      const site = await this.access.requireSite(request, id, 'customers.read', session);
      if (!(await this.access.hasSitePermission(request, id, 'customers.assign', session)) && !(await this.access.hasSitePermission(request, id, 'tasks.assign', session)) && !(await this.access.hasSitePermission(request, id, 'sales.assign_leads', session)) && !(await this.access.hasSitePermission(request, id, 'service.assign_work', session))) throw new ForbiddenException('Assignment permission is required');
      const grouped = await this.mongo.memberships.aggregate<{ userId: string; grants: import('../database/models.js').Membership[] }>([
        { $match: { organisation_id: site.organisation_id, status: 'active', $or: [{ role: 'ADMIN', site_id: null }, { role: { $in: ['SALES', 'SERVICE'] }, site_id: id }] } },
        { $group: { _id: '$user_id', grants: { $push: '$$ROOT' } } }, { $sort: { _id: 1 } }, { $skip: page.offset }, { $limit: page.limit + 1 },
        { $project: { _id: 0, userId: '$_id', grants: 1 } },
      ], { session }).toArray();
      const result = pageResult(grouped, page);
      const profiles = await this.mongo.users.find({ _id: { $in: result.rows.map(row => row.userId) } }, { session, projection: { full_name: 1 } }).toArray();
      return { staff: result.rows.map(row => ({ userId: row.userId, fullName: profiles.find(profile => profile._id === row.userId)?.full_name ?? null,
        permissions: permissionsFor(grantsForSite(row.grants, site)) })), pagination: result.pagination };
    });
  }

  @Get('admin/sites')
  @ApiQuery({ name: 'organisationId', required: true, type: String, format: 'uuid' })
  @ApiPagination()
  async sites(@Req() request: AuthenticatedRequest, @Query('organisationId') organisation: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    const organisationId = uuid(organisation, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    const page = pagination(offset, limit);
    const result = pageResult(await this.mongo.sites.find({ organisation_id: organisationId }).sort({ name: 1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
    return { sites: result.rows.map(publicRecord), pagination: result.pagination };
  }

  @Post('admin/sites')
  @ApiJsonBody('siteCreate')
  async createSite(@Req() request: AuthenticatedRequest, @Body() body: SiteBody) {
    const organisationId = uuid(body.organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    const name = text(body.name, 'name', 2, 120);
    const zone = timezone(body.timezone ?? 'Australia/Sydney');
    const brandIds = body.brandIds === undefined ? [] : identifiers(body.brandIds, 'brandIds');
    return this.mongo.transaction(async session => {
      await this.lockAdmin(request, organisationId, session);
      await this.mappedBrands(organisationId, brandIds, session);
      const id = randomUUID();
      const now = new Date().toISOString();
      const site: Site = { _id: id, id, organisation_id: organisationId, name, timezone: zone, brand_ids: brandIds, created_at: now, updated_at: now };
      await this.mongo.sites.insertOne(site, { session });
      await this.audit.record(session, request.user!.id, organisationId, id, 'site.created', 'site', id, { after: publicRecord(site) });
      return { site: publicRecord(site) };
    });
  }

  @Patch('admin/sites/:id')
  @ApiJsonBody('siteUpdate')
  async updateSite(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: SiteBody) {
    uuid(id, 'siteId');
    const organisationId = uuid(body.organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    if (body.name === undefined && body.timezone === undefined && body.brandIds === undefined) throw new BadRequestException('Provide name, timezone, or brandIds');
    const changes = { ...(body.name === undefined ? {} : { name: text(body.name, 'name', 2, 120) }),
      ...(body.timezone === undefined ? {} : { timezone: timezone(body.timezone) }),
      ...(body.brandIds === undefined ? {} : { brand_ids: identifiers(body.brandIds, 'brandIds') }), updated_at: new Date().toISOString() };
    return this.mongo.transaction(async session => {
      await this.lockAdmin(request, organisationId, session);
      const previous = await this.mongo.sites.findOne({ id, organisation_id: organisationId }, { session });
      if (!previous) throw new NotFoundException('Site is unavailable');
      if (changes.brand_ids) await this.mappedBrands(organisationId, changes.brand_ids, session);
      const next = { ...previous, ...changes };
      await this.mongo.sites.replaceOne({ _id: previous._id }, next, { session });
      await this.audit.record(session, request.user!.id, organisationId, id, 'site.updated', 'site', id, { before: publicRecord(previous), after: publicRecord(next) });
      return { site: publicRecord(next) };
    });
  }

  @Get('admin/brands')
  @ApiQuery({ name: 'organisationId', required: true, type: String, format: 'uuid' })
  @ApiPagination()
  async brands(@Req() request: AuthenticatedRequest, @Query('organisationId') organisation: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    const organisationId = uuid(organisation, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    const page = pagination(offset, limit);
    const result = pageResult(await this.mongo.brands.find({ organisation_id: organisationId }).sort({ name: 1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
    return { brands: result.rows.map(publicRecord), pagination: result.pagination };
  }

  @Post('admin/brands')
  @ApiJsonBody('brandCreate')
  async createBrand(@Req() request: AuthenticatedRequest, @Body() body: BrandBody) {
    const organisationId = uuid(body.organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    const name = text(body.name, 'name', 2, 120);
    return this.mongo.transaction(async session => {
      await this.lockAdmin(request, organisationId, session);
      const id = randomUUID();
      const now = new Date().toISOString();
      const brand: Brand = { _id: id, id, organisation_id: organisationId, name, created_at: now, updated_at: now };
      await this.mongo.brands.insertOne(brand, { session });
      await this.audit.record(session, request.user!.id, organisationId, null, 'brand.created', 'brand', id, { after: publicRecord(brand) });
      return { brand: publicRecord(brand) };
    });
  }

  @Patch('admin/brands/:id')
  @ApiJsonBody('brandUpdate')
  async updateBrand(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: BrandBody) {
    uuid(id, 'brandId');
    const organisationId = uuid(body.organisationId, 'organisationId');
    await this.access.requireAdmin(request, organisationId);
    const name = text(body.name, 'name', 2, 120);
    return this.mongo.transaction(async session => {
      await this.lockAdmin(request, organisationId, session);
      const previous = await this.mongo.brands.findOne({ id, organisation_id: organisationId }, { session });
      if (!previous) throw new NotFoundException('Brand is unavailable');
      const next = { ...previous, name, updated_at: new Date().toISOString() };
      await this.mongo.brands.replaceOne({ _id: previous._id }, next, { session });
      await this.audit.record(session, request.user!.id, organisationId, null, 'brand.updated', 'brand', id, { before: publicRecord(previous), after: publicRecord(next) });
      return { brand: publicRecord(next) };
    });
  }

  @Get('sites/:id/brands')
  @ApiPagination()
  async accessibleBrands(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    uuid(id, 'siteId');
    const site = await this.access.requireSite(request, id, 'customers.read');
    const grants = await this.access.memberships(request);
    const brandIds = (site.brand_ids ?? []).filter(brand => grantsForBrand(grants, site, brand).length > 0);
    const page = pagination(offset, limit);
    const result = pageResult(await this.mongo.brands.find({ organisation_id: site.organisation_id, id: { $in: brandIds } }).sort({ name: 1, id: 1 }).skip(page.offset).limit(page.limit + 1).toArray(), page);
    return { brands: result.rows.map(brand => ({ ...publicRecord(brand), permissions: permissionsFor(grantsForBrand(grants, site, brand.id)) })), pagination: result.pagination };
  }

  @Get('sites/:siteId/brands/:brandId')
  async brand(@Req() request: AuthenticatedRequest, @Param('siteId') siteId: string, @Param('brandId') brandId: string) {
    uuid(siteId, 'siteId'); uuid(brandId, 'brandId');
    const { site, brand } = await this.access.requireBrand(request, siteId, brandId, 'customers.read');
    const grants = await this.access.memberships(request);
    return { brand: { ...publicRecord(brand), permissions: permissionsFor(grantsForBrand(grants, site, brandId)) } };
  }
}
