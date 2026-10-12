import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { IntegrationService } from './integration.service.js';

@Injectable()
export class IntegrationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private readonly logger = new Logger(IntegrationWorker.name);
  constructor(@Inject(IntegrationService) private readonly integration: IntegrationService) {}
  onApplicationBootstrap() {
    if (this.integration.config.workerEnabled) {
      this.timer = setInterval(() => {
        if (this.active || this.stopping) return;
        this.active = this.tick().finally(() => { this.active = undefined; });
      }, 1000);
      this.timer.unref();
    }
  }
  private async tick() {
    try {
      await this.integration.recoverExpired();
      if (this.integration.config.mode === 'simulated') await this.integration.processOne();
    } catch { this.logger.warn('Integration worker could not complete a cycle; inspect queued commands and database availability'); }
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
