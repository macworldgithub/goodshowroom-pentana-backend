import { Injectable, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { generateSecureToken, hashToken } from './crypto.util.js';

export type JwtPayload = {
  sub: string;
  email?: string | null;
  fullName?: string;
};

@Injectable()
export class JwtAuthService {
  private get secret(): string {
    return process.env.JWT_SECRET || 'goodshowroom-pentana-jwt-secret-key-32-chars-min';
  }

  private get expiresIn(): string {
    return process.env.JWT_EXPIRES_IN || '1h';
  }

  signAccessToken(user: { id: string; email?: string | null; full_name?: string }): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      fullName: user.full_name,
    };
    return jwt.sign(payload, this.secret, {
      expiresIn: this.expiresIn as jwt.SignOptions['expiresIn'],
    });
  }

  verifyAccessToken(token: string): JwtPayload {
    try {
      return jwt.verify(token, this.secret) as JwtPayload;
    } catch {
      throw new UnauthorizedException('Your session is invalid or expired');
    }
  }

  createRefreshToken() {
    const rawToken = generateSecureToken(48);
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    return { rawToken, tokenHash, expiresAt };
  }
}
