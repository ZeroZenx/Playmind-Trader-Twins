import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBehaviorObservations } from '../src/engine/behavior.mjs';
import { estimateTwins } from '../src/engine/estimate.mjs';
import { SETTLEMENT_RULES, simulateTwinV2 } from '../src/engine/simulate.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';
import { assessReadiness, OUTCOME_TIMING_LOW_SHARE, renderReadinessMarkdown } from '../src/intake/readiness.mjs';

// Outcome timing (ADR-018), on SYNTHETIC traders whose outcomes settle about 20 minutes after
// each trade while they re-enter after 2 to 12. Most outcomes are still open at the next
// trade, as on Polymarket and other in-play venues. With settled_at the twin recovers chase
// and stop behavior; without it (the behavior-0.2.0 assumption) both degrade.

const DELAY = { medianMinutes: 20, spread: 0.6 };
const data = generateBehavioralDataset({
  seed: 77,
  archetypes: ['steady', 'chaser', 'shrinker', 'quits-when-down'],
  tradersPerArchetype: 14,
  sessionsPerTrader: 60,
  includeBalances: false,
  settlementDelay: DELAY
});
const withoutSettlement = data.events.map(({ settled_at: _dropped, ...event }) => event);

function medians(fit) {
  const groups = {};
  fit.twins.forEach((twin, index) => {
    (groups[data.truth.traders[index].archetype] ??= []).push(twin);
  });
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  };
  return Object.fromEntries(Object.entries(groups).map(([name, twins]) => [name, {
    chase: median(twins.map((twin) => twin.parameters.chaseCoefficient.estimate)),
    stopUp: median(twins.map((twin) => twin.parameters.stopHazard.up.estimate)),
    stopDownLarge: median(twins.map((twin) => twin.parameters.stopHazard.down_large.estimate)),
    lag: median(twins.map((twin) => twin.parameters.settlementLagMinutes.estimate))
  }]));
}

const withFit = estimateTwins(data.events, { dataLabel: 'SYNTHETIC' });
const withoutFit = estimateTwins(withoutSettlement, { dataLabel: 'SYNTHETIC' });
const recovered = medians(withFit);
const assumed = medians(withoutFit);

test('the generator\'s settlement delay: SYNTHETIC trades carry settled_at after the trade, and most are still open at the next trade', () => {
  const trades = data.events.filter((event) => event.type === 'trade');
  assert.ok(trades.every((event) => event.realized_result === null || Date.parse(event.settled_at) >= Date.parse(event.occurred_at)));
  assert.equal(data.truth.options.settlementDelay.medianMinutes, DELAY.medianMinutes);
  const settledTrades = buildBehaviorObservations(data.events).flatMap((record) => record.trades).filter((trade) => trade.settlement?.knownBeforeNextTrade !== null && trade.settlement?.knownBeforeNextTrade !== undefined);
  const knownShare = settledTrades.filter((trade) => trade.settlement.knownBeforeNextTrade).length / settledTrades.length;
  assert.ok(knownShare < 0.5, `share known before the next trade ${knownShare}`);
  const unchanged = generateBehavioralDataset({ seed: 77, tradersPerArchetype: 1, sessionsPerTrader: 5 });
  assert.ok(unchanged.events.every((event) => event.settled_at === undefined), 'no delay, no settled_at');
});

test('with settled_at the twin recovers chase and stop behavior, and the settlement lag', () => {
  assert.ok(Math.abs(recovered.chaser.chase - 1.8) < 0.25, `chaser chase ${recovered.chaser.chase}`);
  assert.ok(Math.abs(recovered.shrinker.chase - 0.6) < 0.12, `shrinker chase ${recovered.shrinker.chase}`);
  assert.ok(Math.abs(recovered.steady.chase - 1) < 0.1, `steady chase ${recovered.steady.chase}`);
  const gradient = recovered['quits-when-down'].stopDownLarge - recovered['quits-when-down'].stopUp;
  assert.ok(gradient > 0.3, `quits-when-down stop gradient ${gradient} (truth 0.55)`);
  for (const group of Object.values(recovered)) assert.ok(Math.abs(group.lag - DELAY.medianMinutes) < 3, `lag ${group.lag}`);
});

test('without settled_at (outcomes assumed known before the next trade) chase and stop behavior degrade', () => {
  assert.ok(Math.abs(Math.log(assumed.chaser.chase)) < Math.abs(Math.log(recovered.chaser.chase)) / 2, `chaser chase ${assumed.chaser.chase}`);
  assert.ok(Math.abs(Math.log(assumed.shrinker.chase)) < Math.abs(Math.log(recovered.shrinker.chase)) / 2, `shrinker chase ${assumed.shrinker.chase}`);
  const gradient = assumed['quits-when-down'].stopDownLarge - assumed['quits-when-down'].stopUp;
  const withGradient = recovered['quits-when-down'].stopDownLarge - recovered['quits-when-down'].stopUp;
  assert.ok(gradient < withGradient / 2, `stop gradient ${gradient} vs ${withGradient}`);
  assert.ok(withoutFit.twins.every((twin) => twin.parameters.settlementLagMinutes.status === 'not_estimable'));
});

test('simulator-0.3.0: simulated trades settle after a drawn lag and traders react only to settled outcomes; without settled_at nothing changes', () => {
  const chasers = withFit.twins.filter((_, index) => data.truth.traders[index].archetype === 'chaser').map((twin) => twin.traderToken);
  const run = simulateTwinV2(withFit, { traders: chasers, replicates: 3, sessions: 60, uncertainty: false, keepEvents: true, seed: 5 });
  const events = run.traders.flatMap((trader) => trader.runs.flatMap((replicate) => replicate.events.map((event) => ({ ...event, trader_token: `${trader.traderToken}:${replicate.replicate}` }))));
  const trades = events.filter((event) => event.type === 'trade');
  assert.ok(trades.length > 1000);
  assert.ok(trades.every((event) => Date.parse(event.settled_at) >= Date.parse(event.occurred_at)));
  assert.ok(run.traders.every((trader) => trader.mechanisms.settlement.simulated));
  // Refit the simulated events: with their settled_at the chase comes back; without it, it fades.
  const chaseOf = (fit) => {
    const values = fit.twins.map((twin) => twin.parameters.chaseCoefficient.estimate).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const settledChase = chaseOf(estimateTwins(events, { dataLabel: 'SYNTHETIC' }));
  const assumedChase = chaseOf(estimateTwins(events.map(({ settled_at: _dropped, ...event }) => event), { dataLabel: 'SYNTHETIC' }));
  assert.ok(settledChase > 1.5, `chase refitted with settled_at ${settledChase}`);
  assert.ok(assumedChase < 1.3, `chase refitted without settled_at ${assumedChase}`);

  const plain = simulateTwinV2(withoutFit, { traders: chasers, replicates: 2, sessions: 5, keepEvents: true, seed: 5 });
  assert.ok(plain.traders.every((trader) => !trader.mechanisms.settlement.simulated));
  assert.ok(plain.traders.every((trader) => trader.runs.every((replicate) => replicate.events.every((event) => event.settled_at === undefined))));
});

test('readiness reports the outcome-timing share, overall and by market type, and flags it when low', () => {
  const typed = data.events.map((event, index) => (event.type === 'trade' ? { ...event, market_type: index % 2 ? 'live' : 'pre-match' } : event));
  const timing = assessReadiness(typed, { label: 'SYNTHETIC' }).outcomeTiming;
  assert.ok(timing.share < OUTCOME_TIMING_LOW_SHARE && timing.low);
  assert.equal(timing.lowShareThreshold, OUTCOME_TIMING_LOW_SHARE);
  assert.deepEqual(timing.byMarketType.map((row) => row.marketType).sort(), ['live', 'pre-match']);
  assert.equal(timing.byMarketType.reduce((total, row) => total + row.comparable, 0), timing.comparable);
  assert.equal(timing.withSettlementTime + timing.assumed, timing.resolvedTrades);
  const markdown = renderReadinessMarkdown(assessReadiness(typed, { label: 'SYNTHETIC' }));
  assert.match(markdown, /## Outcome timing/);
  assert.match(markdown, /\*\*Low\*\*/);
  const untested = assessReadiness(withoutSettlement, { label: 'SYNTHETIC' }).outcomeTiming;
  assert.equal(untested.share, null);
  assert.equal(untested.low, false);
  assert.match(untested.note, /untested/);
});

test('a long-tailed settlement lag stays a valid time: simulated lags are capped at SETTLEMENT_RULES.maxLagDays', () => {
  // Without the cap, a lag median of 10 million minutes with a log SD of 4 draws lags past the
  // largest valid date, and the run throws (the OBSERVATIONAL Polymarket run found this).
  const fit = structuredClone(withFit);
  for (const twin of fit.twins) {
    twin.parameters.settlementLagMinutes.estimate = 1e7;
    twin.parameters.settlementLagMinutes.posterior.mean = Math.log(1e7);
    twin.parameters.settlementLagSpread.estimate = 4;
    twin.parameters.settlementLagSpread.posterior.mean = Math.log(4);
  }
  const run = simulateTwinV2(fit, { traders: fit.twins.slice(0, 4).map((twin) => twin.traderToken), replicates: 5, sessions: 10, uncertainty: false, keepEvents: true, seed: 3 });
  const maxMs = SETTLEMENT_RULES.maxLagDays * 86400000;
  let capped = 0;
  for (const trader of run.traders) {
    for (const replicate of trader.runs) {
      for (const event of replicate.events.filter((item) => item.type === 'trade')) {
        const lag = Date.parse(event.settled_at) - Date.parse(event.occurred_at);
        assert.ok(lag >= 0 && lag <= maxMs);
        if (lag === maxMs) capped += 1;
      }
    }
  }
  assert.ok(capped > 0, 'the cap binds on this long tail');
});
