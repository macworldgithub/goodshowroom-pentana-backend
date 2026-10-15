import type { DeliveryPlan, SalesDeal, StockVehicle, StockReservation, TradeInAppraisal } from '../database/models.js';
export const DELIVERY_ITEMS = ['documents', 'payment_verified', 'vehicle_preparation', 'customer_confirmation', 'handover_pack'] as const;
export type DeliveryItem = typeof DELIVERY_ITEMS[number];
export const DELIVERY_LABELS: Record<DeliveryItem, string> = { documents: 'Documents checked', payment_verified: 'Payment verified', vehicle_preparation: 'Vehicle preparation', customer_confirmation: 'Customer confirmation', handover_pack: 'Handover pack' };
export function emptyChecklist(): DeliveryPlan['checklist'] {
  return Object.fromEntries(DELIVERY_ITEMS.map(key => [key, { complete: false, note: null, updated_by: null, updated_at: null }])) as DeliveryPlan['checklist'];
}
export function deliveryReadiness(plan: DeliveryPlan, deal: SalesDeal | null, stock: StockVehicle | null, hold: StockReservation | null, appraisal: TradeInAppraisal | null, now = new Date().toISOString()) {
  const blockers: string[] = [];
  if (plan.status !== 'planned') blockers.push('Delivery plan is cancelled');
  if (!deal || deal.status !== 'approved' || deal.version !== plan.deal_version) blockers.push('A current approved deal is required');
  if (!stock || stock.status !== 'available' || stock.version !== deal?.stock_version || stock.brand_id !== plan.brand_id || stock.integration_mode !== plan.integration_mode) blockers.push('Vehicle availability or approved snapshot changed');
  if (!hold || hold.status !== 'active' || hold.expires_at <= now || hold.deal_id !== plan.deal_id || hold.stock_id !== plan.stock_id) blockers.push('An active reservation for this deal is required');
  else if (hold.expires_at < plan.scheduled_at) blockers.push('Reservation must cover the planned delivery time');
  if (deal?.appraisal_id && (!appraisal || appraisal.status !== 'valued' || appraisal.version !== deal.appraisal_version || appraisal.valuation_cents !== deal.trade_in_cents)) blockers.push('Approved trade-in appraisal changed');
  for (const key of DELIVERY_ITEMS) if (!plan.checklist[key]?.complete) blockers.push(DELIVERY_LABELS[key]);
  return { ready: blockers.length === 0, blockers, completedItems: DELIVERY_ITEMS.filter(key => plan.checklist[key]?.complete).length, totalItems: DELIVERY_ITEMS.length, overdue: plan.status === 'planned' && plan.scheduled_at < now };
}
