import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { existsSync } from 'node:fs';
import { setupSwagger } from './swagger.js';

if (existsSync('.env')) process.loadEnvFile('.env');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  setupSwagger(app);
  app.enableShutdownHooks();
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    allowedHeaders: ['Content-Type', 'Authorization', 'x-site-id', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  });
  await app.listen(process.env.PORT ?? 4000);
}
await bootstrap();
