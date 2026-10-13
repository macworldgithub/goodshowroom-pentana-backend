import { journalInput } from './journal-validation.js';
describe('Customer journal validation', () => {
  it('normalizes notes', () => { expect(journalInput('note', { text: '  Internal note  ' })).toEqual({ text: 'Internal note', occurredAt: null, followUp: null }); });
  it.each(['', ' '.repeat(10), 'a'.repeat(5001)])('rejects invalid note content', text => { expect(() => journalInput('note', { text })).toThrow(); });
  it('keeps omitted time stable for replay hashes', () => { expect(journalInput('call', { summary: 'Attempt', direction: 'outgoing', outcome: 'no_answer' }).occurredAt).toBeNull(); });
  it('validates promised callback priority and input shape', () => {
    const base = { summary: 'Callback', direction: 'outgoing', outcome: 'connected' };
    expect(() => journalInput('call', { ...base, followUp: [] })).toThrow();
    expect(() => journalInput('call', { ...base, followUp: { title: 'Callback', dueAt: '2026-10-14', priority: 'urgent' } })).toThrow();
    expect(journalInput('call', { ...base, followUp: { title: 'Callback', dueAt: '2026-10-14T09:00:00+05:00' } }).followUp?.dueAt).toBe('2026-10-14T04:00:00.000Z');
  });
  it('rejects future calls but permits historical records', () => {
    const base = { summary: 'Attempt', direction: 'incoming', outcome: 'voicemail' };
    expect(() => journalInput('call', { ...base, occurredAt: '2026-10-15' }, Date.parse('2026-10-13'))).toThrow();
    expect(journalInput('call', { ...base, occurredAt: '2026-10-01' }, Date.parse('2026-10-13')).occurredAt).toBe('2026-10-01T00:00:00.000Z');
  });
});
