import { BadRequestException } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { applyDecorators } from '@nestjs/common';

export function pagination(offset?: unknown, limit?: unknown) {
  const integer = (value: unknown, fallback: number, name: string, min: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new BadRequestException(`${name} must be an integer`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new BadRequestException(`${name} must be between ${min} and ${max}`);
    return parsed;
  };
  return { offset: integer(offset, 0, 'offset', 0, 1000000), limit: integer(limit, 100, 'limit', 1, 100) };
}
export function pageResult<T>(rows: T[], page: { offset: number; limit: number }) {
  const hasMore = rows.length > page.limit;
  return { rows: rows.slice(0, page.limit), pagination: { ...page, hasMore, nextOffset: hasMore ? page.offset + page.limit : null } };
}
export const ApiPagination = () => applyDecorators(
  ApiQuery({ name: 'offset', required: false, type: Number, description: 'Zero-based offset, default 0; maximum 1000000.' }),
  ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size from 1 to 100; default 100.' }),
);
