import { BadRequestException } from '@nestjs/common';
import { StaffController } from './staff.controller.js';
import { validateRoleScope } from './validation.js';
import type { AccessService } from './access.service.js';
import type { MongoService } from '../database/mongo.service.js';
import type { AuditService } from '../database/audit.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
const organisationId = '00000000-0000-0000-0000-000000000001';
const siteId = '00000000-0000-0000-0000-000000000002';
const id = '00000000-0000-0000-0000-000000000003';
const request = { user: { id: 'admin', email: 'staff@example.test', email_confirmed_at: '2026-01-01' } } as unknown as AuthenticatedRequest;
describe('Staff scope enforcement', () => {
  let controller: StaffController;
  let mongo: any;
  beforeEach(() => {
    mongo = { transaction: vi.fn(async op => op({})), organisations: { updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }) }, sites: { findOne: vi.fn().mockResolvedValue({ id: siteId }) }, memberships: { findOne: vi.fn(), replaceOne: vi.fn(), updateOne: vi.fn() }, invitations: { findOneAndUpdate: vi.fn(), insertOne: vi.fn(), updateMany: vi.fn() } };
    controller = new StaffController({ requireAdmin: vi.fn() } as unknown as AccessService, mongo as MongoService, { record: vi.fn() } as unknown as AuditService, { sendInvitationEmail: vi.fn().mockResolvedValue({ sent: true }) } as any);
  });
  it.each([[['SALES']], [['SERVICE']], [['ADMIN', 'SALES']]])('rejects unscoped roles %j', requestedRoles => {
    expect(() => validateRoleScope(requestedRoles, null)).toThrow(BadRequestException);
  });
  it('accepts scoped staff and organisation a67890-09 89dministrators', () => {
    expect(() => validateRoleScope(['SALES', 'SERVICE'], siteId)).not.toThrow();
    expect(() => validateRoleScope(['ADMIN'], null)).not.toThrow();
  });
  it.each(['SALES', 'SERVICE'])('rejects an omitted site on a %s invitation before writing', async role => {
    await expect(controller.invite(request, { organisationId, email: 'staff@example.test', roles: [role] })).rejects.toBeInstanceOf(BadRequestException);
    expect(mongo.transaction).not.toHaveBeenCalled();
  });
  it('rejects invitations to a site outside the organisation', async () => {
    mongo.sites.findOne.mockResolvedValue(null);
    await expect(controller.invite(request, { organisationId, siteId, email: 'staff@example.test', roles: ['SALES'] })).rejects.toBeInstanceOf(BadRequestException);
    expect(mongo.invitations.insertOne).not.toHaveBeenCalled();
  });
  it('rejects legacy unscoped invitation acceptance before granting memberships', async () => {
    mongo.invitations.findOneAndUpdate.mockResolvedValue({ organisation_id: organisationId, site_id: null, roles: ['SALES'] });
    await expect(controller.accept(request, id)).rejects.toBeInstanceOf(BadRequestException);
    expect(mongo.memberships.updateOne).not.toHaveBeenCalled();
  });
  it('requires a site when changing an administrator to staff', async () => {
    mongo.memberships.findOne.mockResolvedValue({ _id: id, id, role: 'ADMIN', status: 'active', site_id: null });
    await expect(controller.update(request, id, { organisationId, role: 'SALES' })).rejects.toBeInstanceOf(BadRequestException);
    expect(mongo.memberships.replaceOne).not.toHaveBeenCalled();
    const result = await controller.update(request, id, { organisationId, role: 'SALES', siteId });
    expect(result.membership.site_id).toBe(siteId);
  });
  it('allows suspension but prevents restoration of unscoped legacy staff', async () => {
    mongo.memberships.findOne.mockResolvedValue({ _id: id, id, role: 'SERVICE', status: 'active', site_id: null });
    await expect(controller.update(request, id, { organisationId, status: 'suspended' })).resolves.toBeDefined();
    await expect(controller.update(request, id, { organisationId, status: 'active' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
