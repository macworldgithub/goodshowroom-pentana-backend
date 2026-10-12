import { BadRequestException, ForbiddenException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import { MongoService } from '../database/mongo.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { permissionsFor } from './permissions.js';
import type { Membership, Site } from '../database/models.js';
export type { Role } from './permissions.js';
export type { Membership } from '../database/models.js';

export function grantsForSite(grants: Membership[], site: Site): Membership[] {
  return grants.filter(grant => grant.organisation_id === site.organisation_id &&
    ((grant.role === 'ADMIN' && grant.site_id === null) || (grant.role !== 'ADMIN' && grant.site_id === site.id)));
}

export function grantsForBrand(grants: Membership[], site: Site, brandId: string): Membership[] {
  if (!site.brand_ids?.includes(brandId)) return [];
  return grantsForSite(grants, site).filter(grant => grant.role === 'ADMIN' ||
    grant.brand_ids == null || grant.brand_ids.includes(brandId));
}

@Injectable()
export class AccessService {
  constructor(@Inject(MongoService) private readonly mongo: MongoService) {}

  async memberships(request: AuthenticatedRequest, session?: ClientSession) {
    if (!request.user) throw new UnauthorizedException();
    try {
      return await this.mongo.memberships.find({ user_id: request.user.id, status: 'active' }, { session }).toArray();
    } catch { throw new ServiceUnavailableException('Unable to verify your access'); }
  }

  async requireSite(request: AuthenticatedRequest, siteId: string, permission: string, session?: ClientSession) {
    if (!request.user) throw new UnauthorizedException();
    const site = await this.mongo.sites.findOne({ id: siteId }, { session });
    if (!site) throw new ForbiddenException('You do not have access to this site');
    const grants = grantsForSite(await this.memberships(request, session), site);
    if (!permissionsFor(grants).includes(permission)) throw new ForbiddenException('You do not have permission for this action');
    return site;
  }

  async hasSitePermission(request: AuthenticatedRequest, siteId: string, permission: string, session?: ClientSession) {
    try { await this.requireSite(request, siteId, permission, session); return true; }
    catch (error) { if (error instanceof ForbiddenException) return false; throw error; }
  }

  async requireAdmin(request: AuthenticatedRequest, organisationId: string, session?: ClientSession) {
    const grants = (await this.memberships(request, session)).filter(grant =>
      grant.organisation_id === organisationId && grant.site_id === null && grant.role === 'ADMIN');
    if (!permissionsFor(grants).includes('users.manage')) throw new ForbiddenException('An organisation administrator is required');
  }

  async validateBrandScope(organisationId: string, siteId: string | null, roles: string[], brandIds: string[] | null, session?: ClientSession) {
    if (brandIds === null) return;
    if (siteId === null || roles.includes('ADMIN')) throw new BadRequestException('Brand restrictions require a SALES/SERVICE site membership');
    const site = await this.mongo.sites.findOne({ id: siteId, organisation_id: organisationId }, { session });
    if (!site || brandIds.some(id => !site.brand_ids?.includes(id))) throw new BadRequestException('Every assigned brand must be mapped to the selected site');
    const brands = await this.mongo.brands.find({ organisation_id: organisationId, id: { $in: brandIds } }, { session }).toArray();
    if (brands.length !== brandIds.length) throw new BadRequestException('Brand does not belong to this organisation');
  }

  async requireBrand(request: AuthenticatedRequest, siteId: string, brandId: string, permission: string, session?: ClientSession) {
    if (!request.user) throw new UnauthorizedException();
    const site = await this.mongo.sites.findOne({ id: siteId }, { session });
    if (!site || !permissionsFor(grantsForBrand(await this.memberships(request, session), site, brandId)).includes(permission)) {
      throw new ForbiddenException('You do not have access to this brand at this site');
    }
    const brand = await this.mongo.brands.findOne({ id: brandId, organisation_id: site.organisation_id }, { session });
    if (!brand) throw new ForbiddenException('You do not have access to this brand at this site');
    return { site, brand };
  }
}
