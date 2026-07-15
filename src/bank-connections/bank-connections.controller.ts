import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { BankConnectionsService } from './bank-connections.service';
import { CompleteConnectionDto } from './dto/complete-connection.dto';
import { ConnectionAttemptErrorDto } from './dto/connection-attempt-error.dto';
import { ConnectTokenDto } from './dto/connect-token.dto';

@Controller()
export class BankConnectionsController {
  constructor(
    private readonly bankConnectionsService: BankConnectionsService,
  ) {}

  @Get('bank-connections')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.bankConnectionsService.list(user.id);
  }

  @Post('integrations/pluggy/connect-token')
  connectToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConnectTokenDto,
  ) {
    return this.bankConnectionsService.createConnectToken(
      user.id,
      dto.connectionId,
    );
  }

  @Post('integrations/pluggy/connection-attempts/error')
  connectionAttemptError(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConnectionAttemptErrorDto,
  ) {
    return this.bankConnectionsService.reportConnectionAttemptError(
      user.id,
      dto,
    );
  }

  @Post('bank-connections/complete')
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CompleteConnectionDto,
  ) {
    return this.bankConnectionsService.completeConnection(user.id, dto.itemId);
  }

  @Post('bank-connections/:id/sync')
  sync(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.bankConnectionsService.sync(user.id, id);
  }

  @Delete('bank-connections/:id')
  disconnect(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.bankConnectionsService.disconnect(user.id, id);
  }

  @Delete('bank-connections/:id/imported-data')
  deleteImportedData(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.bankConnectionsService.deleteImportedData(user.id, id);
  }

  @Public()
  @Get('internal/webhooks/process-pending')
  processPendingWebhooks(
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.bankConnectionsService.recoverPendingWebhooks(authorization);
  }

  @Public()
  @Post('integrations/pluggy/webhook')
  @HttpCode(202)
  webhook(
    @Headers('x-gatekeep-webhook-secret') secret: string | undefined,
    @Body() payload: unknown,
  ) {
    return this.bankConnectionsService.enqueueWebhook(secret, payload);
  }
}
