import { Module } from '@nestjs/common';
import { ContextController } from './context.controller.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({ imports: [AuthModule], controllers: [ContextController] })
export class ContextModule {}
