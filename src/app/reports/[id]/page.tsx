import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/src/components/app-shell";
import { ReportApproval } from "@/src/components/report-approval";
import { query } from "@/src/lib/db";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await requireWorkspaceContext();
  const { id } = await params;
  const result = await query<{ id: string; version: string; report_json: Record<string, unknown>; created_at: string; approved_at: string | null; experiment_name: string }>(
    `SELECT r.id, r.version, r.report_json, r.created_at, e.name AS experiment_name
       FROM reports r JOIN experiments e ON e.id = r.experiment_id
      WHERE r.id = $1 AND r.workspace_id = $2
        AND ($3 IN ('owner', 'analyst', 'reviewer') OR r.approved_at IS NOT NULL)`,
    [id, context.workspace.id, context.workspace.role],
  );
  const row = result.rows[0];
  if (!row) notFound();
  const report = row.report_json;
  const sections = (report.sections ?? {}) as Record<string, Record<string, unknown>>;
  return <AppShell context={context}>
    <div className="eyebrow">Evidence report</div>
    <h1>{row.experiment_name}</h1>
    <p className="lede">{String(report.banner ?? "")}</p>
    <div className="button-row"><Link className="button secondary" href="/reports">Back to reports</Link><ReportApproval reportId={row.id} approvedAt={row.approved_at} allowed={["owner", "reviewer"].includes(context.workspace.role)} /></div>
    <div className="grid-2" style={{ marginTop: 18 }}>
      {Object.entries(sections).map(([name, section]) => <div className="card" key={name}>
        <div className="eyebrow">{name}</div>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, overflowX: "auto" }}>{JSON.stringify(section, null, 2)}</pre>
      </div>)}
    </div>
  </AppShell>;
}
