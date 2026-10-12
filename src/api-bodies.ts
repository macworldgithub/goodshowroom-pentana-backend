import { ApiBody } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';

const identifier: SchemaObject = { type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001' };
const site: SchemaObject = { ...identifier, example: '00000000-0000-4000-8000-000000000002', description: 'Copy a site ID from GET /api/auth/me.' };
const email: SchemaObject = { type: 'string', format: 'email', example: 'sales.person@example.com' };
const password: SchemaObject = { type: 'string', minLength: 12, maxLength: 128, example: 'Sales-Test!2026', description: 'Use a unique password; existing accounts are not reset.' };
const roleList: SchemaObject = { type: 'array', minItems: 1, items: { type: 'string', enum: ['ADMIN', 'SALES', 'SERVICE'] }, example: ['SALES'] };
const setupKey: SchemaObject = { type: 'string', example: 'REPLACE_WITH_INITIAL_SETUP_KEY', description: 'Must match INITIAL_SETUP_KEY on the backend.' };

const brandIds: SchemaObject = { type: 'array', nullable: true, maxItems: 100, items: identifier, description: 'Staff access restriction: null/omitted grants all brands mapped to the assigned site. Otherwise provide one or more mapped brand IDs. ADMIN cannot be brand-restricted.' };
const mappedBrands: SchemaObject = { type: 'array', maxItems: 100, items: identifier, description: 'Brands offered at this site. An empty array removes all brand mappings.' };
const name: SchemaObject = { type: 'string', minLength: 2, maxLength: 120, example: 'Pilot Brand' };
const normalizedCustomer: SchemaObject = { type: 'object', required: ['external_id', 'revision', 'observed_at', 'first_name', 'last_name'], properties: {
  external_id: { type: 'string', maxLength: 200, example: 'scraped-customer-123' }, revision: { type: 'string', maxLength: 100, example: 'source-version-1' }, observed_at: { type: 'string', format: 'date-time', example: '2026-10-09T09:00:00Z' },
  first_name: { type: 'string', example: 'Test' }, last_name: { type: 'string', example: 'Customer' }, email: { ...email, nullable: true }, phone: { type: 'string', nullable: true, example: '0400000000' },
} };
const resultProperties: Record<string, SchemaObject> = { outcome: { type: 'string', enum: ['succeeded', 'rejected', 'not_applied', 'unknown'] }, customer: normalizedCustomer, code: { type: 'string', maxLength: 100 }, message: { type: 'string', maxLength: 1000 } };
const bodies: Record<string, SchemaObject> = {
  integrationEmpty: { type: 'object', properties: {} },
  integrationLease: { type: 'object', required: ['leaseToken'], properties: { leaseToken: identifier } },
  integrationSite: { type: 'object', required: ['siteId'], properties: { siteId: site } },
  integrationResult: { type: 'object', required: ['leaseToken', 'outcome'], description: 'succeeded requires the normalized customer. Other outcomes require code/message. not_applied certifies that NO write was submitted/applied; uncertain results must use unknown.', properties: { leaseToken: identifier, ...resultProperties } },
  integrationResolve: { type: 'object', required: ['outcome', 'note'], description: 'ADMIN reconciliation of needs_review. Verify source first; succeeded requires matching normalized customer, rejected requires code/message. Preserves original attempt evidence.', properties: { ...resultProperties, note: { type: 'string', minLength: 5, maxLength: 1000 } } },
  integrationRetry: { type: 'object', required: ['note'], properties: { note: { type: 'string', minLength: 5, maxLength: 1000 }, confirmedNotApplied: { type: 'boolean', description: 'Required true for needs_review; verify absence in Pentana before asserting this.' } } },
  integrationImport: { type: 'object', required: ['siteId', 'customers'], description: 'Incremental upserts, not a full snapshot/delete. Source IDs must be stable, observations monotonic. Contact records remain site-neutral.', properties: { siteId: site, customers: { type: 'array', minItems: 1, maxItems: 100, items: normalizedCustomer } } },
  simulationBehavior: { type: 'object', required: ['siteId', 'behavior', 'count'], properties: { siteId: site, behavior: { type: 'string', enum: ['accept', 'reject', 'outage', 'unknown'] }, count: { type: 'integer', minimum: 1, maximum: 100, example: 1 } } },
  siteCreate: { type: 'object', required: ['organisationId', 'name'], properties: { organisationId: identifier, name: { ...name, example: 'Second Branch' }, timezone: { type: 'string', example: 'Australia/Sydney', default: 'Australia/Sydney' }, brandIds: mappedBrands } },
  siteUpdate: { type: 'object', required: ['organisationId'], description: 'Provide at least one of name, timezone, or brandIds. Removing a mapping immediately removes access to that brand here.', properties: { organisationId: identifier, name, timezone: { type: 'string', example: 'Australia/Sydney' }, brandIds: mappedBrands } },
  brandCreate: { type: 'object', required: ['organisationId', 'name'], properties: { organisationId: identifier, name } },
  brandUpdate: { type: 'object', required: ['organisationId', 'name'], properties: { organisationId: identifier, name } },
  initialUser: { type: 'object', required: ['email', 'password', 'setupKey'], properties: {
    email: { ...email, example: 'admin@example.com' }, password,
    fullName: { type: 'string', example: 'Initial administrator', minLength: 1, maxLength: 120 }, setupKey,
  } },
  staff: { type: 'object', required: ['organisationId', 'email', 'password', 'roles'], properties: {
    organisationId: identifier, siteId: { ...site, nullable: true, description: 'Required for SALES/SERVICE; use null for organisation-wide ADMIN access.' },
    brandIds, email, password, fullName: { type: 'string', example: 'Sales Person', minLength: 1, maxLength: 120 }, roles: roleList,
  } },
  setup: { type: 'object', required: ['organisationName', 'siteName', 'setupKey'], properties: {
    organisationName: { type: 'string', example: 'Good Showroom', minLength: 2, maxLength: 120 },
    siteName: { type: 'string', example: 'Main Branch', minLength: 2, maxLength: 120 },
    timezone: { type: 'string', example: 'Australia/Sydney', default: 'Australia/Sydney' }, setupKey,
  } },
  organisation: { type: 'object', required: ['organisationId'], properties: { organisationId: identifier } },
  invitation: { type: 'object', required: ['organisationId', 'email', 'roles'], properties: {
    organisationId: identifier, siteId: { ...site, nullable: true, description: 'Required for SALES/SERVICE. Grant ADMIN separately with null scope.' }, brandIds, email, roles: roleList,
  } },
  membership: { type: 'object', required: ['organisationId'], description: 'Provide at least one of role, siteId, brandIds, status, or extraPermissions. Active SALES/SERVICE require a site; ADMIN requires null scope.', properties: {
    organisationId: identifier, siteId: { ...site, nullable: true }, brandIds, role: { type: 'string', enum: ['ADMIN', 'SALES', 'SERVICE'] },
    status: { type: 'string', enum: ['active', 'suspended'], example: 'active' },
    extraPermissions: { type: 'array', items: { type: 'string' }, example: [] },
  } },
  customer: { type: 'object', required: ['siteId', 'firstName', 'lastName'], description: 'Provide an email address or phone number.', properties: {
    siteId: site, firstName: { type: 'string', minLength: 1, maxLength: 100, example: 'Test' },
    lastName: { type: 'string', minLength: 1, maxLength: 100, example: 'Customer' },
    email: { ...email, nullable: true, example: 'customer@example.com' }, phone: { type: 'string', nullable: true, maxLength: 40 },
  } },
  task: { type: 'object', required: ['siteId', 'customerId', 'title', 'dueAt'], properties: {
    kind: { type: 'string', enum: ['follow_up', 'call'], default: 'follow_up', description: 'call schedules a work item only; it does not dial or log a call outcome.' },
    siteId: site, customerId: { ...identifier, description: 'An existing customer ID at the selected site.' },
    title: { type: 'string', minLength: 2, maxLength: 180, example: 'Follow up with customer' },
    details: { type: 'string', nullable: true, maxLength: 5000 },
    dueAt: { type: 'string', format: 'date-time', example: '2026-10-09T09:00:00+05:00' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'], default: 'normal' },
  } },
};

export const ApiJsonBody = (name: keyof typeof bodies) => ApiBody({ schema: bodies[name] });
