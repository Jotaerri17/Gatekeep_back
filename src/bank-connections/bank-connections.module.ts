import { Module } from '@nestjs/common';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { BankConnectionsController } from './bank-connections.controller';
import { BankConnectionsService } from './bank-connections.service';
import { WebhookRecoveryService } from './webhook-recovery.service';

@Module({
  imports: [PrismaModule],
  controllers: [BankConnectionsController],
  providers: [BankConnectionsService, WebhookRecoveryService],
  exports: [BankConnectionsService],
})
export class BankConnectionsModule {}
