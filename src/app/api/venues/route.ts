import { NextResponse } from "next/server";
import { query } from "@/src/lib/db";
import { liveExecutionBoundary, supportedVenues } from "@/src/lib/venue";
import { routeError } from "@/src/lib/route";
import { requireWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const context = await requireWorkspaceContext();
    const result = await query(
      `SELECT venue_id, display_name, mode::text, capabilities, updated_at
         FROM venue_connections WHERE workspace_id = $1 ORDER BY display_name`,
      [context.workspace.id],
    );
    return NextResponse.json({ venues: result.rows.length ? result.rows : supportedVenues, liveExecutionBoundary });
  } catch (error) {
    return routeError(error);
  }
}
