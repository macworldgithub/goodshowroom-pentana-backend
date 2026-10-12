import { IntegrationModule } from '../integration/integration.module.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomersController } from './customers.controller.js';
import { TasksController } from './tasks.controller.js';
import { MyDayController } from './my-day.controller.js';

@Module({ imports: [AuthModule, IntegrationModule], controllers: [CustomersController, TasksController, MyDayController] })
export class CrmModule {}
