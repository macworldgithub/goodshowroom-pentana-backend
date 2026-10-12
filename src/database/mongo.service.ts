import { ConflictException, HttpException, Injectable, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { MongoClient, MongoServerError, type ClientSession, type Db } from 'mongodb';
import type { AuditEvent, Brand, Customer, Invitation, Membership, Organisation, Site, Task } from './models.js';
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
  get commands() { return this.database.collection<Command>('integration_commands'); }
  get commandAttempts() { return this.database.collection<Attempt>('integration_attempts'); }
  get simulatedRecords() { return this.database.collection<SimulatedRecord>('simulated_source_records'); }
  get simulatorBehaviors() { return this.database.collection<SimulatorBehavior>('simulator_behaviors'); }
  get auditEvents() { return this.database.collection<AuditEvent>('audit_events'); }
  get users() { return this.database.collection<{ _id: string; email: string | null; full_name?: string; updated_at: string }>('users'); }
  get systemState() { return this.database.collection<{ _id: string; organisation_id?: string; email?: string; user_id?: string; created_at?: string; revision?: number }>('system_state'); }

  private async ensureIndexes() {
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
    await this.tasks.createIndex({ organisation_id: 1, site_id: 1, customer_id: 1, assigned_to: 1 });
    await this.commands.createIndex({ organisation_id: 1, actor_user_id: 1, idempotency_key: 1 }, { unique: true });
    await this.commands.createIndex({ mode: 1, status: 1, available_at: 1 });
    await this.commands.createIndex({ status: 1, lease_expires_at: 1 });
    await this.commandAttempts.createIndex({ command_id: 1, attempt: 1 }, { unique: true });
    await this.simulatedRecords.createIndex({ command_id: 1 }, { unique: true });
    await this.simulatorBehaviors.createIndex({ organisation_id: 1, site_id: 1 }, { unique: true });
    await this.customers.createIndex({ organisation_id: 1, integration_mode: 1, integration_external_id: 1 }, { unique: true,
      partialFilterExpression: { integration_external_id: { $type: 'string' } } });
    await this.auditEvents.createIndex({ organisation_id: 1, created_at: -1 });
    await this.auditEvents.createIndex({ organisation_id: 1, site_id: 1, entity_type: 1, entity_id: 1, created_at: -1, id: 1 });
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
