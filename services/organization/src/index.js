const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const redis = require('redis');

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

const PORT = process.env.PORT || 3003;

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'organization-service', timestamp: new Date().toISOString() });
});

// Get Organization
app.get('/organizations/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM organizations WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get organization error:', error);
    res.status(500).json({ error: 'Failed to get organization' });
  }
});

// Create Organization
app.post('/organizations', async (req, res) => {
  try {
    const { name, slug, description } = req.body;

    const result = await pool.query(
      'INSERT INTO organizations (name, slug, description) VALUES ($1, $2, $3) RETURNING *',
      [name, slug, description]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create organization error:', error);
    res.status(500).json({ error: 'Failed to create organization' });
  }
});

app.listen(PORT, () => {
  console.log(`Organization Service running on port ${PORT}`);
});

module.exports = app;
