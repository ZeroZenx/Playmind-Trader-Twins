import pg from 'pg';
import { processNextAnalysisJob } from '../src/lib/twin-runner.mjs';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the worker');

const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  ssl: databaseUrl.includes('sslmode=require') ? undefined : { rejectUnauthorized: false }
});

try {
  const result = await processNextAnalysisJob(pool);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'failed' ? 1 : 0;
} finally {
  await pool.end();
}
