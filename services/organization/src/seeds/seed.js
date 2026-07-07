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
    console.log('Seeding organization data...');

    // Insert default organization
    const orgResult = await pool.query(
      'INSERT INTO organizations (name, slug, description) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING RETURNING *',
      ['Default Organization', 'default-org', 'Default organization for testing']
    );

    if (orgResult.rows.length > 0) {
      const orgId = orgResult.rows[0].id;

      // Assign admin user to organization
      const userResult = await pool.query('SELECT id FROM users WHERE email = $1', ['admin@example.com']);
      if (userResult.rows.length > 0) {
        const userId = userResult.rows[0].id;
        await pool.query(
          'INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [userId, orgId, 'admin']
        );
      }
    }

    console.log('Organization seed complete!');
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
}

seed();
