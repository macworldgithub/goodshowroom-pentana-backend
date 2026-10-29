import { Module } from '@nestjs/common';
import { JwtAuthGuard } from './supabase-auth.guard.js';
import { AccessService } from './access.service.js';
import { StaffController } from './staff.controller.js';
import { UsersController } from './users.controller.js';
import { UserProvisioningService } from './user-provisioning.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthService } from './jwt.service.js';
import { AuthMailService } from './auth-mail.service.js';

@Module({
  controllers: [AuthController, StaffController, UsersController],
  providers: [
    JwtAuthService,
    AuthMailService,
    AuthService,
    JwtAuthGuard,
    AccessService,
    UserProvisioningService,
  ],
  exports: [JwtAuthService, AuthMailService, AuthService, JwtAuthGuard, AccessService, UserProvisioningService],
})
export class AuthModule {}
