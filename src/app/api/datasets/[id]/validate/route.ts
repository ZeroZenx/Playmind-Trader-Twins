import { NextResponse } from "next/server";
import { query } from "@/src/lib/db";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireWorkspaceContext();
    if (!["owner", "analyst"].includes(context.workspace.role)) throw new Error("FORBIDDEN");
    const { id } = await params;
    const result = await query(
      `WITH stats AS (
         SELECT count(*)::int AS row_count, count(DISTINCT trader_token)::int AS trader_count,
                min(occurred_at) AS starts_at, max(occurred_at) AS ends_at
           FROM trader_events
          WHERE dataset_id = $1 AND workspace_id = $2
       )
       UPDATE datasets d
          SET status = CASE WHEN s.row_count > 0 THEN 'ready'::dataset_status ELSE 'rejected'::dataset_status END,
              row_count = s.row_count, trader_count = s.trader_count, starts_at = s.starts_at, ends_at = s.ends_at,
              quality_report = coalesce(d.quality_report, '{}'::jsonb) || jsonb_build_object('validatedAt', now(), 'validatedRows', s.row_count),
              updated_at = now()
         FROM stats s
        WHERE d.id = $1 AND d.workspace_id = $2
        RETURNING d.id, d.status::text, d.row_count, d.trader_count, d.starts_at, d.ends_at, d.quality_report`,
      [id, context.workspace.id],
    );
    if (!result.rows[0]) return NextResponse.json({ error: "Dataset not found" }, { status: 404 });
    return NextResponse.json({ dataset: result.rows[0] });
  } catch (error) {
    return routeError(error);
  }
}
