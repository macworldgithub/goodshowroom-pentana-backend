import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import { AccessService } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { uuid } from '../auth/validation.js';
export async function requireAssignee(access: AccessService, userId: unknown, siteId: string, permission: string, session: ClientSession) {
  const id = uuid(userId, 'assignedTo');
  try { await access.requireSite({ user: { id } } as AuthenticatedRequest, siteId, permission, session); }
  catch (error) { if (error instanceof ForbiddenException) throw new BadRequestException('Assignee must have active access and the required permission at this site'); throw error; }
  return id;
}
