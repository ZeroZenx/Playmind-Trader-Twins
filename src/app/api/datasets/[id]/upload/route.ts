import { NextResponse } from "next/server";
import { eventSchema, parseTokenizedCsv } from "@/src/lib/ingestion";
import { query, withTransaction } from "@/src/lib/db";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";
import { recordAudit } from "@/src/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireWorkspaceContext();
    if (!["owner", "analyst"].includes(context.workspace.role)) throw new Error("FORBIDDEN");
    const { id } = await params;
    const dataset = await query<{ id: string; source_filename: string }>(
      `SELECT id, source_filename FROM datasets WHERE id = $1 AND workspace_id = $2`,
      [id, context.workspace.id],
    );
    if (!dataset.rows[0]) return NextResponse.json({ error: "Dataset not found" }, { status: 404 });

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Upload a CSV file in the file field" }, { status: 400 });
    if (file.size > 4_000_000) return NextResponse.json({ error: "First-pass uploads are limited to 4 MB" }, { status: 413 });
    const csv = await file.text();
    const parsed = parseTokenizedCsv(csv);
    const eventIds = new Set<string>();
    const traders = new Set<string>();
    const dates: number[] = [];
    for (const event of parsed.events) {
      eventIds.add(event.event_id);
      traders.add(event.trader_token);
      dates.push(new Date(event.occurred_at).getTime());
    }
    const startsAt = dates.length ? new Date(Math.min(...dates)).toISOString() : null;
    const endsAt = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
    const qualityReport = {
      parser: "tokenized-csv-v1",
      validRows: parsed.events.length,
      rejectedRows: parsed.errors.length,
      duplicateEventIds: parsed.errors.filter((error) => error.message.startsWith("Duplicate event_id:")).length,
      directPiiHeadersRejected: false,
      headers: parsed.headers,
    };

    const result = await withTransaction(async (client) => {
      const priorExperiments = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM experiments WHERE dataset_id = $1`,
        [id],
      );
      if (priorExperiments.rows[0].count > 0) {
        throw new Error("Dataset already has an experiment. Create a new dataset for a replacement upload.");
      }
      await client.query(`DELETE FROM signal_runs WHERE dataset_id = $1`, [id]);
      await client.query(`DELETE FROM trader_events WHERE dataset_id = $1`, [id]);
      const job = await client.query<{ id: string }>(
        `INSERT INTO ingestion_jobs
          (workspace_id, dataset_id, source_kind, source_filename, status, created_by, started_at)
         VALUES ($1, $2, 'tokenized_csv', $3, 'running', $4, now())
         RETURNING id`,
        [context.workspace.id, id, file.name || dataset.rows[0].source_filename, context.user.id],
      );
      await client.query(
        `UPDATE datasets
            SET status = 'validating', source_filename = $1, source_sha256 = $2, quality_report = $3::jsonb, updated_at = now()
          WHERE id = $4 AND workspace_id = $5`,
        [file.name || dataset.rows[0].source_filename, parsed.sha256, JSON.stringify(qualityReport), id, context.workspace.id],
      );
      for (const event of parsed.events) {
        const values = eventSchema.parse(event);
        await client.query(
          `INSERT INTO trader_events
            (workspace_id, dataset_id, event_id, trader_token, occurred_at, type, venue_id, market_id, market_type,
             side, price, quantity, stake_amount, payout_amount, deposit_amount, withdrawal_amount, balance_before,
             balance_after, policy_event_type, policy_event_value, realized_result, placed_at, settled_at, provenance, source_row_number)
           VALUES ($1, $2, $3, $4, $5, $6::event_type, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26)
           ON CONFLICT (dataset_id, event_id) DO NOTHING`,
          [context.workspace.id, id, values.event_id, values.trader_token, values.occurred_at, values.type, values.venue_id,
            values.market_id ?? null, values.market_type ?? null, values.side ?? null, values.price ?? null, values.quantity ?? null,
            values.stake_amount ?? null, values.payout_amount ?? null, values.deposit_amount ?? null, values.withdrawal_amount ?? null,
            values.balance_before ?? null, values.balance_after ?? null, values.policy_event_type ?? null, values.policy_event_value ?? null,
            values.realized_result ?? null, values.placed_at ?? null, values.settled_at ?? null,
            JSON.stringify(values.provenance ?? {}), values.source_row_number],
        );
      }
      const finalStatus = parsed.errors.length ? "rejected" : "ready";
      await client.query(
        `UPDATE datasets
            SET status = $1::dataset_status, upload_status = $6, row_count = $2, trader_count = $3, starts_at = $4, ends_at = $5,
            content_type = 'text/csv', size_bytes = $7, malware_scan_status = 'skipped', uploaded_at = now(), updated_at = now()
          WHERE id = $8`,
        [finalStatus, parsed.events.length, traders.size, startsAt, endsAt, finalStatus === "ready" ? "processed" : "failed", file.size, id],
      );
      await client.query(
        `UPDATE ingestion_jobs
            SET status = $1::job_status, row_count = $2, error_count = $3, errors = $4::jsonb, finished_at = now()
          WHERE id = $5`,
        [parsed.errors.length ? "failed" : "succeeded", parsed.events.length, parsed.errors.length, JSON.stringify(parsed.errors), job.rows[0].id],
      );
      return { jobId: job.rows[0].id, status: finalStatus, rowCount: parsed.events.length, errorCount: parsed.errors.length };
    });
    await recordAudit({ workspaceId: context.workspace.id, actorUserId: context.user.id, action: "dataset.uploaded", targetType: "dataset", targetId: id, details: { sourceFilename: file.name, rowCount: result.rowCount, errorCount: result.errorCount, status: result.status } });
    return NextResponse.json({ ingestion: result, qualityReport });
  } catch (error) {
    return routeError(error);
  }
}
