import { NextResponse } from "next/server";
import { z } from "zod";
import { query, withTransaction } from "@/src/lib/db";
import { headPrivateBlob } from "@/src/lib/blob";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";
import { recordAudit } from "@/src/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const completeSchema = z.object({
  pathname: z.string().min(1).max(500),
  sourceFilename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireWorkspaceContext();
    if (!["owner", "analyst"].includes(context.workspace.role)) throw new Error("FORBIDDEN");
    const { id } = await params;
    const body = completeSchema.parse(await request.json());
    const prefix = `datasets/${context.workspace.id}/${id}/`;
    if (!body.pathname.startsWith(prefix)) throw new Error("Invalid upload path");
    const blob = await headPrivateBlob(body.pathname);
    if (!blob) return NextResponse.json({ error: "Uploaded file was not found" }, { status: 400 });
    if (Number(blob.size) !== body.sizeBytes) throw new Error("Uploaded file size does not match the declared size");
    const result = await withTransaction(async (client) => {
      const dataset = await client.query<{ id: string; source_filename: string }>(
        `SELECT id, source_filename FROM datasets WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [id, context.workspace.id],
      );
      if (!dataset.rows[0]) throw new Error("Dataset not found");
      const experiments = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM experiments WHERE dataset_id = $1`, [id]);
      if (experiments.rows[0].count > 0) throw new Error("Dataset already has an experiment. Create a new dataset for replacement.");
      const idempotencyKey = `${body.pathname}:${blob.etag}`;
      const job = await client.query<{ id: string; status: string }>(
        `INSERT INTO ingestion_jobs
          (workspace_id, dataset_id, source_kind, source_filename, storage_path, content_type, size_bytes,
           status, idempotency_key, created_by)
         VALUES ($1, $2, 'vercel_blob', $3, $4, $5, $6, 'queued', $7, $8)
         ON CONFLICT (dataset_id, idempotency_key) DO UPDATE SET updated_at = now()
         RETURNING id, status::text`,
        [context.workspace.id, id, body.sourceFilename, body.pathname, body.contentType, body.sizeBytes, idempotencyKey, context.user.id],
      );
      await client.query(
        `UPDATE datasets SET source_filename = $1, storage_provider = 'vercel_blob', storage_path = $2,
            storage_etag = $3, content_type = $4, size_bytes = $5, malware_scan_status = 'pending', upload_status = 'uploaded', status = 'uploaded',
            uploaded_at = now(), updated_at = now()
          WHERE id = $6 AND workspace_id = $7`,
        [body.sourceFilename, body.pathname, blob.etag, body.contentType, body.sizeBytes, id, context.workspace.id],
      );
      return { id: job.rows[0].id, status: job.rows[0].status };
    });
    await recordAudit({ workspaceId: context.workspace.id, actorUserId: context.user.id, action: "dataset.upload_completed", targetType: "dataset", targetId: id, details: { sourceFilename: body.sourceFilename, sizeBytes: body.sizeBytes, storageProvider: "vercel_blob" } });
    return NextResponse.json({ ingestion: { jobId: result.id, status: result.status }, storage: { provider: "vercel_blob", pathname: body.pathname } }, { status: 202 });
  } catch (error) {
    return routeError(error);
  }
}
