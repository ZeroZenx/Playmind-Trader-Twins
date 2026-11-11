import { getWorkspaceContext } from "@/src/lib/workspace";
import { Landing } from "@/src/components/landing";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const context = await getWorkspaceContext().catch(() => null);
  if (context) redirect("/dashboard");
  return <Landing />;
}
