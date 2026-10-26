import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Good Showroom API')
    .setDescription('Sign in via POST /api/auth/login with your email and password, then paste the returned accessToken into Authorize. Use GET /api/auth/me to find your organisation and site IDs. Initial account creation and setup require the backend INITIAL_SETUP_KEY; staff creation requires an ADMIN token. Examples are editable sample values, not existing accounts. Requests execute against the backend and may create or modify records.')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT access token from POST /api/auth/login (paste without the Bearer prefix).' })
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: '/api/docs-json',
    swaggerOptions: { docExpansion: 'list' },
  });
  return document;
}
