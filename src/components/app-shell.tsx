import Link from "next/link";
import { AuthButtons } from "@/src/components/auth-buttons";
import type { WorkspaceContext } from "@/src/lib/workspace";

export function AppShell({ context, children }: { context: WorkspaceContext; children: React.ReactNode }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/dashboard" className="brand"><span className="brand-mark">P</span><span className="brand-copy">PlayMind<br />Trader Twins</span></Link>
        <nav className="nav" aria-label="Primary navigation">
          <Link href="/dashboard">Overview</Link>
          <Link href="/onboarding">Onboarding</Link>
          <Link href="/datasets">Datasets</Link>
          <Link href="/experiments">Experiments</Link>
          <Link href="/reports">Reports</Link>
          <Link href="/settings">Settings</Link>
        </nav>
        <div className="sidebar-foot">Workspace<br /><strong>{context.workspace.name}</strong><br /><span>{context.workspace.role}</span></div>
      </aside>
      <main className="main">
        <header className="topbar"><div><div className="topbar-title">Evidence workspace</div><div className="topbar-meta">Tokenized activity only · live execution disabled</div></div><AuthButtons /></header>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}
