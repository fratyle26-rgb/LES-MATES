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
    console.log('Seeding RBAC data...');

    // Insert permissions
    const permissionsInserted = await pool.query(
      `INSERT INTO permissions (name, description, resource, action) VALUES
       ('view_dashboard', 'Can view dashboard', 'dashboard', 'read'),
       ('create_journal', 'Can create journal entries', 'journal', 'create'),
       ('post_journal', 'Can post journal entries', 'journal', 'post'),
       ('view_ledger', 'Can view general ledger', 'ledger', 'read'),
       ('view_trial_balance', 'Can view trial balance', 'trial_balance', 'read')
       ON CONFLICT (name) DO NOTHING
       RETURNING id`
    );

    console.log('RBAC seed complete!');
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
}

seed();
