import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AccessService } from './access.service.js';
import { MongoService } from '../database/mongo.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';

const request = {
  user: { id: 'staff', app_metadata: { role: 'ADMIN' } },
} as unknown as AuthenticatedRequest;
const grant = {
  user_id: 'staff',
  organisation_id: 'dealer',
  site_id: 'site',
  role: 'SALES',
  status: 'active',
  extra_permissions: [],
};

describe('MongoDB access decisions', () => {
  const mongo = { memberships: { find: vi.fn() }, sites: { findOne: vi.fn() } };
  const service = new AccessService(mongo as unknown as MongoService);
  beforeEach(() => {
    vi.clearAllMocks();
    mongo.sites.findOne.mockResolvedValue({
      id: 'site',
      organisation_id: 'dealer',
    });
    mongo.memberships.find.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([grant]),
    });
  });

  it('rejects a site belonging to another dealership', async () => {
    mongo.sites.findOne.mockResolvedValue({
      id: 'site',
      organisation_id: 'other-dealer',
    });
    await expect(
      service.requireSite(request, 'site', 'customers.read'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not trust client roles or token metadata for administration', async () => {
    await expect(
      service.requireAdmin(request, 'dealer'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mongo.memberships.find).toHaveBeenCalledWith(
      { user_id: 'staff', status: 'active' },
      { session: undefined },
    );
  });

  it('removes access as soon as no active membership remains', async () => {
    await expect(
      service.requireSite(request, 'site', 'customers.read'),
    ).resolves.toMatchObject({ id: 'site' });
    mongo.memberships.find.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([]),
    });
    await expect(
      service.requireSite(request, 'site', 'customers.read'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('combines SALES and SERVICE grants only within their site scope', async () => {
    mongo.memberships.find.mockReturnValue({
      toArray: vi
        .fn()
        .mockResolvedValue([
          grant,
          { ...grant, role: 'SERVICE' },
          { ...grant, role: 'ADMIN', site_id: 'other-site' },
        ]),
    });
    await expect(
      service.requireSite(request, 'site', 'service.write'),
    ).resolves.toBeDefined();
    await expect(
      service.requireAdmin(request, 'dealer'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not let additional permissions grant administration', async () => {
    mongo.memberships.find.mockReturnValue({
      toArray: vi
        .fn()
        .mockResolvedValue([{ ...grant, extra_permissions: ['users.manage'] }]),
    });
    await expect(
      service.requireAdmin(request, 'dealer'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['SALES', 'SERVICE'])(
    'denies legacy organisation-wide %s access',
    async (role) => {
      mongo.memberships.find.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ ...grant, role, site_id: null }]),
      });
      await expect(
        service.requireSite(request, 'site', 'customers.read'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('fails closed when MongoDB is unavailable', async () => {
    mongo.memberships.find.mockReturnValue({
      toArray: vi.fn().mockRejectedValue(new Error('offline')),
    });
    await expect(
      service.requireAdmin(request, 'dealer'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
