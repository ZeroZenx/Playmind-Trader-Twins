import { withTransaction } from "@/src/lib/db";

export async function consumeRateLimit(key: string, limit: number, windowSeconds: number) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - (now.getTime() % (windowSeconds * 1000)));
  return withTransaction(async (client) => {
    const existing = await client.query<{ window_start: Date; request_count: number }>(
      `SELECT window_start, request_count FROM rate_limit_counters WHERE bucket_key = $1 FOR UPDATE`,
      [key],
    );
    if (!existing.rows[0] || new Date(existing.rows[0].window_start) < windowStart) {
      await client.query(
        `INSERT INTO rate_limit_counters (bucket_key, window_start, request_count, updated_at)
         VALUES ($1, $2, 1, now())
         ON CONFLICT (bucket_key) DO UPDATE SET window_start = EXCLUDED.window_start, request_count = 1, updated_at = now()`,
        [key, windowStart],
      );
      return { allowed: true, remaining: Math.max(0, limit - 1), resetAt: new Date(windowStart.getTime() + windowSeconds * 1000).toISOString() };
    }
    const count = Number(existing.rows[0].request_count);
    if (count >= limit) {
      return { allowed: false, remaining: 0, resetAt: new Date(windowStart.getTime() + windowSeconds * 1000).toISOString() };
    }
    await client.query(
      `UPDATE rate_limit_counters SET request_count = request_count + 1, updated_at = now() WHERE bucket_key = $1`,
      [key],
    );
    return { allowed: true, remaining: Math.max(0, limit - count - 1), resetAt: new Date(windowStart.getTime() + windowSeconds * 1000).toISOString() };
  });
}

export function requestAddress(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}
