import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { SupabaseAuthGuard } from './supabase-auth.guard.js';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

describe('SupabaseAuthGuard', () => {
  const guard = new SupabaseAuthGuard();
  const context = (request: object) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as ExecutionContext;
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_ANON_KEY', 'test-key');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it.each([undefined, 'Basic token', 'Bearer token extra', 'Bearer '])('rejects malformed credentials %s', async authorization => {
    await expect(guard.canActivate(context({ headers: { authorization } }))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('rejects a token rejected by Supabase', async () => {
    vi.mocked(createClient).mockReturnValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } }) } } as unknown as ReturnType<typeof createClient>);
    await expect(guard.canActivate(context({ headers: { authorization: 'Bearer invalid' } }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches only the user verified by Supabase', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'verified-user' } }, error: null });
    vi.mocked(createClient).mockReturnValue({ auth: { getUser } } as unknown as ReturnType<typeof createClient>);
    const request: { headers: object; user?: object; accessToken?: string } = { headers: { authorization: 'Bearer valid' } };
    expect(await guard.canActivate(context(request))).toBe(true);
    expect(getUser).toHaveBeenCalledWith('valid');
    expect(request.user).toEqual({ id: 'verified-user' });
  });
});
