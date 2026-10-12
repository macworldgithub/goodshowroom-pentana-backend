import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import type { AuthenticatedRequest } from './authenticated-request.js';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const accessToken = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
    if (!accessToken) throw new UnauthorizedException('Sign in to continue');
    if (!url || !anonKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be configured for the backend');

    const supabase = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error && (!error.status || error.status >= 500) && error.name === 'AuthRetryableFetchError') {
      throw new ServiceUnavailableException('Authentication is temporarily unavailable');
    }
    if (error || !data.user) throw new UnauthorizedException('Your session is invalid or expired');
    request.user = data.user;
    request.accessToken = accessToken;
    return true;
  }
}
