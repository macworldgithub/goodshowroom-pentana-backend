import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import { MongoService } from './mongo.service.js';

@Injectable()
export class AuditService {
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
