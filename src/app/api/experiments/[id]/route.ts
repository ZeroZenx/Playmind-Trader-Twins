import { NextResponse } from "next/server";
import { query } from "@/src/lib/db";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireWorkspaceContext();
    const { id } = await params;
    const experiment = await query(
      `SELECT e.id, e.name, e.status::text, e.horizon_days, e.random_seed, e.assumptions,
              e.created_at, e.updated_at, e.last_job_id, d.name AS dataset_name,
              d.data_label, d.row_count, d.trader_count
         FROM experiments e JOIN datasets d ON d.id = e.dataset_id
        WHERE e.id = $1 AND e.workspace_id = $2`,
      [id, context.workspace.id],
    );
    if (!experiment.rows[0]) return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
    const [results, report, job] = await Promise.all([
      query(`SELECT scenario, metrics, coverage, limitations, created_at FROM experiment_results WHERE experiment_id = $1 ORDER BY scenario`, [id]),
      query(`SELECT id, version, report_json, created_at, approved_at FROM reports WHERE experiment_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]),
      experiment.rows[0].last_job_id
        ? query(`SELECT id, status::text, attempts, error_message, started_at, finished_at, created_at FROM analysis_jobs WHERE id = $1 AND workspace_id = $2`, [experiment.rows[0].last_job_id, context.workspace.id])
        : Promise.resolve({ rows: [] })
    ]);
    return NextResponse.json({ experiment: experiment.rows[0], job: job.rows[0] ?? null, results: results.rows, report: report.rows[0] ?? null });
  } catch (error) {
    return routeError(error);
  }
}
