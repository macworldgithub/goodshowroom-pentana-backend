import { Test } from '@nestjs/testing';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { SupabaseAuthGuard } from '../src/auth/supabase-auth.guard.js';
import { AccessService } from '../src/auth/access.service.js';
import { ForbiddenException } from '@nestjs/common';
import { MongoService } from '../src/database/mongo.service.js';

describe('Protected API boundaries', () => {
  let app: INestApplication;
  afterEach(async () => { await app?.close(); });

  it('rejects unauthenticated calls before querying Supabase', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MongoService).useValue({}).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    for (const path of ['/api/customers/customer/journal?siteId=site', '/api/auth/me', '/api/customers?siteId=site', '/api/admin/memberships?organisationId=org', '/api/auth/invitations', '/api/admin/sites?organisationId=org', '/api/admin/brands?organisationId=org', '/api/sites/site/brands', '/api/customers/customer?siteId=site', '/api/my-day?siteId=site', '/api/integration/status', '/api/integration/commands/command', '/api/admin/integration/commands?organisationId=org']) {
      await request(app.getHttpServer()).get(path).expect(401);
    }
    await request(app.getHttpServer()).post('/api/customers/customer/notes').send({}).expect(401);
    await request(app.getHttpServer()).post('/api/customers/customer/calls').send({}).expect(401);
    await request(app.getHttpServer()).patch('/api/customers/customer').send({}).expect(401);
    await request(app.getHttpServer()).patch('/api/customers/customer/privacy').send({}).expect(401);
    await request(app.getHttpServer()).patch('/api/tasks/task/cancel').send({}).expect(401);
    await request(app.getHttpServer()).post('/api/customers/customer/messages').send({}).expect(401);
    await request(app.getHttpServer()).post('/api/messages/message/send').send({}).expect(401);
    await request(app.getHttpServer()).post('/api/messages/message/resolve').send({}).expect(401);
    await request(app.getHttpServer()).get('/api/sites/site/staff').expect(401);
    await request(app.getHttpServer()).post('/api/admin/users').send({}).expect(401);
    await request(app.getHttpServer()).post('/api/admin/sites').send({}).expect(401);
    await request(app.getHttpServer()).post('/api/admin/brands').send({}).expect(401);
    await request(app.getHttpServer()).post('/api/admin/integration/customers/import').send({}).expect(401);
  });

  it('rejects a verified SALES user attempting staff administration', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MongoService).useValue({})
      .overrideGuard(SupabaseAuthGuard).useValue({ canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest();
        req.user = { id: 'staff' }; req.accessToken = 'token'; return true;
      } })
      .overrideProvider(AccessService).useValue({ requireAdmin: () => { throw new ForbiddenException(); } })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    await request(app.getHttpServer()).get('/api/admin/memberships?organisationId=00000000-0000-0000-0000-000000000001').expect(403);
  });
});
