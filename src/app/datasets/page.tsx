import { AppShell } from "@/src/components/app-shell";
import { DatasetUpload } from "@/src/components/dataset-upload";
import { query } from "@/src/lib/db";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export default async function DatasetsPage() {
  const context = await requireWorkspaceContext();
  const result = await query(`SELECT id, name, source_filename, status::text, is_synthetic, row_count, trader_count, starts_at, ends_at, created_at FROM datasets WHERE workspace_id = $1 ORDER BY created_at DESC`, [context.workspace.id]);
  return <AppShell context={context}><div className="eyebrow">Data intake</div><h1>Bring in evidence without bringing in identity.</h1><p className="lede">The first customer workflow accepts tokenized event CSVs, rejects direct identity fields, records provenance, and reports data quality before analysis.</p><div className="grid-2"><div className="card"><h2>Upload a sample</h2><DatasetUpload /></div><div className="card"><div className="eyebrow">Contract</div><h2>What enters the system</h2><p className="muted">A stable trader token, event timestamp, event type, venue identifier, and event measures. Keep names, emails, phones, addresses, device fingerprints, and unmasked account IDs outside the file.</p><div className="notice">Production ingestion still needs object storage, signed uploads, malware scanning, rate limits, and customer-specific retention settings.</div></div></div><div className="card" style={{ marginTop: 18 }}><h2>Datasets</h2>{result.rows.length ? <div className="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th>Rows</th><th>Traders</th><th>Window</th></tr></thead><tbody>{result.rows.map((dataset) => <tr key={dataset.id}><td><strong>{dataset.name}</strong><br /><small className="muted">{dataset.source_filename}</small></td><td><span className={`status ${dataset.status === "rejected" ? "red" : dataset.status === "uploaded" ? "amber" : ""}`}>{dataset.status}</span></td><td>{dataset.row_count ?? "-"}</td><td>{dataset.trader_count ?? "-"}</td><td>{dataset.starts_at ? `${new Date(dataset.starts_at).toLocaleDateString()} to ${new Date(dataset.ends_at).toLocaleDateString()}` : "-"}</td></tr>)}</tbody></table></div> : <p className="muted">No datasets yet.</p>}</div></AppShell>;
}
