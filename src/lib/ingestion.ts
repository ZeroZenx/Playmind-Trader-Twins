import { createHash } from "node:crypto";
import { z } from "zod";

const forbidden = new Set([
  "name", "full_name", "first_name", "last_name", "username", "user_name", "customer_name",
  "email", "email_address", "phone", "address", "date_of_birth", "dob", "government_id",
  "ip", "ip_address", "device_fingerprint", "unmasked_account_id", "account_id", "customer_id",
]);

const requiredHeaders = ["event_id", "trader_token", "occurred_at", "type", "venue_id", "source_row_number"];

export const eventSchema = z.object({
  event_id: z.string().min(1),
  trader_token: z.string().min(1),
  occurred_at: z.string().datetime({ offset: true }),
  type: z.enum(["trade", "deposit", "withdrawal", "balance_snapshot", "policy_event", "restriction_event", "self_exclusion_event"]),
  venue_id: z.string().min(1),
  market_id: z.string().nullable().optional(),
  market_type: z.string().nullable().optional(),
  side: z.string().nullable().optional(),
  price: z.coerce.number().finite().nullable().optional(),
  quantity: z.coerce.number().finite().nullable().optional(),
  stake_amount: z.coerce.number().finite().nullable().optional(),
  payout_amount: z.coerce.number().finite().nullable().optional(),
  deposit_amount: z.coerce.number().finite().nullable().optional(),
  withdrawal_amount: z.coerce.number().finite().nullable().optional(),
  balance_before: z.coerce.number().finite().nullable().optional(),
  balance_after: z.coerce.number().finite().nullable().optional(),
  policy_event_type: z.string().nullable().optional(),
  policy_event_value: z.string().nullable().optional(),
  realized_result: z.coerce.number().finite().nullable().optional(),
  placed_at: z.string().datetime({ offset: true }).nullable().optional(),
  settled_at: z.string().datetime({ offset: true }).nullable().optional(),
  provenance: z.record(z.string(), z.string()).nullable().optional(),
  source_row_number: z.coerce.number().int().positive(),
});

export type IngestedEvent = z.infer<typeof eventSchema>;

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (character === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
}

// The normalization normalizeField in src/engine/validate.mjs applies: trim, lowercase, and
// whitespace to "_", so "Email Address" is checked as email_address. Used for the forbidden
// headers only. Required columns still match after trim and lowercase only, so this never loosens a check.
export function normalizeHeader(header: string) {
  return header.trim().toLowerCase().replace(/\s+/g, "_");
}

export function parseTokenizedCsv(csv: string) {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) throw new Error("CSV is empty");
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  const normalizedHeaders = headers.map((header) => header.toLowerCase());
  const prohibited = [...new Set(headers.map(normalizeHeader).filter((header) => forbidden.has(header)))];
  if (prohibited.length) throw new Error(`Direct PII fields are prohibited: ${prohibited.join(", ")}`);
  const missing = requiredHeaders.filter((header) => !normalizedHeaders.includes(header));
  if (missing.length) throw new Error(`Required columns are missing: ${missing.join(", ")}`);
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) throw new Error("CSV contains duplicate column headers");

  const events: IngestedEvent[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  const seen = new Set<string>();
  for (let index = 1; index < lines.length; index += 1) {
    const values = parseCsvLine(lines[index]);
    const raw = Object.fromEntries(headers.map((header, valueIndex) => [header, values[valueIndex] || null]));
    const result = eventSchema.safeParse(raw);
    if (!result.success) {
      errors.push({ row: index + 1, message: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
      continue;
    }
    if (seen.has(result.data.event_id)) {
      errors.push({ row: index + 1, message: `Duplicate event_id: ${result.data.event_id}` });
      continue;
    }
    seen.add(result.data.event_id);
    events.push(result.data);
  }
  return {
    events,
    errors,
    headers,
    sha256: createHash("sha256").update(csv).digest("hex"),
  };
}
