import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { createUserSupabaseClient } from '../auth/user-supabase.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';

@Controller('tasks')
@UseGuards(SupabaseAuthGuard)
export class TasksController {
  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query('siteId') siteId?: string, @Query('through') through?: string) {
    if (!request.user || !request.accessToken) throw new UnauthorizedException();
    if (!siteId) throw new BadRequestException('Choose a site first');
    const cutoff = through && Number.isFinite(Date.parse(through)) ? new Date(through).toISOString() : new Date().toISOString();
    const supabase = createUserSupabaseClient(request.accessToken);
    const { data, error } = await supabase.from('tasks')
      .select('id, customer_id, title, details, due_at, priority, completed_at, assigned_to, customers(first_name, last_name)')
      .eq('site_id', siteId).lte('due_at', cutoff).order('completed_at', { ascending: true, nullsFirst: true })
      .order('due_at', { ascending: true }).limit(100);
    if (error) throw new BadRequestException(error.message);
    return { tasks: data ?? [] };
  }

  @Post()
  async create(@Req() request: AuthenticatedRequest, @Body() body: {
    siteId?: string; customerId?: string; title?: string; details?: string; dueAt?: string; priority?: string;
  }) {
    const user = request.user;
    if (!user || !request.accessToken) throw new UnauthorizedException();
    const siteId = body.siteId?.trim();
    const customerId = body.customerId?.trim();
    const title = body.title?.trim();
    const dueAt = body.dueAt && Date.parse(body.dueAt);
    const priority = body.priority ?? 'normal';
    if (!siteId || !customerId || !title || !dueAt) throw new BadRequestException('Customer, task title, and due date are required');
    if (title.length > 180) throw new BadRequestException('Task title must be 180 characters or fewer');
    if (!['low', 'normal', 'high'].includes(priority)) throw new BadRequestException('Choose a valid priority');
    const supabase = createUserSupabaseClient(request.accessToken);
    const { data, error } = await supabase.rpc('create_followup', {
      p_site_id: siteId, p_customer_id: customerId, p_title: title,
      p_details: body.details?.trim() || '', p_due_at: new Date(dueAt).toISOString(), p_priority: priority,
    });
    if (error) throw new BadRequestException(error.message);
    const task = data?.[0];
    if (!task) throw new BadRequestException('Follow-up could not be saved');
    return { task };
  }

  @Patch(':id/complete')
  async complete(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('siteId') siteId?: string) {
    if (!request.user || !request.accessToken) throw new UnauthorizedException();
    if (!siteId) throw new BadRequestException('Choose a site first');
    const supabase = createUserSupabaseClient(request.accessToken);
    const { data, error } = await supabase.rpc('complete_followup', { p_task_id: id, p_site_id: siteId });
    if (error) throw new BadRequestException(error.message);
    const task = data?.[0];
    if (!task) throw new BadRequestException('Task was already completed or is not available');
    return { task };
  }
}
