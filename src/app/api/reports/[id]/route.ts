import { NextResponse } from "next/server";
import { query } from "@/src/lib/db";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireWorkspaceContext();
    const { id } = await params;
    const result = await query(
      `SELECT r.id, r.version, r.report_json, r.created_at, r.approved_at,
              e.id AS experiment_id, e.name AS experiment_name, e.status::text AS experiment_status
         FROM reports r JOIN experiments e ON e.id = r.experiment_id
        WHERE r.id = $1 AND r.workspace_id = $2`,
      [id, context.workspace.id],
    );
    if (!result.rows[0]) return NextResponse.json({ error: "Report not found" }, { status: 404 });
    return NextResponse.json({ report: result.rows[0] });
  } catch (error) {
    return routeError(error);
  }
}
