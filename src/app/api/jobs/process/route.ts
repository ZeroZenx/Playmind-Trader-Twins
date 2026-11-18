import { NextResponse } from "next/server";
import { pool } from "@/src/lib/db";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const context = await requireWorkspaceContext();
    if (!["owner", "analyst"].includes(context.workspace.role)) throw new Error("FORBIDDEN");
    if (!pool) throw new Error("DATABASE_URL is not configured");
    const body = await request.json().catch(() => ({})) as { jobId?: string };
    // @ts-ignore The engine runner is a checked-in ESM module without a duplicate TS surface.
    const { processNextAnalysisJob } = await import("@/src/lib/twin-runner.mjs");
    const result = await processNextAnalysisJob(pool, { workspaceId: context.workspace.id, jobId: body.jobId ?? null });
    return NextResponse.json({ job: result });
  } catch (error) {
    return routeError(error);
  }
}
