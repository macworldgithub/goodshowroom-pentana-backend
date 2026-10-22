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
import { DeliveriesController } from './deliveries.controller.js';
import { DeliveriesService } from './deliveries.service.js';
import { ServiceAppointmentsController } from './service-appointments.controller.js';
import { ServiceDiaryController } from './service-diary.controller.js';
import { ReportsController } from './reports.controller.js';
import { WorkshopService } from './workshop.service.js';
import { RepairOrdersController } from './repair-orders.controller.js';
import { RepairOrdersService } from './repair-orders.service.js';
import { HandoverController } from './handover.controller.js';
import { ManagementController } from './management.controller.js';
import { ServiceOperationsController } from './service-operations.controller.js';
import { ActivityMirrorService } from './activity-mirror.service.js';
import { ActivityMirrorController } from './activity-mirror.controller.js';

@Module({
  imports: [AuthModule, IntegrationModule],
  controllers: [
    ReportsController,
    ActivityMirrorController,
    ServiceOperationsController,
    HandoverController,
    ManagementController,
    RepairOrdersController,
    ServiceDiaryController,
    ServiceAppointmentsController,
    DeliveriesController,
    ReservationsController,
    DealsController,
    AppraisalsController,
    StockController,
    SalesPipelineController,
    SalesLeadsController,
    CustomersController,
    CustomerJournalController,
    CustomerChangesController,
    CustomerMessagesController,
    TasksController,
    MyDayController,
  ],
  providers: [
    ActivityMirrorService,
    RepairOrdersService,
    WorkshopService,
    CustomerMailTransport,
    ReservationsService,
    DeliveriesService,
  ],
})
export class CrmModule {}
