import type { Role } from '../auth/permissions.js';

export type RepairOrderStatus = 'waiting_authority' | 'in_workshop' | 'waiting_parts' | 'ready' | 'invoiced';
export type RecordBase = { _id: string; id: string; created_at: string };
export type ActivityMirrorCommand = RecordBase & {
  organisation_id:string;site_id:string;customer_id:string;actor_user_id:string;
  integration_mode:'simulated';kind:'note'|'call'|'message_outcome';request:Record<string,unknown>;
  status:'queued'|'retry_wait'|'succeeded'|'rejected'|'failed'|'needs_review';attempts:number;available_at:string;updated_at:string;error?:string;
};
export type CheckInDetails = {
  arrived_at: string;
  mileage_in: number;
  fuel_level: string;
  notes?: string;
  signature_confirmed: boolean;
  loan_car_id?: string | null;
  loan_car_rego?: string | null;
};

export type AuthorityRequest = {
  amount_cents?: number; // Read-only source context, never entered by workflow actions.
  description: string;
  requested_at: string;
  status: 'pending' | 'approved' | 'declined';
  response_note?: string;
  responded_at?: string;
};

export type CollectionDetails = {
  collected_at: string;
  collected_by_staff_id: string;
  keys_returned: boolean;
  payment_status?: 'paid' | 'on_account' | 'warranty'; // Source context only.
  loan_returned?: boolean;
  notes?: string;
};

export type RepairOrder = RecordBase & {
  organisation_id: string; site_id: string; brand_id: string; customer_id: string; appointment_id: string;
  assigned_to: string; vehicle: string; vehicle_external_id: string | null; number: string; external_id: string;
  integration_mode: 'simulated' | 'scraping'; source_status: string; status: RepairOrderStatus;
  operations_summary: string; promised_at: string; updated_at: string; version: number;
  authority_notes: { text: string; recorded_at: string; recorded_by: string }[];
  status_history: { from: RepairOrderStatus; to: RepairOrderStatus; note: string; recorded_at: string; recorded_by: string }[];
  ready_at: string | null; invoiced_at: string | null;
  check_in?: CheckInDetails | null;
  stage?: 'check_in' | 'dispatched' | 'in_progress' | 'waiting_parts' | 'road_test_ready' | 'road_test_completed' | 'wash_clean' | 'completed';
  technician_name?: string | null;
  technician_notes?: string | null;
  road_test_status?: 'not_required' | 'pending' | 'in_progress' | 'passed' | 'failed';
  authority_request?: AuthorityRequest | null;
  collection?: CollectionDetails | null;
};
export type RepairOrderCommand = RecordBase & {
  organisation_id: string; site_id: string; brand_id: string; customer_id: string; assigned_to: string;
  actor_user_id: string; repair_order_id: string; appointment_id: string; mode: 'simulated';
  kind: 'repair_order.simulate' | 'repair_order.transition' | 'repair_order.authority_note' | 'repair_order.workflow';
  payload: { version?: number; status?: RepairOrderStatus; note?: string; promised_at?: string; action?: string; data?: Record<string, unknown>; vehicle_id?: string; vehicle_external_id?: string; vehicle_label?: string };
  idempotency_key: string; request_hash: string;
  status: 'queued' | 'retry_wait' | 'succeeded' | 'rejected' | 'failed' | 'needs_review';
  attempts: number; available_at: string; updated_at: string; error?: string;
};
export type ServiceAppointment = RecordBase & {
  resource_id?: string;
  organisation_id: string; site_id: string; brand_id: string; customer_id: string;
  assigned_to: string; created_by: string; title: string; vehicle: string;
  starts_at: string; ends_at: string; notes: string; outcome_note: string | null;
  status: 'booked' | 'confirmed' | 'cancelled' | 'attended' | 'no_show';
  version: number; updated_at: string; integration_mode?: 'simulated' | 'scraping';
  create_key: string; create_hash: string;
};
export type WorkshopResource = RecordBase & {
  organisation_id: string; site_id: string; name: string; active: boolean;
  days: number[]; open_minute: number; close_minute: number;
  version: number; booking_revision: number; updated_at: string;
  created_by: string; create_key: string; create_hash: string;
};
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
  token_hash?: string;
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
  channel: 'email' | 'sms'; subject: string; body: string; version: number;
  status: 'draft' | 'sending' | 'accepted' | 'delivered' | 'bounced' | 'rejected' | 'needs_review' | 'cancelled';
  transport?: 'smtp' | 'simulated'; to?: string; provider_id?: string; sent_at?: string; updated_at: string;
  send_key?: string; send_started_at?: string; error_code?: string;
  draft_key?: string; draft_hash?: string;
  integration_mode?: 'simulated' | 'scraping';
  repair_order_id?: string | null;
  appointment_id?: string | null;
};
export type Task = RecordBase & {
  repair_order_id?: string;
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
  price_cents: number | null; currency: 'AUD'; status: 'available' | 'incoming' | 'sold' | 'unavailable';
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

export type DeliveryPlan = RecordBase & {
  handed_over_at?: string; handed_over_by?: string;
  organisation_id: string; site_id: string; lead_id: string; customer_id: string; deal_id: string; deal_version: number;
  stock_id: string; stock_label: string; brand_id: string; scheduled_at: string; notes: string; status: 'planned' | 'cancelled' | 'handed_over';
  checklist: Record<import('../crm/delivery-checklist.js').DeliveryItem, { complete: boolean; note: string | null; updated_by: string | null; updated_at: string | null }>;
  created_by: string; updated_at: string; version: number; integration_mode?: 'simulated' | 'scraping';
  create_key: string; create_hash: string;
};

export type CallOutcome = 'connected' | 'no_answer' | 'voicemail' | 'busy' | 'wrong_number';
export type CustomerJournal = RecordBase & {
  organisation_id: string; site_id: string; customer_id: string; created_by: string;
  kind: 'note' | 'call'; text: string; occurred_at: string;
  direction?: 'incoming' | 'outgoing'; outcome?: CallOutcome; follow_up_task_id?: string;
  integration_mode?: 'simulated' | 'scraping'; idempotency_key: string; request_hash: string;
};

export type CustomerVehicle = RecordBase & {
  ownership?: 'owned' | 'previous'; external_id?: string;
  organisation_id: string; site_id: string; customer_id: string;
  make: string; model: string; year: number; registration: string; vin: string;
  odometer_km?: number | null; next_service_date?: string | null; open_campaigns?: string[];
  notes?: string | null; integration_mode?: 'simulated' | 'scraping';
  updated_at: string;
};
export type RecoveryResolution = RecordBase & {
  integration_mode?: 'simulated' | 'scraping';
  organisation_id: string; site_id: string; customer_id: string; entity_id: string; kind: string;
  fingerprint: string; note: string; resolved_by: string; follow_up_task_id?: string;
};

export type CustomerRelationship = RecordBase & {
  integration_mode?: 'simulated' | 'scraping';
  organisation_id: string; site_id: string; customer_id: string;
  related_customer_id: string;
  relation_type: 'household' | 'spouse' | 'company' | 'subsidiary' | 'fleet_driver' | 'parent_child' | 'other';
  notes?: string | null;
  updated_at: string;
};

export type LoanCar = RecordBase & {
  integration_mode?: 'simulated' | 'scraping'; create_key?: string;
  organisation_id: string; site_id: string; brand_id: string;
  make: string; model: string; year: number; registration: string;
  status: 'available' | 'allocated' | 'maintenance';
  allocated_repair_order_id?: string | null;
  allocated_customer_id?: string | null;
  notes?: string | null;
  updated_at: string;
};

export type HandoverItem = RecordBase & {
  lead_id?: string; pdi_task_id?: string;
  version?: number; integration_mode?: 'simulated' | 'scraping';
  pdi_owner?: string; pdi_technician?: string; pdi_notes?: string;
  customer_service_preference?: { preferred_channel: string; notes: string };
  completed_at?: string; completed_by?: string;
  organisation_id: string; site_id: string; brand_id: string;
  deal_id: string; delivery_plan_id: string; customer_id: string; stock_id: string;
  vehicle_label: string; scheduled_delivery_at: string;
  pdi_due_date: string; pdi_status: 'pending' | 'booked' | 'in_progress' | 'completed';
  pdi_appointment_id?: string | null;
  accessories_status: 'pending' | 'in_progress' | 'ready';
  accessories_notes?: string | null;
  first_service_status: 'not_booked' | 'booked';
  first_service_appointment_id?: string | null;
  notes?: string | null; status: 'active' | 'completed' | 'cancelled';
  created_by: string; updated_at: string;
};

export type DbUser = RecordBase & {
  email: string | null;
  full_name?: string;
  password_hash?: string;
  password_salt?: string;
  email_confirmed_at?: string | null;
  failed_login_attempts?: number;
  locked_until?: string | null;
  updated_at: string;
};

export type AuthSession = RecordBase & {
  user_id: string;
  refresh_token_hash: string;
  user_agent?: string | null;
  ip_address?: string | null;
  expires_at: string;
  revoked_at?: string | null;
};

export type PasswordReset = RecordBase & {
  user_id: string;
  email: string;
  token_hash: string;
  expires_at: string;
  used_at?: string | null;
};

export function publicRecord<T extends { _id: string }>(record: T): Omit<T, '_id'> {
  const { _id, ...result } = record;
  return result;
}
