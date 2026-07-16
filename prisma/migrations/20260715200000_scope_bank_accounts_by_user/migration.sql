DROP INDEX IF EXISTS "bank_accounts_externalAccountId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "bank_accounts_userId_externalAccountId_key"
ON "bank_accounts"("userId", "externalAccountId");
