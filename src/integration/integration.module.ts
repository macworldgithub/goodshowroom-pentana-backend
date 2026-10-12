import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IntegrationConfig } from './integration.config.js';
import { SimulatedAdapter } from './simulated.adapter.js';
import { IntegrationService } from './integration.service.js';
import { IntegrationController } from './integration.controller.js';
import { IntegrationWorker } from './integration.worker.js';
@Module({ imports: [AuthModule], controllers: [IntegrationController], providers: [IntegrationConfig, SimulatedAdapter, IntegrationService, IntegrationWorker], exports: [IntegrationService, IntegrationConfig] })
export class IntegrationModule {}
