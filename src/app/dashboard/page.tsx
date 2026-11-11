import Link from "next/link";
import { AppShell } from "@/src/components/app-shell";
import { query } from "@/src/lib/db";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const context = await requireWorkspaceContext();
  const [datasets, experiments, reports, tasks] = await Promise.all([
    query(`SELECT count(*)::int AS count FROM datasets WHERE workspace_id = $1`, [context.workspace.id]),
    query(`SELECT count(*)::int AS count FROM experiments WHERE workspace_id = $1`, [context.workspace.id]),
    query(`SELECT count(*)::int AS count FROM reports WHERE workspace_id = $1`, [context.workspace.id]),
    query(`SELECT count(*)::int AS count FROM onboarding_tasks WHERE workspace_id = $1 AND status = 'done'`, [context.workspace.id]),
  ]);
  return <AppShell context={context}><div className="eyebrow">Workspace overview</div><h1>Turn activity data into accountable decisions.</h1><p className="lede">PlayMind keeps customer data tokenized, separates observation from prediction, and records each policy test for review.</p>
    <div className="metrics"><div className="metric"><div className="metric-label">Datasets</div><div className="metric-value">{datasets.rows[0].count}</div><div className="metric-note">Uploaded to this workspace</div></div><div className="metric"><div className="metric-label">Experiments</div><div className="metric-value">{experiments.rows[0].count}</div><div className="metric-note">Policy tests created</div></div><div className="metric"><div className="metric-label">Reports</div><div className="metric-value">{reports.rows[0].count}</div><div className="metric-note">Evidence packages</div></div><div className="metric"><div className="metric-label">Onboarding</div><div className="metric-value">{tasks.rows[0].count}/5</div><div className="metric-note">Tasks complete</div></div></div>
    <div className="grid-2"><div className="card"><div className="eyebrow">Next action</div><h2>Start with a tokenized sample</h2><p className="muted">Upload a small CSV, inspect rejected rows, and confirm the data contract before any model work.</p><div className="button-row"><Link className="button" href="/datasets">Open datasets</Link><Link className="button secondary" href="/onboarding">Review onboarding</Link></div></div><div className="card"><div className="eyebrow">Boundary</div><h2>Read-only by design</h2><p className="muted">The current product reads public or customer-provided activity. It does not place orders, move funds, or manage venue accounts.</p><span className="status">Execution disabled</span></div></div>
  </AppShell>;
}
