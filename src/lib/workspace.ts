import type { PoolClient } from "pg";
import { auth } from "@/src/lib/auth/server";
import { query, withTransaction } from "@/src/lib/db";

export type WorkspaceContext = {
  user: { id: string; name: string; email?: string | null };
  workspace: { id: string; name: string; role: string };
};

export const defaultOnboardingTasks = [
  { taskKey: "confirm-data-contract", title: "Confirm the tokenized data contract", description: "Approve event fields, date boundaries, and the no-direct-PII rule.", sortOrder: 10 },
  { taskKey: "upload-sample", title: "Upload a validation sample", description: "Upload a small tokenized CSV and review schema and quality results.", sortOrder: 20 },
  { taskKey: "review-venue-boundary", title: "Review venue boundary", description: "Confirm read-only venue capabilities and keep order placement disabled.", sortOrder: 30 },
  { taskKey: "run-baseline", title: "Run a baseline signal", description: "Run the first signal definition against a ready dataset.", sortOrder: 40 },
  { taskKey: "approve-reporting", title: "Approve reporting rules", description: "Confirm evidence labels, holdout policy, and report recipients.", sortOrder: 50 },
];

async function sessionUser() {
  const { data } = await auth.getSession();
  if (!data?.user) return null;
  return data.user;
}

export async function getWorkspaceContext(): Promise<WorkspaceContext | null> {
  const user = await sessionUser();
  if (!user) return null;

  const result = await query<{
    user_id: string;
    display_name: string;
    email: string | null;
    workspace_id: string;
    workspace_name: string;
    role: string;
  }>(
    `SELECT u.id AS user_id, u.display_name, NULL::text AS email,
            w.id AS workspace_id, w.name AS workspace_name, wm.role::text AS role
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       JOIN workspaces w ON w.id = wm.workspace_id
      WHERE u.external_subject = $1
      ORDER BY wm.created_at ASC
      LIMIT 1`,
    [user.id],
  );

  if (!result.rows[0]) return ensureWorkspace(user);
  const row = result.rows[0];
  return {
    user: { id: row.user_id, name: row.display_name, email: row.email },
    workspace: { id: row.workspace_id, name: row.workspace_name, role: row.role },
  };
}

async function ensureWorkspace(user: { id: string; name?: string | null }) {
  return withTransaction(async (client: PoolClient) => {
    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (external_subject, display_name)
       VALUES ($1, $2)
       ON CONFLICT (external_subject) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [user.id, user.name || "PlayMind user"],
    );
    const userId = userResult.rows[0].id;
    const workspaceResult = await client.query<{ id: string; name: string }>(
      `INSERT INTO workspaces (name)
       SELECT $1
       WHERE NOT EXISTS (
         SELECT 1 FROM workspace_members WHERE user_id = $2
       )
       RETURNING id, name`,
      [`${user.name || "PlayMind"}'s workspace`, userId],
    );
    let workspace = workspaceResult.rows[0];
    if (!workspace) {
      const existing = await client.query<{ id: string; name: string }>(
        `SELECT w.id, w.name
           FROM workspaces w
           JOIN workspace_members wm ON wm.workspace_id = w.id
          WHERE wm.user_id = $1
          ORDER BY wm.created_at ASC LIMIT 1`,
        [userId],
      );
      workspace = existing.rows[0];
    } else {
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [workspace.id, userId],
      );
    }
    await seedWorkspaceDefaults(client, workspace.id, userId);
    return {
      user: { id: userId, name: user.name || "PlayMind user", email: null },
      workspace: { id: workspace.id, name: workspace.name, role: "owner" },
    };
  });
}

export async function ensureWorkspaceDefaults(workspaceId: string, userId: string) {
  await withTransaction(async (client) => seedWorkspaceDefaults(client, workspaceId, userId));
}

async function seedWorkspaceDefaults(client: PoolClient, workspaceId: string, userId: string) {
  for (const task of defaultOnboardingTasks) {
    await client.query(
      `INSERT INTO onboarding_tasks (workspace_id, task_key, title, description, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, task_key) DO NOTHING`,
      [workspaceId, task.taskKey, task.title, task.description, task.sortOrder],
    );
  }
  for (const venue of [
    { venueId: "polymarket", displayName: "Polymarket public data", capabilities: ["historical-import", "market-metadata"] },
    { venueId: "customer-batch", displayName: "Customer tokenized batch", capabilities: ["csv-upload", "quality-validation", "signal-runs"] },
  ]) {
    await client.query(
      `INSERT INTO venue_connections (workspace_id, venue_id, display_name, mode, capabilities, created_by)
       VALUES ($1, $2, $3, 'read_only', $4::jsonb, $5)
       ON CONFLICT (workspace_id, venue_id) DO NOTHING`,
      [workspaceId, venue.venueId, venue.displayName, JSON.stringify(venue.capabilities), userId],
    );
  }
}

export async function requireWorkspaceContext() {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("UNAUTHENTICATED");
  return context;
}

export function hasRole(role: string, allowed: string[]) {
  return allowed.includes(role);
}
