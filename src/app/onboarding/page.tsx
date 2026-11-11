import { AppShell } from "@/src/components/app-shell";
import { OnboardingChecklist } from "@/src/components/onboarding-checklist";
import { requireWorkspaceContext, ensureWorkspaceDefaults } from "@/src/lib/workspace";
import { query } from "@/src/lib/db";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const context = await requireWorkspaceContext();
  await ensureWorkspaceDefaults(context.workspace.id, context.user.id);
  const result = await query<{ task_key: string; title: string; description: string; status: string }>(`SELECT task_key, title, description, status::text FROM onboarding_tasks WHERE workspace_id = $1 ORDER BY sort_order`, [context.workspace.id]);
  return <AppShell context={context}><div className="eyebrow">Customer onboarding</div><h1>Make the first data handoff safe and repeatable.</h1><p className="lede">Each workspace starts with a small evidence path: agree the contract, validate a sample, confirm read-only boundaries, then run a baseline.</p><div className="grid-2"><div className="card"><h2>Launch checklist</h2><OnboardingChecklist initialTasks={result.rows} /></div><div className="card"><div className="eyebrow">Required operating rules</div><div className="list"><div className="list-item"><span>Tokenized identifiers only</span><span className="status">Required</span></div><div className="list-item"><span>Holdout data stays separate</span><span className="status">Required</span></div><div className="list-item"><span>Human review before action</span><span className="status">Required</span></div><div className="list-item"><span>Venue execution</span><span className="status red">Disabled</span></div></div></div></div></AppShell>;
}
