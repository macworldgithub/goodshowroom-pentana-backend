import { dealPricing } from './deal-pricing.js';
describe('deal pricing in integer cents', () => {
  it('calculates sale less discount plus fees less appraised trade-in', () => {
    expect(dealPricing(3499000, 100000, 50000, 1450050)).toMatchObject({ total_cents: 1998950, trade_in_cents: 1450050 });
  });
  it('distinguishes zero amounts and accepts a zero net total', () => { expect(dealPricing(10000, 0, 0, 10000).total_cents).toBe(0); });
  it.each([-1, 1.5, '100', NaN, 1000000001])('rejects invalid monetary input %s', value => { expect(() => dealPricing(value, 0, 0, 0)).toThrow(); });
  it('rejects excessive discounts and credits', () => {
    expect(() => dealPricing(100, 101, 0, 0)).toThrow(); expect(() => dealPricing(100, 0, 0, 101)).toThrow();
  });
});
