# LES-MATES Platform

Financial management platform with multi-tenant support, RBAC, and integrated finance module.

## Quick Start

```bash
docker-compose up -d
npm run migrate
npm run seed
```

## Architecture

- **Auth Service**: JWT-based authentication
- **RBAC Service**: Role-based access control
- **Organization Service**: Multi-tenant organization management
- **Finance Service**: Chart of Accounts, Journal, Ledger, Trial Balance
- **Frontend**: React with API proxy to backend

## Demo Flow

1. Login → 2. Dashboard → 3. Finance → 4. Chart of Accounts → 5. Create Journal → 6. Post Journal → 7. Ledger → 8. Trial Balance

## Services

| Service | Port | Tech Stack |
|---------|------|------------|
| PostgreSQL | 5432 | Database |
| Redis | 6379 | Cache |
| Auth API | 3001 | Node.js/Express |
| RBAC API | 3002 | Node.js/Express |
| Org API | 3003 | Node.js/Express |
| Finance API | 3004 | Node.js/Express |
| Frontend | 3000 | React/Vite |
