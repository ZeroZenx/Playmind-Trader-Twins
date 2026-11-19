import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/src/lib/db";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";
import { recordAudit } from "@/src/lib/audit";
import { consumeRateLimit, requestAddress } from "@/src/lib/rate-limit";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  sourceFilename: z.string().min(1).max(200),
  schemaVersion: z.string().min(1).max(40).default("tokenized-trader-event-v1"),
  isSynthetic: z.boolean().default(false),
  dataLabel: z.enum(["SYNTHETIC", "OBSERVATIONAL", "CUSTOMER"]).default("CUSTOMER"),
});

export async function GET() {
  try {
    const context = await requireWorkspaceContext();
    const result = await query<{ id: string; name: string; status: string; is_synthetic: boolean; created_at: string }>(
      `SELECT id, name, source_filename, status::text, is_synthetic, row_count, trader_count,
              starts_at, ends_at, quality_report, created_at, updated_at
         FROM datasets
        WHERE workspace_id = $1
        ORDER BY created_at DESC`,
      [context.workspace.id],
    );
    return NextResponse.json({ datasets: result.rows });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireWorkspaceContext();
    if (!["owner", "analyst"].includes(context.workspace.role)) throw new Error("FORBIDDEN");
    const rate = await consumeRateLimit(`dataset-create:${context.workspace.id}:${requestAddress(request)}`, 30, 3600);
    if (!rate.allowed) return NextResponse.json({ error: "Dataset creation rate limit exceeded", resetAt: rate.resetAt }, { status: 429 });
    const body = createSchema.parse(await request.json());
    const sourceSha256 = `pending:${createHash("sha256").update(`${body.name}:${body.sourceFilename}:${Date.now()}`).digest("hex")}`;
    const result = await query(
      `INSERT INTO datasets
        (workspace_id, name, source_filename, source_sha256, schema_version, is_synthetic, data_label, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, status::text, is_synthetic, data_label, created_at`,
      [context.workspace.id, body.name, body.sourceFilename, sourceSha256, body.schemaVersion, body.isSynthetic || body.dataLabel === "SYNTHETIC", body.dataLabel, context.user.id],
    );
    await recordAudit({ workspaceId: context.workspace.id, actorUserId: context.user.id, action: "dataset.created", targetType: "dataset", targetId: result.rows[0].id, details: { sourceFilename: body.sourceFilename, isSynthetic: body.isSynthetic } });
    return NextResponse.json({ dataset: result.rows[0] }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
