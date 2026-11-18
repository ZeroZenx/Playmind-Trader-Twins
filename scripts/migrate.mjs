import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baselinePath = join(root, 'db', 'schema.sql');
const migrationsPath = join(root, 'db', 'migrations');

function checksum(text) {
  return createHash('sha256').update(text).digest('hex');
}

function migrationSql(text) {
  return text
    .replace(/^\s*BEGIN;\s*/i, '')
    .replace(/\s*COMMIT;\s*$/i, '');
}

function directDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required for migrations');
  if (value.includes('-pooler.')) throw new Error('Use a direct DATABASE_URL for migrations, not a pooled URL');
  return value;
}

async function readMigrationFiles() {
  const names = (await readdir(migrationsPath)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(join(migrationsPath, name), 'utf8');
    return { version: name, sql, hash: checksum(sql) };
  }));
}

export async function runMigrations({ databaseUrl = directDatabaseUrl(), dryRun = false } = {}) {
  const baseline = await readFile(baselinePath, 'utf8');
  const migrations = await readMigrationFiles();
  const pool = new Pool({ connectionString: databaseUrl, max: 1, ssl: databaseUrl.includes('sslmode=require') ? undefined : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const existing = await client.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
    const checksums = new Map(existing.rows.map((row) => [row.version, row.checksum]));
    const baselineExists = await client.query("SELECT to_regclass('public.workspaces') IS NOT NULL AS exists");

    if (!checksums.has('0000_baseline')) {
      if (dryRun) {
        applied.push('0000_baseline (adopt existing schema or apply db/schema.sql)');
      } else if (baselineExists.rows[0].exists) {
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          ['0000_baseline', checksum(baseline)],
        );
        applied.push('0000_baseline (adopted existing schema)');
      } else {
        await client.query('BEGIN');
        try {
          await client.query(baseline);
          await client.query(
            'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
            ['0000_baseline', checksum(baseline)],
          );
          await client.query('COMMIT');
          applied.push('0000_baseline');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } else if (checksums.get('0000_baseline') !== checksum(baseline)) {
      throw new Error('The tracked baseline checksum does not match db/schema.sql');
    }

    for (const migration of migrations) {
      const current = checksums.get(migration.version);
      if (current) {
        if (current !== migration.hash) throw new Error(`Migration checksum changed: ${migration.version}`);
        continue;
      }
      if (dryRun) {
        applied.push(migration.version);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migrationSql(migration.sql));
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [migration.version, migration.hash],
        );
        await client.query('COMMIT');
        applied.push(migration.version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return { status: 'success', dryRun, applied };
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  runMigrations({ dryRun })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
