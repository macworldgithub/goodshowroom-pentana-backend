import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './supabase-auth.guard.js';

describe('JwtAuthGuard', () => {
  const mockJwt = {
    verifyAccessToken: vi.fn(),
  };
  const mockMongo = {
    users: {
      findOne: vi.fn(),
    },
  };
  const guard = new JwtAuthGuard(mockJwt as any, mockMongo as any);
  const context = (request: object) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as ExecutionContext;

  afterEach(() => { vi.clearAllMocks(); });

  it.each([undefined, 'Basic token', 'Bearer token extra', 'Bearer '])('rejects malformed credentials %s', async authorization => {
    await expect(guard.canActivate(context({ headers: { authorization } }))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mockJwt.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects an invalid token', async () => {
    mockJwt.verifyAccessToken.mockImplementation(() => { throw new UnauthorizedException('Invalid token'); });
    await expect(guard.canActivate(context({ headers: { authorization: 'Bearer invalid' } }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches verified user from token and database', async () => {
    mockJwt.verifyAccessToken.mockReturnValue({ sub: 'user-123', email: 'staff@dealership.com' });
    mockMongo.users.findOne.mockResolvedValue({ _id: 'user-123', email: 'staff@dealership.com', full_name: 'Staff Member' });

    const request: { headers: object; user?: any; accessToken?: string } = { headers: { authorization: 'Bearer valid-jwt' } };
    expect(await guard.canActivate(context(request))).toBe(true);
    expect(mockJwt.verifyAccessToken).toHaveBeenCalledWith('valid-jwt');
    expect(request.user).toMatchObject({ id: 'user-123', email: 'staff@dealership.com', fullName: 'Staff Member' });
    expect(request.accessToken).toBe('valid-jwt');
  });
});
