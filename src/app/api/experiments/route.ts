import { NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/src/lib/db";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";
import { recordAudit } from "@/src/lib/audit";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  datasetId: z.string().uuid(),
  horizonDays: z.number().int().min(1).max(90).default(30),
  randomSeed: z.number().int().default(42),
});

export async function GET() {
  try {
    const context = await requireWorkspaceContext();
    const result = await query<{ id: string; name: string; status: string; horizon_days: number; random_seed: number; created_at: string }>(
      `SELECT e.id, e.name, e.status::text, e.horizon_days, e.random_seed, e.created_at,
              d.name AS dataset_name, p.name AS policy_name
         FROM experiments e
         JOIN datasets d ON d.id = e.dataset_id
         JOIN policies p ON p.id = e.policy_id
        WHERE e.workspace_id = $1
        ORDER BY e.created_at DESC`,
      [context.workspace.id],
    );
    return NextResponse.json({ experiments: result.rows });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireWorkspaceContext();
    if (!["owner", "analyst"].includes(context.workspace.role)) throw new Error("FORBIDDEN");
    const body = createSchema.parse(await request.json());
    const dataset = await query<{ id: string }>(
      `SELECT id FROM datasets WHERE id = $1 AND workspace_id = $2 AND status = 'ready'`,
      [body.datasetId, context.workspace.id],
    );
    if (!dataset.rows[0]) return NextResponse.json({ error: "Ready dataset not found" }, { status: 400 });
    const policy = await query<{ id: string }>(
      `INSERT INTO policies (workspace_id, name, version, policy_type, configuration, created_by)
       VALUES ($1, 'Responsible-trading baseline', 'v1', 'baseline', '{"mode":"evidence_only","liveExecution":false}', $2)
       ON CONFLICT (workspace_id, name, version) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [context.workspace.id, context.user.id],
    );
    const result = await query(
      `INSERT INTO experiments (workspace_id, dataset_id, policy_id, name, status, random_seed, horizon_days, created_by)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
       RETURNING id, name, status::text, horizon_days, random_seed, created_at`,
      [context.workspace.id, body.datasetId, policy.rows[0].id, body.name, body.randomSeed, body.horizonDays, context.user.id],
    );
    await recordAudit({ workspaceId: context.workspace.id, actorUserId: context.user.id, action: "experiment.created", targetType: "experiment", targetId: result.rows[0].id, details: { datasetId: body.datasetId, horizonDays: body.horizonDays, randomSeed: body.randomSeed } });
    return NextResponse.json({ experiment: result.rows[0] }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
