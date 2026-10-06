import { BadRequestException, Controller, Get, Post, Body, Query, Req, UseGuards, UnauthorizedException } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { createUserSupabaseClient } from '../auth/user-supabase.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';

@Controller('customers')
@UseGuards(SupabaseAuthGuard)
export class CustomersController {
  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query('siteId') siteId?: string, @Query('search') search?: string) {
    if (!request.user || !request.accessToken) throw new UnauthorizedException();
    if (!siteId) throw new BadRequestException('Choose a site first');
    const supabase = createUserSupabaseClient(request.accessToken);
    let query = supabase.from('customers')
      .select('id, first_name, last_name, email, phone, assigned_to, created_at, updated_at')
      .eq('site_id', siteId).order('updated_at', { ascending: false }).limit(100);
    const term = search?.trim().replace(/[,%()"\\]/g, ' ').replace(/\s+/g, ' ').slice(0, 60);
    if (term) query = query.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`);
    const { data, error } = await query;
    if (error) throw new BadRequestException(error.message);
    return { customers: data ?? [] };
  }

  @Post()
  async create(@Req() request: AuthenticatedRequest, @Body() body: {
    siteId?: string; firstName?: string; lastName?: string; email?: string; phone?: string;
  }) {
    const user = request.user;
    if (!user || !request.accessToken) throw new UnauthorizedException();
    const siteId = body.siteId?.trim();
    const firstName = body.firstName?.trim();
    const lastName = body.lastName?.trim();
    const email = body.email?.trim().toLowerCase() || null;
    const phone = body.phone?.trim() || null;
    if (!siteId || !firstName || !lastName) throw new BadRequestException('Site, first name, and last name are required');
    if (firstName.length > 100 || lastName.length > 100 || (email && email.length > 254) || (phone && phone.length > 40)) {
      throw new BadRequestException('One or more fields are too long');
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Enter a valid email address');
    if (!email && !phone) throw new BadRequestException('Add an email address or phone number');

    const supabase = createUserSupabaseClient(request.accessToken);
    const { data, error } = await supabase.rpc('create_customer', {
      p_site_id: siteId, p_first_name: firstName, p_last_name: lastName, p_email: email ?? '', p_phone: phone ?? '',
    });
    if (error) throw new BadRequestException(error.message);
    const customer = data?.[0];
    if (!customer) throw new BadRequestException('Customer could not be saved');
    return { customer };
  }
}
