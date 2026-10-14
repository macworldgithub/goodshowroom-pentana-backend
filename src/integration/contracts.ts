import type { CustomerPrivacy, RecordBase } from '../database/models.js';

// Provisional normalized contract. The scraping runner must translate Pentana UI
// fields/IDs into these records; no DOM selectors or external status maps are assumed.
export type CustomerInput = { first_name: string; last_name: string; email: string | null; phone: string | null; privacy?: CustomerPrivacy };
export type SourceCustomer = CustomerInput & { external_id: string; revision: string; observed_at: string };
export type SourceVehicle = { external_id: string; site_external_id: string; brand_external_id: string; vin: string | null; registration: string | null; status: string };
export type SourceDeal = { external_id: string; customer_external_id: string; vehicle_external_id: string | null; status: string; source_total: string | null; currency: string | null };
export type SourceAppointment = { external_id: string; customer_external_id: string; starts_at: string; status: string };
export type SourceRepairOrder = { external_id: string; customer_external_id: string; vehicle_external_id: string | null; status: string };
export type IntegrationMode = 'disabled' | 'simulated' | 'scraping';
export type CommandStatus = 'queued' | 'processing' | 'retry_wait' | 'succeeded' | 'rejected' | 'failed' | 'needs_review';
export type Command = RecordBase & {
  organisation_id: string; site_id: string; actor_user_id: string; mode: 'simulated' | 'scraping';
  kind: 'customer.create' | 'customer.update' | 'customer.privacy_update'; payload: CustomerInput; customer_id: string;
  external_id?: string; expected_revision?: string;
  idempotency_key: string; request_hash: string; status: CommandStatus; attempts: number;
  available_at: string; updated_at: string; lease_token?: string; lease_expires_at?: string;
  result?: SourceCustomer; error?: { code: string; message: string };
};
export type CommandResult =
  | { outcome: 'succeeded'; customer: SourceCustomer }
  | { outcome: 'rejected' | 'not_applied' | 'unknown'; code: string; message: string };
export type Attempt = RecordBase & { command_id: string; organisation_id: string; site_id: string; mode: Command['mode']; attempt: number; request: CustomerInput; response: CommandResult | null; completed_at: string | null; processing_outcome?: CommandResult; outcome_status?: CommandStatus; resolution?: { response: CommandResult; status: CommandStatus; note: string; actor: string; resolved_at: string } };
export type SimulatedRecord = RecordBase & { organisation_id: string; site_id: string; command_id: string; customer: SourceCustomer };
export type SimulatorBehavior = { organisation_id: string; site_id: string; behavior: 'accept' | 'reject' | 'outage' | 'unknown'; remaining: number };

export interface SourceAdapter {
  readonly mode: 'simulated' | 'scraping';
  readonly supportsIdempotency: boolean;
  readCustomers(organisationId: string, siteId: string): Promise<SourceCustomer[]>;
  execute(command: Command): Promise<CommandResult>;
}
