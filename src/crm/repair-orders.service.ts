import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { workflowInput, workflowChanges } from './service-workflow.js';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { AccessService, grantsForBrand } from '../auth/access.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { permissionsFor } from '../auth/permissions.js';
import { text, uuid } from '../auth/validation.js';
import { AuditService } from '../database/audit.service.js';
import { MongoService } from '../database/mongo.service.js';
import {
  publicRecord,
  type RepairOrder,
  type RepairOrderCommand,
} from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import {
  allowedRepairOrderTransitions,
  repairOrderPromise,
  validateRepairOrderTransition,
} from './repair-order-lifecycle.js';
import {
  simulateRepairOrder,
  simulatedRepairOrderStatuses,
} from '../integration/repair-order.adapter.js';

@Injectable()
export class RepairOrdersService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<unknown>;
  private readonly logger = new Logger(RepairOrdersService.name);
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(MongoService) readonly mongo: MongoService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntegrationService) readonly integration: IntegrationService,
  ) {}
  onApplicationBootstrap() {
    if (!this.integration.config.workerEnabled) return;
    this.timer = setInterval(() => {
      if (this.active || this.integration.config.mode !== 'simulated') return;
      this.active = this.processOne()
        .catch(() =>
          this.logger.warn(
            'Repair-order command remains pending after processing failure',
          ),
        )
        .finally(() => {
          this.active = undefined;
        });
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  capabilities() {
    return {
      mode: this.integration.config.mode,
      simulated: this.integration.config.mode === 'simulated',
      writesEnabled:
        this.integration.config.mode === 'simulated' &&
        this.integration.config.writesEnabled,
      blocker:
        this.integration.config.mode === 'simulated'
          ? null
          : 'Authorised RO reads, write capabilities and dealer status mappings are not configured',
      vehicleLink: 'simulated_customer_vehicle_or_appointment_description',
      financials: 'read_only_unavailable',
    };
  }
  async scope(
    request: AuthenticatedRequest,
    siteId: string,
    permission = 'service.read',
    session?: ClientSession,
  ) {
    const site = await this.access.requireSite(
      request,
      siteId,
      permission,
      session,
    );
    await this.access.requireSite(request, siteId, 'customers.read', session);
    const grants = await this.access.memberships(request, session);
    const brands = (site.brand_ids ?? []).filter((id) =>
      permissionsFor(grantsForBrand(grants, site, id)).includes(permission),
    );
    const team = await this.access.hasSitePermission(
      request,
      siteId,
      'service.view_team',
      session,
    );
    return {
      organisation_id: site.organisation_id,
      site_id: siteId,
      ...this.integration.projectionFilter(),
      brand_id: { $in: brands },
      ...(team ? {} : { assigned_to: request.user!.id }),
    };
  }
  publicCommand(row: RepairOrderCommand) {
    const {
      id,
      repair_order_id,
      appointment_id,
      kind,
      mode,
      status,
      attempts,
      available_at,
      created_at,
      updated_at,
      error,
    } = row;
    return {
      id,
      repair_order_id,
      appointment_id,
      kind,
      mode,
      status,
      attempts,
      available_at,
      created_at,
      updated_at,
      error,
    };
  }
  publicOrder(row: RepairOrder) {
    return {
      ...publicRecord(row),
      allowedTransitions: allowedRepairOrderTransitions(row.status),
    };
  }
  async retry(
    request: AuthenticatedRequest,
    id: string,
    body: Record<string, unknown>,
  ) {
    const siteId = uuid(body.siteId, 'siteId');
    if (
      Object.keys(body).some(
        (field) => !['siteId', 'note', 'confirmedNotApplied'].includes(field),
      )
    )
      throw new BadRequestException('Unsupported retry field');
    const note = text(body.note, 'note', 5, 2000);
    if (body.confirmedNotApplied !== true)
      throw new BadRequestException(
        'Confirm that this simulated command was not applied before retrying',
      );
    if (!this.capabilities().writesEnabled)
      throw new ServiceUnavailableException(
        'Repair-order simulator is unavailable',
      );
    return this.mongo.transaction(async (session) => {
      const site = await this.access.requireSite(
        request,
        siteId,
        'users.manage',
        session,
      );
      await this.mongo.organisations.updateOne(
        { id: site.organisation_id },
        { $inc: { access_revision: 1 } },
        { session },
      );
      const command = await this.mongo.repairOrderCommands.findOne(
        {
          ...(await this.scope(request, siteId, 'service.write', session)),
          id,
        },
        { session },
      );
      if (!command)
        throw new NotFoundException('Repair order command is unavailable');
      if (!['failed', 'rejected', 'needs_review'].includes(command.status))
        throw new ConflictException(
          'Only resolved unsuccessful commands may be retried',
        );
      if (
        await this.mongo.repairOrderCommands.findOne(
          {
            appointment_id: command.appointment_id,
            id: { $ne: id },
            status: { $in: ['queued', 'retry_wait', 'needs_review'] },
          },
          { session },
        )
      )
        throw new ConflictException('Resolve the other pending command first');
      await this.mongo.repairOrderCommands.updateOne(
        { id },
        {
          $set: {
            status: 'queued',
            attempts: 0,
            available_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          $unset: { error: '' },
        },
        { session },
      );
      await this.audit.record(
        session,
        request.user!.id,
        site.organisation_id,
        siteId,
        'service.repair_order_command_retried',
        'repair_order_command',
        id,
        {
          note,
          previous_status: command.status,
          previous_attempts: command.attempts,
          confirmed_not_applied: true,
        },
      );
      return {
        command: this.publicCommand({
          ...command,
          status: 'queued',
          attempts: 0,
          error: undefined,
        }),
      };
    });
  }
  async order(
    request: AuthenticatedRequest,
    siteId: string,
    id: string,
    permission = 'service.read',
    session?: ClientSession,
  ) {
    const row = await this.mongo.repairOrders.findOne(
      { ...(await this.scope(request, siteId, permission, session)), id },
      { session },
    );
    if (!row) throw new NotFoundException('Repair order is unavailable');
    return row;
  }
  async enqueue(
    request: AuthenticatedRequest,
    id: string | null,
    kind: RepairOrderCommand['kind'],
    body: Record<string, unknown>,
    key: unknown,
  ) {
    const allowed =
      kind === 'repair_order.simulate'
        ? ['siteId', 'appointmentId', 'promisedAt', 'customerVehicleId']
        : [
            'siteId',
            'version',
            'note',
            ...(kind === 'repair_order.transition' ? ['status'] : []),
          ];
    if (
      kind !== 'repair_order.workflow' &&
      Object.keys(body).some((field) => !allowed.includes(field))
    )
      throw new BadRequestException(
        'Unsupported repair order field; operations and financials are read-only',
      );
    const siteId = uuid(body.siteId, 'siteId');
    const createKey = text(key, 'Idempotency-Key', 8, 200);
    const appointmentId = id ? null : uuid(body.appointmentId, 'appointmentId');
    const payload: RepairOrderCommand['payload'] =
      kind === 'repair_order.workflow'
        ? workflowInput(
            String(body.action),
            Object.fromEntries(
              Object.entries(body).filter(([k]) => k !== 'action'),
            ),
          )
        : id
          ? {
              version: Number(body.version),
              note: text(body.note, 'note', 3, 2000),
              ...(kind === 'repair_order.transition'
                ? { status: body.status as RepairOrder['status'] }
                : {}),
            }
          : {
              promised_at: repairOrderPromise(body.promisedAt),
              ...(body.customerVehicleId
                ? {
                    vehicle_id: uuid(
                      body.customerVehicleId,
                      'customerVehicleId',
                    ),
                  }
                : {}),
            };
    if (id && (!Number.isInteger(body.version) || Number(body.version) < 0))
      throw new BadRequestException('Provide the current repair order version');
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          siteId,
          id,
          appointmentId,
          kind,
          payload,
          mode: this.integration.config.mode,
        }),
      )
      .digest('hex');
    return this.mongo.transaction(async (session) => {
      const site = await this.access.requireSite(
        request,
        siteId,
        'service.write',
        session,
      );
      // Serialize submission, source acknowledgement and access changes within the organisation.
      await this.mongo.organisations.updateOne(
        { id: site.organisation_id },
        { $inc: { access_revision: 1 } },
        { session },
      );
      const scope = await this.scope(request, siteId, 'service.write', session);
      const row = id
        ? await this.order(request, siteId, id, 'service.write', session)
        : null;
      const appointment = await this.mongo.serviceAppointments.findOne(
        {
          ...scope,
          ...(row ? { assigned_to: { $exists: true } } : {}),
          id: row?.appointment_id ?? appointmentId!,
        },
        { session },
      );
      if (!appointment)
        throw new NotFoundException('Linked appointment is unavailable');
      await this.access.requireBrand(
        request,
        siteId,
        appointment.brand_id,
        'service.write',
        session,
      );
      const previous = await this.mongo.repairOrderCommands.findOne(
        {
          organisation_id: site.organisation_id,
          actor_user_id: request.user!.id,
          idempotency_key: createKey,
        },
        { session },
      );
      if (previous) {
        if (previous.request_hash !== hash)
          throw new ConflictException(
            'Idempotency key already used for another request',
          );
        return {
          command: this.publicCommand(previous),
          replayed: true,
          integration: this.capabilities(),
        };
      }
      if (!this.capabilities().writesEnabled)
        throw new ServiceUnavailableException(
          this.capabilities().blocker ?? 'Source writes are disabled',
        );
      if (row) {
        if (row.version !== payload.version)
          throw new ConflictException(
            'Repair order changed; refresh before editing',
          );
        if (
          kind === 'repair_order.transition' &&
          ['in_workshop', 'ready'].includes(String(payload.status)) &&
          ['pending', 'declined'].includes(row.authority_request?.status ?? '')
        )
          throw new ConflictException(
            'Resolve outstanding customer authority before progressing',
          );
        if (
          kind === 'repair_order.transition' &&
          payload.status === 'ready' &&
          !row.check_in
        )
          throw new ConflictException('Check in the vehicle before readiness');
        if (
          kind === 'repair_order.transition' &&
          payload.status === 'ready' &&
          ['pending', 'in_progress', 'failed'].includes(
            row.road_test_status ?? '',
          )
        )
          throw new ConflictException('Resolve road test before readiness');
        if (kind === 'repair_order.transition')
          payload.status = validateRepairOrderTransition(
            row.status,
            payload.status,
          );
        if (row.collection)
          throw new ConflictException('Collected repair orders are read-only');
        if (kind === 'repair_order.workflow') {
          workflowChanges(
            row,
            payload.action!,
            payload.data!,
            request.user!.id,
            new Date().toISOString(),
          );
          if (payload.action === 'reassign') {
            await this.access.requireSite(
              request,
              siteId,
              'service.assign_work',
              session,
            );
            await this.access.requireBrand(
              {
                user: { id: String(payload.data!.assignedTo) },
              } as AuthenticatedRequest,
              siteId,
              row.brand_id,
              'service.write',
              session,
            );
          }
        }
        if (row.status === 'invoiced')
          throw new ConflictException('Invoiced repair orders are read-only');
      } else {
        if (['cancelled', 'no_show'].includes(appointment.status))
          throw new ConflictException(
            'Cannot simulate an RO for a cancelled or missed appointment',
          );
        if (
          await this.mongo.repairOrders.findOne(
            {
              site_id: siteId,
              appointment_id: appointment.id,
              integration_mode: 'simulated',
            },
            { session },
          )
        )
          throw new ConflictException(
            'This appointment already has a repair order',
          );
      }
      if (
        await this.mongo.repairOrderCommands.findOne(
          {
            site_id: siteId,
            appointment_id: appointment.id,
            status: { $in: ['queued', 'retry_wait', 'needs_review'] },
          },
          { session },
        )
      )
        throw new ConflictException(
          'Resolve the pending repair order command first',
        );
      if (payload.vehicle_id) {
        const vehicle = await this.mongo.customerVehicles.findOne(
          {
            id: payload.vehicle_id,
            organisation_id: site.organisation_id,
            site_id: siteId,
            customer_id: appointment.customer_id,
            integration_mode: 'simulated',
          },
          { session },
        );
        if (!vehicle || vehicle.ownership === 'previous')
          throw new BadRequestException(
            'Select a currently owned simulated customer vehicle',
          );
        payload.vehicle_external_id =
          vehicle.external_id ?? 'simulated-vehicle-' + vehicle.id;
        payload.vehicle_label = `${vehicle.make} ${vehicle.model} ? ${vehicle.registration}`;
      }
      const commandId = randomUUID();
      const now = new Date().toISOString();
      const command: RepairOrderCommand = {
        _id: commandId,
        id: commandId,
        organisation_id: site.organisation_id,
        site_id: siteId,
        brand_id: appointment.brand_id,
        customer_id: appointment.customer_id,
        assigned_to: row?.assigned_to ?? appointment.assigned_to,
        actor_user_id: request.user!.id,
        repair_order_id: row?.id ?? randomUUID(),
        appointment_id: appointment.id,
        mode: 'simulated',
        kind,
        payload,
        idempotency_key: createKey,
        request_hash: hash,
        status: 'queued',
        attempts: 0,
        available_at: now,
        created_at: now,
        updated_at: now,
      };
      await this.mongo.repairOrderCommands.insertOne(command, { session });
      await this.audit.record(
        session,
        request.user!.id,
        site.organisation_id,
        siteId,
        'service.repair_order_command_queued',
        'repair_order_command',
        commandId,
        { customer_id: command.customer_id, kind },
      );
      return {
        command: this.publicCommand(command),
        replayed: false,
        integration: this.capabilities(),
      };
    });
  }
  // This is an atomic development adapter: simulated source acceptance, projection and
  // receipt commit together. No network or real source mutation is performed here.
  async processOne(id?: string) {
    if (!this.capabilities().writesEnabled)
      throw new ServiceUnavailableException(
        'Repair-order simulator is unavailable',
      );
    return this.mongo.transaction(async (session) => {
      const command = await this.mongo.repairOrderCommands.findOne(
        {
          mode: 'simulated',
          ...(id ? { id } : {}),
          status: { $in: ['queued', 'retry_wait'] },
          available_at: { $lte: new Date().toISOString() },
        },
        { session, sort: { created_at: 1, id: 1 } },
      );
      if (!command) return null;
      await this.mongo.organisations.updateOne(
        { id: command.organisation_id },
        { $inc: { access_revision: 1 } },
        { session },
      );
      const now = new Date().toISOString();
      const finish = async (
        status: RepairOrderCommand['status'],
        error?: string,
      ) => {
        const attempts = command.attempts + 1;
        const updated = {
          ...command,
          status,
          error,
          attempts,
          updated_at: now,
          available_at:
            status === 'retry_wait'
              ? new Date(Date.now() + attempts * 1000).toISOString()
              : now,
        };
        await this.mongo.repairOrderCommands.updateOne(
          { id: command.id },
          {
            $set: {
              status,
              error,
              attempts,
              updated_at: now,
              available_at: updated.available_at,
            },
          },
          { session },
        );
        await this.audit.record(
          session,
          command.actor_user_id,
          command.organisation_id,
          command.site_id,
          'service.repair_order_command_' + status,
          'repair_order_command',
          command.id,
          {
            customer_id: command.customer_id,
            kind: command.kind,
            request: command.payload,
            response: { status, error },
            attempt: attempts,
            mode: 'simulated',
          },
        );
        return { command: this.publicCommand(updated) };
      };
      const actor = {
        user: { id: command.actor_user_id },
      } as AuthenticatedRequest;
      try {
        await this.access.requireBrand(
          actor,
          command.site_id,
          command.brand_id,
          'service.write',
          session,
        );
      } catch (error) {
        if (error instanceof ForbiddenException)
          return finish(
            'rejected',
            'Current actor access no longer permits this command',
          );
        throw error;
      }
      let scope: Awaited<ReturnType<RepairOrdersService['scope']>>;
      try {
        scope = await this.scope(
          actor,
          command.site_id,
          'service.write',
          session,
        );
      } catch (error) {
        if (error instanceof ForbiddenException)
          return finish(
            'rejected',
            'Current actor access no longer permits this command',
          );
        throw error;
      }
      const appointment = await this.mongo.serviceAppointments.findOne(
        {
          ...scope,
          ...(command.kind !== 'repair_order.simulate'
            ? { assigned_to: { $exists: true } }
            : {}),
          id: command.appointment_id,
        },
        { session },
      );
      const customer = await this.mongo.customers.findOne(
        {
          ...this.integration.projectionFilter(),
          organisation_id: command.organisation_id,
          site_id: command.site_id,
          id: command.customer_id,
        },
        { session },
      );
      if (
        !appointment ||
        !customer ||
        appointment.customer_id !== command.customer_id ||
        appointment.brand_id !== command.brand_id
      )
        return finish(
          'rejected',
          'Appointment or customer link changed or is unavailable',
        );
      const behavior = await this.mongo.simulatorBehaviors.findOneAndUpdate(
        {
          organisation_id: command.organisation_id,
          site_id: command.site_id,
          remaining: { $gt: 0 },
        },
        { $inc: { remaining: -1 } },
        { session, returnDocument: 'before' },
      );
      if (behavior?.behavior === 'reject')
        return finish('rejected', 'Simulated source rejected the command');
      if (behavior?.behavior === 'unknown')
        return finish(
          'needs_review',
          'Simulated uncertain outcome; administrator review required',
        );
      if (behavior?.behavior === 'outage')
        return finish(
          command.attempts >= 2 ? 'failed' : 'retry_wait',
          'Simulated source unavailable',
        );
      if (command.kind === 'repair_order.simulate') {
        if (['cancelled', 'no_show'].includes(appointment.status))
          return finish('rejected', 'Appointment is cancelled or missed');
        if (
          await this.mongo.repairOrders.findOne(
            {
              site_id: command.site_id,
              appointment_id: appointment.id,
              integration_mode: 'simulated',
            },
            { session },
          )
        )
          return finish('rejected', 'Appointment already has a repair order');
        if (command.payload.vehicle_id) {
          const vehicle = await this.mongo.customerVehicles.findOne(
            {
              id: command.payload.vehicle_id,
              customer_id: command.customer_id,
              site_id: command.site_id,
              organisation_id: command.organisation_id,
              integration_mode: 'simulated',
            },
            { session },
          );
          if (!vehicle || vehicle.ownership === 'previous')
            return finish(
              'rejected',
              'Customer vehicle is no longer available',
            );
        }
        const row = simulateRepairOrder(command, appointment, now);
        await this.mongo.repairOrders.insertOne(row, { session });
      } else {
        const row = await this.mongo.repairOrders.findOne(
          { ...scope, id: command.repair_order_id },
          { session },
        );
        if (
          !row ||
          row.version !== command.payload.version ||
          row.status === 'invoiced'
        )
          return finish(
            'rejected',
            'Repair order changed; refresh and submit a new command',
          );
        let changes: Partial<RepairOrder> = { updated_at: now };
        if (row.collection)
          return finish('rejected', 'Repair order is already collected');
        if (command.kind === 'repair_order.workflow') {
          try {
            changes = workflowChanges(
              row,
              command.payload.action!,
              command.payload.data!,
              command.actor_user_id,
              now,
            );
            if (command.payload.action === 'reassign') {
              await this.access.requireSite(
                actor,
                command.site_id,
                'service.assign_work',
                session,
              );
              await this.access.requireBrand(
                { user: { id: changes.assigned_to! } } as AuthenticatedRequest,
                command.site_id,
                row.brand_id,
                'service.write',
                session,
              );
            }
          } catch (error) {
            if (
              error instanceof ConflictException ||
              error instanceof ForbiddenException
            )
              return finish('rejected', error.message);
            throw error;
          }
          if (command.payload.action === 'check-in') {
            if (
              Date.parse(appointment.starts_at) > Date.now() ||
              ['cancelled', 'no_show'].includes(appointment.status)
            )
              return finish(
                'rejected',
                'Appointment has not started or is closed',
              );
            const loanId = command.payload.data!.loanCarId;
            if (loanId) {
              const car = await this.mongo.loanCars.findOneAndUpdate(
                {
                  id: String(loanId),
                  site_id: row.site_id,
                  organisation_id: row.organisation_id,
                  brand_id: row.brand_id,
                  integration_mode: 'simulated',
                  status: 'available',
                },
                {
                  $set: {
                    status: 'allocated',
                    allocated_repair_order_id: row.id,
                    allocated_customer_id: row.customer_id,
                    updated_at: now,
                  },
                },
                { session, returnDocument: 'after' },
              );
              if (!car)
                return finish(
                  'rejected',
                  'Loan car is unavailable for this brand',
                );
              changes.check_in!.loan_car_rego = car.registration;
            }
            await this.mongo.serviceAppointments.updateOne(
              { id: appointment.id, version: appointment.version },
              {
                $set: { status: 'attended', updated_at: now },
                $inc: { version: 1 },
              },
              { session },
            );
          }
          if (command.payload.action === 'collect' && row.check_in?.loan_car_id)
            await this.mongo.loanCars.updateOne(
              {
                id: row.check_in.loan_car_id,
                organisation_id: row.organisation_id,
                site_id: row.site_id,
                allocated_repair_order_id: row.id,
              },
              {
                $set: {
                  status: 'available',
                  allocated_repair_order_id: null,
                  allocated_customer_id: null,
                  updated_at: now,
                },
              },
              { session },
            );
          if (changes.status)
            changes.source_status =
              simulatedRepairOrderStatuses[changes.status];
        }
        if (command.kind === 'repair_order.transition') {
          if (
            ['in_workshop', 'ready'].includes(String(command.payload.status)) &&
            ['pending', 'declined'].includes(
              row.authority_request?.status ?? '',
            )
          )
            return finish('rejected', 'Customer authority is outstanding');
          if (command.payload.status === 'ready' && !row.check_in)
            return finish('rejected', 'Vehicle is not checked in');
          if (
            command.payload.status === 'ready' &&
            ['pending', 'in_progress', 'failed'].includes(
              row.road_test_status ?? '',
            )
          )
            return finish('rejected', 'Road test is unresolved');
          try {
            changes.status = validateRepairOrderTransition(
              row.status,
              command.payload.status,
            );
          } catch {
            return finish(
              'rejected',
              'Source transition is no longer permitted',
            );
          }
          changes.source_status = simulatedRepairOrderStatuses[changes.status];
          changes.ready_at = changes.status === 'ready' ? now : null;
        }
        const result = await this.mongo.repairOrders.updateOne(
          { id: row.id, version: row.version },
          {
            $set: changes,
            $inc: { version: 1 },
            $push:
              command.kind === 'repair_order.authority_note'
                ? {
                    authority_notes: {
                      text: command.payload.note!,
                      recorded_by: command.actor_user_id,
                      recorded_at: now,
                    },
                  }
                : {
                    status_history: {
                      from: row.status,
                      to: changes.status ?? row.status,
                      note:
                        command.payload.note ??
                        String(
                          command.payload.data?.responseNote ??
                            command.payload.data?.description ??
                            command.payload.data?.notes ??
                            command.payload.action ??
                            '',
                        ),
                      recorded_by: command.actor_user_id,
                      recorded_at: now,
                    },
                  },
          },
          { session },
        );
        if (!result.modifiedCount)
          throw new ConflictException('Repair order changed during acceptance');
      }
      await this.audit.record(
        session,
        command.actor_user_id,
        command.organisation_id,
        command.site_id,
        command.kind === 'repair_order.simulate'
          ? 'service.repair_order_imported'
          : command.kind === 'repair_order.transition'
            ? 'service.repair_order_' + command.payload.status
            : command.kind === 'repair_order.workflow'
              ? 'service.repair_order_' +
                command.payload.action!.replaceAll('-', '_')
              : 'service.repair_order_authority_noted',
        'repair_order',
        command.repair_order_id,
        {
          customer_id: command.customer_id,
          command_id: command.id,
          mode: 'simulated',
        },
      );
      return finish('succeeded');
    });
  }
}
