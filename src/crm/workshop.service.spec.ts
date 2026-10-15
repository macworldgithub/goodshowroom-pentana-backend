import { withinWorkshopHours, workshopHours } from './workshop.service.js';
describe('Workshop local hours', () => {
  const allDay = { days: [0,1,2,3,4,5,6], open_minute: 0, close_minute: 1440 };
  it('honours the site weekday and allows an exact closing boundary', () => {
    const bay = { days: [1], open_minute: 480, close_minute: 1020 };
    expect(withinWorkshopHours(bay, '2026-10-19T05:00:00Z', '2026-10-19T06:00:00Z', 'Australia/Sydney')).toBe(true);
    expect(withinWorkshopHours(bay, '2026-10-18T21:00:00Z', '2026-10-18T22:00:00Z', 'Australia/Sydney')).toBe(true);
    expect(withinWorkshopHours(bay, '2026-10-19T06:00:00Z', '2026-10-19T07:00:00Z', 'Australia/Sydney')).toBe(false);
  });
  it('rejects fractional/off-grid times and cross-day occupancy', () => {
    expect(withinWorkshopHours(allDay, '2026-10-19T08:01:00Z', '2026-10-19T09:00:00Z', 'UTC')).toBe(false);
    expect(withinWorkshopHours(allDay, '2026-10-19T08:00:00.001Z', '2026-10-19T09:00:00Z', 'UTC')).toBe(false);
    expect(withinWorkshopHours(allDay, '2026-10-19T23:30:00Z', '2026-10-20T00:30:00Z', 'UTC')).toBe(false);
    expect(withinWorkshopHours(allDay, '2026-10-19T23:00:00Z', '2026-10-20T00:00:00Z', 'UTC')).toBe(true);
  });
  it('handles repeated DST times without treating the clock rollback as a negative duration', () => {
    expect(withinWorkshopHours(allDay, '2026-11-01T05:45:00Z', '2026-11-01T06:15:00Z', 'America/New_York')).toBe(true);
    expect(withinWorkshopHours({ ...allDay, open_minute: 90 }, '2026-11-01T05:45:00Z', '2026-11-01T06:45:00Z', 'America/New_York')).toBe(false);
  });
  it('validates resource weekday/hours configuration', () => {
    expect(() => workshopHours({ days: [1,1], openMinute: 480, closeMinute: 1020 })).toThrow();
    expect(() => workshopHours({ days: [7], openMinute: 480, closeMinute: 1020 })).toThrow();
    expect(() => workshopHours({ days: [1], openMinute: 481, closeMinute: 1020 })).toThrow();
    expect(workshopHours({ days: [5,1], openMinute: 480, closeMinute: 1020 }).days).toEqual([1,5]);
  });
});

