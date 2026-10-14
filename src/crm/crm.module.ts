import { IntegrationModule } from '../integration/integration.module.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomersController } from './customers.controller.js';
import { TasksController } from './tasks.controller.js';
import { MyDayController } from './my-day.controller.js';
import { CustomerJournalController } from './customer-journal.controller.js';
import { CustomerChangesController } from './customer-changes.controller.js';
import { CustomerMessagesController } from './customer-messages.controller.js';
import { CustomerMailTransport } from './customer-mail.transport.js';
import { SalesLeadsController } from './sales-leads.controller.js';
import { SalesPipelineController } from './sales-pipeline.controller.js';
import { StockController } from './stock.controller.js';
import { AppraisalsController } from './appraisals.controller.js';
import { DealsController } from './deals.controller.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';

@Module({ imports: [AuthModule, IntegrationModule], controllers: [ReservationsController, DealsController, AppraisalsController, StockController, SalesPipelineController, SalesLeadsController, CustomersController, CustomerJournalController, CustomerChangesController, CustomerMessagesController, TasksController, MyDayController], providers: [CustomerMailTransport, ReservationsService] })
export class CrmModule {}
