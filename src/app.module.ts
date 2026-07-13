import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { BankConnectionsModule } from './bank-connections/bank-connections.module';
import { BudgetsModule } from './budgets/budgets.module';
import { CategoriesModule } from './categories/categories.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { TransactionsModule } from './transactions/transactions.module';

@Module({
  imports: [
    AuthModule,
    HealthModule,
    UsersModule,
    CategoriesModule,
    BudgetsModule,
    TransactionsModule,
    DashboardModule,
    BankConnectionsModule,
  ],
})
export class AppModule {}
