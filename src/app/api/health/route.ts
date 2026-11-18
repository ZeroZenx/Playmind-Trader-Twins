import { NextResponse } from "next/server";
import { appConfig } from "@/src/lib/env";
import { pool } from "@/src/lib/db";

export async function GET() {
  let database: "configured" | "unconfigured" = pool ? "configured" : "unconfigured";
  if (pool) {
    try { await pool.query("SELECT 1"); } catch { database = "unconfigured"; }
  }
  const authConfigured = Boolean(process.env.NEON_AUTH_BASE_URL && process.env.NEON_AUTH_COOKIE_SECRET);
  const storageConfigured = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const workerConfigured = Boolean(process.env.CRON_SECRET);
  const production = process.env.NODE_ENV === "production";
  const status = database === "configured" && authConfigured && (!production || (storageConfigured && workerConfigured)) ? "ok" : "degraded";
  return NextResponse.json({ status, app: appConfig.name, database, auth: authConfigured, storage: storageConfigured, worker: workerConfigured, customerDataMode: appConfig.customerDataMode, liveTradingEnabled: appConfig.liveTradingEnabled, checkedAt: new Date().toISOString() }, { status: status === "ok" ? 200 : 503 });
}
