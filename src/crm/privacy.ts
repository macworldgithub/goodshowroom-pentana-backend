import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Customer, CustomerPrivacy } from '../database/models.js';
export const UNKNOWN_PRIVACY: CustomerPrivacy = { do_not_contact: false, email: 'unknown', sms: 'unknown', call: 'unknown' };
export function privacyInput(value: unknown): CustomerPrivacy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('privacy must be an object');
  const p = value as Record<string, unknown>;
  if (typeof p.do_not_contact !== 'boolean') throw new BadRequestException('privacy.do_not_contact must be boolean');
  for (const channel of ['email', 'sms', 'call']) if (!['unknown', 'granted', 'denied'].includes(p[channel] as string)) throw new BadRequestException(`privacy.${channel} must be unknown, granted, or denied`);
  return { do_not_contact: p.do_not_contact, email: p.email as CustomerPrivacy['email'], sms: p.sms as CustomerPrivacy['sms'], call: p.call as CustomerPrivacy['call'] };
}
export function requireEmailConsent(customer: Customer) {
  if (customer.privacy?.do_not_contact || customer.privacy?.email !== 'granted') throw new ForbiddenException('Confirmed email consent is required and do-not-contact must be false');
  if (!customer.email) throw new BadRequestException('Customer has no email address');
}
