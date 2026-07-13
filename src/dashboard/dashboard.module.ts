import { Module } from '@nestjs/common';
import { BudgetsModule } from '../budgets/budgets.module';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [PrismaModule, BudgetsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
