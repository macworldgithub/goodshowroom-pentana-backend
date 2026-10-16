import { ConflictException, HttpException, Injectable, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { MongoClient, MongoServerError, type ClientSession, type Db } from 'mongodb';
import type { AuditEvent, Brand, Customer, CustomerJournal, CustomerMessage, Invitation, Membership, Organisation, Site, Task } from './models.js';
import type { Attempt, Command, SimulatedRecord, SimulatorBehavior } from '../integration/contracts.js';

@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  private client: MongoClient;
  private database: Db;

  async onModuleInit() {
    const uri = process.env.MONGODB_URI;
    const databaseName = process.env.MONGODB_DATABASE;
    if (!uri || !databaseName) throw new Error('Configure MONGODB_URI and MONGODB_DATABASE before starting the backend');
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await this.client.connect();
    this.database = this.client.db(databaseName);
    const hello = await this.database.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      throw new Error('MongoDB must be a replica set or Atlas cluster to support transactions');
    }
    await this.ensureIndexes();
  }

  get organisations() { return this.database.collection<Organisation>('organisations'); }
  get sites() { return this.database.collection<Site>('sites'); }
  get brands() { return this.database.collection<Brand>('brands'); }
  get memberships() { return this.database.collection<Membership>('memberships'); }
  get invitations() { return this.database.collection<Invitation>('staff_invitations'); }
  get customers() { return this.database.collection<Customer>('customers'); }
  get tasks() { return this.database.collection<Task>('tasks'); }
  get salesLeads() { return this.database.collection<import('./models.js').SalesLead>('sales_leads'); }
  get serviceAppointments() { return this.database.collection<import('./models.js').ServiceAppointment>('service_appointments'); }
  get repairOrders() { return this.database.collection<import('./models.js').RepairOrder>('repair_orders'); }
  get repairOrderCommands() { return this.database.collection<import('./models.js').RepairOrderCommand>('repair_order_commands'); }
  get workshopResources() { return this.database.collection<import('./models.js').WorkshopResource>('workshop_resources'); }
  get stockVehicles() { return this.database.collection<import('./models.js').StockVehicle>('stock_vehicles'); }
  get appraisals() { return this.database.collection<import('./models.js').TradeInAppraisal>('trade_in_appraisals'); }
  get salesDeals() { return this.database.collection<import('./models.js').SalesDeal>('sales_deals'); }
  get reservations() { return this.database.collection<import('./models.js').StockReservation>('stock_reservations'); }
  get deliveries() { return this.database.collection<import('./models.js').DeliveryPlan>('delivery_plans'); }
  get customerJournal() { return this.database.collection<CustomerJournal>('customer_journal'); }
  get customerMessages() { return this.database.collection<CustomerMessage>('customer_messages'); }
  get commands() { return this.database.collection<Command>('integration_commands'); }
  get commandAttempts() { return this.database.collection<Attempt>('integration_attempts'); }
  get simulatedRecords() { return this.database.collection<SimulatedRecord>('simulated_source_records'); }
  get simulatorBehaviors() { return this.database.collection<SimulatorBehavior>('simulator_behaviors'); }
  get auditEvents() { return this.database.collection<AuditEvent>('audit_events'); }
  get customerVehicles() { return this.database.collection<import('./models.js').CustomerVehicle>('customer_vehicles'); }
  get customerRelationships() { return this.database.collection<import('./models.js').CustomerRelationship>('customer_relationships'); }
  get loanCars() { return this.database.collection<import('./models.js').LoanCar>('loan_cars'); }
  get handoverItems() { return this.database.collection<import('./models.js').HandoverItem>('handover_items'); }
  get recoveryResolutions() { return this.database.collection<import('./models.js').RecoveryResolution>('service_recovery_resolutions'); }
  get activityMirrors() { return this.database.collection<import('./models.js').ActivityMirrorCommand>('activity_mirror_commands'); }
  get simulatedActivities() { return this.database.collection<import('./models.js').ActivityMirrorCommand & { external_id:string }>('simulated_source_activities'); }
  get users() { return this.database.collection<{ _id: string; email: string | null; full_name?: string; updated_at: string }>('users'); }
  get systemState() { return this.database.collection<{ _id: string; organisation_id?: string; email?: string; user_id?: string; created_at?: string; revision?: number }>('system_state'); }

  private async ensureIndexes() {
    await this.activityMirrors.createIndex({status:1,available_at:1});
    await this.activityMirrors.createIndex({organisation_id:1,site_id:1,customer_id:1,created_at:-1,id:1});
    await this.recoveryResolutions.createIndex({ organisation_id: 1, site_id: 1, kind: 1, entity_id: 1, fingerprint: 1 }, { unique: true });
    await this.repairOrders.createIndex({ site_id: 1, integration_mode: 1, appointment_id: 1 }, { unique: true, partialFilterExpression: { integration_mode: 'simulated' } });
    await this.repairOrders.createIndex({ site_id: 1, integration_mode: 1, external_id: 1 }, { unique: true });
    await this.repairOrders.createIndex({ site_id: 1, brand_id: 1, assigned_to: 1, status: 1, promised_at: 1, id: 1 });
    await this.repairOrderCommands.createIndex({ organisation_id: 1, actor_user_id: 1, idempotency_key: 1 }, { unique: true });
    await this.repairOrderCommands.createIndex({ mode: 1, appointment_id: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['queued', 'retry_wait'] } } });
    await this.repairOrderCommands.createIndex({ status: 1, available_at: 1 });
    await this.workshopResources.createIndex({ site_id: 1, name: 1 }, { unique: true });
    await this.workshopResources.createIndex({ organisation_id: 1, created_by: 1, create_key: 1 }, { unique: true });
    await this.serviceAppointments.createIndex({ site_id: 1, resource_id: 1, status: 1, starts_at: 1, ends_at: 1 });
    await this.serviceAppointments.createIndex({ organisation_id: 1, created_by: 1, create_key: 1 }, { unique: true });
    await this.serviceAppointments.createIndex({ site_id: 1, brand_id: 1, assigned_to: 1, starts_at: 1, id: 1 });
    await this.deliveries.createIndex({ organisation_id: 1, deal_id: 1 }, { unique: true });
    await this.deliveries.createIndex({ organisation_id: 1, created_by: 1, create_key: 1 }, { unique: true });
    await this.deliveries.createIndex({ site_id: 1, brand_id: 1, status: 1, scheduled_at: 1, id: 1 });
    await this.reservations.createIndex({ organisation_id: 1, stock_id: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
    await this.reservations.createIndex({ organisation_id: 1, created_by: 1, create_key: 1 }, { unique: true });
    await this.reservations.createIndex({ status: 1, expires_at: 1 });
    await this.reservations.createIndex({ site_id: 1, deal_id: 1, created_at: -1, id: 1 });
    await this.salesDeals.createIndex({ organisation_id: 1, created_by: 1, create_key: 1 }, { unique: true });
    await this.salesDeals.createIndex({ site_id: 1, lead_id: 1, brand_id: 1, updated_at: -1, id: 1 });
    await this.appraisals.createIndex({ organisation_id: 1, created_by: 1, create_key: 1 }, { unique: true });
    await this.appraisals.createIndex({ site_id: 1, lead_id: 1, updated_at: -1, id: 1 });
    await this.stockVehicles.createIndex({ organisation_id: 1, created_by: 1, create_key: 1 }, { unique: true });
    await this.stockVehicles.createIndex({ site_id: 1, integration_mode: 1, stock_number: 1 }, { unique: true });
    await this.stockVehicles.createIndex({ site_id: 1, brand_id: 1, status: 1, updated_at: -1, id: 1 });
    await this.salesLeads.createIndex({ organisation_id: 1, created_by: 1, create_key: 1 }, { unique: true });
    await this.salesLeads.createIndex({ site_id: 1, assigned_to: 1, updated_at: -1, id: 1 });
    await this.sites.createIndex({ organisation_id: 1, name: 1 }, { unique: true });
    await this.brands.createIndex({ organisation_id: 1, name: 1 }, { unique: true });
    await this.memberships.createIndex({ organisation_id: 1, site_id: 1, user_id: 1, role: 1 }, { unique: true });
    await this.memberships.createIndex({ user_id: 1, status: 1 });
    await this.invitations.createIndex({ organisation_id: 1, email: 1 }, {
      unique: true, partialFilterExpression: { status: 'pending' },
    });
    await this.invitations.createIndex({ email: 1, status: 1, expires_at: 1 });
    await this.customers.createIndex({ site_id: 1, updated_at: -1 });
    await this.customers.createIndex({ organisation_id: 1, 'external_ids.pentana': 1 }, {
      unique: true, partialFilterExpression: { 'external_ids.pentana': { $type: 'string' } },
    });
    await this.tasks.createIndex({ site_id: 1, assigned_to: 1, due_at: 1 });
    await this.customerMessages.createIndex({ organisation_id: 1, site_id: 1, customer_id: 1, created_at: -1, id: 1 });
    await this.customerMessages.createIndex({ status: 1, send_started_at: 1 });
    await this.customerMessages.createIndex({ organisation_id: 1, created_by: 1, draft_key: 1 }, { unique: true, partialFilterExpression: { draft_key: { $type: 'string' } } });
    await this.customerJournal.createIndex({ organisation_id: 1, created_by: 1, idempotency_key: 1 }, { unique: true });
    await this.customerJournal.createIndex({ organisation_id: 1, site_id: 1, customer_id: 1, occurred_at: -1, id: 1 });
    await this.tasks.createIndex({ organisation_id: 1, site_id: 1, customer_id: 1, assigned_to: 1 });
    await this.commands.createIndex({ organisation_id: 1, actor_user_id: 1, idempotency_key: 1 }, { unique: true });
    await this.commands.createIndex({ mode: 1, status: 1, available_at: 1 });
    await this.commands.createIndex({ organisation_id: 1, site_id: 1, customer_id: 1, mode: 1, created_at: -1, id: 1 });
    await this.commands.createIndex({ mode: 1, customer_id: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['queued', 'processing', 'retry_wait'] } } });
    await this.commands.createIndex({ status: 1, lease_expires_at: 1 });
    await this.commandAttempts.createIndex({ command_id: 1, attempt: 1 }, { unique: true });
    await this.simulatedRecords.createIndex({ command_id: 1 }, { unique: true });
    await this.simulatedRecords.createIndex({ organisation_id: 1, site_id: 1, 'customer.external_id': 1, 'customer.observed_at': -1, created_at: -1 });
    await this.simulatorBehaviors.createIndex({ organisation_id: 1, site_id: 1 }, { unique: true });
    await this.customers.createIndex({ organisation_id: 1, integration_mode: 1, integration_external_id: 1 }, { unique: true,
      partialFilterExpression: { integration_external_id: { $type: 'string' } } });
    await this.auditEvents.createIndex({ organisation_id: 1, created_at: -1 });
    await this.auditEvents.createIndex({ organisation_id: 1, site_id: 1, entity_type: 1, entity_id: 1, created_at: -1, id: 1 });
    await this.customerVehicles.createIndex({ organisation_id: 1, site_id: 1, customer_id: 1, updated_at: -1, id: 1 });
    await this.customerRelationships.createIndex({ organisation_id: 1, site_id: 1, customer_id: 1, related_customer_id: 1 }, { unique: true });
    await this.loanCars.createIndex({ organisation_id: 1, site_id: 1, status: 1, id: 1 });
    await this.handoverItems.createIndex({ organisation_id: 1, site_id: 1, status: 1, scheduled_delivery_at: 1, id: 1 });
    await this.handoverItems.createIndex({ organisation_id: 1, deal_id: 1 }, { unique: true });
  }

  async transaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(() => operation(session), {
        readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof MongoServerError && error.code === 11000) throw new ConflictException('This record already exists');
      throw new ServiceUnavailableException('The database operation could not be completed');
    } finally { await session.endSession(); }
  }

  async onModuleDestroy() { await this.client?.close(); }
}
