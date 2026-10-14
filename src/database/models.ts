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
  privacy?: CustomerPrivacy;
  organisation_id: string; site_id: string; created_by: string; assigned_to: string;
  first_name: string; last_name: string; email: string | null; phone: string | null;
  source: 'manual' | 'csv' | 'pentana' | 'simulated'; external_ids: { pentana?: string; simulated?: string };
  integration_mode?: 'simulated' | 'scraping'; integration_external_id?: string;
  source_revision?: string; source_observed_at?: string;
  updated_at: string;
};

export type CustomerPrivacy = { do_not_contact: boolean; email: 'unknown' | 'granted' | 'denied'; sms: 'unknown' | 'granted' | 'denied'; call: 'unknown' | 'granted' | 'denied' };

export type CustomerMessage = RecordBase & {
  organisation_id: string; site_id: string; customer_id: string; created_by: string;
  channel: 'email'; subject: string; body: string; version: number;
  status: 'draft' | 'sending' | 'accepted' | 'delivered' | 'bounced' | 'rejected' | 'needs_review' | 'cancelled';
  transport?: 'smtp' | 'simulated'; to?: string; provider_id?: string; sent_at?: string; updated_at: string;
  send_key?: string; send_started_at?: string; error_code?: string;
  draft_key?: string; draft_hash?: string;
  integration_mode?: 'simulated' | 'scraping';
};
export type Task = RecordBase & {
  kind?: 'follow_up' | 'call'; cancelled_at?: string | null; cancellation_reason?: string; version?: number;
  organisation_id: string; site_id: string; customer_id: string; created_by: string; assigned_to: string;
  title: string; details: string | null; due_at: string; priority: 'low' | 'normal' | 'high';
  completed_at: string | null; updated_at: string; integration_mode?: 'simulated' | 'scraping';
};
export type AuditEvent = RecordBase & {
  organisation_id: string; site_id: string | null; actor_user_id: string;
  action: string; entity_type: string; entity_id: string; metadata: Record<string, unknown>;
};

export type SalesLead = RecordBase & {
  stock_ids?: string[];
  pipeline_stage?: import('../crm/sales-pipeline.js').PipelineStage;
  organisation_id: string; site_id: string; customer_id: string; assigned_to: string; created_by: string;
  title: string; source: string; vehicle_interest: string | null; status: 'new' | 'contacted' | 'qualified' | 'closed';
  version: number; updated_at: string; follow_up_task_id?: string; integration_mode?: 'simulated' | 'scraping';
  create_key: string; create_hash: string;
};

export type StockVehicle = RecordBase & {
  organisation_id: string; site_id: string; brand_id: string; stock_number: string;
  make: string; model: string; variant: string | null; year: number; odometer_km: number;
  vin: string | null; colour: string | null; body_type: string; fuel_type: string; transmission: string;
  price_cents: number | null; currency: 'AUD'; status: 'available' | 'sold' | 'unavailable';
  source: 'simulated'; integration_mode: 'simulated' | 'scraping'; version: number; updated_at: string; match_revision?: number;
  created_by: string; create_key: string; create_hash: string;
};

export type TradeInAppraisal = RecordBase & {
  review_revision?: number;
  organisation_id: string; site_id: string; lead_id: string; customer_id: string; created_by: string;
  make: string; model: string; year: number; odometer_km: number; registration: string | null; vin: string | null;
  condition_notes: string; valuation_notes: string | null; valuation_cents: number | null; currency: 'AUD';
  status: 'draft' | 'valued' | 'withdrawn'; withdrawal_reason: string | null;
  source: 'local'; integration_mode?: 'simulated' | 'scraping'; version: number; updated_at: string;
  create_key: string; create_hash: string;
};

export type SalesDeal = RecordBase & {
  reservation_revision?: number;
  organisation_id: string; site_id: string; lead_id: string; customer_id: string; stock_id: string; brand_id: string;
  stock_label: string; stock_version: number; appraisal_id: string | null; appraisal_version: number | null;
  sale_price_cents: number; discount_cents: number; fees_cents: number; trade_in_cents: number; total_cents: number; currency: 'AUD';
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled'; notes: string;
  reviewed_by: string | null; reviewed_at: string | null; review_note: string | null;
  created_by: string; updated_at: string; version: number; source: 'local'; integration_mode?: 'simulated' | 'scraping';
  create_key: string; create_hash: string;
};

export type StockReservation = RecordBase & {
  organisation_id: string; site_id: string; lead_id: string; customer_id: string; deal_id: string; stock_id: string; brand_id: string;
  status: 'active' | 'released' | 'expired'; expires_at: string; ended_at: string | null; reason: string;
  created_by: string; version: number; updated_at: string; integration_mode?: 'simulated' | 'scraping';
  create_key: string; create_hash: string;
};

export type CallOutcome = 'connected' | 'no_answer' | 'voicemail' | 'busy' | 'wrong_number';
export type CustomerJournal = RecordBase & {
  organisation_id: string; site_id: string; customer_id: string; created_by: string;
  kind: 'note' | 'call'; text: string; occurred_at: string;
  direction?: 'incoming' | 'outgoing'; outcome?: CallOutcome; follow_up_task_id?: string;
  integration_mode?: 'simulated' | 'scraping'; idempotency_key: string; request_hash: string;
};

export function publicRecord<T extends { _id: string }>(record: T): Omit<T, '_id'> {
  const { _id, ...result } = record;
  return result;
}
