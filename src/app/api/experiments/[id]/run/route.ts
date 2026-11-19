import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { query, withTransaction } from "@/src/lib/db";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";
import { recordAudit } from "@/src/lib/audit";
import { consumeRateLimit, requestAddress } from "@/src/lib/rate-limit";

export const dynamic = "force-dynamic";

const runSchema = z.object({
  seed: z.number().int().default(42),
  holdoutSeed: z.number().int().default(7100),
  sweepSeed: z.number().int().default(7200),
  holdoutReplicates: z.number().int().min(1).max(100).default(3),
  sweepReplicates: z.number().int().min(1).max(100).default(3),
  horizonDays: z.number().int().min(1).max(90).default(30),
  policies: z.array(z.enum(["cooldown", "deposit_limit", "stake_limit", "session_loss_limit"])).min(1).optional()
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireWorkspaceContext();
    if (!["owner", "analyst"].includes(context.workspace.role)) throw new Error("FORBIDDEN");
    const rate = await consumeRateLimit(`experiment-run:${context.workspace.id}:${requestAddress(request)}`, 30, 3600);
    if (!rate.allowed) return NextResponse.json({ error: "Experiment rate limit exceeded", resetAt: rate.resetAt }, { status: 429 });
    const { id } = await params;
    const body = runSchema.parse(await request.json().catch(() => ({})));
    const idempotencyKey = request.headers.get("idempotency-key")?.trim()
      || createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const experiment = await query<{ id: string; dataset_id: string; status: string }>(
      `SELECT id, dataset_id, status::text FROM experiments WHERE id = $1 AND workspace_id = $2`,
      [id, context.workspace.id],
    );
    if (!experiment.rows[0]) return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
    if (["queued", "running", "succeeded"].includes(experiment.rows[0].status)) {
      return NextResponse.json({ error: `Experiment is already ${experiment.rows[0].status}` }, { status: 409 });
    }
    const dataset = await query<{ id: string }>(
      `SELECT id FROM datasets WHERE id = $1 AND workspace_id = $2 AND status = 'ready'`,
      [experiment.rows[0].dataset_id, context.workspace.id],
    );
    if (!dataset.rows[0]) return NextResponse.json({ error: "Experiment dataset is not ready" }, { status: 400 });
    const result = await withTransaction(async (client) => {
      const job = await client.query<{ id: string; status: string; created_at: string }>(
        `INSERT INTO analysis_jobs
          (workspace_id, experiment_id, dataset_id, job_type, status, payload, idempotency_key, created_by)
         VALUES ($1, $2, $3, 'experiment_run', 'queued', $4::jsonb, $5, $6)
         ON CONFLICT (experiment_id, idempotency_key) DO UPDATE SET updated_at = now()
         RETURNING id, status::text, created_at`,
        [context.workspace.id, id, experiment.rows[0].dataset_id, JSON.stringify(body), idempotencyKey, context.user.id],
      );
      await client.query(
        `UPDATE experiments SET status = 'queued', last_job_id = $2, updated_at = now()
         WHERE id = $1 AND workspace_id = $3`,
        [id, job.rows[0].id, context.workspace.id],
      );
      return job.rows[0];
    });
    await recordAudit({ workspaceId: context.workspace.id, actorUserId: context.user.id, action: "experiment.queued", targetType: "experiment", targetId: id, details: { jobId: result.id, options: body } });
    return NextResponse.json({ job: { ...result, experimentId: id } }, { status: 202 });
  } catch (error) {
    return routeError(error);
  }
}
