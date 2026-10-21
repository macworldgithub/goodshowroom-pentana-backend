import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AccessService } from '../auth/access.service.js';
import { MongoService } from '../database/mongo.service.js';
import { AuditService } from '../database/audit.service.js';
import type { ActivityMirrorCommand } from '../database/models.js';
import { IntegrationService } from '../integration/integration.service.js';
import { createHash } from 'node:crypto';

@Injectable()
export class ActivityMirrorService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<unknown>;
  private readonly logger = new Logger(ActivityMirrorService.name);
  constructor(
    @Inject(MongoService) readonly mongo: MongoService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntegrationService) readonly integration: IntegrationService,
  ) {}
  onApplicationBootstrap() {
    if (this.integration.config.workerEnabled) {
      this.timer = setInterval(() => {
        if (!this.active && this.integration.config.mode === 'simulated')
          this.active = this.processOne()
            .catch(() => this.logger.warn('Activity mirror remains pending'))
            .finally(() => {
              this.active = undefined;
            });
      }, 1000);
      this.timer.unref();
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  async queue(
    session: ClientSession,
    id: string,
    organisationId: string,
    siteId: string,
    customerId: string,
    actor: string,
    kind: ActivityMirrorCommand['kind'],
    request: Record<string, unknown>,
  ) {
    if (this.integration.config.mode !== 'simulated') return;
    const now = new Date().toISOString();
    await this.mongo.activityMirrors.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          id,
          organisation_id: organisationId,
          site_id: siteId,
          customer_id: customerId,
          actor_user_id: actor,
          integration_mode: 'simulated',
          kind,
          request,
          status: 'queued',
          attempts: 0,
          available_at: now,
          created_at: now,
          updated_at: now,
        },
      },
      { session, upsert: true },
    );
  }
  publicCommand(c: ActivityMirrorCommand) {
    return {
      id: c.id,
      customerId: c.customer_id,
      kind: c.kind,
      status: c.status,
      attempts: c.attempts,
      error: c.error,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      simulated: true,
    };
  }
  async queueOutcome(
    session: ClientSession,
    message: {
      id: string;
      organisation_id: string;
      site_id: string;
      customer_id: string;
      created_by: string;
      status: string;
      channel: string;
    },
    actor = message.created_by,
  ) {
    const h = createHash('sha256')
      .update(message.id + ':' + message.status)
      .digest('hex');
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    return this.queue(
      session,
      id,
      message.organisation_id,
      message.site_id,
      message.customer_id,
      actor,
      'message_outcome',
      {
        message_id: message.id,
        channel: message.channel,
        status: message.status,
      },
    );
  }
  async processOne(id?: string) {
    if (
      this.integration.config.mode !== 'simulated' ||
      !this.integration.config.writesEnabled
    )
      throw new ServiceUnavailableException(
        'Activity mirroring is simulation only',
      );
    return this.mongo.transaction(async (session) => {
      const c = await this.mongo.activityMirrors.findOne(
        {
          ...(id ? { id } : {}),
          integration_mode: 'simulated',
          status: { $in: ['queued', 'retry_wait'] },
          available_at: { $lte: new Date().toISOString() },
        },
        { session, sort: { created_at: 1, id: 1 } },
      );
      if (!c) return null;
      await this.mongo.organisations.updateOne(
        { id: c.organisation_id },
        { $inc: { access_revision: 1 } },
        { session },
      );
      let status: ActivityMirrorCommand['status'] = 'succeeded',
        error: string | undefined;
      try {
        await this.access.requireSite(
          { user: { id: c.actor_user_id } } as AuthenticatedRequest,
          c.site_id,
          c.kind === 'message_outcome' ? 'messages.send' : 'customers.write',
          session,
        );
      } catch (e) {
        if (!(e instanceof ForbiddenException)) throw e;
        status = 'rejected';
        error = 'Current actor access does not permit source mirroring';
      }
      const customer = await this.mongo.customers.findOne(
        {
          id: c.customer_id,
          site_id: c.site_id,
          organisation_id: c.organisation_id,
          integration_mode: 'simulated',
        },
        { session },
      );
      if (!customer) {
        status = 'rejected';
        error = 'Customer is unavailable in the simulator';
      }
      const behavior =
        status === 'succeeded'
          ? await this.mongo.simulatorBehaviors.findOneAndUpdate(
              {
                site_id: c.site_id,
                organisation_id: c.organisation_id,
                remaining: { $gt: 0 },
              },
              { $inc: { remaining: -1 } },
              { session, returnDocument: 'before' },
            )
          : null;
      if (behavior?.behavior === 'reject') {
        status = 'rejected';
        error = 'Simulated source rejected activity';
      }
      if (behavior?.behavior === 'unknown') {
        status = 'needs_review';
        error =
          'Unknown simulated activity outcome; administrator review required';
      }
      if (behavior?.behavior === 'outage') {
        status = c.attempts >= 2 ? 'failed' : 'retry_wait';
        error = 'Simulated source unavailable';
      }
      const now = new Date().toISOString(),
        next = {
          ...c,
          status,
          error,
          attempts: c.attempts + 1,
          updated_at: now,
          available_at:
            status === 'retry_wait'
              ? new Date(Date.now() + (c.attempts + 1) * 1000).toISOString()
              : now,
        };
      await this.mongo.activityMirrors.replaceOne({ _id: c._id }, next, {
        session,
      });
      if (status === 'succeeded')
        await this.mongo.simulatedActivities.updateOne(
          { _id: c.id },
          {
            $setOnInsert: {
              ...next,
              external_id: 'simulated-activity-' + c.id,
            },
          },
          { session, upsert: true },
        );
      await this.audit.record(
        session,
        c.actor_user_id,
        c.organisation_id,
        c.site_id,
        'customer.activity_mirror_' + status,
        'customer',
        c.customer_id,
        { mirror_id: c.id, kind: c.kind, mode: 'simulated', error },
      );
      return { command: this.publicCommand(next) };
    });
  }
  async retry(
    req: AuthenticatedRequest,
    id: string,
    siteId: string,
    note: string,
  ) {
    return this.mongo.transaction(async (session) => {
      const site = await this.access.requireSite(
        req,
        siteId,
        'users.manage',
        session,
      );
      if (this.integration.config.mode !== 'simulated')
        throw new ServiceUnavailableException('Simulation only');
      const c = await this.mongo.activityMirrors.findOne(
        { id, site_id: siteId, organisation_id: site.organisation_id },
        { session },
      );
      if (!c || !['failed', 'rejected', 'needs_review'].includes(c.status))
        throw new ConflictException(
          'Only unresolved unsuccessful mirrors may be retried',
        );
      if (
        await this.mongo.simulatedActivities.findOne({ _id: id }, { session })
      )
        throw new ConflictException('Source receipt already exists');
      await this.mongo.activityMirrors.updateOne(
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
        req.user!.id,
        site.organisation_id,
        siteId,
        'customer.activity_mirror_retried',
        'customer',
        c.customer_id,
        { mirror_id: id, note },
      );
      return {
        command: this.publicCommand({
          ...c,
          status: 'queued',
          attempts: 0,
          error: undefined,
        }),
      };
    });
  }
}
