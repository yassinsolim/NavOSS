import { Pool } from 'pg';

import { applyTrafficMigrations } from './migrations.js';

// Explicit entry point for operators: `node dist/traffic/migrate.js` with the PG* environment.
const pool = new Pool({ max: 1 });
try {
  const client = await pool.connect();
  try {
    const applied = await applyTrafficMigrations(client);
    console.log(
      applied.length === 0
        ? 'Community-traffic schema is up to date.'
        : `Applied community-traffic migrations: ${applied.join(', ')}`,
    );
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
