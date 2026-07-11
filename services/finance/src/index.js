const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const redis = require('redis');
const Decimal = require('decimal.js');

const { authenticate, requirePostingRole } = require('./middleware/auth');

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const redisClient = redis.createClient({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});
redisClient.connect().catch(err => console.error('Redis connection error:', err));

const PORT = process.env.PORT || 3004;
const auth = authenticate(pool);

// -------------------------- helpers ----------------------------------------

async function writeAuditAndOutbox(client, {
  organizationId, actorUserId, eventType, entityType, entityId, payload,
}) {
  await client.query(
    `INSERT INTO audit_events (organization_id, actor_user_id, event_type, entity_type, entity_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [organizationId, actorUserId, eventType, entityType, entityId, JSON.stringify(payload || {})]
  );
  await client.query(
    `INSERT INTO outbox_events (organization_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [organizationId, entityType, entityId, eventType, JSON.stringify(payload || {})]
  );
}

async function findOpenPeriodForDate(client, organizationId, entryDate) {
  const result = await client.query(
    `SELECT * FROM accounting_periods
     WHERE organization_id = $1 AND status = 'OPEN'
       AND $2::date BETWEEN start_date AND end_date
     ORDER BY start_date DESC LIMIT 1`,
    [organizationId, entryDate]
  );
  return result.rows[0] || null;
}

// -------------------------- health -----------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'finance-service', timestamp: new Date().toISOString() });
});

// -------------------------- accounting periods -----------------------------

app.get('/periods', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM accounting_periods
       WHERE organization_id = $1 ORDER BY start_date DESC`,
      [req.organizationId]
    );
    res.json({ periods: result.rows });
  } catch (error) {
    console.error('List periods error:', error);
    res.status(500).json({ error: 'Failed to list periods' });
  }
});

app.post('/periods', auth, requirePostingRole, async (req, res) => {
  try {
    const { name, start_date, end_date } = req.body;
    if (!name || !start_date || !end_date) {
      return res.status(400).json({ error: 'name, start_date, end_date required' });
    }
    const result = await pool.query(
      `INSERT INTO accounting_periods (organization_id, name, start_date, end_date)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.organizationId, name, start_date, end_date]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create period error:', error);
    res.status(500).json({ error: 'Failed to create period' });
  }
});

// -------------------------- chart of accounts ------------------------------

app.get('/accounts', auth, async (req, res) => {
  try {
    // Serve derived balance from ledger view.
    const result = await pool.query(
      `SELECT id AS account_id, account_number, account_name, account_type,
              normal_side, currency_code, is_control_account, balance
       FROM account_balances
       WHERE organization_id = $1
       ORDER BY account_number`,
      [req.organizationId]
    );
    res.json({ accounts: result.rows });
  } catch (error) {
    console.error('Get accounts error:', error);
    res.status(500).json({ error: 'Failed to get accounts' });
  }
});

app.post('/accounts', auth, requirePostingRole, async (req, res) => {
  try {
    const {
      account_number, account_name, account_type,
      normal_side, currency_code, is_control_account,
    } = req.body;
    if (!account_number || !account_name || !account_type) {
      return res.status(400).json({ error: 'account_number, account_name, account_type required' });
    }
    if (normal_side && !['DR', 'CR'].includes(normal_side)) {
      return res.status(400).json({ error: 'normal_side must be DR or CR' });
    }
    const result = await pool.query(
      `INSERT INTO accounts
         (organization_id, account_number, account_name, account_type,
          normal_side, currency_code, is_control_account)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        req.organizationId, account_number, account_name, account_type,
        normal_side || (['ASSET', 'EXPENSE'].includes(account_type) ? 'DR' : 'CR'),
        currency_code || 'TZS',
        !!is_control_account,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create account error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// -------------------------- journals ---------------------------------------

app.post('/journals', auth, requirePostingRole, async (req, res) => {
  const { journal_number, entry_date, description, lines, currency_code } = req.body;

  if (!journal_number || !entry_date || !Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: 'journal_number, entry_date, and >=2 lines required' });
  }
  for (const [i, line] of lines.entries()) {
    const dr = new Decimal(line.debit || 0);
    const cr = new Decimal(line.credit || 0);
    if (dr.isNegative() || cr.isNegative()) {
      return res.status(400).json({ error: `Line ${i + 1}: negative amounts not allowed` });
    }
    if (dr.isZero() && cr.isZero()) {
      return res.status(400).json({ error: `Line ${i + 1}: debit or credit must be > 0` });
    }
    if (!dr.isZero() && !cr.isZero()) {
      return res.status(400).json({ error: `Line ${i + 1}: line cannot be both debit and credit` });
    }
    if (!Number.isInteger(line.account_id)) {
      return res.status(400).json({ error: `Line ${i + 1}: account_id required` });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Accounting-period validation
    const period = await findOpenPeriodForDate(client, req.organizationId, entry_date);
    if (!period) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'No OPEN accounting period contains entry_date for this organization',
      });
    }

    // Cross-tenant + postable-account check
    const accountIds = [...new Set(lines.map(l => l.account_id))];
    const accountsResult = await client.query(
      `SELECT id, organization_id, is_active, is_control_account
       FROM accounts WHERE id = ANY($1::int[])`,
      [accountIds]
    );
    if (accountsResult.rows.length !== accountIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'One or more accounts do not exist' });
    }
    for (const acc of accountsResult.rows) {
      if (acc.organization_id !== req.organizationId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Account does not belong to this organization' });
      }
      if (!acc.is_active) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Account ${acc.id} is inactive` });
      }
      if (acc.is_control_account) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Account ${acc.id} is a control account and cannot receive direct postings`,
        });
      }
    }

    const journalResult = await client.query(
      `INSERT INTO journals
         (organization_id, journal_number, entry_date, description,
          created_by, accounting_period_id, currency_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        req.organizationId, journal_number, entry_date, description || null,
        req.user.id, period.id, currency_code || 'TZS',
      ]
    );
    const journalId = journalResult.rows[0].id;

    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    for (let i = 0; i < lines.length; i++) {
      const { account_id, debit, credit, description: lineDesc } = lines[i];
      const dr = new Decimal(debit || 0);
      const cr = new Decimal(credit || 0);
      await client.query(
        `INSERT INTO journal_lines (journal_id, account_id, debit, credit, description, line_number)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [journalId, account_id, dr.toString(), cr.toString(), lineDesc || null, i + 1]
      );
      totalDebit = totalDebit.plus(dr);
      totalCredit = totalCredit.plus(cr);
    }

    if (!totalDebit.equals(totalCredit)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Journal must be balanced (total debit = total credit)',
        total_debit: totalDebit.toString(),
        total_credit: totalCredit.toString(),
      });
    }

    await client.query(
      'UPDATE journals SET total_debit=$1, total_credit=$2 WHERE id=$3',
      [totalDebit.toString(), totalCredit.toString(), journalId]
    );

    await writeAuditAndOutbox(client, {
      organizationId: req.organizationId,
      actorUserId: req.user.id,
      eventType: 'JournalCreated',
      entityType: 'journal',
      entityId: journalId,
      payload: { journal_number, entry_date, period_id: period.id, total_debit: totalDebit.toString() },
    });

    await client.query('COMMIT');
    res.status(201).json({
      id: journalId,
      status: 'DRAFT',
      total_debit: totalDebit.toString(),
      total_credit: totalCredit.toString(),
      accounting_period_id: period.id,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create journal error:', error);
    res.status(500).json({ error: 'Failed to create journal' });
  } finally {
    client.release();
  }
});

app.post('/journals/:id/post', auth, requirePostingRole, async (req, res) => {
  const journalId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(journalId) || journalId <= 0) {
    return res.status(400).json({ error: 'Invalid journal id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const journalResult = await client.query(
      `SELECT j.*, p.status AS period_status
       FROM journals j
       LEFT JOIN accounting_periods p ON p.id = j.accounting_period_id
       WHERE j.id = $1 AND j.organization_id = $2 AND j.status = 'DRAFT'
       FOR UPDATE OF j`,
      [journalId, req.organizationId]
    );
    if (journalResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Journal not found in this organization or not in DRAFT status' });
    }
    const journal = journalResult.rows[0];

    if (journal.period_status !== 'OPEN') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Accounting period is not OPEN' });
    }

    if (!new Decimal(journal.total_debit).equals(new Decimal(journal.total_credit))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Journal must be balanced (debit = credit)' });
    }

    const linesResult = await client.query(
      'SELECT * FROM journal_lines WHERE journal_id = $1 ORDER BY line_number',
      [journalId]
    );
    if (linesResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Journal has no lines' });
    }

    const accountIds = [...new Set(linesResult.rows.map(l => l.account_id))];
    const accountLock = await client.query(
      `SELECT id, organization_id, is_active, is_control_account
       FROM accounts WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [accountIds]
    );
    for (const acc of accountLock.rows) {
      if (acc.organization_id !== req.organizationId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Journal references cross-tenant account' });
      }
      if (!acc.is_active) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Account ${acc.id} is inactive` });
      }
      if (acc.is_control_account) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Account ${acc.id} is a control account` });
      }
    }

    for (const line of linesResult.rows) {
      await client.query(
        `INSERT INTO ledger_entries
           (organization_id, account_id, journal_id, posting_date, debit, credit, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          journal.organization_id, line.account_id, journalId,
          journal.entry_date, line.debit, line.credit, line.description,
        ]
      );
    }

    const updateResult = await client.query(
      `UPDATE journals
       SET status='POSTED', posted_by=$1, posted_at=CURRENT_TIMESTAMP
       WHERE id=$2 AND organization_id=$3 AND status='DRAFT'`,
      [req.user.id, journalId, req.organizationId]
    );
    if (updateResult.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Journal state changed during posting' });
    }

    await writeAuditAndOutbox(client, {
      organizationId: req.organizationId,
      actorUserId: req.user.id,
      eventType: 'JournalPosted',
      entityType: 'journal',
      entityId: journalId,
      payload: { total_debit: journal.total_debit, total_credit: journal.total_credit },
    });

    await client.query('COMMIT');
    res.json({ message: 'Journal posted successfully', status: 'POSTED', journal_id: journalId });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Post journal error:', error);
    res.status(500).json({ error: error.message || 'Failed to post journal' });
  } finally {
    client.release();
  }
});

// Reversal: creates a new DRAFT journal in the caller's org that mirrors the
// original with debit/credit swapped. Original is untouched (immutable).
app.post('/journals/:id/reverse', auth, requirePostingRole, async (req, res) => {
  const originalId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(originalId) || originalId <= 0) {
    return res.status(400).json({ error: 'Invalid journal id' });
  }
  const { entry_date, description } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orig = await client.query(
      `SELECT * FROM journals WHERE id=$1 AND organization_id=$2 AND status='POSTED'`,
      [originalId, req.organizationId]
    );
    if (orig.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Original POSTED journal not found in this organization' });
    }
    const original = orig.rows[0];

    const revDate = entry_date || new Date().toISOString().slice(0, 10);
    const period = await findOpenPeriodForDate(client, req.organizationId, revDate);
    if (!period) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No OPEN accounting period contains reversal entry_date' });
    }

    const revNumber = `REV-${original.journal_number}-${Date.now()}`;
    const created = await client.query(
      `INSERT INTO journals
         (organization_id, journal_number, entry_date, description,
          created_by, accounting_period_id, currency_code, reversal_of_journal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        req.organizationId, revNumber, revDate,
        description || `Reversal of ${original.journal_number}`,
        req.user.id, period.id, original.currency_code, originalId,
      ]
    );
    const newId = created.rows[0].id;

    const lines = await client.query(
      'SELECT * FROM journal_lines WHERE journal_id=$1 ORDER BY line_number',
      [originalId]
    );

    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    for (const [i, line] of lines.rows.entries()) {
      // Swap DR/CR
      const dr = new Decimal(line.credit || 0);
      const cr = new Decimal(line.debit || 0);
      await client.query(
        `INSERT INTO journal_lines (journal_id, account_id, debit, credit, description, line_number)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [newId, line.account_id, dr.toString(), cr.toString(),
          `Reversal: ${line.description || ''}`.trim(), i + 1]
      );
      totalDebit = totalDebit.plus(dr);
      totalCredit = totalCredit.plus(cr);
    }
    await client.query(
      'UPDATE journals SET total_debit=$1, total_credit=$2 WHERE id=$3',
      [totalDebit.toString(), totalCredit.toString(), newId]
    );

    await writeAuditAndOutbox(client, {
      organizationId: req.organizationId,
      actorUserId: req.user.id,
      eventType: 'JournalReversalDrafted',
      entityType: 'journal',
      entityId: newId,
      payload: { reversal_of_journal_id: originalId, reversal_journal_number: revNumber },
    });

    await client.query('COMMIT');
    res.status(201).json({
      id: newId,
      status: 'DRAFT',
      reversal_of_journal_id: originalId,
      journal_number: revNumber,
      total_debit: totalDebit.toString(),
      total_credit: totalCredit.toString(),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Reversal error:', error);
    res.status(500).json({ error: 'Failed to reverse journal' });
  } finally {
    client.release();
  }
});

// -------------------------- ledger + trial balance -------------------------

app.get('/ledger/:accountId', auth, async (req, res) => {
  try {
    const accountId = Number.parseInt(req.params.accountId, 10);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ error: 'Invalid account id' });
    }

    const acc = await pool.query(
      'SELECT id, normal_side FROM accounts WHERE id=$1 AND organization_id=$2',
      [accountId, req.organizationId]
    );
    if (acc.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found in this organization' });
    }
    const normalSide = acc.rows[0].normal_side;

    const result = await pool.query(
      `SELECT id, journal_id, posting_date, debit, credit, description, created_at
       FROM ledger_entries
       WHERE organization_id=$1 AND account_id=$2
       ORDER BY posting_date, id`,
      [req.organizationId, accountId]
    );

    let running = new Decimal(0);
    const entries = result.rows.map(e => {
      const dr = new Decimal(e.debit || 0);
      const cr = new Decimal(e.credit || 0);
      const delta = normalSide === 'DR' ? dr.minus(cr) : cr.minus(dr);
      running = running.plus(delta);
      return {
        ...e,
        debit: dr.toString(),
        credit: cr.toString(),
        running_balance: running.toString(),
      };
    });

    res.json({ account_id: accountId, normal_side: normalSide, entries });
  } catch (error) {
    console.error('Get ledger error:', error);
    res.status(500).json({ error: 'Failed to get ledger' });
  }
});

app.get('/trial-balance', auth, async (req, res) => {
  try {
    const asOfDate = req.query.as_of_date;
    const params = [req.organizationId];
    let where = 'a.organization_id = $1';
    if (asOfDate) {
      params.push(asOfDate);
      where += ' AND (le.posting_date IS NULL OR le.posting_date <= $2::date)';
    }
    const sql = `
      SELECT a.id, a.account_number, a.account_name, a.account_type,
             a.normal_side, a.currency_code, a.is_control_account,
             COALESCE(SUM(le.debit),0)  AS total_debit,
             COALESCE(SUM(le.credit),0) AS total_credit
      FROM accounts a
      LEFT JOIN ledger_entries le
        ON le.account_id = a.id
       ${asOfDate ? 'AND le.posting_date <= $2::date' : ''}
      WHERE ${where}
      GROUP BY a.id
      ORDER BY a.account_number`;
    const result = await pool.query(sql, params);

    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    const accounts = result.rows.map(r => {
      const dr = new Decimal(r.total_debit);
      const cr = new Decimal(r.total_credit);
      // Net balance placed on its normal side.
      const net = dr.minus(cr);
      let debitCol = new Decimal(0);
      let creditCol = new Decimal(0);
      if (r.normal_side === 'DR') {
        if (net.isPositive()) debitCol = net;
        else creditCol = net.abs();
      } else {
        if (net.isNegative()) creditCol = net.abs();
        else debitCol = net;
      }
      totalDebit = totalDebit.plus(debitCol);
      totalCredit = totalCredit.plus(creditCol);
      return {
        account_id: r.id,
        account_number: r.account_number,
        account_name: r.account_name,
        account_type: r.account_type,
        normal_side: r.normal_side,
        currency_code: r.currency_code,
        debit: debitCol.toString(),
        credit: creditCol.toString(),
      };
    });

    res.json({
      as_of_date: asOfDate || null,
      accounts,
      total_debit: totalDebit.toString(),
      total_credit: totalCredit.toString(),
      is_balanced: totalDebit.equals(totalCredit),
    });
  } catch (error) {
    console.error('Get trial balance error:', error);
    res.status(500).json({ error: 'Failed to get trial balance' });
  }
});

app.listen(PORT, () => {
  console.log(`Finance Service running on port ${PORT}`);
});

module.exports = app;
