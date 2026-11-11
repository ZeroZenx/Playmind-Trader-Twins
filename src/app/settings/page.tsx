import { AppShell } from "@/src/components/app-shell";
import { query } from "@/src/lib/db";
import { liveExecutionBoundary, supportedVenues } from "@/src/lib/venue";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const context = await requireWorkspaceContext();
  const result = await query<{ venue_id: string; display_name: string; mode: "read_only" | "disabled"; capabilities: string[] }>(`SELECT venue_id, display_name, mode::text, capabilities FROM venue_connections WHERE workspace_id = $1 ORDER BY display_name`, [context.workspace.id]);
  const venues = result.rows.length ? result.rows.map((venue) => ({ venueId: venue.venue_id, displayName: venue.display_name, mode: venue.mode, capabilities: venue.capabilities })) : supportedVenues;
  return <AppShell context={context}><div className="eyebrow">Settings and boundaries</div><h1>Keep access narrow and reviewable.</h1><p className="lede">Credentials never enter event files. The first release exposes read-only data capabilities and keeps live execution disabled.</p><div className="grid-2"><div className="card"><h2>Venue connections</h2><div className="list">{venues.map((venue) => <div className="list-item" key={venue.venueId}><span><strong>{venue.displayName}</strong><br /><small>{Array.isArray(venue.capabilities) ? venue.capabilities.join(" · ") : "Read-only"}</small></span><span className="status">{venue.mode}</span></div>)}</div></div><div className="card"><h2>Execution boundary</h2><div className="notice">{liveExecutionBoundary.reason}</div><div className="list"><div className="list-item"><span>Order placement</span><span className="status red">Disabled</span></div><div className="list-item"><span>Fund custody</span><span className="status red">Disabled</span></div><div className="list-item"><span>Public or batch reads</span><span className="status">Enabled</span></div></div></div></div></AppShell>;
}
