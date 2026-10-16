import type {
  RepairOrder,
  RepairOrderCommand,
  RepairOrderStatus,
  ServiceAppointment,
} from '../database/models.js';

// Development source contract only. These are not eraPower status codes.
// Live reads/writes require a dealer-authorised adapter and verified field mappings.
export const simulatedRepairOrderStatuses: Record<RepairOrderStatus, string> = {
  waiting_authority: 'SIM_AUTHORITY',
  in_workshop: 'SIM_WORKSHOP',
  waiting_parts: 'SIM_PARTS',
  ready: 'SIM_READY',
  invoiced: 'SIM_INVOICED',
};
export function simulateRepairOrder(
  command: RepairOrderCommand,
  appointment: ServiceAppointment,
  now: string,
): RepairOrder {
  return {
    _id: command.repair_order_id,
    id: command.repair_order_id,
    organisation_id: command.organisation_id,
    site_id: command.site_id,
    brand_id: command.brand_id,
    customer_id: command.customer_id,
    appointment_id: appointment.id,
    assigned_to: appointment.assigned_to,
    vehicle: command.payload.vehicle_label ?? appointment.vehicle,
    vehicle_external_id: command.payload.vehicle_external_id ?? null,
    number: 'SIM-RO-' + command.repair_order_id,
    external_id: 'simulated-ro-' + command.repair_order_id,
    integration_mode: 'simulated',
    status: 'waiting_authority',
    source_status: simulatedRepairOrderStatuses.waiting_authority,
    operations_summary: appointment.title,
    promised_at: command.payload.promised_at!,
    version: 0,
    authority_notes: [],
    ready_at: null,
    invoiced_at: null,
    status_history: [],
    created_at: now,
    updated_at: now,
  };
}
