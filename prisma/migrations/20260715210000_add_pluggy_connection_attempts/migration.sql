DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "bank_accounts"
    GROUP BY "externalAccountId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot restore global bank account uniqueness while duplicate externalAccountId values exist';
  END IF;
END $$;

DROP INDEX IF EXISTS "bank_accounts_userId_externalAccountId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "bank_accounts_externalAccountId_key"
ON "bank_accounts"("externalAccountId");

CREATE TYPE "PluggyConnectionAttemptStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'EXPIRED'
);

CREATE TABLE "pluggy_connection_attempts" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "bankConnectionId" UUID,
  "expectedItemId" TEXT,
  "resultItemId" TEXT,
  "status" "PluggyConnectionAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "pluggy_connection_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pluggy_connection_attempts_userId_status_expiresAt_idx"
ON "pluggy_connection_attempts"("userId", "status", "expiresAt");

CREATE INDEX "pluggy_connection_attempts_resultItemId_idx"
ON "pluggy_connection_attempts"("resultItemId");

CREATE INDEX "pluggy_connection_attempts_bankConnectionId_idx"
ON "pluggy_connection_attempts"("bankConnectionId");

ALTER TABLE "pluggy_connection_attempts"
ADD CONSTRAINT "pluggy_connection_attempts_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pluggy_connection_attempts"
ADD CONSTRAINT "pluggy_connection_attempts_bankConnectionId_fkey"
FOREIGN KEY ("bankConnectionId") REFERENCES "bank_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
