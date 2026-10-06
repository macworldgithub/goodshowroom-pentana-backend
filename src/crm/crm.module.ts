import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomersController } from './customers.controller.js';
import { TasksController } from './tasks.controller.js';

@Module({ imports: [AuthModule], controllers: [CustomersController, TasksController] })
export class CrmModule {}
