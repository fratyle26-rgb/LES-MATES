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

    const orgResult = await pool.query(
      'SELECT id FROM organizations WHERE slug = $1', ['default-org']
    );
    if (orgResult.rows.length === 0) {
      throw new Error('Default organization not found');
    }
    const orgId = orgResult.rows[0].id;

    // Chart of Accounts. Control accounts flagged so they cannot be posted
    // to directly (per charter).
    const accounts = [
      { number: '1000', name: 'Cash',                type: 'ASSET',     normal: 'DR', control: false },
      { number: '1100', name: 'Accounts Receivable', type: 'ASSET',     normal: 'DR', control: true  },
      { number: '2000', name: 'Accounts Payable',    type: 'LIABILITY', normal: 'CR', control: true  },
      { number: '3000', name: 'Owner Capital',       type: 'EQUITY',    normal: 'CR', control: false },
      { number: '3100', name: 'Retained Earnings',   type: 'EQUITY',    normal: 'CR', control: false },
      { number: '4000', name: 'Sales Revenue',       type: 'REVENUE',   normal: 'CR', control: false },
      { number: '5000', name: 'Cost of Goods Sold',  type: 'EXPENSE',   normal: 'DR', control: false },
    ];

    for (const acc of accounts) {
      await pool.query(
        `INSERT INTO accounts
           (organization_id, account_number, account_name, account_type,
            normal_side, currency_code, is_control_account)
         VALUES ($1,$2,$3,$4,$5,'TZS',$6)
         ON CONFLICT (organization_id, account_number) DO UPDATE SET
           account_name = EXCLUDED.account_name,
           account_type = EXCLUDED.account_type,
           normal_side = EXCLUDED.normal_side,
           is_control_account = EXCLUDED.is_control_account`,
        [orgId, acc.number, acc.name, acc.type, acc.normal, acc.control]
      );
    }

    // Default OPEN accounting period covering the current calendar year.
    const year = new Date().getUTCFullYear();
    await pool.query(
      `INSERT INTO accounting_periods (organization_id, name, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, 'OPEN')
       ON CONFLICT (organization_id, name) DO NOTHING`,
      [orgId, `FY${year}`, `${year}-01-01`, `${year}-12-31`]
    );

    console.log('Finance seed complete!');
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
}

seed();
