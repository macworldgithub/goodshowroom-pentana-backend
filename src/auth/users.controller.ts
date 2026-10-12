import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { UserProvisioningService, type CreateUserBody } from './user-provisioning.service.js';
import { SupabaseAuthGuard } from './supabase-auth.guard.js';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiJsonBody } from '../api-bodies.js';
import type { AuthenticatedRequest } from './authenticated-request.js';

@Controller()
@ApiTags('Accounts')
export class UsersController {
  constructor(@Inject(UserProvisioningService) private readonly provisioning: UserProvisioningService) {}

  @Post('auth/initial-user')
  @ApiOperation({ summary: 'Create the initial administrator identity', description: 'Initial installation only. Requires the setup key, but no bearer token. Complete login and /api/setup afterward.' })
  @ApiJsonBody('initialUser')
  initial(@Body() body: CreateUserBody) { return this.provisioning.initial(body); }

  @Post('admin/users')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a staff account and memberships', description: 'Requires organisation-wide ADMIN access. Existing email addresses return 409.' })
  @ApiJsonBody('staff')
  @UseGuards(SupabaseAuthGuard)
  create(@Req() request: AuthenticatedRequest, @Body() body: CreateUserBody) { return this.provisioning.staff(request, body); }
}
