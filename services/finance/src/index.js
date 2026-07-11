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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'finance-service', timestamp: new Date().toISOString() });
});

// Chart of Accounts (org derived from JWT context; URL org id removed)
app.get('/accounts', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM accounts WHERE organization_id = $1 AND is_active = true ORDER BY account_number',
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
    const { account_number, account_name, account_type } = req.body;
    if (!account_number || !account_name || !account_type) {
      return res.status(400).json({ error: 'account_number, account_name, account_type required' });
    }
    const result = await pool.query(
      'INSERT INTO accounts (organization_id, account_number, account_name, account_type) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.organizationId, account_number, account_name, account_type]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create account error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// Create Journal Entry (DRAFT)
app.post('/journals', auth, requirePostingRole, async (req, res) => {
  const { journal_number, entry_date, description, lines } = req.body;

  if (!journal_number || !entry_date || !Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: 'journal_number, entry_date, and >=2 lines required' });
  }

  // Line-shape validation
  for (const [i, line] of lines.entries()) {
    const debit = new Decimal(line.debit || 0);
    const credit = new Decimal(line.credit || 0);
    if (debit.isNegative() || credit.isNegative()) {
      return res.status(400).json({ error: `Line ${i + 1}: negative amounts not allowed` });
    }
    if (debit.isZero() && credit.isZero()) {
      return res.status(400).json({ error: `Line ${i + 1}: debit or credit must be > 0` });
    }
    if (!debit.isZero() && !credit.isZero()) {
      return res.status(400).json({ error: `Line ${i + 1}: line cannot be both debit and credit` });
    }
    if (!Number.isInteger(line.account_id)) {
      return res.status(400).json({ error: `Line ${i + 1}: account_id required` });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Cross-tenant check: every account_id must belong to req.organizationId AND be active
    const accountIds = [...new Set(lines.map(l => l.account_id))];
    const accountsResult = await client.query(
      'SELECT id, organization_id, is_active FROM accounts WHERE id = ANY($1::int[])',
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
    }

    const journalResult = await client.query(
      'INSERT INTO journals (organization_id, journal_number, entry_date, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.organizationId, journal_number, entry_date, description || null, req.user.id]
    );
    const journalId = journalResult.rows[0].id;

    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);

    for (let i = 0; i < lines.length; i++) {
      const { account_id, debit, credit, description: lineDesc } = lines[i];
      const dr = new Decimal(debit || 0);
      const cr = new Decimal(credit || 0);
      await client.query(
        'INSERT INTO journal_lines (journal_id, account_id, debit, credit, description, line_number) VALUES ($1, $2, $3, $4, $5, $6)',
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
      'UPDATE journals SET total_debit = $1, total_credit = $2 WHERE id = $3',
      [totalDebit.toString(), totalCredit.toString(), journalId]
    );

    await client.query('COMMIT');
    res.status(201).json({
      id: journalId,
      status: 'DRAFT',
      total_debit: totalDebit.toString(),
      total_credit: totalCredit.toString(),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create journal error:', error);
    res.status(500).json({ error: 'Failed to create journal' });
  } finally {
    client.release();
  }
});

// Post Journal Entry
app.post('/journals/:id/post', auth, requirePostingRole, async (req, res) => {
  const journalId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(journalId) || journalId <= 0) {
    return res.status(400).json({ error: 'Invalid journal id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Repost guard + tenant scope + row lock, all in one SELECT
    const journalResult = await client.query(
      `SELECT * FROM journals
       WHERE id = $1 AND organization_id = $2 AND status = 'DRAFT'
       FOR UPDATE`,
      [journalId, req.organizationId]
    );
    if (journalResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Journal not found in this organization or not in DRAFT status' });
    }
    const journal = journalResult.rows[0];

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

    // Lock all account rows involved (defense against concurrent posts touching same accounts)
    const accountIds = [...new Set(linesResult.rows.map(l => l.account_id))];
    const accountLock = await client.query(
      `SELECT id, organization_id, is_active FROM accounts
       WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
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
    }

    for (const line of linesResult.rows) {
      await client.query(
        `INSERT INTO ledger_entries
         (organization_id, account_id, journal_id, posting_date, debit, credit, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [journal.organization_id, line.account_id, journalId, journal.entry_date, line.debit, line.credit, line.description]
      );

      const netChange = new Decimal(line.debit || 0).minus(new Decimal(line.credit || 0));
      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND organization_id = $3',
        [netChange.toString(), line.account_id, req.organizationId]
      );
    }

    // Final guard: only flip DRAFT->POSTED (0 rows means someone else beat us; rollback)
    const updateResult = await client.query(
      `UPDATE journals
       SET status = 'POSTED', posted_by = $1, posted_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND organization_id = $3 AND status = 'DRAFT'`,
      [req.user.id, journalId, req.organizationId]
    );
    if (updateResult.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Journal state changed during posting' });
    }

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

// General Ledger — org derived from JWT
app.get('/ledger/:accountId', auth, async (req, res) => {
  try {
    const accountId = Number.parseInt(req.params.accountId, 10);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ error: 'Invalid account id' });
    }
    const result = await pool.query(
      `SELECT * FROM ledger_entries
       WHERE organization_id = $1 AND account_id = $2
       ORDER BY posting_date, id`,
      [req.organizationId, accountId]
    );
    res.json({ entries: result.rows });
  } catch (error) {
    console.error('Get ledger error:', error);
    res.status(500).json({ error: 'Failed to get ledger' });
  }
});

// Trial Balance
app.get('/trial-balance', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT account_number, account_name, account_type, balance FROM accounts
       WHERE organization_id = $1 AND is_active = true
       ORDER BY account_number`,
      [req.organizationId]
    );

    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    const accounts = result.rows.map(acc => {
      const balance = new Decimal(acc.balance);
      if (['ASSET', 'EXPENSE'].includes(acc.account_type)) {
        if (balance.isPositive()) totalDebit = totalDebit.plus(balance);
        else totalCredit = totalCredit.plus(balance.abs());
      } else {
        if (balance.isPositive()) totalCredit = totalCredit.plus(balance);
        else totalDebit = totalDebit.plus(balance.abs());
      }
      return { ...acc, balance: balance.toString() };
    });

    res.json({
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
