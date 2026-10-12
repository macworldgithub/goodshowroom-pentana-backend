import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CrmModule } from './crm/crm.module.js';
import { ContextModule } from './context/context.module.js';
import { DatabaseModule } from './database/database.module.js';
import { IntegrationModule } from './integration/integration.module.js';
import { OrganisationModule } from './organisation/organisation.module.js';

@Module({
  imports: [DatabaseModule, AuthModule, CrmModule, ContextModule, OrganisationModule, IntegrationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
