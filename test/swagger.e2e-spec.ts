import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { MongoService } from '../src/database/mongo.service.js';
import { setupSwagger } from '../src/swagger.js';

describe('Swagger explorer', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MongoService).useValue({}).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => { await app?.close(); });

  it('serves the UI and JSON with editable bodies and correct authentication', async () => {
    await request(app.getHttpServer()).get('/api/docs/').expect(200).expect(/swagger-ui/);
    const { body } = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(body.components.securitySchemes.bearer.scheme).toBe('bearer');
    expect(body.paths['/api/auth/me'].get.security).toEqual([{ bearer: [] }]);
    expect(body.paths['/api/auth/initial-user'].post.security ?? []).toEqual([]);
    const staff = body.paths['/api/admin/users'].post;
    expect(staff.security).toEqual([{ bearer: [] }]);
    expect(staff.requestBody.content['application/json'].schema.properties.siteId.format).toBe('uuid');
    expect(staff.requestBody.content['application/json'].schema.properties.password.minLength).toBe(12);
    expect(body.paths['/api/customers'].post.parameters.find((item: { name: string }) => item.name === 'Idempotency-Key').required).toBe(true);
    expect(body.paths['/api/customers'].post.responses['202']).toBeDefined();
    expect(body.paths['/api/admin/integration/commands/{id}/result'].post.requestBody.content['application/json'].schema.required).toContain('leaseToken');
    expect(body.paths['/api/customers/{id}'].get.parameters.find((item: { name: string }) => item.name === 'siteId').required).toBe(true);
    expect(body.paths['/api/customers/{id}'].get.security).toEqual([{ bearer: [] }]);
    expect(body.paths['/api/customers/{id}/notes'].post.parameters.find((item: { name: string }) => item.name === 'Idempotency-Key').required).toBe(true);
    expect(body.paths['/api/customers/{id}/calls'].post.requestBody.content['application/json'].schema.properties.followUp.required).toContain('dueAt');
    expect(body.paths['/api/customers/{id}/privacy'].patch.requestBody.content['application/json'].schema.properties.privacy.required).toContain('do_not_contact');
    expect(body.paths['/api/tasks/{id}'].patch.requestBody.content['application/json'].schema.required).toContain('version');
    expect(body.paths['/api/messages/{id}/send'].post.parameters.find((item: { name: string }) => item.name === 'Idempotency-Key').required).toBe(true);
    const customers = body.paths['/api/customers'].get;
    expect(customers.parameters.find((item: { name: string }) => item.name === 'siteId').required).toBe(true);
    expect(customers.parameters.find((item: { name: string }) => item.name === 'search').required).toBe(false);
    expect(customers.parameters.find((item: { name: string }) => item.name === 'limit').required).toBe(false);
    expect(body.paths['/api/admin/sites'].post.requestBody.content['application/json'].schema.properties.brandIds.type).toBe('array');
    expect(body.paths['/api/admin/brands'].get.security).toEqual([{ bearer: [] }]);
    expect(staff.requestBody.content['application/json'].schema.properties.brandIds.nullable).toBe(true);
    for (const [path, methods] of Object.entries(body.paths)) {
      for (const [method, operation] of Object.entries(methods as Record<string, { requestBody?: unknown }>)) {
        if ((method === 'post' || method === 'patch') && !path.endsWith('/accept') && !path.endsWith('/complete')) {
          expect(operation.requestBody, `${method} ${path} must have an editable body`).toBeDefined();
        }
      }
    }
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
  });
});
