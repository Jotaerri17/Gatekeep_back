import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { BudgetsService } from './budgets.service';
import { UpdateBudgetDto } from './dto/update-budget.dto';

@Controller('budgets')
export class BudgetsController {
  constructor(private readonly budgetsService: BudgetsService) {}

  @Get(':month')
  get(@CurrentUser() user: AuthenticatedUser, @Param('month') month: string) {
    return this.budgetsService.get(user.id, month);
  }

  @Put(':month')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('month') month: string,
    @Body() dto: UpdateBudgetDto,
  ) {
    return this.budgetsService.update(user.id, month, dto);
  }
}
