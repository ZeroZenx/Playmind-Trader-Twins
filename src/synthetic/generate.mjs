import { createRng } from '../engine/rng.mjs';

const MARKET_TYPES = ['sports', 'politics', 'culture'];

export function generateSyntheticDataset(options = {}) {
  const seed = options.seed ?? 424242;
  const traderCount = options.traderCount ?? 12;
  const days = options.days ?? 21;
  const rng = createRng(seed);
  const events = [];
  const profiles = ['steady', 'high_intensity', 'deposit_limited'];
  let sequence = 1;

  for (let traderIndex = 1; traderIndex <= traderCount; traderIndex += 1) {
    const traderToken = `trader_${String(traderIndex).padStart(3, '0')}`;
    const profile = profiles[(traderIndex - 1) % profiles.length];
    const baseDeposit = profile === 'deposit_limited' ? 45 : profile === 'high_intensity' ? 120 : 75;
    const sessionsPerDay = profile === 'high_intensity' ? 2.1 : profile === 'steady' ? 1.2 : 0.8;
    const tradesPerSession = profile === 'high_intensity' ? 7 : profile === 'steady' ? 4 : 3;

    for (let day = 0; day < days; day += 1) {
      const sessionsToday = Math.max(1, Math.round(sessionsPerDay * (0.6 + rng.next() * 0.8)));
      for (let session = 0; session < sessionsToday; session += 1) {
        const sessionStart = new Date(Date.UTC(2026, 0, 1 + day, 9 + session * 4, traderIndex % 5));
        const depositAmount = Math.round(baseDeposit * (0.6 + rng.next() * 0.8) * 100) / 100;
        events.push({
          event_id: `evt_${String(sequence++).padStart(6, '0')}`,
          trader_token: traderToken,
          occurred_at: sessionStart.toISOString(),
          type: 'deposit',
          venue_id: 'synthetic-venue-001',
          market_id: null,
          market_type: null,
          deposit_amount: depositAmount,
          balance_before: 0,
          balance_after: depositAmount,
          source_row_number: sequence
        });

        const tradeCount = Math.max(1, Math.round(tradesPerSession * (0.7 + rng.next() * 0.7)));
        for (let trade = 0; trade < tradeCount; trade += 1) {
          const tradeTime = new Date(sessionStart.getTime() + (trade + 1) * 11 * 60000);
          const stake = Math.round((profile === 'high_intensity' ? 28 : 16) * (0.5 + rng.next() * 1.4) * 100) / 100;
          const realizedResult = rng.next() < (profile === 'high_intensity' ? 0.62 : 0.52)
            ? -Math.round(stake * (0.2 + rng.next() * 0.8) * 100) / 100
            : Math.round(stake * (0.1 + rng.next() * 1.1) * 100) / 100;
          events.push({
            event_id: `evt_${String(sequence++).padStart(6, '0')}`,
            trader_token: traderToken,
            occurred_at: tradeTime.toISOString(),
            type: 'trade',
            venue_id: 'synthetic-venue-001',
            market_id: `market_${1 + (trade + day) % 8}`,
            market_type: MARKET_TYPES[(traderIndex + trade + day) % MARKET_TYPES.length],
            side: rng.pick(['yes', 'no']),
            price: Math.round((0.25 + rng.next() * 0.5) * 100) / 100,
            quantity: Math.max(1, Math.round(stake / 2)),
            stake_amount: stake,
            realized_result: (trade + day + traderIndex) % 7 === 0 ? null : realizedResult,
            source_row_number: sequence
          });
        }
      }
    }

    if (traderIndex % 3 === 0) {
      events.push({
        event_id: `evt_${String(sequence++).padStart(6, '0')}`,
        trader_token: traderToken,
        occurred_at: new Date(Date.UTC(2026, 0, 12, 14, traderIndex)).toISOString(),
        type: 'policy_event',
        venue_id: 'synthetic-venue-001',
        policy_event_type: 'cooldown',
        policy_event_value: 30,
        source_row_number: sequence
      });
    }
  }

  return {
    name: 'synthetic-policy-test-2026-01',
    venueId: 'synthetic-venue-001',
    isSynthetic: true,
    seed,
    events: events.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at)),
    profileCount: profiles.length
  };
}
