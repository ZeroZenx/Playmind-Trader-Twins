import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function routeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed";
  if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
  if (message === "FORBIDDEN") return NextResponse.json({ error: message }, { status: 403 });
  if (message === "BLOB_STORAGE_NOT_CONFIGURED") return NextResponse.json({ error: "Object storage is not configured" }, { status: 503 });
  if (message === "Dataset not found" || message === "Experiment not found" || message === "Report not found") {
    return NextResponse.json({ error: message }, { status: 404 });
  }
  if (message.startsWith("Polymarket public API")) return NextResponse.json({ error: message }, { status: 502 });
  if (message.includes("DATABASE_URL is not configured")) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
  }
  if (/^(Dataset mismatch|Invalid upload path|Unsupported content type|Only CSV uploads|Uploaded file size|Dataset already has an experiment|Uploaded file was not found|CSV is empty|Direct PII fields|Required columns|CSV contains duplicate)/.test(message)) {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "Invalid request", issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) }, { status: 400 });
  }
  const safeMessage = process.env.NODE_ENV === "production" ? "Request failed" : message;
  return NextResponse.json({ error: safeMessage }, { status: 500 });
}
