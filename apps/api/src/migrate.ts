import { Pool } from 'pg';

import { runMigrations } from './migrations.js';

// Uses the standard PG* environment. Prints migration ids only, never connection details.
const pool = new Pool({ max: 1 });
try {
  const applied = await runMigrations(pool);
  process.stdout.write(
    applied.length === 0
      ? 'Database schema is current.\n'
      : `Applied migrations: ${applied.join(', ')}\n`,
  );
} catch (error: unknown) {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
