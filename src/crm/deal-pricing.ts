import { BadRequestException } from '@nestjs/common';
export function moneyCents(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1000000000) throw new BadRequestException(`${field} must be integer cents between 0 and 1000000000`);
  return Number(value);
}
export function dealPricing(sale: unknown, discount: unknown, fees: unknown, tradeIn: unknown) {
  const sale_price_cents = moneyCents(sale, 'salePriceCents');
  const discount_cents = moneyCents(discount, 'discountCents'); const fees_cents = moneyCents(fees, 'feesCents');
  const trade_in_cents = moneyCents(tradeIn, 'tradeInCents');
  if (discount_cents > sale_price_cents) throw new BadRequestException('Discount cannot exceed the vehicle sale price');
  const total_cents = sale_price_cents - discount_cents + fees_cents - trade_in_cents;
  if (total_cents < 0) throw new BadRequestException('Trade-in credit cannot exceed the proposal subtotal');
  return { sale_price_cents, discount_cents, fees_cents, trade_in_cents, total_cents };
}
