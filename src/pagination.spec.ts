import { pagination, pageResult } from './pagination.js';
import { BadRequestException } from '@nestjs/common';
import { brandScope, identifiers, timezone } from './auth/validation.js';
describe('Foundation input boundaries', () => {
  it.each(['-1', '1.5', 'NaN', '', ['1'], {}, '1000001'])('rejects invalid offsets %j', offset => {
    expect(() => pagination(offset)).toThrow(BadRequestException);
  });
  it.each(['0', '101', '-1', '1e2', ['5']])('rejects invalid limits %j', limit => {
    expect(() => pagination(undefined, limit)).toThrow(BadRequestException);
  });
  it('returns a usable next offset only when another row exists', () => {
    expect(pageResult(['a', 'b'], pagination('3', '1'))).toEqual({ rows: ['a'], pagination: { offset: 3, limit: 1, hasMore: true, nextOffset: 4 } });
    expect(pageResult([], pagination())).toEqual({ rows: [], pagination: { offset: 0, limit: 100, hasMore: false, nextOffset: null } });
  });
  it('rejects empty brand restrictions but permits removing site mappings', () => {
    expect(() => brandScope([])).toThrow(BadRequestException);
    expect(brandScope(null)).toBeNull();
    expect(brandScope(undefined)).toBeNull();
    expect(identifiers([], 'brandIds')).toEqual([]);
  });
  it('validates and deduplicates brand UUIDs', () => {
    const id = '00000000-0000-0000-0000-000000000001';
    expect(brandScope([id, id])).toEqual([id]);
    expect(() => brandScope(['wrong'])).toThrow(BadRequestException);
    expect(() => brandScope('wrong')).toThrow(BadRequestException);
  });
  it('validates site timezones', () => {
    expect(timezone('Australia/Perth')).toBe('Australia/Perth');
    expect(() => timezone('Invalid/Zone')).toThrow(BadRequestException);
  });
});
