import type { DeliveryPlan, SalesDeal, StockVehicle, StockReservation, TradeInAppraisal } from '../database/models.js';
import { deliveryReadiness, emptyChecklist, DELIVERY_ITEMS } from './delivery-checklist.js';
describe('delivery readiness gates', () => {
  const now = '2026-10-14T10:00:00.000Z';
  function fixture() {
    const plan = { status: 'planned', deal_id: 'deal', stock_id: 'stock', brand_id: 'brand', integration_mode: 'simulated', deal_version: 2,
      scheduled_at: '2026-10-14T14:00:00.000Z', checklist: emptyChecklist() } as DeliveryPlan;
    for (const key of DELIVERY_ITEMS) plan.checklist[key].complete = true;
    const deal = { id: 'deal', status: 'approved', version: 2, stock_version: 0, appraisal_id: null } as SalesDeal;
    const stock = { id: 'stock', status: 'available', version: 0, brand_id: 'brand', integration_mode: 'simulated' } as StockVehicle;
    const hold = { status: 'active', stock_id: 'stock', deal_id: 'deal', expires_at: '2026-10-15T10:00:00.000Z' } as StockReservation;
    return { plan, deal, stock, hold };
  }
  it('requires all checkpoints, approval and a covering hold', () => {
    const { plan, deal, stock, hold } = fixture(); expect(deliveryReadiness(plan, deal, stock, hold, null, now).ready).toBe(true);
    plan.checklist.payment_verified.complete = false; expect(deliveryReadiness(plan, deal, stock, hold, null, now).ready).toBe(false);
  });
  it('does not trust checklist completion when a hold expires or ends before delivery', () => {
    const { plan, deal, stock, hold } = fixture();
    hold.expires_at = '2026-10-14T09:00:00.000Z'; expect(deliveryReadiness(plan, deal, stock, hold, null, now).ready).toBe(false);
    hold.expires_at = '2026-10-14T12:00:00.000Z'; expect(deliveryReadiness(plan, deal, stock, hold, null, now).blockers).toContain('Reservation must cover the planned delivery time');
  });
  it('blocks changed approvals, vehicle snapshots and withdrawn trade-ins', () => {
    const { plan, deal, stock, hold } = fixture();
    deal.version = 3; expect(deliveryReadiness(plan, deal, stock, hold, null, now).ready).toBe(false);
    deal.version = 2; stock.status = 'sold'; expect(deliveryReadiness(plan, deal, stock, hold, null, now).ready).toBe(false);
    stock.status = 'available'; deal.appraisal_id = 'appraisal'; deal.appraisal_version = 1; deal.trade_in_cents = 0;
    const appraisal = { status: 'valued', version: 1, valuation_cents: 0 } as TradeInAppraisal;
    expect(deliveryReadiness(plan, deal, stock, hold, appraisal, now).ready).toBe(true);
    appraisal.status = 'withdrawn'; expect(deliveryReadiness(plan, deal, stock, hold, appraisal, now).ready).toBe(false);
  });
  it('never marks cancelled plans ready, and flags overdue planned delivery', () => {
    const { plan, deal, stock, hold } = fixture(); plan.scheduled_at = '2026-10-14T09:00:00.000Z';
    expect(deliveryReadiness(plan, deal, stock, hold, null, now).overdue).toBe(true);
    plan.status = 'cancelled'; expect(deliveryReadiness(plan, deal, stock, hold, null, now).ready).toBe(false);
  });
});
