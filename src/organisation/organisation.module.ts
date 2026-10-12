import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SitesController } from './sites.controller.js';
@Module({ imports: [AuthModule], controllers: [SitesController] })
export class OrganisationModule {}
