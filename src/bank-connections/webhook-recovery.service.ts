import { Injectable, OnModuleInit } from '@nestjs/common';
import { BankConnectionsService } from './bank-connections.service';

@Injectable()
export class WebhookRecoveryService implements OnModuleInit {
  constructor(
    private readonly bankConnectionsService: BankConnectionsService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.VERCEL) return;
    void this.bankConnectionsService
      .processPendingWebhooks()
      .catch(() => undefined);
  }
}
