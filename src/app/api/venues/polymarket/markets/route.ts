import { NextResponse } from "next/server";
import { fetchPolymarketPublicMarkets, liveExecutionBoundary } from "@/src/lib/venue";
import { requireWorkspaceContext } from "@/src/lib/workspace";
import { routeError } from "@/src/lib/route";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireWorkspaceContext();
    const markets = await fetchPolymarketPublicMarkets();
    return NextResponse.json({ venue: "polymarket", mode: "read_only", markets, liveExecutionBoundary, source: "https://gamma-api.polymarket.com/docs" });
  } catch (error) {
    return routeError(error);
  }
}
