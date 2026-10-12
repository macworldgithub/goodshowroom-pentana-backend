import { Module } from '@nestjs/common';
import { SupabaseAuthGuard } from './supabase-auth.guard.js';
import { AccessService } from './access.service.js';
import { StaffController } from './staff.controller.js';
import { UsersController } from './users.controller.js';
import { UserProvisioningService } from './user-provisioning.service.js';

@Module({ controllers: [StaffController, UsersController], providers: [SupabaseAuthGuard, AccessService, UserProvisioningService], exports: [SupabaseAuthGuard, AccessService] })
export class AuthModule {}
