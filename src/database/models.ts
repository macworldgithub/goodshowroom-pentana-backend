import type { Role } from '../auth/permissions.js';

export type RecordBase = { _id: string; id: string; created_at: string };
export type Organisation = RecordBase & { name: string; access_revision: number };
export type Brand = RecordBase & { organisation_id: string; name: string; updated_at: string };
export type Site = RecordBase & { organisation_id: string; name: string; timezone: string; brand_ids?: string[]; updated_at?: string };
export type Membership = RecordBase & {
  organisation_id: string; site_id: string | null; user_id: string;
  role: Role; status: 'active' | 'suspended'; extra_permissions: string[];
  // Missing/null means all brands mapped to this site. An array is an explicit restriction.
  brand_ids?: string[] | null;
};
export type Invitation = RecordBase & {
  organisation_id: string; site_id: string | null; email: string; roles: Role[];
  status: 'pending' | 'accepted' | 'revoked'; delivery_status: 'not_sent' | 'sent' | 'failed';
  invited_by: string; expires_at: string; accepted_by?: string; accepted_at?: string;
  brand_ids?: string[] | null;
};
export type Customer = RecordBase & {
  organisation_id: string; site_id: string; created_by: string; assigned_to: string;
  first_name: string; last_name: string; email: string | null; phone: string | null;
  source: 'manual' | 'csv' | 'pentana' | 'simulated'; external_ids: { pentana?: string; simulated?: string };
  integration_mode?: 'simulated' | 'scraping'; integration_external_id?: string;
  source_revision?: string; source_observed_at?: string;
  updated_at: string;
};
export type Task = RecordBase & {
  kind?: 'follow_up' | 'call'; cancelled_at?: string | null;
  organisation_id: string; site_id: string; customer_id: string; created_by: string; assigned_to: string;
  title: string; details: string | null; due_at: string; priority: 'low' | 'normal' | 'high';
  completed_at: string | null; updated_at: string; integration_mode?: 'simulated' | 'scraping';
};
export type AuditEvent = RecordBase & {
  organisation_id: string; site_id: string | null; actor_user_id: string;
  action: string; entity_type: string; entity_id: string; metadata: Record<string, unknown>;
};

export function publicRecord<T extends { _id: string }>(record: T): Omit<T, '_id'> {
  const { _id, ...result } = record;
  return result;
}
