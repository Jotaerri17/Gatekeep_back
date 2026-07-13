-- CreateEnum
CREATE TYPE "TransactionSource" AS ENUM ('MANUAL', 'PLUGGY');

-- CreateEnum
CREATE TYPE "ExpenseNature" AS ENUM ('FIXED', 'VARIABLE', 'ONE_OFF');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('POSTED', 'PENDING');

-- CreateEnum
CREATE TYPE "BankConnectionStatus" AS ENUM ('CONNECTING', 'ACTIVE', 'WAITING_USER_INPUT', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- AlterTable
ALTER TABLE "Users"
ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
ADD COLUMN "defaultMonthlyLimit" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "monthly_budgets" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "referenceMonth" DATE NOT NULL,
    "totalLimit" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_budgets" (
    "id" UUID NOT NULL,
    "monthlyBudgetId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "limit" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "category_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_connections" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PLUGGY',
    "externalItemId" TEXT NOT NULL,
    "connectorId" INTEGER,
    "institutionName" TEXT,
    "institutionLogoUrl" TEXT,
    "status" "BankConnectionStatus" NOT NULL DEFAULT 'CONNECTING',
    "lastSyncedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "consentExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "bankConnectionId" UUID NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subtype" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "balance" DECIMAL(14,2),
    "numberLastFour" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "transactions"
ADD COLUMN "bankAccountId" UUID,
ADD COLUMN "source" "TransactionSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN "nature" "ExpenseNature",
ADD COLUMN "status" "TransactionStatus" NOT NULL DEFAULT 'POSTED',
ADD COLUMN "externalId" TEXT,
ADD COLUMN "providerCategoryId" TEXT,
ADD COLUMN "providerCategoryName" TEXT,
ADD COLUMN "excludedFromBudget" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "monthly_budgets_userId_referenceMonth_key" ON "monthly_budgets"("userId", "referenceMonth");
CREATE INDEX "monthly_budgets_userId_referenceMonth_idx" ON "monthly_budgets"("userId", "referenceMonth");
CREATE UNIQUE INDEX "category_budgets_monthlyBudgetId_categoryId_key" ON "category_budgets"("monthlyBudgetId", "categoryId");
CREATE INDEX "category_budgets_categoryId_idx" ON "category_budgets"("categoryId");
CREATE UNIQUE INDEX "bank_connections_externalItemId_key" ON "bank_connections"("externalItemId");
CREATE INDEX "bank_connections_userId_status_idx" ON "bank_connections"("userId", "status");
CREATE UNIQUE INDEX "bank_accounts_externalAccountId_key" ON "bank_accounts"("externalAccountId");
CREATE INDEX "bank_accounts_userId_idx" ON "bank_accounts"("userId");
CREATE INDEX "bank_accounts_bankConnectionId_idx" ON "bank_accounts"("bankConnectionId");
CREATE UNIQUE INDEX "webhook_events_externalId_key" ON "webhook_events"("externalId");
CREATE INDEX "webhook_events_status_createdAt_idx" ON "webhook_events"("status", "createdAt");
CREATE UNIQUE INDEX "transactions_bankAccountId_externalId_key" ON "transactions"("bankAccountId", "externalId");
CREATE INDEX "transactions_bankAccountId_idx" ON "transactions"("bankAccountId");
CREATE INDEX "transactions_userId_status_transactionDate_idx" ON "transactions"("userId", "status", "transactionDate");

-- AddForeignKey
ALTER TABLE "monthly_budgets" ADD CONSTRAINT "monthly_budgets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "category_budgets" ADD CONSTRAINT "category_budgets_monthlyBudgetId_fkey" FOREIGN KEY ("monthlyBudgetId") REFERENCES "monthly_budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "category_budgets" ADD CONSTRAINT "category_budgets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_bankConnectionId_fkey" FOREIGN KEY ("bankConnectionId") REFERENCES "bank_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
