import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MongoService } from '../database/mongo.service.js';
import type { Command, CommandResult, SourceAdapter, SourceCustomer } from './contracts.js';

@Injectable()
export class SimulatedAdapter implements SourceAdapter {
  readonly mode = 'simulated' as const;
  readonly supportsIdempotency = true;
  constructor(@Inject(MongoService) private readonly mongo: MongoService) {}
  async execute(command: Command): Promise<CommandResult> {
    const existing = await this.mongo.simulatedRecords.findOne({ command_id: command.id });
    if (existing) return { outcome: 'succeeded', customer: existing.customer };
    const behavior = await this.mongo.simulatorBehaviors.findOneAndUpdate({ organisation_id: command.organisation_id, site_id: command.site_id, remaining: { $gt: 0 } }, { $inc: { remaining: -1 } }, { returnDocument: 'before' });
    if (behavior?.behavior === 'reject') return { outcome: 'rejected', code: 'SIMULATED_REJECTION', message: 'Simulator rejected this change' };
    if (behavior?.behavior === 'outage') return { outcome: 'not_applied', code: 'SIMULATED_OUTAGE', message: 'Simulator unavailable; no change was applied' };
    if (behavior?.behavior === 'unknown') return { outcome: 'unknown', code: 'SIMULATED_AMBIGUOUS_RESULT', message: 'Simulator cannot confirm the write outcome' };
    // Durable source receipt, separate from local projection transaction. A crash
    // after source acceptance replays this receipt instead of creating another record.
    const now = new Date().toISOString();
    const customer: SourceCustomer = { ...command.payload, external_id: `sim-${command.id}`, revision: '1', observed_at: now };
    const id = randomUUID();
    await this.mongo.simulatedRecords.updateOne({ command_id: command.id }, { $setOnInsert: { _id: id, id, command_id: command.id, organisation_id: command.organisation_id, site_id: command.site_id, customer, created_at: now } }, { upsert: true });
    const saved = await this.mongo.simulatedRecords.findOne({ command_id: command.id });
    return { outcome: 'succeeded', customer: saved!.customer };
  }
  async readCustomers(organisationId: string, siteId: string) {
    const records = await this.mongo.simulatedRecords.find({ organisation_id: organisationId, site_id: siteId }).toArray();
    const fixtures: SourceCustomer[] = [
      { external_id: `sim-fixture-${siteId}-1`, revision: '1', observed_at: '2026-10-01T00:00:00.000Z', first_name: 'Simulated', last_name: 'Sales Customer', email: 'sim-sales@example.test', phone: null },
      { external_id: `sim-fixture-${siteId}-2`, revision: '1', observed_at: '2026-10-01T00:00:00.000Z', first_name: 'Simulated', last_name: 'Service Customer', email: null, phone: '0400000000' },
    ];
    return [...fixtures, ...records.map(record => record.customer)];
  }
}
