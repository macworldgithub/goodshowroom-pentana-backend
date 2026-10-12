import { Global, Module } from '@nestjs/common';
import { MongoService } from './mongo.service.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({ providers: [MongoService, AuditService], exports: [MongoService, AuditService] })
export class DatabaseModule {}
