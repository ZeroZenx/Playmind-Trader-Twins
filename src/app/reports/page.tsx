import { AppShell } from "@/src/components/app-shell";
import { query } from "@/src/lib/db";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const context = await requireWorkspaceContext();
  const result = await query(`SELECT r.id, r.version, r.created_at, r.approved_at, e.name AS experiment_name, e.status::text AS experiment_status FROM reports r JOIN experiments e ON e.id = r.experiment_id WHERE r.workspace_id = $1 ORDER BY r.created_at DESC`, [context.workspace.id]);
  return <AppShell context={context}><div className="eyebrow">Evidence reports</div><h1>Make every result inspectable.</h1><p className="lede">Reports will show cohort definitions, coverage, holdout status, uncertainty, and operational limits. A report without those fields stays a draft.</p><div className="card"><h2>Reports</h2>{result.rows.length ? <div className="table-wrap"><table><thead><tr><th>Experiment</th><th>Version</th><th>Status</th><th>Created</th><th>Approved</th></tr></thead><tbody>{result.rows.map((report) => <tr key={report.id}><td>{report.experiment_name}</td><td>{report.version}</td><td><span className={`status ${report.approved_at ? "" : "amber"}`}>{report.approved_at ? "approved" : "review"}</span></td><td>{new Date(report.created_at).toLocaleDateString()}</td><td>{report.approved_at ? new Date(report.approved_at).toLocaleDateString() : "-"}</td></tr>)}</tbody></table></div> : <p className="muted">No reports yet. Finish a draft experiment first.</p>}</div></AppShell>;
}
