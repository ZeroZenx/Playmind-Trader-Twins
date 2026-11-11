import { query } from "@/src/lib/db";

export async function recordAudit(input: {
  workspaceId: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
}) {
  await query(
    `INSERT INTO audit_events (workspace_id, actor_user_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [input.workspaceId, input.actorUserId, input.action, input.targetType, input.targetId ?? null, JSON.stringify(input.details ?? {})],
  );
}
