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

const PORT = process.env.PORT || 3002;

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'rbac-service', timestamp: new Date().toISOString() });
});

// Get User Permissions
app.get('/permissions/:userId/:organizationId', async (req, res) => {
  try {
    const { userId, organizationId } = req.params;

    const result = await pool.query(
      `SELECT DISTINCT p.* FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       JOIN user_roles ur ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1 AND ur.organization_id = $2`,
      [userId, organizationId]
    );

    res.json({ permissions: result.rows });
  } catch (error) {
    console.error('Get permissions error:', error);
    res.status(500).json({ error: 'Failed to get permissions' });
  }
});

// Create Role
app.post('/roles', async (req, res) => {
  try {
    const { organizationId, name, description } = req.body;

    const result = await pool.query(
      'INSERT INTO roles (organization_id, name, description) VALUES ($1, $2, $3) RETURNING *',
      [organizationId, name, description]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({ error: 'Failed to create role' });
  }
});

app.listen(PORT, () => {
  console.log(`RBAC Service running on port ${PORT}`);
});

module.exports = app;
