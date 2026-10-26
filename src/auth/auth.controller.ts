import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { ApiJsonBody } from '../api-bodies.js';

@Controller('auth')
@ApiTags('Authentication')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('login')
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiJsonBody('login')
  login(@Body() body: { email?: string; password?: string }, @Req() req: Request) {
    const userAgent = req.headers['user-agent'];
    const ip = req.ip || (req.headers['x-forwarded-for'] as string);
    return this.auth.login(body.email ?? '', body.password ?? '', userAgent, ip);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token using a refresh token' })
  @ApiJsonBody('refresh')
  refresh(@Body() body: { refreshToken?: string }) {
    return this.auth.refresh(body.refreshToken ?? '');
  }

  @Post('logout')
  @ApiOperation({ summary: 'Log out and revoke current session' })
  @ApiJsonBody('logout')
  logout(@Body() body: { refreshToken?: string }) {
    return this.auth.logout(body.refreshToken);
  }

  @Post('forgot-password')
  @ApiOperation({ summary: 'Request password reset email' })
  @ApiJsonBody('forgotPassword')
  forgotPassword(@Body() body: { email?: string }) {
    return this.auth.forgotPassword(body.email ?? '');
  }

  @Post('reset-password')
  @ApiOperation({ summary: 'Reset password using token' })
  @ApiJsonBody('resetPassword')
  resetPassword(@Body() body: { token?: string; password?: string }) {
    return this.auth.resetPassword(body.token ?? '', body.password);
  }

  @Post('accept-invitation')
  @ApiOperation({ summary: 'Accept invitation and set password' })
  @ApiJsonBody('acceptInvitation')
  acceptInvitation(
    @Body() body: { invitationId?: string; token?: string; password?: string; fullName?: string },
  ) {
    return this.auth.acceptInvitation(
      body.invitationId ?? '',
      body.token ?? '',
      body.password,
      body.fullName,
    );
  }
}
