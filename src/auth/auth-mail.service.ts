import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

@Injectable()
export class AuthMailService {
  private readonly logger = new Logger(AuthMailService.name);

  private get origin(): string {
    return process.env.WEB_ORIGIN || 'http://localhost:3000';
  }

  private createTransport(): Transporter | null {
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) return null;
    const port = Number(process.env.SMTP_PORT ?? 587);
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      tls: { rejectUnauthorized: true },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {}),
    });
  }

  async sendInvitationEmail(to: string, invitationId: string, token: string, siteName?: string): Promise<{ sent: boolean; message?: string }> {
    const inviteUrl = `${this.origin}/set-password?invitationId=${invitationId}&token=${token}`;
    const subject = 'Your Good Showroom invitation';
    const text = `You have been invited to join ${siteName || 'Good Showroom'}.\n\nTo accept your invitation and set up your password, please click the link below:\n\n${inviteUrl}\n\nThis invitation will expire in 7 days.\nIf you did not request this invitation, you can ignore this email.`;

    const transport = this.createTransport();
    if (!transport) {
      this.logger.warn(`SMTP not configured. Invitation URL for ${to}: ${inviteUrl}`);
      return { sent: true, message: 'Invitation generated (simulated delivery)' };
    }

    try {
      await transport.sendMail({
        from: process.env.SMTP_FROM,
        to,
        subject,
        text,
      });
      return { sent: true, message: 'Invitation email sent successfully' };
    } catch (error) {
      this.logger.error(`Failed to send invitation email to ${to}: ${error instanceof Error ? error.message : error}`);
      return { sent: false, message: 'Failed to send invitation email via SMTP' };
    } finally {
      transport.close();
    }
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<{ sent: boolean; message?: string }> {
    const resetUrl = `${this.origin}/set-password?token=${token}`;
    const subject = 'Reset your Good Showroom password';
    const text = `A password reset was requested for your Good Showroom account.\n\nClick the link below to choose a new password:\n\n${resetUrl}\n\nThis link will expire in 1 hour.\nIf you did not request a password reset, please ignore this email.`;

    const transport = this.createTransport();
    if (!transport) {
      this.logger.warn(`SMTP not configured. Password reset URL for ${to}: ${resetUrl}`);
      return { sent: true, message: 'Password reset generated (simulated delivery)' };
    }

    try {
      await transport.sendMail({
        from: process.env.SMTP_FROM,
        to,
        subject,
        text,
      });
      return { sent: true, message: 'Password reset email sent' };
    } catch (error) {
      this.logger.error(`Failed to send password reset to ${to}: ${error instanceof Error ? error.message : error}`);
      return { sent: false, message: 'Failed to send password reset email via SMTP' };
    } finally {
      transport.close();
    }
  }
}
