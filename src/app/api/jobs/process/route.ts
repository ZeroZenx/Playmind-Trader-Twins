import { NextResponse } from "next/server";
import { pool } from "@/src/lib/db";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function hasWorkerSecret(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

async function processOne() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  // @ts-ignore The runners are checked-in ESM modules without duplicate TS surfaces.
  const { processNextIngestionJob } = await import("@/src/lib/ingestion-runner.mjs");
  // @ts-ignore The runners are checked-in ESM modules without duplicate TS surfaces.
  const { processNextAnalysisJob } = await import("@/src/lib/twin-runner.mjs");
  const ingestion = await processNextIngestionJob(pool);
  return ingestion.status === "idle" ? processNextAnalysisJob(pool) : ingestion;
}

async function handle(request: Request) {
  if (!hasWorkerSecret(request)) {
    if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const context = await requireWorkspaceContext();
    if (!["owner", "analyst"].includes(context.workspace.role)) throw new Error("FORBIDDEN");
    return NextResponse.json({ job: await processOne() });
  }
  return NextResponse.json({ job: await processOne() });
}

export async function GET(request: Request) {
  try { return await handle(request); } catch (error) { return routeError(error); }
}

export async function POST(request: Request) {
  try { return await handle(request); } catch (error) { return routeError(error); }
}
