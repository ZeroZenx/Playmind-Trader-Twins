import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/src/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET() {
  const context = await getWorkspaceContext();
  if (!context) return NextResponse.json({ user: null, workspace: null }, { status: 401 });
  return NextResponse.json(context);
}
