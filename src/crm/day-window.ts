import { BadRequestException } from '@nestjs/common';

function localDate(timestamp: number, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(new Date(timestamp));
  const part = (name: string) => parts.find(item => item.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
// Search calendar boundaries instead of assuming a day is 24 hours or that every
// timezone has a midnight. This handles DST changes and skipped civil dates.
export function dayWindow(zone: string, requested?: string, now = new Date()) {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { throw new BadRequestException('Site timezone is invalid'); }
  const date = requested ?? localDate(now.getTime(), formatter);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('date must be YYYY-MM-DD');
  const anchor = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(anchor) || new Date(anchor).toISOString().slice(0, 10) !== date || date < '1970-01-01' || date > '2100-12-31') throw new BadRequestException('date must be a valid calendar date between 1970 and 2100');
  const boundary = (target: string, center: number) => {
    let lo = center - 36 * 3600000;
    let hi = center + 36 * 3600000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (localDate(mid, formatter) < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const start = boundary(date, anchor);
  if (localDate(start, formatter) !== date) throw new BadRequestException('This calendar date does not exist in the site timezone');
  const next = new Date(anchor + 86400000).toISOString().slice(0, 10);
  const end = boundary(next, anchor + 86400000);
  return { date, timezone: zone, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
}
