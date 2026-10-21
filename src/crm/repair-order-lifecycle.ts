import { BadRequestException, ConflictException } from '@nestjs/common';
import type { RepairOrderStatus } from '../database/models.js';
export const repairOrderStates: RepairOrderStatus[] = [
  'waiting_authority',
  'in_workshop',
  'waiting_parts',
  'ready',
  'invoiced',
];
export function allowedRepairOrderTransitions(
  status: RepairOrderStatus,
): RepairOrderStatus[] {
  return {
    waiting_authority: ['in_workshop'],
    in_workshop: ['waiting_authority', 'waiting_parts', 'ready'],
    waiting_parts: ['in_workshop', 'waiting_authority'],
    ready: ['in_workshop'],
    invoiced: [],
  }[status] as RepairOrderStatus[];
}
export function validateRepairOrderTransition(
  from: RepairOrderStatus,
  to: unknown,
) {
  if (!repairOrderStates.includes(to as RepairOrderStatus))
    throw new BadRequestException('Invalid repair order status');
  if (!allowedRepairOrderTransitions(from).includes(to as RepairOrderStatus))
    throw new ConflictException(
      'Unsupported repair order transition; invoicing is source-owned',
    );
  return to as RepairOrderStatus;
}
export function repairOrderPromise(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new BadRequestException(
      'promisedAt must be a timestamp with a timezone',
    );
  return new Date(value).toISOString();
}
