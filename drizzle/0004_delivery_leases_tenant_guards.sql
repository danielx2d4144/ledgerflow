-- Bounded waits: a later ALTER must never queue behind a long transaction and
-- block writers indefinitely (review L9).
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '5min';--> statement-breakpoint

-- H5: exclusive, time-boxed claim on a delivery row. A worker takes the row by
-- setting `lease_expires_at` in the same UPDATE that increments `attempt`;
-- concurrent workers see zero updated rows and skip. A crashed worker's lease
-- simply expires and the row becomes claimable again.
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_lease_idx" ON "webhook_deliveries" ("status", "lease_expires_at");--> statement-breakpoint

-- M9: tenant isolation for entries enforced by the database, not only by the
-- service layer. `entries.organization_id` is denormalised and tied to both the
-- parent transaction and the referenced account through composite foreign keys,
-- so no future code path can post an entry across tenants.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_id_org_key" UNIQUE ("id", "organization_id");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_id_org_key" UNIQUE ("id", "organization_id");--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN IF NOT EXISTS "organization_id" uuid;--> statement-breakpoint
UPDATE "entries" e
   SET "organization_id" = t."organization_id"
  FROM "transactions" t
 WHERE t."id" = e."transaction_id"
   AND e."organization_id" IS NULL;--> statement-breakpoint
-- Expand/contract: migrations run before the new image takes traffic, so the
-- previous release still inserts entries without `organization_id`. This
-- trigger derives it, which keeps the column NOT NULL safe during the rollout.
CREATE OR REPLACE FUNCTION "entries_fill_organization_id"() RETURNS trigger AS $$
BEGIN
  IF NEW."organization_id" IS NULL THEN
    SELECT t."organization_id" INTO NEW."organization_id"
      FROM "transactions" t WHERE t."id" = NEW."transaction_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "entries_fill_organization_id_trg"
  BEFORE INSERT ON "entries"
  FOR EACH ROW EXECUTE FUNCTION "entries_fill_organization_id"();--> statement-breakpoint
ALTER TABLE "entries" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_transaction_org_fk"
  FOREIGN KEY ("transaction_id", "organization_id")
  REFERENCES "transactions" ("id", "organization_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_account_org_fk"
  FOREIGN KEY ("account_id", "organization_id")
  REFERENCES "accounts" ("id", "organization_id") ON DELETE restrict;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_org_idx" ON "entries" ("organization_id");
