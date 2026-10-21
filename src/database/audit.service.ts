import { randomUUID } from 'node:crypto';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import { MongoService } from './mongo.service.js';

@Injectable()
export class AuditService implements OnModuleInit {
  private retentionYears = 7;
  onModuleInit() {
    const years = Number(process.env.AUDIT_RETENTION_YEARS ?? 7);
    if (!Number.isInteger(years) || years < 7 || years > 100) throw new Error('AUDIT_RETENTION_YEARS must be an integer between 7 and 100');
    this.retentionYears = years;
  }
  policy() { return { minimumYears: this.retentionYears, automaticDeletion: false, productionRetentionVerified: false }; }
  constructor(@Inject(MongoService) private readonly mongo: MongoService) {}
  async record(session: ClientSession, actor: string, organisationId: string, siteId: string | null,
    action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) {
    const id = randomUUID();
    await this.mongo.auditEvents.insertOne({
      _id: id, id, created_at: new Date().toISOString(), organisation_id: organisationId,
      site_id: siteId, actor_user_id: actor, action, entity_type: entityType, entity_id: entityId, metadata,
    }, { session });
  }
}
