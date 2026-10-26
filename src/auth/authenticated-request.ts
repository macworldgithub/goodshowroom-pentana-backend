import type { Request } from 'express';

export type AuthUser = {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  user_metadata?: { full_name?: string };
  fullName?: string;
};

export type AuthenticatedRequest = Request & {
  user?: AuthUser;
  accessToken?: string;
};
