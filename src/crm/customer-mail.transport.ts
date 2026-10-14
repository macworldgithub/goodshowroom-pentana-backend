import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import nodemailer from 'nodemailer';
export type MailResult = { outcome: 'accepted' | 'rejected' | 'unknown'; providerId?: string; errorCode?: string };
@Injectable()
export class CustomerMailTransport {
  info() {
    const mode = process.env.MESSAGE_TRANSPORT ?? 'disabled';
    return { mode, channel: 'email', simulated: mode === 'simulated', deliveryConfirmation: mode === 'smtp' ? 'provider_evidence_required' : mode === 'simulated' ? 'simulated' : 'unavailable' };
  }
  assertReady() {
    const mode = this.info().mode;
    if (mode === 'simulated') {
      if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SIMULATED_INTEGRATION !== 'true') throw new ServiceUnavailableException('Messaging simulation is development-only with explicit opt-in');
      return;
    }
    if (mode !== 'smtp' || !process.env.SMTP_HOST || !process.env.SMTP_FROM) throw new ServiceUnavailableException('Configure MESSAGE_TRANSPORT=smtp, SMTP_HOST, SMTP_FROM before sending');
    const port = Number(process.env.SMTP_PORT ?? 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(process.env.SMTP_FROM)) throw new ServiceUnavailableException('SMTP configuration is invalid');
    if (!!process.env.SMTP_USER !== !!process.env.SMTP_PASSWORD) throw new ServiceUnavailableException('Configure both SMTP_USER and SMTP_PASSWORD');
  }
  async send(id: string, to: string, subject: string, body: string): Promise<MailResult> {
    this.assertReady();
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to) || /[\r\n]/.test(subject)) throw new BadRequestException('A single valid recipient and single-line subject are required');
    if (this.info().mode === 'simulated') return { outcome: 'accepted', providerId: 'simulated-email-' + id };
    const port = Number(process.env.SMTP_PORT ?? 587);
    const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465,
      requireTLS: port !== 465, tls: { rejectUnauthorized: true }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {}) });
    try {
      const result = await transport.sendMail({ from: process.env.SMTP_FROM!, to: { address: to, name: '' }, envelope: { from: process.env.SMTP_FROM!, to: [to] }, subject, text: body,
        messageId: `<goodshowroom-${id}@${process.env.SMTP_FROM!.split('@')[1]}>`, disableFileAccess: true, disableUrlAccess: true });
      return result.accepted.length > 0 ? { outcome: 'accepted', providerId: result.messageId } : { outcome: 'rejected', errorCode: 'SMTP_REJECTED' };
    } catch (error) {
      const code = (error as { code?: string }).code;
      return ['EAUTH', 'EENVELOPE', 'EMESSAGE'].includes(code ?? '') ? { outcome: 'rejected', errorCode: 'SMTP_REJECTED' } : { outcome: 'unknown', errorCode: 'SMTP_UNCERTAIN' };
    } finally { transport.close(); }
  }
}
