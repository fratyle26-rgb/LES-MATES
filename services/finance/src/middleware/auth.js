const jwt = require('jsonwebtoken');

const POSTING_ROLES = new Set(['owner', 'admin', 'manager', 'accountant']);

function authenticate(pool) {
  return async function (req, res, next) {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Missing bearer token' });

      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      } catch (e) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      const userId = decoded.userId;
      if (!userId) return res.status(401).json({ error: 'Malformed token' });

      const orgHeader = req.headers['x-organization-id'];
      const orgId = Number.parseInt(orgHeader, 10);
      if (!Number.isInteger(orgId) || orgId <= 0) {
        return res.status(400).json({ error: 'X-Organization-Id header required' });
      }

      const membership = await pool.query(
        'SELECT role FROM user_organizations WHERE user_id = $1 AND organization_id = $2',
        [userId, orgId]
      );
      if (membership.rows.length === 0) {
        return res.status(403).json({ error: 'User is not a member of this organization' });
      }

      req.user = { id: userId, email: decoded.email };
      req.organizationId = orgId;
      req.membershipRole = membership.rows[0].role;
      next();
    } catch (error) {
      console.error('Auth middleware error:', error);
      res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

function requirePostingRole(req, res, next) {
  if (!POSTING_ROLES.has(String(req.membershipRole).toLowerCase())) {
    return res.status(403).json({ error: 'Insufficient role for this action' });
  }
  next();
}

module.exports = { authenticate, requirePostingRole };
