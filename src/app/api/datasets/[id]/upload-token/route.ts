import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/src/lib/db";
import { requestAddress, consumeRateLimit } from "@/src/lib/rate-limit";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = Number(process.env.PLAYMIND_MAX_UPLOAD_BYTES ?? 500_000_000);
const bodySchema = z.object({
  datasetId: z.string().uuid(),
  sourceFilename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

function safeFilename(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 160) || "upload.csv";
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireWorkspaceContext();
    if (!["owner", "analyst"].includes(context.workspace.role)) throw new Error("FORBIDDEN");
    const { id } = await params;
    const uploadRequest = request.clone();
    const uploadBody = (await request.json()) as HandleUploadBody & { clientPayload?: string };
    const body = bodySchema.parse(JSON.parse(uploadBody.clientPayload ?? "{}"));
    if (body.datasetId !== id) throw new Error("Dataset mismatch");
    if (!body.sourceFilename.toLowerCase().endsWith(".csv")) throw new Error("Only CSV uploads are supported in this release");
    if (!/^text\/csv$|^application\/csv$|^application\/octet-stream$/i.test(body.contentType)) throw new Error("Unsupported content type");
    const rate = await consumeRateLimit(`upload:${context.workspace.id}:${requestAddress(request)}`, 10, 3600);
    if (!rate.allowed) return NextResponse.json({ error: "Upload rate limit exceeded", resetAt: rate.resetAt }, { status: 429 });
    const dataset = await query<{ id: string }>(
      `SELECT id FROM datasets WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [id, context.workspace.id],
    );
    if (!dataset.rows[0]) return NextResponse.json({ error: "Dataset not found" }, { status: 404 });

    const jsonResponse = await handleUpload({
      body: uploadBody,
      request: uploadRequest,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = bodySchema.parse(JSON.parse(clientPayload ?? "{}"));
        if (payload.datasetId !== id) throw new Error("Dataset mismatch");
        const expectedPrefix = `datasets/${context.workspace.id}/${id}/`;
        if (!pathname.startsWith(expectedPrefix)) throw new Error("Invalid upload path");
        return {
          allowedContentTypes: ["text/csv", "application/csv", "application/octet-stream"],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
          access: "private",
          tokenPayload: JSON.stringify({
            datasetId: id,
            workspaceId: context.workspace.id,
            userId: context.user.id,
            sourceFilename: payload.sourceFilename,
            contentType: payload.contentType,
            sizeBytes: payload.sizeBytes,
          }),
        };
      },
      onUploadCompleted: async () => undefined,
    });
    return NextResponse.json(jsonResponse, { headers: { "x-ratelimit-remaining": String(rate.remaining) } });
  } catch (error) {
    return routeError(error);
  }
}
