export type VenueConnection = {
  venueId: string;
  displayName: string;
  mode: "read_only" | "disabled";
  capabilities: string[];
};

export const supportedVenues: VenueConnection[] = [
  {
    venueId: "polymarket",
    displayName: "Polymarket public data",
    mode: "read_only",
    capabilities: ["historical-import", "market-metadata"],
  },
  {
    venueId: "customer-batch",
    displayName: "Customer tokenized batch",
    mode: "read_only",
    capabilities: ["csv-upload", "quality-validation", "signal-runs"],
  },
];

export const liveExecutionBoundary = {
  enabled: false,
  orderPlacement: false,
  custody: false,
  reason: "PlayMind produces evidence reports and does not execute trades or manage funds.",
};

export type PublicMarket = {
  id: string;
  question: string;
  slug: string | null;
  active: boolean;
  closed: boolean;
  endDate: string | null;
  volume: number | null;
};

export async function fetchPolymarketPublicMarkets(limit = 20): Promise<PublicMarket[]> {
  const response = await fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${Math.min(Math.max(limit, 1), 100)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
    next: { revalidate: 60 },
  });
  if (!response.ok) throw new Error(`Polymarket public API returned ${response.status}`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error("Polymarket public API returned an unexpected response");
  const numberOrNull = (value: unknown) => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return payload.map((market) => {
    const item = market as Record<string, unknown>;
    return {
      id: String(item.id ?? item.conditionId ?? "unknown"),
      question: String(item.question ?? item.title ?? "Untitled market"),
      slug: item.slug ? String(item.slug) : null,
      active: Boolean(item.active),
      closed: Boolean(item.closed),
      endDate: item.endDate ? String(item.endDate) : null,
      volume: numberOrNull(item.volume),
    };
  });
}
