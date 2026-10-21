import { BadRequestException, ConflictException } from '@nestjs/common';
import { text, uuid } from '../auth/validation.js';
import type { RepairOrder } from '../database/models.js';
import { repairOrderPromise } from './repair-order-lifecycle.js';
export const workflowFields: Record<string, string[]> = {
  'check-in': [
    'mileageIn',
    'fuelLevel',
    'notes',
    'signatureConfirmed',
    'loanCarId',
  ],
  progress: [
    'stage',
    'technicianName',
    'technicianNotes',
    'roadTestStatus',
    'markReady',
  ],
  'request-authority': ['description'],
  'respond-authority': ['approved', 'responseNote'],
  collect: ['keysReturned', 'loanReturned', 'notes'],
  reassign: ['assignedTo', 'reason'],
  promise: ['promisedAt', 'note'],
  'add-operation': ['description', 'note'],
};
export function workflowInput(action: string, body: Record<string, unknown>) {
  if (
    !workflowFields[action] ||
    Object.keys(body).some(
      (k) => !['siteId', 'version', ...workflowFields[action]].includes(k),
    )
  )
    throw new BadRequestException(
      'Unsupported workflow field; financials and source totals are read-only',
    );
  if (!Number.isInteger(body.version) || Number(body.version) < 0)
    throw new BadRequestException('Current repair-order version is required');
  const data: Record<string, unknown> = {};
  for (const k of workflowFields[action])
    if (body[k] !== undefined && body[k] !== '') data[k] = body[k];
  for (const k of [
    'notes',
    'technicianName',
    'technicianNotes',
    'responseNote',
    'reason',
    'description',
    'note',
    'fuelLevel',
  ])
    if (data[k] !== undefined) data[k] = text(data[k], k, 1, 2000);
  for (const k of [
    'signatureConfirmed',
    'approved',
    'markReady',
    'keysReturned',
    'loanReturned',
  ])
    if (data[k] !== undefined && typeof data[k] !== 'boolean')
      throw new BadRequestException(`${k} must be boolean`);
  for (const k of ['assignedTo', 'loanCarId'])
    if (data[k] !== undefined) data[k] = uuid(data[k], k);
  if (action === 'check-in') {
    if (
      !Number.isInteger(data.mileageIn) ||
      Number(data.mileageIn) < 0 ||
      Number(data.mileageIn) > 2000000
    )
      throw new BadRequestException('Valid integer mileageIn is required');
    if (!data.fuelLevel || data.signatureConfirmed !== true)
      throw new BadRequestException(
        'Fuel level and explicit check-in confirmation are required',
      );
  }
  if (action === 'progress') {
    if (
      ![
        'check_in',
        'dispatched',
        'in_progress',
        'waiting_parts',
        'road_test_ready',
        'road_test_completed',
        'wash_clean',
        'completed',
      ].includes(String(data.stage))
    )
      throw new BadRequestException('Invalid workshop stage');
    if (
      data.roadTestStatus !== undefined &&
      !['not_required', 'pending', 'in_progress', 'passed', 'failed'].includes(
        String(data.roadTestStatus),
      )
    )
      throw new BadRequestException('Invalid road test status');
  }
  if (
    ['request-authority', 'add-operation'].includes(action) &&
    !data.description
  )
    throw new BadRequestException('description is required');
  if (
    action === 'respond-authority' &&
    (typeof data.approved !== 'boolean' || !data.responseNote)
  )
    throw new BadRequestException(
      'Explicit decision and customer response evidence are required',
    );
  if (action === 'collect' && data.keysReturned !== true)
    throw new BadRequestException('Confirm keys and vehicle handover');
  if (action === 'reassign' && (!data.assignedTo || !data.reason))
    throw new BadRequestException('Assignee and reason are required');
  if (action === 'promise') {
    data.promisedAt = repairOrderPromise(data.promisedAt);
    if (!data.note)
      throw new BadRequestException('Promise change reason is required');
  }
  return { version: Number(body.version), action, data };
}
export function workflowChanges(
  row: RepairOrder,
  action: string,
  d: Record<string, unknown>,
  actor: string,
  now: string,
): Partial<RepairOrder> {
  if (row.collection || row.status === 'invoiced')
    throw new ConflictException(
      'Collected/invoiced repair orders are read-only',
    );
  const changes: Partial<RepairOrder> = { updated_at: now };
  if (action === 'check-in') {
    if (
      row.check_in ||
      !['waiting_authority', 'in_workshop'].includes(row.status)
    )
      throw new ConflictException(
        'Vehicle is already checked in or is not awaiting arrival',
      );
    changes.check_in = {
      arrived_at: now,
      mileage_in: Number(d.mileageIn),
      fuel_level: String(d.fuelLevel),
      signature_confirmed: true,
      notes: String(d.notes ?? ''),
      loan_car_id: d.loanCarId ? String(d.loanCarId) : null,
    };
    changes.stage = 'check_in'; // Check-in never supplies customer authority implicitly.
  } else if (action === 'progress') {
    if (
      !row.check_in ||
      row.status === 'waiting_authority' ||
      row.authority_request?.status === 'pending' ||
      row.authority_request?.status === 'declined'
    )
      throw new ConflictException(
        'Check-in and customer authority are required before work progresses',
      );
    changes.stage = d.stage as RepairOrder['stage'];
    changes.technician_name = String(
      d.technicianName ?? row.technician_name ?? '',
    );
    changes.technician_notes = String(
      d.technicianNotes ?? row.technician_notes ?? '',
    );
    changes.road_test_status = (d.roadTestStatus ??
      row.road_test_status ??
      'not_required') as RepairOrder['road_test_status'];
    changes.status =
      d.stage === 'waiting_parts' ? 'waiting_parts' : 'in_workshop';
    if (d.markReady === true || d.stage === 'completed') {
      if (
        ['pending', 'in_progress', 'failed'].includes(changes.road_test_status!)
      )
        throw new ConflictException(
          'Resolve the road test before marking ready',
        );
      changes.status = 'ready';
      changes.ready_at = now;
    } else changes.ready_at = null;
  } else if (action === 'request-authority') {
    if (
      !['waiting_authority', 'in_workshop', 'waiting_parts'].includes(
        row.status,
      ) ||
      row.authority_request?.status === 'pending'
    )
      throw new ConflictException(
        'An authority request is already outstanding or the job is ready',
      );
    changes.authority_request = {
      description: String(d.description),
      requested_at: now,
      status: 'pending',
    };
    changes.status = 'waiting_authority';
  } else if (action === 'respond-authority') {
    if (row.authority_request?.status !== 'pending')
      throw new ConflictException('There is no outstanding authority request');
    changes.authority_request = {
      ...row.authority_request,
      status: d.approved ? 'approved' : 'declined',
      responded_at: now,
      response_note: String(d.responseNote),
    };
    changes.status = d.approved ? 'in_workshop' : 'waiting_authority';
  } else if (action === 'collect') {
    if (!row.check_in || row.status !== 'ready')
      throw new ConflictException(
        'Only a checked-in, ready vehicle can be collected',
      );
    if (row.check_in.loan_car_id && d.loanReturned !== true)
      throw new ConflictException(
        'Record the loan car return before collection',
      );
    changes.collection = {
      collected_at: now,
      collected_by_staff_id: actor,
      keys_returned: true,
      loan_returned: d.loanReturned === true,
      notes: String(d.notes ?? ''),
    };
    // Collection is an operational event; it never invoices or changes payment context.
  } else if (action === 'reassign') changes.assigned_to = String(d.assignedTo);
  else if (action === 'promise') changes.promised_at = String(d.promisedAt);
  else if (action === 'add-operation') {
    if (row.authority_request?.status !== 'approved')
      throw new ConflictException(
        'Customer authority is required to add a simulated source operation',
      );
    changes.operations_summary = `${row.operations_summary}\n${String(d.description)}`;
  }
  return changes;
}
