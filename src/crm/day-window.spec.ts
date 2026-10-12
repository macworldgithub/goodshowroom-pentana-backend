import { dayWindow } from './day-window.js';
describe('Site-local day boundaries', () => {
  it('uses site date rather than execution-host date', () => {
    expect(dayWindow('Australia/Sydney', undefined, new Date('2026-10-11T20:00:00Z'))).toEqual({ date: '2026-10-12', timezone: 'Australia/Sydney', startsAt: '2026-10-11T13:00:00.000Z', endsAt: '2026-10-12T13:00:00.000Z' });
  });
  it('supports a 23-hour daylight-saving day', () => {
    const day = dayWindow('Australia/Sydney', '2026-10-04');
    expect(Date.parse(day.endsAt) - Date.parse(day.startsAt)).toBe(23 * 3600000);
  });
  it('supports a 25-hour daylight-saving day', () => {
    const day = dayWindow('Australia/Sydney', '2026-04-05');
    expect(Date.parse(day.endsAt) - Date.parse(day.startsAt)).toBe(25 * 3600000);
  });
  it('rejects a skipped civil date', () => {
    expect(() => dayWindow('Pacific/Apia', '2011-12-30')).toThrow();
  });
  it.each(['2026-02-30', '2026-2-1', '', '2026-10-12T00:00:00Z', '1960-01-01'])('rejects invalid requested dates %s', date => {
    expect(() => dayWindow('Australia/Sydney', date)).toThrow();
  });
  it('rejects an invalid timezone', () => { expect(() => dayWindow('Invalid/Timezone')).toThrow(); });
});
