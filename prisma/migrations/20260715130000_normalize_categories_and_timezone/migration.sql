-- The application now uses Brasilia time for every account.
UPDATE "Users"
SET "timezone" = 'America/Sao_Paulo'
WHERE "timezone" <> 'America/Sao_Paulo';

-- Every affected account must have the fallback category before data is moved.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "categories" AS removed
    LEFT JOIN "categories" AS fallback
      ON fallback."userId" = removed."userId"
      AND fallback."name" = 'Outros'
      AND fallback."type" = 'EXPENSE'
    WHERE removed."type" = 'EXPENSE'
      AND removed."name" IN ('Educação', 'Lazer', 'Impostos e Taxas')
      AND fallback."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot normalize categories: an affected user does not have the Outros category';
  END IF;
END $$;

UPDATE "categories" AS fallback
SET "isActive" = true
WHERE fallback."type" = 'EXPENSE'
  AND fallback."name" = 'Outros'
  AND EXISTS (
    SELECT 1
    FROM "categories" AS removed
    WHERE removed."userId" = fallback."userId"
      AND removed."type" = 'EXPENSE'
      AND removed."name" IN ('Educação', 'Lazer', 'Impostos e Taxas')
  );

UPDATE "transactions" AS txn
SET "categoryId" = fallback."id"
FROM "categories" AS removed
JOIN "categories" AS fallback
  ON fallback."userId" = removed."userId"
  AND fallback."name" = 'Outros'
  AND fallback."type" = 'EXPENSE'
WHERE txn."categoryId" = removed."id"
  AND removed."type" = 'EXPENSE'
  AND removed."name" IN ('Educação', 'Lazer', 'Impostos e Taxas');

DELETE FROM "category_budgets" AS category_budget
USING "categories" AS removed
WHERE category_budget."categoryId" = removed."id"
  AND removed."type" = 'EXPENSE'
  AND removed."name" IN ('Educação', 'Lazer', 'Impostos e Taxas');

UPDATE "categories"
SET "isActive" = false,
    "monthlyLimit" = NULL
WHERE "type" = 'EXPENSE'
  AND "name" IN ('Educação', 'Lazer', 'Impostos e Taxas');
