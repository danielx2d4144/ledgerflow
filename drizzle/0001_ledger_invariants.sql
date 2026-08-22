-- Enforce the core double-entry invariant in the database itself, so no
-- application bug (or manual SQL) can leave an unbalanced transaction behind.
--
-- The constraint is DEFERRABLE INITIALLY DEFERRED: entries are inserted one row
-- at a time, so the balance can only be checked at COMMIT time.

CREATE OR REPLACE FUNCTION ledger_assert_transaction_balanced() RETURNS trigger AS $$
DECLARE
  affected uuid := COALESCE(NEW.transaction_id, OLD.transaction_id);
  total bigint;
  entry_count int;
BEGIN
  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO total, entry_count
  FROM entries WHERE transaction_id = affected;

  -- A fully deleted transaction (cascade) leaves no entries; nothing to assert.
  IF entry_count = 0 THEN
    RETURN NULL;
  END IF;

  IF entry_count < 2 THEN
    RAISE EXCEPTION 'transaction % has % entry, double-entry requires at least 2',
      affected, entry_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF total <> 0 THEN
    RAISE EXCEPTION 'transaction % is unbalanced by % minor units', affected, total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER entries_balanced_check
  AFTER INSERT OR UPDATE OR DELETE ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_transaction_balanced();
--> statement-breakpoint

ALTER TABLE entries ADD CONSTRAINT entries_amount_nonzero CHECK (amount <> 0);
--> statement-breakpoint

ALTER TABLE accounts ADD CONSTRAINT accounts_currency_iso CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint

ALTER TABLE transactions ADD CONSTRAINT transactions_currency_iso CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint

CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
