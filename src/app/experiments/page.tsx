import { AppShell } from "@/src/components/app-shell";
import { ExperimentForm } from "@/src/components/experiment-form";
import { query } from "@/src/lib/db";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export default async function ExperimentsPage() {
  const context = await requireWorkspaceContext();
  const [datasets, experiments] = await Promise.all([
    query<{ id: string; name: string }>(`SELECT id, name FROM datasets WHERE workspace_id = $1 AND status = 'ready' ORDER BY created_at DESC`, [context.workspace.id]),
    query(`SELECT e.id, e.name, e.status::text, e.horizon_days, d.name AS dataset_name FROM experiments e JOIN datasets d ON d.id = e.dataset_id WHERE e.workspace_id = $1 ORDER BY e.created_at DESC`, [context.workspace.id]),
  ]);
  return <AppShell context={context}><div className="eyebrow">Policy testing</div><h1>Run controlled experiments before changing operations.</h1><p className="lede">A draft experiment records its dataset, policy, seed, horizon, and assumptions. Reports need review before anyone treats a result as a decision.</p><div className="grid-2"><div className="card"><h2>New experiment</h2><ExperimentForm datasets={datasets.rows} /></div><div className="card"><div className="eyebrow">Model boundary</div><h2>Evidence first</h2><p className="muted">The platform stores signal definitions and scenario results. It does not send recommendations to a venue or execute a trade.</p><span className="status">Drafts require review</span></div></div><div className="card" style={{ marginTop: 18 }}><h2>Experiments</h2>{experiments.rows.length ? <div className="table-wrap"><table><thead><tr><th>Name</th><th>Dataset</th><th>Status</th><th>Horizon</th></tr></thead><tbody>{experiments.rows.map((experiment) => <tr key={experiment.id}><td><strong>{experiment.name}</strong></td><td>{experiment.dataset_name}</td><td><span className="status amber">{experiment.status}</span></td><td>{experiment.horizon_days} days</td></tr>)}</tbody></table></div> : <p className="muted">No experiments yet.</p>}</div></AppShell>;
}
