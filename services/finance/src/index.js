const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const redis = require('redis');
const Decimal = require('decimal.js');

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

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'finance-service', timestamp: new Date().toISOString() });
});

// Chart of Accounts
app.get('/accounts/:organizationId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM accounts WHERE organization_id = $1 AND is_active = true ORDER BY account_number',
      [req.params.organizationId]
    );
    res.json({ accounts: result.rows });
  } catch (error) {
    console.error('Get accounts error:', error);
    res.status(500).json({ error: 'Failed to get accounts' });
  }
});

// Create Account
app.post('/accounts', async (req, res) => {
  try {
    const { organizationId, account_number, account_name, account_type } = req.body;

    const result = await pool.query(
      'INSERT INTO accounts (organization_id, account_number, account_name, account_type) VALUES ($1, $2, $3, $4) RETURNING *',
      [organizationId, account_number, account_name, account_type]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create account error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// Create Journal Entry
app.post('/journals', async (req, res) => {
  try {
    const { organizationId, journal_number, entry_date, description, lines, createdBy } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const journalResult = await client.query(
        'INSERT INTO journals (organization_id, journal_number, entry_date, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [organizationId, journal_number, entry_date, description, createdBy]
      );

      const journalId = journalResult.rows[0].id;
      let totalDebit = new Decimal(0);
      let totalCredit = new Decimal(0);

      for (let i = 0; i < lines.length; i++) {
        const { account_id, debit, credit, description: lineDesc } = lines[i];
        await client.query(
          'INSERT INTO journal_lines (journal_id, account_id, debit, credit, description, line_number) VALUES ($1, $2, $3, $4, $5, $6)',
          [journalId, account_id, debit || 0, credit || 0, lineDesc, i + 1]
        );

        totalDebit = totalDebit.plus(new Decimal(debit || 0));
        totalCredit = totalCredit.plus(new Decimal(credit || 0));
      }

      await client.query(
        'UPDATE journals SET total_debit = $1, total_credit = $2 WHERE id = $3',
        [totalDebit.toString(), totalCredit.toString(), journalId]
      );

      await client.query('COMMIT');
      res.status(201).json({ id: journalId, status: 'DRAFT', total_debit: totalDebit.toString(), total_credit: totalCredit.toString() });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Create journal error:', error);
    res.status(500).json({ error: 'Failed to create journal' });
  }
});

// Post Journal Entry
app.post('/journals/:id/post', async (req, res) => {
  try {
    const { id } = req.params;
    const { postedBy } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get journal
      const journalResult = await client.query('SELECT * FROM journals WHERE id = $1', [id]);
      if (journalResult.rows.length === 0) {
        throw new Error('Journal not found');
      }

      const journal = journalResult.rows[0];

      // Verify debit == credit
      if (new Decimal(journal.total_debit).toString() !== new Decimal(journal.total_credit).toString()) {
        throw new Error('Journal must be balanced (debit = credit)');
      }

      // Get journal lines
      const linesResult = await client.query('SELECT * FROM journal_lines WHERE journal_id = $1', [id]);

      // Post entries to ledger and update account balances
      for (const line of linesResult.rows) {
        await client.query(
          'INSERT INTO ledger_entries (organization_id, account_id, journal_id, posting_date, debit, credit, description) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [journal.organization_id, line.account_id, id, journal.entry_date, line.debit, line.credit, line.description]
        );

        // Update account balance
        const netChange = new Decimal(line.debit || 0).minus(new Decimal(line.credit || 0));
        await client.query(
          'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
          [netChange.toString(), line.account_id]
        );
      }

      // Update journal status
      await client.query(
        'UPDATE journals SET status = $1, posted_by = $2, posted_at = CURRENT_TIMESTAMP WHERE id = $3',
        ['POSTED', postedBy, id]
      );

      await client.query('COMMIT');
      res.json({ message: 'Journal posted successfully', status: 'POSTED' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Post journal error:', error);
    res.status(500).json({ error: error.message || 'Failed to post journal' });
  }
});

// Get General Ledger
app.get('/ledger/:organizationId/:accountId', async (req, res) => {
  try {
    const { organizationId, accountId } = req.params;
    const result = await pool.query(
      'SELECT * FROM ledger_entries WHERE organization_id = $1 AND account_id = $2 ORDER BY posting_date, id',
      [organizationId, accountId]
    );
    res.json({ entries: result.rows });
  } catch (error) {
    console.error('Get ledger error:', error);
    res.status(500).json({ error: 'Failed to get ledger' });
  }
});

// Get Trial Balance
app.get('/trial-balance/:organizationId', async (req, res) => {
  try {
    const { organizationId } = req.params;
    const result = await pool.query(
      `SELECT account_number, account_name, account_type, balance FROM accounts 
       WHERE organization_id = $1 AND is_active = true 
       ORDER BY account_number`,
      [organizationId]
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

    const isBalanced = totalDebit.equals(totalCredit);

    res.json({
      accounts,
      total_debit: totalDebit.toString(),
      total_credit: totalCredit.toString(),
      is_balanced: isBalanced
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
