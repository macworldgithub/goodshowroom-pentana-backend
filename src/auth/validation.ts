import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

export function requireSetupKey(value: unknown) {
  const configured = process.env.INITIAL_SETUP_KEY;
  if (!configured) throw new BadRequestException('Initial workspace setup is not enabled on the backend');
  const expected = Buffer.from(configured);
  const supplied = Buffer.from(typeof value === 'string' ? value : '');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new UnauthorizedException('Setup key is incorrect');
}

export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

export function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new BadRequestException(`${field} must contain ${min} to ${max} characters`);
  }
  return value.trim();
}

export function roles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3 || value.some(role => !['ADMIN', 'SALES', 'SERVICE'].includes(role))) {
    throw new BadRequestException('Choose ADMIN, SALES, or SERVICE');
  }
  return [...new Set(value)] as string[];
}

export function validateRoleScope(requestedRoles: string[], siteId: string | null) {
  if (requestedRoles.includes('ADMIN') && siteId !== null) throw new BadRequestException('ADMIN requires organisation-wide access');
  if (requestedRoles.some(role => role !== 'ADMIN') && siteId === null) throw new BadRequestException('SALES and SERVICE require an explicit siteId; grant ADMIN separately');
}

export function identifiers(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new BadRequestException(`${field} must be an array of up to 100 UUIDs`);
  return [...new Set(value.map(item => uuid(item, field)))];
}

export function brandScope(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  const result = identifiers(value, 'brandIds');
  if (!result.length) throw new BadRequestException('Use null for all site brands, or provide at least one brandId');
  return result;
}

export function timezone(value: unknown): string {
  const zone = text(value, 'timezone', 1, 100);
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); }
  catch { throw new BadRequestException('Choose a valid timezone'); }
  return zone;
}
