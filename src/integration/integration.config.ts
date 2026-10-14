import { Injectable, OnModuleInit } from '@nestjs/common';
import type { IntegrationMode } from './contracts.js';

@Injectable()
export class IntegrationConfig implements OnModuleInit {
  mode: IntegrationMode = 'disabled';
  workerEnabled = false;
  writesEnabled = false;
  onModuleInit() {
    const mode = process.env.INTEGRATION_MODE ?? 'disabled';
    if (!['disabled', 'simulated', 'scraping'].includes(mode)) throw new Error('INTEGRATION_MODE must be disabled, simulated, or scraping');
    if (mode === 'simulated' && (process.env.NODE_ENV === 'production' || process.env.ALLOW_SIMULATED_INTEGRATION !== 'true')) {
      throw new Error('Simulation is development-only and requires ALLOW_SIMULATED_INTEGRATION=true');
    }
    this.mode = mode as IntegrationMode;
    this.writesEnabled = mode === 'simulated' || (mode === 'scraping' && process.env.INTEGRATION_WRITES_ENABLED === 'true');
    this.workerEnabled = mode !== 'disabled' && process.env.INTEGRATION_WORKER_ENABLED !== 'false';
  }
  info() {
    return { mode: this.mode, simulated: this.mode === 'simulated', writesEnabled: this.writesEnabled, workerEnabled: this.workerEnabled,
      transport: this.mode === 'scraping' ? 'external_scraping_runner' : this.mode,
      supportedCommands: ['customer.create', 'customer.update', 'customer.privacy_update'], provisionalContract: true };
  }
}
