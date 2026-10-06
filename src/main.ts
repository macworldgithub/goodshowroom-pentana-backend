import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    allowedHeaders: ['Content-Type', 'Authorization', 'x-site-id'],
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  });
  await app.listen(process.env.PORT ?? 4000);
}
await bootstrap();
