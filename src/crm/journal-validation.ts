import { BadRequestException } from '@nestjs/common';
import { text } from '../auth/validation.js';
import type { CallOutcome } from '../database/models.js';

export const CALL_OUTCOMES: CallOutcome[] = ['connected', 'no_answer', 'voicemail', 'busy', 'wrong_number'];
export type FollowUpInput = { title: string; dueAt: string; priority: 'low' | 'normal' | 'high' };
export type JournalInput = { text: string; occurredAt: string | null; direction?: 'incoming' | 'outgoing'; outcome?: CallOutcome; followUp: FollowUpInput | null };
export function journalInput(kind: 'note' | 'call', body: Record<string, unknown>, now = Date.now()): JournalInput {
  const content = text(kind === 'note' ? body.text : body.summary, kind === 'note' ? 'text' : 'summary', 1, 5000);
  if (kind === 'note') return { text: content, occurredAt: null, followUp: null };
  if (!['incoming', 'outgoing'].includes(body.direction as string)) throw new BadRequestException('direction must be incoming or outgoing');
  if (!CALL_OUTCOMES.includes(body.outcome as CallOutcome)) throw new BadRequestException('Choose a supported call outcome');
  let occurredAt: string | null = null;
  if (body.occurredAt !== undefined) {
    if (typeof body.occurredAt !== 'string' || !Number.isFinite(Date.parse(body.occurredAt)) || Date.parse(body.occurredAt) > now + 60000) throw new BadRequestException('occurredAt must be a valid past/current timestamp (maximum 60 seconds clock tolerance)');
    occurredAt = new Date(body.occurredAt).toISOString();
  }
  let followUp: FollowUpInput | null = null;
  if (body.followUp !== undefined && body.followUp !== null) {
    if (typeof body.followUp !== 'object' || Array.isArray(body.followUp)) throw new BadRequestException('followUp must be an object');
    const value = body.followUp as Record<string, unknown>;
    const title = text(value.title, 'followUp.title', 2, 180);
    if (typeof value.dueAt !== 'string' || !Number.isFinite(Date.parse(value.dueAt))) throw new BadRequestException('followUp.dueAt must be a valid timestamp');
    const priority = value.priority ?? 'normal';
    if (!['low', 'normal', 'high'].includes(priority as string)) throw new BadRequestException('Choose a supported follow-up priority');
    followUp = { title, dueAt: new Date(value.dueAt).toISOString(), priority: priority as FollowUpInput['priority'] };
  }
  return { text: content, occurredAt, direction: body.direction as 'incoming' | 'outgoing', outcome: body.outcome as CallOutcome, followUp };
}
