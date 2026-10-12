import { BadRequestException } from '@nestjs/common';
import { text } from '../auth/validation.js';
import type { CommandResult, CustomerInput, SourceCustomer } from './contracts.js';
export function customerInput(body: { firstName?: unknown; lastName?: unknown; email?: unknown; phone?: unknown }): CustomerInput {
  const first_name = text(body.firstName, 'firstName', 1, 100);
  const last_name = text(body.lastName, 'lastName', 1, 100);
  const email = body.email == null || body.email === '' ? null : text(body.email, 'email', 3, 254).toLowerCase();
  const phone = body.phone == null || body.phone === '' ? null : text(body.phone, 'phone', 1, 40);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Enter a valid email address');
  if (!email && !phone) throw new BadRequestException('Add an email address or phone number');
  return { first_name, last_name, email, phone };
}
export function sourceCustomer(value: unknown): SourceCustomer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Provide a normalized customer record');
  const record = value as Record<string, unknown>;
  const contact = customerInput({ firstName: record.first_name, lastName: record.last_name, email: record.email, phone: record.phone });
  if (typeof record.observed_at !== 'string' || !Number.isFinite(Date.parse(record.observed_at))) throw new BadRequestException('observed_at must be a valid timestamp');
  return { ...contact, external_id: text(record.external_id, 'external_id', 1, 200), revision: text(record.revision, 'revision', 1, 100), observed_at: new Date(record.observed_at).toISOString() };
}
export function commandResult(value: unknown): CommandResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Provide an outcome');
  const result = value as Record<string, unknown>;
  if (result.outcome === 'succeeded') return { outcome: 'succeeded', customer: sourceCustomer(result.customer) };
  if (!['rejected', 'not_applied', 'unknown'].includes(result.outcome as string)) throw new BadRequestException('Choose succeeded, rejected, not_applied, or unknown');
  return { outcome: result.outcome as 'rejected' | 'not_applied' | 'unknown', code: text(result.code, 'code', 1, 100), message: text(result.message, 'message', 1, 1000) };
}
