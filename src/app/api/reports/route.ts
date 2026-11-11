import { NextResponse } from "next/server";
import { query } from "@/src/lib/db";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const context = await requireWorkspaceContext();
    const result = await query(
      `SELECT r.id, r.version, r.created_at, r.approved_at, e.name AS experiment_name,
              e.status::text AS experiment_status
         FROM reports r JOIN experiments e ON e.id = r.experiment_id
        WHERE r.workspace_id = $1 ORDER BY r.created_at DESC`,
      [context.workspace.id],
    );
    return NextResponse.json({ reports: result.rows });
  } catch (error) {
    return routeError(error);
  }
}
