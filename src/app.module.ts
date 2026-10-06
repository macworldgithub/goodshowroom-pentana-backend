import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CrmModule } from './crm/crm.module.js';
import { ContextModule } from './context/context.module.js';

@Module({
  imports: [AuthModule, CrmModule, ContextModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
