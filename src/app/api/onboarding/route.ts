import { NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/src/lib/db";
import { routeError } from "@/src/lib/route";
import { ensureWorkspaceDefaults, requireWorkspaceContext } from "@/src/lib/workspace";
import { recordAudit } from "@/src/lib/audit";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  taskKey: z.string().min(1),
  status: z.enum(["pending", "in_progress", "done", "blocked"]),
});

export async function GET() {
  try {
    const context = await requireWorkspaceContext();
    await ensureWorkspaceDefaults(context.workspace.id, context.user.id);
    const result = await query(
      `SELECT task_key, title, description, status::text, sort_order, completed_at, updated_at
         FROM onboarding_tasks
        WHERE workspace_id = $1
        ORDER BY sort_order, task_key`,
      [context.workspace.id],
    );
    return NextResponse.json({ tasks: result.rows });
  } catch (error) {
    return routeError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await requireWorkspaceContext();
    if (!["owner", "analyst", "reviewer"].includes(context.workspace.role)) throw new Error("FORBIDDEN");
    const body = updateSchema.parse(await request.json());
    const result = await query(
      `UPDATE onboarding_tasks
          SET status = $1::onboarding_task_status,
              completed_at = CASE WHEN $1 = 'done' THEN now() ELSE NULL END,
              updated_at = now()
        WHERE workspace_id = $2 AND task_key = $3
        RETURNING task_key, status::text, completed_at`,
      [body.status, context.workspace.id, body.taskKey],
    );
    if (!result.rows[0]) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    await recordAudit({ workspaceId: context.workspace.id, actorUserId: context.user.id, action: "onboarding.task_updated", targetType: "onboarding_task", targetId: body.taskKey, details: { status: body.status } });
    return NextResponse.json({ task: result.rows[0] });
  } catch (error) {
    return routeError(error);
  }
}
