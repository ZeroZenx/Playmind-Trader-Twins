import { NextResponse } from "next/server";

export function routeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed";
  if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
  if (message === "FORBIDDEN") return NextResponse.json({ error: message }, { status: 403 });
  if (message.startsWith("Polymarket public API")) return NextResponse.json({ error: message }, { status: 502 });
  if (message.includes("DATABASE_URL is not configured")) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
  }
  return NextResponse.json({ error: message }, { status: 400 });
}
