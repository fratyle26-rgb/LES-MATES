const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function seed() {
  try {
    console.log('Seeding finance data...');

    // Get default organization
    const orgResult = await pool.query('SELECT id FROM organizations WHERE slug = $1', ['default-org']);
    if (orgResult.rows.length === 0) {
      throw new Error('Default organization not found');
    }

    const orgId = orgResult.rows[0].id;

    // Insert Chart of Accounts
    const accounts = [
      { number: '1000', name: 'Cash', type: 'ASSET' },
      { number: '1100', name: 'Accounts Receivable', type: 'ASSET' },
      { number: '2000', name: 'Accounts Payable', type: 'LIABILITY' },
      { number: '3000', name: 'Retained Earnings', type: 'EQUITY' },
      { number: '4000', name: 'Sales Revenue', type: 'REVENUE' },
      { number: '5000', name: 'Cost of Goods Sold', type: 'EXPENSE' },
    ];

    for (const acc of accounts) {
      await pool.query(
        'INSERT INTO accounts (organization_id, account_number, account_name, account_type) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [orgId, acc.number, acc.name, acc.type]
      );
    }

    console.log('Finance seed complete!');
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
}

seed();
