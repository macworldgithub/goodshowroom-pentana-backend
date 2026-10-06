import { Controller, Get, Post, Body, UseGuards, Req, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { createAdminSupabaseClient, createUserSupabaseClient } from '../auth/user-supabase.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';

@Controller()
@UseGuards(SupabaseAuthGuard)
export class ContextController {
  @Get('context')
  async getContext(@Req() request: AuthenticatedRequest) {
    const user = request.user;
    if (!user || !request.accessToken) throw new UnauthorizedException();
    const supabase = createUserSupabaseClient(request.accessToken);
    const { data: memberships, error } = await supabase
      .from('memberships')
      .select('organisation_id, site_id, role')
      .eq('user_id', user.id);
    if (error) throw new BadRequestException(error.message);

    const organisations = [...new Set((memberships ?? []).map((item) => item.organisation_id))];
    const sites: { id: string; organisation_id: string; name: string; timezone: string; role: string }[] = [];
    for (const organisationId of organisations) {
      const grants = (memberships ?? []).filter((item) => item.organisation_id === organisationId);
      const siteIds = grants.map((grant) => grant.site_id).filter((id): id is string => Boolean(id));
      let query = supabase.from('sites').select('id, organisation_id, name, timezone').eq('organisation_id', organisationId);
      if (!grants.some((grant) => grant.site_id === null)) query = query.in('id', siteIds);
      const { data, error: siteError } = await query.order('name');
      if (siteError) throw new BadRequestException(siteError.message);
      for (const site of data ?? []) {
        const role = grants.find((grant) => grant.site_id === null || grant.site_id === site.id)?.role ?? 'sales_consultant';
        sites.push({ ...site, role });
      }
    }

    const { data: setupAvailable, error: setupError } = await supabase.rpc('is_initial_setup_available');
    if (setupError) throw new BadRequestException(setupError.message);
    return { user: { id: user.id, email: user.email }, sites, needsInitialSetup: Boolean(setupAvailable) && sites.length === 0 };
  }

  @Post('setup')
  async setup(@Req() request: AuthenticatedRequest, @Body() body: { organisationName?: string; siteName?: string; timezone?: string; setupKey?: string }) {
    if (!request.user || !request.accessToken) throw new UnauthorizedException();
    const organisationName = body.organisationName?.trim();
    const siteName = body.siteName?.trim();
    if (!organisationName || !siteName) throw new BadRequestException('Enter an organisation name and a site name');
    const expectedKey = process.env.INITIAL_SETUP_KEY;
    const suppliedKey = body.setupKey ?? '';
    if (!expectedKey) throw new BadRequestException('Initial workspace setup is not enabled on the backend');
    const expected = Buffer.from(expectedKey);
    const supplied = Buffer.from(suppliedKey);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new UnauthorizedException('Setup key is incorrect');

    const supabase = createAdminSupabaseClient();
    const { data, error } = await supabase.rpc('bootstrap_first_organisation', {
      p_name: organisationName,
      p_site_name: siteName,
      p_timezone: body.timezone?.trim() || 'Australia/Sydney',
      p_user_id: request.user.id,
    });
    if (error) throw new BadRequestException(error.message);
    return { setup: data?.[0] ?? null };
  }
}
