import { Controller, Get, Post, Body, UseGuards, Req, UnauthorizedException, BadRequestException, ConflictException, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AccessService, grantsForBrand, grantsForSite } from '../auth/access.service.js';
import { requireSetupKey, text } from '../auth/validation.js';
import { permissionsFor } from '../auth/permissions.js';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord } from '../database/models.js';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiJsonBody } from '../api-bodies.js';

@Controller()
@ApiTags('Context and setup')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
export class ContextController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  @Get(['context', 'auth/me'])
  @ApiOperation({ summary: 'Get signed-in user, memberships, sites, and permissions' })
  async getContext(@Req() request: AuthenticatedRequest) {
    const user = request.user;
    if (!user) throw new UnauthorizedException();
    await this.mongo.users.updateOne({ _id: user.id }, { $set: {
      email: user.email ?? null, updated_at: new Date().toISOString(),
    } }, { upsert: true });
    const memberships = await this.access.memberships(request);
    const sites: { id: string; organisation_id: string; name: string; timezone: string; role: string; roles: string[]; permissions: string[]; brands: { id: string; name: string; roles: string[]; permissions: string[] }[] }[] = [];
    for (const organisationId of new Set(memberships.map(item => item.organisation_id))) {
      const grants = memberships.filter(item => item.organisation_id === organisationId);
      const available = await this.mongo.sites.find({ organisation_id: organisationId,
        ...(grants.some(grant => grant.site_id === null && grant.role === 'ADMIN') ? {} : { id: { $in: grants.map(grant => grant.site_id!) } }),
      }).sort({ name: 1 }).toArray();
      const mappedIds = [...new Set(available.flatMap(site => site.brand_ids ?? []))];
      const brands = mappedIds.length ? await this.mongo.brands.find({ organisation_id: organisationId, id: { $in: mappedIds } }).sort({ name: 1, id: 1 }).toArray() : [];
      for (const site of available) {
        const siteGrants = grantsForSite(grants, site);
        if (!siteGrants.length) continue;
        const roles = [...new Set(siteGrants.flatMap(grant => grant.role === 'ADMIN' ? ['ADMIN', 'SALES', 'SERVICE'] : [grant.role]))].sort();
        const accessibleBrands = brands.flatMap(brand => {
          const brandGrants = grantsForBrand(grants, site, brand.id);
          return brandGrants.length ? [{ id: brand.id, name: brand.name, roles: [...new Set(brandGrants.flatMap(grant => grant.role === 'ADMIN' ? ['ADMIN', 'SALES', 'SERVICE'] : [grant.role]))].sort(), permissions: permissionsFor(brandGrants) }] : [];
        });
        sites.push({ id: site.id, organisation_id: site.organisation_id, name: site.name, timezone: site.timezone,
          role: 'ADMIN', roles, permissions: permissionsFor(siteGrants), brands: accessibleBrands });
      }
    }
    const setupAvailable = !(await this.mongo.organisations.findOne({}));
    return { user: { id: user.id, email: user.email }, memberships: memberships.map(publicRecord), sites,
      needsInitialSetup: setupAvailable && sites.length === 0 };
  }

  @Post('setup')
  @ApiOperation({ summary: 'Create the first organisation, site, and ADMIN membership', description: 'Runs once for an empty installation. Requires a confirmed user and the setup key.' })
  @ApiJsonBody('setup')
  async setup(@Req() request: AuthenticatedRequest, @Body() body: { organisationName?: unknown; siteName?: unknown; timezone?: unknown; setupKey?: unknown }) {
    if (!request.user?.email_confirmed_at) throw new UnauthorizedException('A confirmed user is required');
    const organisationName = text(body.organisationName, 'organisationName', 2, 120);
    const siteName = text(body.siteName, 'siteName', 2, 120);
    const timezone = body.timezone === undefined ? 'Australia/Sydney' : text(body.timezone, 'timezone', 1, 100);
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new BadRequestException('Choose a valid timezone'); }
    requireSetupKey(body.setupKey);
    const actor = request.user.id;
    return this.mongo.transaction(async session => {
      await this.mongo.systemState.updateOne({ _id: 'setup_gate' }, { $inc: { revision: 1 } }, { session, upsert: true });
      if (await this.mongo.organisations.findOne({}, { session })) throw new ConflictException('Initial setup has already been completed');
      const initialUser = await this.mongo.systemState.findOne({ _id: 'initial_user' }, { session });
      if (initialUser && (initialUser.user_id ? initialUser.user_id !== actor : initialUser.email !== request.user!.email?.toLowerCase())) {
        throw new UnauthorizedException('Sign in with the reserved initial administrator account');
      }
      const organisationId = randomUUID();
      const siteId = randomUUID();
      const membershipId = randomUUID();
      const now = new Date().toISOString();
      // The fixed key prevents two simultaneous requests bootstrapping different organisations.
      await this.mongo.systemState.insertOne({ _id: 'initial_setup', organisation_id: organisationId }, { session });
      await this.mongo.organisations.insertOne({ _id: organisationId, id: organisationId, name: organisationName, access_revision: 0, created_at: now }, { session });
      await this.mongo.sites.insertOne({ _id: siteId, id: siteId, organisation_id: organisationId, name: siteName, timezone, brand_ids: [], created_at: now, updated_at: now }, { session });
      await this.mongo.memberships.insertOne({ _id: membershipId, id: membershipId, organisation_id: organisationId,
        site_id: null, user_id: actor, role: 'ADMIN', status: 'active', extra_permissions: [], created_at: now }, { session });
      await this.audit.record(session, actor, organisationId, siteId, 'organisation.bootstrapped', 'organisation', organisationId);
      return { setup: { organisation_id: organisationId, site_id: siteId } };
    });
  }
}
