import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import { MongoService } from '../database/mongo.service.js';
import type { WorkshopResource } from '../database/models.js';

export function workshopHours(body: Record<string, unknown>) {
  const days = body.days;
  if (!Array.isArray(days) || !days.length || days.length > 7 || days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(days).size !== days.length)
    throw new BadRequestException('days must contain unique weekdays, Sunday=0 to Saturday=6');
  const open = body.openMinute; const close = body.closeMinute;
  if (!Number.isInteger(open) || !Number.isInteger(close) || Number(open) < 0 || Number(close) > 1440 || Number(open) >= Number(close) ||
      Number(open) % 15 || Number(close) % 15) throw new BadRequestException('Opening hours must use 15-minute boundaries within one day');
  return { days: [...days].sort() as number[], open_minute: Number(open), close_minute: Number(close) };
}
function localParts(value: string, zone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const p = (key: string) => parts.find(part => part.type === key)!.value;
  const date = p('year') + '-' + p('month') + '-' + p('day');
  return { date, weekday: new Date(date + 'T12:00:00Z').getUTCDay(), minute: Number(p('hour')) * 60 + Number(p('minute')) };
}
export function withinWorkshopHours(resource: Pick<WorkshopResource, 'days' | 'open_minute' | 'close_minute'>, start: string, end: string, zone: string) {
  const a = localParts(start, zone); const b = localParts(end, zone);
  if (new Date(start).getUTCSeconds() || new Date(start).getUTCMilliseconds() || new Date(end).getUTCSeconds() || new Date(end).getUTCMilliseconds() || a.minute % 15 || b.minute % 15) return false;
  // The closing boundary may be midnight of the next local date.
  const midnightEnd = b.minute === 0 && Date.parse(b.date + 'T00:00:00Z') - Date.parse(a.date + 'T00:00:00Z') === 86400000;
  if (Date.parse(end) <= Date.parse(start) || !resource.days.includes(a.weekday) || a.minute < resource.open_minute ||
    !(a.date === b.date ? b.minute <= resource.close_minute : midnightEnd && resource.close_minute === 1440)) return false;
  for (let instant = Date.parse(start); instant < Date.parse(end); instant += 900000) {
    const point = localParts(new Date(instant).toISOString(), zone);
    if (point.date !== a.date || point.minute < resource.open_minute || point.minute >= resource.close_minute) return false;
  }
  return true;
}
@Injectable()
export class WorkshopService {
  constructor(@Inject(MongoService) private readonly mongo: MongoService) {}
  async lock(siteId: string, organisationId: string, resourceId: string, session: ClientSession) {
    const resource = await this.mongo.workshopResources.findOneAndUpdate({ id: resourceId, site_id: siteId, organisation_id: organisationId },
      { $inc: { booking_revision: 1 } }, { session, returnDocument: 'after' });
    if (!resource) throw new BadRequestException('Workshop resource is unavailable at this site');
    return resource;
  }
  async reserve(siteId: string, organisationId: string, resourceId: string, start: string, end: string, zone: string, session: ClientSession, excludeId?: string) {
    const resource = await this.lock(siteId, organisationId, resourceId, session);
    if (!resource.active) throw new BadRequestException('Workshop resource is inactive');
    if (!withinWorkshopHours(resource, start, end, zone)) throw new BadRequestException('Choose a slot within resource hours on 15-minute boundaries');
    // All brands/owners/source modes share physical capacity. Never return another customer's details.
    const overlap = await this.mongo.serviceAppointments.findOne({ organisation_id: organisationId, site_id: siteId, resource_id: resourceId,
      status: { $in: ['booked', 'confirmed'] }, starts_at: { $lt: end }, ends_at: { $gt: start }, ...(excludeId ? { id: { $ne: excludeId } } : {}) }, { session, projection: { id: 1 } });
    if (overlap) throw new ConflictException('This resource is already booked during that time; choose another slot');
    return resource;
  }
}

