-- The category list becomes a setting (2026-09-12) and the only source of a
-- category on a cheque or a planned line. Seeded from everything already
-- recorded, unioned with the importer's own set, so nothing recorded becomes
-- invalid. Data only; a row that already exists is left alone.
INSERT INTO "Setting" ("key", "value")
SELECT 'categories', COALESCE(jsonb_agg(c ORDER BY c)::text, '[]')
FROM (
  SELECT DISTINCT upper(trim("category")) AS c FROM "Check"
    WHERE "category" IS NOT NULL AND trim("category") <> ''
  UNION
  SELECT DISTINCT upper(trim("category")) FROM "PlannedOutflow"
    WHERE "category" IS NOT NULL AND trim("category") <> ''
  UNION
  SELECT unnest(ARRAY['LOCAL SUPPLIER','PAYROLL','UTILITIES','TAX','FUND TRANSFER','BROKERS','SALARIES','FTP','TRANSPO,GAS AND OIL'])
) AS s
ON CONFLICT ("key") DO NOTHING;
