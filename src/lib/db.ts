import { Pool, type PoolClient, type QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var playmindPool: Pool | undefined;
}

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;
  return new Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: connectionString.includes("sslmode=require") ? undefined : { rejectUnauthorized: false },
  });
}

export const pool = globalThis.playmindPool ?? createPool();

if (process.env.NODE_ENV !== "production" && pool) globalThis.playmindPool = pool;

export function requireDatabase() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  return requireDatabase().query<T>(text, values);
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await requireDatabase().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
