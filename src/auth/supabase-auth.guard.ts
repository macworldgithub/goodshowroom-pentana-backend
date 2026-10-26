import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { JwtAuthService } from './jwt.service.js';
import { MongoService } from '../database/mongo.service.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(JwtAuthService) private readonly jwt: JwtAuthService,
    @Inject(MongoService) private readonly mongo: MongoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const accessToken = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!accessToken) throw new UnauthorizedException('Sign in to continue');

    const payload = this.jwt.verifyAccessToken(accessToken);
    const user = await this.mongo.users.findOne({ _id: payload.sub });
    if (!user) throw new UnauthorizedException('Your session is invalid or expired');

    request.user = {
      id: user._id,
      email: user.email,
      email_confirmed_at: user.email_confirmed_at ?? user.updated_at ?? new Date().toISOString(),
      user_metadata: user.full_name ? { full_name: user.full_name } : {},
      fullName: user.full_name,
    };
    request.accessToken = accessToken;
    return true;
  }
}

export const SupabaseAuthGuard = JwtAuthGuard;
