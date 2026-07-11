-- Fix Pack 1: enforce immutability of POSTED journals at the database layer.
-- Charter: "posted journal becomes immutable". Corrections must use reversal
-- entries, not in-place edits.
--
-- Blocks:
--   * Any UPDATE to journals rows whose status was POSTED (before or after)
--     except the specific DRAFT->POSTED transition.
--   * Any DELETE of POSTED journals.
--   * Any UPDATE or DELETE on journal_lines whose parent journal is POSTED.
--   * Any UPDATE or DELETE on ledger_entries (append-only ledger).
--
-- Safe to re-run.

CREATE OR REPLACE FUNCTION guard_journals_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'Cannot delete a POSTED journal (id=%). Use a reversal entry instead.', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE path
  IF OLD.status = 'POSTED' THEN
    -- Once posted, nothing may change. Ever.
    RAISE EXCEPTION 'Cannot modify a POSTED journal (id=%). Use a reversal entry instead.', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- OLD.status <> 'POSTED': allow the DRAFT->POSTED transition and any DRAFT edits.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journals_immutable ON journals;
CREATE TRIGGER trg_journals_immutable
BEFORE UPDATE OR DELETE ON journals
FOR EACH ROW EXECUTE FUNCTION guard_journals_immutable();


CREATE OR REPLACE FUNCTION guard_journal_lines_immutable()
RETURNS trigger AS $$
DECLARE
  parent_status TEXT;
  target_id INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_id := OLD.journal_id;
  ELSE
    target_id := NEW.journal_id;
  END IF;

  SELECT status INTO parent_status FROM journals WHERE id = target_id;

  IF parent_status = 'POSTED' THEN
    RAISE EXCEPTION 'Cannot modify journal_lines of POSTED journal (id=%).', target_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_lines_immutable ON journal_lines;
CREATE TRIGGER trg_journal_lines_immutable
BEFORE UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION guard_journal_lines_immutable();


CREATE OR REPLACE FUNCTION guard_ledger_entries_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (op=%). Use a reversal entry.', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER trg_ledger_entries_append_only
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION guard_ledger_entries_append_only();
