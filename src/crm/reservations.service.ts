import { Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import { publicRecord, type StockReservation } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';

@Injectable()
export class ReservationsService implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(MongoService) private readonly mongo: MongoService, @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntegrationService) private readonly integration: IntegrationService) {}
  private timer?: NodeJS.Timeout; private running = false; private readonly logger = new Logger('Reservations');
  onModuleInit() { this.timer = setInterval(() => { void this.sweep(); }, 60000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  publicReservation(row: StockReservation) {
    const { create_key: _key, create_hash: _hash, ...record } = publicRecord(row);
    return { ...record, status: row.status === 'active' && row.expires_at <= new Date().toISOString() ? 'expired' : row.status };
  }
  async end(row: StockReservation, status: 'released' | 'expired', actor: string, reason: string, session: ClientSession) {
    const now = new Date().toISOString();
    const changed = await this.mongo.reservations.findOneAndUpdate({ _id: row._id, status: 'active', version: row.version },
      { $set: { status, ended_at: now, updated_at: now, reason }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
    if (!changed) return null;
    await this.mongo.stockVehicles.updateOne({ id: row.stock_id, organisation_id: row.organisation_id }, { $inc: { match_revision: 1 } }, { session });
    await this.record(changed, actor, `sales.reservation_${status}`, reason, session); return changed;
  }
  async record(row: StockReservation, actor: string, action: string, reason: string, session: ClientSession) {
    const lead = await this.mongo.salesLeads.findOneAndUpdate({ id: row.lead_id, organisation_id: row.organisation_id, site_id: row.site_id },
      { $inc: { version: 1 }, $set: { updated_at: new Date().toISOString() } }, { session, returnDocument: 'after' });
    await this.audit.record(session, actor, row.organisation_id, row.site_id, action, 'sales_lead', row.lead_id,
      { reservation_id: row.id, reservation_status: action === 'sales.reservation_created' ? 'active' : row.status,
        reservation_expires_at: row.expires_at, deal_id: row.deal_id, stock_brand_id: row.brand_id, reason, version: lead?.version ?? null });
  }
  async expireStock(organisationId: string, stockId: string, session: ClientSession) {
    const rows = await this.mongo.reservations.find({ organisation_id: organisationId, stock_id: stockId, status: 'active', expires_at: { $lte: new Date().toISOString() } }, { session }).toArray();
    for (const row of rows) await this.end(row, 'expired', 'system', 'Reservation expiry reached', session);
  }
  async releaseDeal(organisationId: string, dealId: string, actor: string, session: ClientSession) {
    const rows = await this.mongo.reservations.find({ organisation_id: organisationId, deal_id: dealId, status: 'active' }, { session }).toArray();
    for (const row of rows) await this.end(row, row.expires_at <= new Date().toISOString() ? 'expired' : 'released', actor, 'Deal cancelled', session);
  }
  async sweep() {
    if (this.running) return; this.running = true;
    try {
      const rows = await this.mongo.reservations.find({ ...this.integration.projectionFilter(), status: 'active', expires_at: { $lte: new Date().toISOString() } }).limit(100).toArray();
      for (const row of rows) await this.mongo.transaction(session => this.expireStock(row.organisation_id, row.stock_id, session));
    } catch { this.logger.warn('Reservation expiry could not complete; check database availability'); }
    finally { this.running = false; }
  }
}
