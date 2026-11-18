import { NextResponse } from "next/server";
import { query } from "@/src/lib/db";
import { recordAudit } from "@/src/lib/audit";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireWorkspaceContext();
    if (!["owner", "reviewer"].includes(context.workspace.role)) throw new Error("FORBIDDEN");
    const { id } = await params;
    const result = await query(
      `UPDATE reports SET approved_by = $1, approved_at = now()
        WHERE id = $2 AND workspace_id = $3
        RETURNING id, approved_by, approved_at`,
      [context.user.id, id, context.workspace.id],
    );
    if (!result.rows[0]) return NextResponse.json({ error: "Report not found" }, { status: 404 });
    await recordAudit({ workspaceId: context.workspace.id, actorUserId: context.user.id, action: "report.approved", targetType: "report", targetId: id, details: {} });
    return NextResponse.json({ report: result.rows[0] });
  } catch (error) {
    return routeError(error);
  }
}
