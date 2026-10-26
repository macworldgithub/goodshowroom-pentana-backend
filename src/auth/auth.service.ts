import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MongoService } from '../database/mongo.service.js';
import { JwtAuthService } from './jwt.service.js';
import { AuthMailService } from './auth-mail.service.js';
import { hashPassword, verifyPassword, hashToken, generateSecureToken } from './crypto.util.js';
import { type AuthSession, type DbUser, type PasswordReset } from '../database/models.js';
import { roles, validateRoleScope, brandScope } from './validation.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(MongoService) private readonly mongo: MongoService,
    @Inject(JwtAuthService) private readonly jwt: JwtAuthService,
    @Inject(AuthMailService) private readonly mail: AuthMailService,
  ) {}

  async login(emailInput: string, passwordInput: string, userAgent?: string, ipAddress?: string) {
    const email = String(emailInput ?? '').trim().toLowerCase();
    const password = String(passwordInput ?? '');

    if (!email || !password) {
      throw new UnauthorizedException('Enter your email and password');
    }

    const user = await this.mongo.users.findOne({ email });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const now = new Date();
    if (user.locked_until && new Date(user.locked_until) > now) {
      throw new UnauthorizedException('Account temporarily locked due to failed attempts. Please try again later or reset your password.');
    }

    if (!user.password_hash || !user.password_salt) {
      throw new UnauthorizedException('No password set. Please use the invitation link or reset your password.');
    }

    const isValid = await verifyPassword(password, user.password_hash, user.password_salt);
    if (!isValid) {
      const failedAttempts = (user.failed_login_attempts ?? 0) + 1;
      const lockedUntil = failedAttempts >= 5 ? new Date(now.getTime() + 15 * 60 * 1000).toISOString() : null;
      await this.mongo.users.updateOne(
        { _id: user._id },
        { $set: { failed_login_attempts: failedAttempts, ...(lockedUntil ? { locked_until: lockedUntil } : {}) } },
      );
      throw new UnauthorizedException('Invalid email or password');
    }

    // Reset failed attempts on success
    await this.mongo.users.updateOne(
      { _id: user._id },
      { $set: { failed_login_attempts: 0, locked_until: null, updated_at: now.toISOString() } },
    );

    const accessToken = this.jwt.signAccessToken({
      id: user._id,
      email: user.email,
      full_name: user.full_name,
    });

    const { rawToken, tokenHash, expiresAt } = this.jwt.createRefreshToken();
    const sessionId = randomUUID();
    const sessionRecord: AuthSession = {
      _id: sessionId,
      id: sessionId,
      user_id: user._id,
      refresh_token_hash: tokenHash,
      user_agent: userAgent ?? null,
      ip_address: ipAddress ?? null,
      expires_at: expiresAt,
      created_at: now.toISOString(),
    };
    await this.mongo.authSessions.insertOne(sessionRecord);

    return {
      accessToken,
      refreshToken: rawToken,
      user: {
        id: user._id,
        email: user.email,
        fullName: user.full_name,
      },
    };
  }

  async refresh(rawRefreshToken: string) {
    if (!rawRefreshToken) throw new UnauthorizedException('Refresh token is required');
    const tokenHash = hashToken(rawRefreshToken);
    const now = new Date().toISOString();

    const session = await this.mongo.authSessions.findOne({
      refresh_token_hash: tokenHash,
      revoked_at: { $in: [null, undefined] },
      expires_at: { $gt: now },
    });

    if (!session) {
      throw new UnauthorizedException('Your session is invalid or expired. Please sign in again.');
    }

    const user = await this.mongo.users.findOne({ _id: session.user_id });
    if (!user) {
      throw new UnauthorizedException('User account no longer exists');
    }

    // Revoke old session and rotate
    await this.mongo.authSessions.updateOne(
      { _id: session._id },
      { $set: { revoked_at: now } },
    );

    const accessToken = this.jwt.signAccessToken({
      id: user._id,
      email: user.email,
      full_name: user.full_name,
    });

    const { rawToken: newRawToken, tokenHash: newTokenHash, expiresAt: newExpiresAt } = this.jwt.createRefreshToken();
    const newSessionId = randomUUID();
    await this.mongo.authSessions.insertOne({
      _id: newSessionId,
      id: newSessionId,
      user_id: user._id,
      refresh_token_hash: newTokenHash,
      user_agent: session.user_agent,
      ip_address: session.ip_address,
      expires_at: newExpiresAt,
      created_at: now,
    });

    return {
      accessToken,
      refreshToken: newRawToken,
      user: {
        id: user._id,
        email: user.email,
        fullName: user.full_name,
      },
    };
  }

  async logout(rawRefreshToken?: string) {
    if (!rawRefreshToken) return { success: true };
    const tokenHash = hashToken(rawRefreshToken);
    await this.mongo.authSessions.updateOne(
      { refresh_token_hash: tokenHash },
      { $set: { revoked_at: new Date().toISOString() } },
    );
    return { success: true };
  }

  async forgotPassword(emailInput: string) {
    const email = String(emailInput ?? '').trim().toLowerCase();
    if (!email) throw new BadRequestException('Enter your email address');

    const user = await this.mongo.users.findOne({ email });
    if (!user) {
      // Return success to avoid email enumeration
      return { success: true, message: 'If an account exists for this address, a reset link was sent.' };
    }

    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString(); // 1 hour

    const resetId = randomUUID();
    const resetRecord: PasswordReset = {
      _id: resetId,
      id: resetId,
      user_id: user._id,
      email,
      token_hash: tokenHash,
      expires_at: expiresAt,
      created_at: now.toISOString(),
    };
    await this.mongo.passwordResets.insertOne(resetRecord);

    await this.mail.sendPasswordResetEmail(email, rawToken);

    return { success: true, message: 'If an account exists for this address, a reset link was sent.' };
  }

  async resetPassword(token: string, newPassword: unknown) {
    if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128) {
      throw new BadRequestException('Password must contain 12 to 128 characters');
    }
    if (!token) throw new BadRequestException('Reset token is required');

    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    const reset = await this.mongo.passwordResets.findOne({
      token_hash: tokenHash,
      used_at: { $in: [null, undefined] },
      expires_at: { $gt: now },
    });

    if (!reset) {
      throw new BadRequestException('The password reset link is invalid or has expired.');
    }

    const { hash, salt } = await hashPassword(newPassword);

    await this.mongo.transaction(async (session) => {
      await this.mongo.users.updateOne(
        { _id: reset.user_id },
        { $set: { password_hash: hash, password_salt: salt, email_confirmed_at: now, updated_at: now } },
        { session },
      );
      await this.mongo.passwordResets.updateOne(
        { _id: reset._id },
        { $set: { used_at: now } },
        { session },
      );
      // Revoke all prior sessions for security
      await this.mongo.authSessions.updateMany(
        { user_id: reset.user_id, revoked_at: { $in: [null, undefined] } },
        { $set: { revoked_at: now } },
        { session },
      );
    });

    return { success: true, message: 'Password updated successfully. You can now sign in.' };
  }

  async acceptInvitation(invitationId: string, token: string, password: unknown, fullName?: unknown) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      throw new BadRequestException('Password must contain 12 to 128 characters');
    }
    if (!invitationId) throw new BadRequestException('Invitation ID is required');

    const tokenHash = token ? hashToken(token) : null;
    const now = new Date().toISOString();

    const invitation = await this.mongo.invitations.findOne({
      id: invitationId,
      status: 'pending',
      expires_at: { $gt: now },
    });

    if (!invitation) {
      throw new BadRequestException('Invitation is unavailable or has expired.');
    }

    if (invitation.token_hash && tokenHash && invitation.token_hash !== tokenHash) {
      throw new BadRequestException('Invalid invitation link.');
    }

    const { hash, salt } = await hashPassword(password);
    const nameText = fullName ? String(fullName).trim() : undefined;

    return this.mongo.transaction(async (session) => {
      let user = await this.mongo.users.findOne({ email: invitation.email }, { session });
      let userId: string;
      if (user) {
        userId = user._id;
        await this.mongo.users.updateOne(
          { _id: userId },
          { $set: { password_hash: hash, password_salt: salt, ...(nameText ? { full_name: nameText } : {}), email_confirmed_at: now, updated_at: now } },
          { session },
        );
      } else {
        userId = randomUUID();
        const newUser: DbUser = {
          _id: userId,
          id: userId,
          email: invitation.email,
          full_name: nameText,
          password_hash: hash,
          password_salt: salt,
          email_confirmed_at: now,
          created_at: now,
          updated_at: now,
        };
        await this.mongo.users.insertOne(newUser, { session });
      }

      validateRoleScope(roles(invitation.roles), invitation.site_id);
      const brandIds = brandScope(invitation.brand_ids);
      if (brandIds !== null) {
        // Validation inside transaction
      }
      if (invitation.site_id !== null && !(await this.mongo.sites.findOne({ id: invitation.site_id, organisation_id: invitation.organisation_id }, { session }))) {
        throw new BadRequestException('Invitation site is unavailable; ask an administrator for a new invitation');
      }

      await this.mongo.organisations.updateOne({ id: invitation.organisation_id }, { $inc: { access_revision: 1 } }, { session });
      const suspended = await this.mongo.memberships.findOne({ organisation_id: invitation.organisation_id, user_id: userId, status: 'suspended' }, { session });
      if (suspended) throw new ConflictException('Ask an administrator to reactivate your suspended access');

      for (const role of invitation.roles) {
        const membershipId = randomUUID();
        await this.mongo.memberships.updateOne(
          { organisation_id: invitation.organisation_id, site_id: invitation.site_id, user_id: userId, role },
          {
            $setOnInsert: {
              _id: membershipId,
              id: membershipId,
              organisation_id: invitation.organisation_id,
              site_id: invitation.site_id,
              user_id: userId,
              role,
              status: 'active',
              extra_permissions: [],
              brand_ids: brandIds,
              created_at: now,
            },
          },
          { session, upsert: true },
        );
      }

      await this.mongo.invitations.updateOne(
        { _id: invitation._id },
        { $set: { status: 'accepted', accepted_by: userId, accepted_at: now } },
        { session },
      );

      const accessToken = this.jwt.signAccessToken({ id: userId, email: invitation.email, full_name: nameText });
      const { rawToken, tokenHash: sessionHash, expiresAt: sessionExpires } = this.jwt.createRefreshToken();
      const sessId = randomUUID();
      await this.mongo.authSessions.insertOne(
        {
          _id: sessId,
          id: sessId,
          user_id: userId,
          refresh_token_hash: sessionHash,
          expires_at: sessionExpires,
          created_at: now,
        },
        { session },
      );

      return {
        accessToken,
        refreshToken: rawToken,
        user: { id: userId, email: invitation.email, fullName: nameText },
      };
    });
  }
}
