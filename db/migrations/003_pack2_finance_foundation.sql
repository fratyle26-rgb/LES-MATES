-- Fix Pack 2: Finance Foundation completion
--
-- - Accounting periods (validation surface for journal create + post).
-- - Accounts: control-account flag, normal_side (DR/CR), currency_code.
-- - Journals: reversal_of_journal_id, currency_code.
-- - journal_lines integrity CHECK constraints (defense-in-depth).
-- - account_balances view derived from ledger_entries (source of truth).
-- - audit_events + outbox_events (append-only).
--
-- Safe to re-run.

-- 1. Accounting periods -------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounting_periods (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN', -- OPEN | CLOSED
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, name),
  CONSTRAINT chk_period_status CHECK (status IN ('OPEN','CLOSED')),
  CONSTRAINT chk_period_range CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_periods_org        ON accounting_periods(organization_id);
CREATE INDEX IF NOT EXISTS idx_periods_org_range  ON accounting_periods(organization_id, start_date, end_date);

-- 2. Chart-of-accounts extensions --------------------------------------------

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS is_control_account BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS normal_side        VARCHAR(2) NOT NULL DEFAULT 'DR',
  ADD COLUMN IF NOT EXISTS currency_code      VARCHAR(3) NOT NULL DEFAULT 'TZS';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_accounts_normal_side') THEN
    ALTER TABLE accounts ADD CONSTRAINT chk_accounts_normal_side CHECK (normal_side IN ('DR','CR'));
  END IF;
END $$;

-- Backfill normal_side from account_type when it's still the default.
UPDATE accounts
   SET normal_side = CASE
     WHEN account_type IN ('ASSET','EXPENSE') THEN 'DR'
     WHEN account_type IN ('LIABILITY','EQUITY','REVENUE') THEN 'CR'
     ELSE normal_side
   END
 WHERE normal_side = 'DR' AND account_type IN ('LIABILITY','EQUITY','REVENUE');

-- 3. Journal-level extensions -------------------------------------------------

ALTER TABLE journals
  ADD COLUMN IF NOT EXISTS reversal_of_journal_id INTEGER REFERENCES journals(id),
  ADD COLUMN IF NOT EXISTS currency_code          VARCHAR(3) NOT NULL DEFAULT 'TZS',
  ADD COLUMN IF NOT EXISTS accounting_period_id   INTEGER REFERENCES accounting_periods(id);

CREATE INDEX IF NOT EXISTS idx_journals_period    ON journals(accounting_period_id);
CREATE INDEX IF NOT EXISTS idx_journals_reversal  ON journals(reversal_of_journal_id);

-- Enforce debit=credit for POSTED journals at the DB layer.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_journals_posted_balanced') THEN
    ALTER TABLE journals ADD CONSTRAINT chk_journals_posted_balanced
      CHECK (status <> 'POSTED' OR total_debit = total_credit);
  END IF;
END $$;

-- 4. journal_lines integrity --------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lines_nonneg') THEN
    ALTER TABLE journal_lines ADD CONSTRAINT chk_lines_nonneg CHECK (debit >= 0 AND credit >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lines_dr_xor_cr') THEN
    ALTER TABLE journal_lines ADD CONSTRAINT chk_lines_dr_xor_cr
      CHECK ((debit = 0 AND credit > 0) OR (debit > 0 AND credit = 0));
  END IF;
END $$;

-- 5. Balances derived from ledger --------------------------------------------

CREATE OR REPLACE VIEW account_balances AS
SELECT
  a.id                                                    AS account_id,
  a.organization_id                                       AS organization_id,
  a.account_number                                        AS account_number,
  a.account_name                                          AS account_name,
  a.account_type                                          AS account_type,
  a.normal_side                                           AS normal_side,
  a.currency_code                                         AS currency_code,
  a.is_control_account                                    AS is_control_account,
  COALESCE(SUM(le.debit), 0)                              AS total_debit,
  COALESCE(SUM(le.credit), 0)                             AS total_credit,
  COALESCE(SUM(le.debit), 0) - COALESCE(SUM(le.credit),0) AS net_debit,
  CASE
    WHEN a.normal_side = 'DR'
      THEN COALESCE(SUM(le.debit),0) - COALESCE(SUM(le.credit),0)
    ELSE COALESCE(SUM(le.credit),0) - COALESCE(SUM(le.debit),0)
  END                                                     AS balance
FROM accounts a
LEFT JOIN ledger_entries le ON le.account_id = a.id
GROUP BY a.id;

-- 6. Audit + outbox -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  actor_user_id   INTEGER,
  event_type      VARCHAR(80) NOT NULL,
  entity_type     VARCHAR(40) NOT NULL,
  entity_id       INTEGER NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_org_entity ON audit_events(organization_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created    ON audit_events(created_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  aggregate_type  VARCHAR(40) NOT NULL,
  aggregate_id    INTEGER NOT NULL,
  event_type      VARCHAR(80) NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING | DISPATCHED | FAILED
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  dispatched_at   TIMESTAMP,
  CONSTRAINT chk_outbox_status CHECK (status IN ('PENDING','DISPATCHED','FAILED'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, created_at);

-- audit_events + outbox_events are append-only.
CREATE OR REPLACE FUNCTION guard_audit_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit/outbox tables are append-only (op=%)', TG_OP
    USING ERRCODE = 'check_violation';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_append_only ON audit_events;
CREATE TRIGGER trg_audit_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION guard_audit_append_only();

-- Note: outbox_events must remain updatable so dispatchers can flip
-- PENDING -> DISPATCHED. We block DELETE only.
CREATE OR REPLACE FUNCTION guard_outbox_no_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'outbox_events cannot be deleted'
    USING ERRCODE = 'check_violation';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_outbox_no_delete ON outbox_events;
CREATE TRIGGER trg_outbox_no_delete
BEFORE DELETE ON outbox_events
FOR EACH ROW EXECUTE FUNCTION guard_outbox_no_delete();
