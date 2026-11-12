import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEHAVIOR_VERSION,
  buildBehaviorSignals,
  buildSignals,
  drawdownBucket,
  validateEvents
} from '../src/engine/index.mjs';

// Hand-built SYNTHETIC event sequences. No market or contract fields anywhere.
// Unless a test says otherwise, every stake is 10, so the median stake is 10,
// the flat band is +/-5, and the large-drawdown edge is -20.

const START = Date.parse('2026-01-05T00:00:00.000Z');
const FAR_END = '2026-02-01T00:00:00.000Z';

// Event builders for one trader. Times are minutes after START.
function eventsFor(token) {
  let row = 0;
  const make = (minute, type, fields) => {
    row += 1;
    return {
      event_id: `${token}_${String(row).padStart(3, '0')}`,
      trader_token: token,
      occurred_at: new Date(START + minute * 60000).toISOString(),
      type,
      venue_id: 'synthetic-test-venue',
      source_row_number: row,
      ...fields
    };
  };
  return {
    trade: (minute, stake, result, fields = {}) => make(minute, 'trade', { stake_amount: stake, realized_result: result, ...fields }),
    deposit: (minute, amount, fields = {}) => make(minute, 'deposit', { deposit_amount: amount, ...fields })
  };
}

function single(events, options) {
  const results = buildBehaviorSignals(events, options);
  assert.equal(results.length, 1);
  return results[0];
}

function assertClose(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
}

// Bets double after a loss, and keep doubling through a losing run.
function chaserEvents() {
  const t = eventsFor('chaser');
  return [
    // Session 1. Trades 2 and 3 have fewer than 3 previous stakes, so they are skipped.
    t.trade(0, 10, 5),
    t.trade(5, 10, 5),
    t.trade(10, 10, 5),
    t.trade(15, 10, 5), //   after a win: 10 / median(10,10,10) = 1
    t.trade(20, 10, -10), // after a win: 1. Loss 1 of a run.
    t.trade(25, 20, -20), // after loss 1: 20 / 10 = 2 (signal 1). Loss 2.
    t.trade(30, 40, -40), // after loss 2: escalation point (1, log 40/20). Loss 3.
    t.trade(35, 80, 80), //  after loss 3: escalation point (2, log 80/20).
    t.trade(40, 10, 5), //   after a win: 10 / median(10,10,10,10,10,20,40,80) = 1
    // Session 2, 160 minutes later.
    t.trade(200, 10, -10), // after a win (previous session): 1
    t.trade(205, 20, 20), //  after a loss: 20 / 10 = 2
    t.trade(210, 10, 5) //    after a win: 1
  ];
}

// Halves the stake after a loss and waits 20 minutes. After a win: stake 10, 5 minutes later.
function shrinkerEvents() {
  const t = eventsFor('shrinker');
  return [
    t.trade(0, 10, 4),
    t.trade(5, 10, 4),
    t.trade(10, 10, 4),
    t.trade(15, 10, -10), // after a win: 1
    t.trade(35, 5, 2), //    after a loss: 5 / 10 = 0.5
    t.trade(40, 10, -10), // after a win: 1
    t.trade(60, 5, 2), //    after a loss: 0.5
    t.trade(65, 10, 4), //   after a win: 1
    t.trade(70, 10, -10), // after a win: 1
    t.trade(90, 5, 2) //     after a loss: 0.5
  ];
}

// Ends every session once the running result is down large (below -20), never otherwise.
function quitterEvents() {
  const t = eventsFor('quitter');
  return [
    // Session 1: running -10, -20, -30, then stops.
    t.trade(0, 10, -10),
    t.trade(5, 10, -10),
    t.trade(10, 10, -10),
    // Session 2: running +10, +20, +10, 0, -10, -20, -30, then stops.
    t.trade(120, 10, 10),
    t.trade(125, 10, 10),
    t.trade(130, 10, -10),
    t.trade(135, 10, -10),
    t.trade(140, 10, -10),
    t.trade(145, 10, -10),
    t.trade(150, 10, -10),
    // Session 3: running +10, 0, -10, -25, then stops. Last session in the data.
    t.trade(240, 10, 10),
    t.trade(245, 10, -10),
    t.trade(250, 10, -10),
    t.trade(255, 15, -15)
  ];
}

// Deposits 10 minutes after the balance runs out, twice. The third time it doesn't come back for hours.
function refuelerEvents({ withBalances = true } = {}) {
  const t = eventsFor('refueler');
  const b = (before, after) => (withBalances ? { balance_before: before, balance_after: after } : {});
  return [
    t.deposit(0, 30, b(0, 30)),
    t.trade(5, 10, -10, b(30, 20)),
    t.trade(10, 10, -10, b(20, 10)),
    t.trade(15, 10, -10, b(10, 0)), //  trigger 1: balance drops below 10, and 3rd loss in a row
    t.deposit(25, 30, b(0, 30)), //     refuel within 60 minutes
    t.trade(30, 10, -10, b(30, 20)),
    t.trade(35, 10, -10, b(20, 10)),
    t.trade(40, 10, -10, b(10, 0)), //  trigger 2
    t.deposit(50, 30, b(0, 30)), //     refuel within 60 minutes
    t.trade(55, 10, -10, b(30, 20)),
    t.trade(60, 10, -10, b(20, 10)),
    t.trade(65, 10, -10, b(10, 0)), //  trigger 3: no deposit within 60 minutes
    t.deposit(300, 30, b(0, 30)),
    t.trade(305, 10, 10, b(30, 40))
  ];
}

// One missing outcome in the middle of a session.
function partlyMissingEvents() {
  const t = eventsFor('missing');
  return [
    t.trade(0, 10, 10), //    running +10: up
    t.trade(5, 10, -10), //   running 0: flat
    t.trade(10, 10, null), // outcome missing: the running result is unknown from here to the session end
    t.trade(15, 10, -10),
    t.trade(20, 10, 10)
  ];
}

// Session 1 has balances but no realized_result. Session 2 has realized_result but no balances.
function mixedSourceEvents() {
  const t = eventsFor('balance');
  return [
    t.trade(0, 10, null, { balance_before: 100, balance_after: 90 }), //   running -10
    t.deposit(5, 50, { balance_before: 90, balance_after: 140 }), //        a transfer, not a result
    t.trade(10, 10, null, { balance_before: 140, balance_after: 130 }), // running 130 - 100 - 50 = -20
    t.trade(15, 10, null, { balance_before: 130, balance_after: 145 }), // running -5
    t.trade(200, 10, -10), // running -10
    t.trade(205, 10, -5) //   running -15
  ];
}

test('chaser: bets more after a loss than after a win, and escalation is measured separately', () => {
  const behavior = single(chaserEvents(), { minSampleSize: 2 });
  const stake = behavior.postOutcomeStake;

  assert.equal(behavior.version, BEHAVIOR_VERSION);
  assert.equal(stake.afterLoss.n, 2);
  assertClose(stake.afterLoss.value, 2, 'afterLoss median ratio');
  assertClose(stake.afterLoss.meanLogRatio, Math.log(2), 'afterLoss mean log ratio');
  assert.equal(stake.afterWin.n, 5);
  assertClose(stake.afterWin.value, 1, 'afterWin median ratio');
  assertClose(stake.lossMinusWin.value, 1, 'loss minus win');
  assertClose(stake.lossMinusWin.logRatioDifference, Math.log(2), 'log ratio difference');
  assert.equal(stake.lossMinusWin.n, 2);
  assert.equal(stake.excluded.insufficientHistory, 2);

  // Four trades follow a loss. Two go to signal 1, two to signal 6. None is used twice.
  assert.equal(stake.excluded.escalationPosition, 2);
  assert.equal(behavior.escalation.n, 2);
  assert.equal(stake.afterLoss.n + stake.excluded.escalationPosition, 4);

  // Points (1, log 2) and (2, log 4): slope = (log 2 + 2 * log 4) / (1 + 4) = log 2.
  assertClose(behavior.escalation.logSlope, Math.log(2), 'escalation log slope');
  assertClose(behavior.escalation.value, 2, 'escalation multiplier per loss');
  assert.equal(behavior.escalation.runs, 1);
});

test('shrinker: bets less and waits longer after a loss, so loss-minus-win is negative', () => {
  const behavior = single(shrinkerEvents(), { minSampleSize: 2 });
  const stake = behavior.postOutcomeStake;

  assert.equal(stake.afterLoss.n, 3);
  assertClose(stake.afterLoss.value, 0.5, 'afterLoss median ratio');
  assert.equal(stake.afterWin.n, 4);
  assertClose(stake.afterWin.value, 1, 'afterWin median ratio');
  assertClose(stake.lossMinusWin.value, -0.5, 'loss minus win');
  assertClose(stake.lossMinusWin.logRatioDifference, Math.log(0.5), 'log ratio difference');
  assert.equal(behavior.escalation.n, 0);
  assert.equal(behavior.escalation.value, null);

  for (const scope of ['anySession', 'withinSession']) {
    const latency = behavior.reentryLatency[scope];
    assert.equal(latency.afterLoss.n, 3, scope);
    assert.equal(latency.afterLoss.value, 20, scope);
    assert.equal(latency.afterWin.n, 6, scope);
    assert.equal(latency.afterWin.value, 5, scope);
    assert.equal(latency.lossMinusWin.value, 15, scope);
  }
  // The final trade has no next trade, so it has no latency.
  assert.equal(behavior.reentryLatency.excluded.noNextTrade, 1);
});

test('quitter-when-down: sessions end in the large-drawdown bucket and nowhere else', () => {
  const behavior = single(quitterEvents(), { minSampleSize: 2, observationEnd: FAR_END });
  const { buckets, edges } = behavior.stopBehavior;

  assert.deepEqual(edges, { flatBand: 5, largeDrawdown: 20 });
  assert.deepEqual(
    Object.fromEntries(Object.entries(buckets).map(([bucket, tally]) => [bucket, [tally.n, tally.stops, tally.value]])),
    { up: [4, 0, 0], flat: [2, 0, 0], down_small: [5, 0, 0], down_large: [3, 3, 1] }
  );

  // Max drawdown per session from the session start: 30, 30, 25.
  assert.equal(behavior.sessionDrawdown.n, 3);
  assert.equal(behavior.sessionDrawdown.value, 30);
  assert.equal(behavior.sessionDrawdown.valueInStakes, 3);
  assert.equal(behavior.sessionDrawdown.worst, 30);
  assert.deepEqual(behavior.sessionDrawdown.sources, { balance: 0, realized_result: 3 });
});

test('quitter-when-down: the last trade in the data is censored, not counted as a stop', () => {
  // With the default observation end (the last event), session 3 might have continued.
  const behavior = single(quitterEvents(), { minSampleSize: 2 });
  assert.equal(behavior.stopBehavior.excluded.censored, 1);
  assert.equal(behavior.stopBehavior.buckets.down_large.n, 2);
  assert.equal(behavior.stopBehavior.buckets.down_large.stops, 2);
});

test('refueler: deposits soon after the balance runs low, and the losing-streak trigger agrees', () => {
  const behavior = single(refuelerEvents(), { minSampleSize: 3 });
  const { refuel } = behavior;

  assert.equal(refuel.windowMinutes, 60);
  assert.equal(refuel.primary, 'lowBalance');
  assert.equal(refuel.lowBalance.threshold, 10);
  assert.equal(refuel.lowBalance.n, 3);
  assert.equal(refuel.lowBalance.refueled, 2);
  assertClose(refuel.lowBalance.value, 2 / 3, 'low-balance refuel probability');
  assert.equal(refuel.losingStreak.n, 3);
  assertClose(refuel.losingStreak.value, 2 / 3, 'losing-streak refuel probability');

  // Deposits came 10 minutes after each trigger, so a 5-minute window catches none.
  const short = single(refuelerEvents(), { minSampleSize: 3, refuelWindowMinutes: 5 });
  assert.equal(short.refuel.lowBalance.n, 3);
  assert.equal(short.refuel.lowBalance.value, 0);
});

test('refueler without balance fields falls back to the losing-streak trigger', () => {
  const behavior = single(refuelerEvents({ withBalances: false }), { minSampleSize: 3 });
  const { refuel } = behavior;

  assert.equal(refuel.primary, 'losingStreak');
  assert.equal(refuel.lowBalance.value, null);
  assert.match(refuel.lowBalance.reason, /balance_before and balance_after unavailable/);
  assert.equal(refuel.losingStreak.n, 3);
  assert.equal(refuel.losingStreak.refueled, 2);
  assertClose(refuel.losingStreak.value, 2 / 3, 'losing-streak refuel probability');
});

test('session drawdown uses balances net of deposits, and falls back to realized_result per session', () => {
  const behavior = single(mixedSourceEvents(), { minSampleSize: 1, observationEnd: FAR_END });

  // Session 1 bottoms at -20 after netting out the 50 deposit. Session 2 bottoms at -15.
  assert.deepEqual(behavior.sessionDrawdown.sources, { balance: 1, realized_result: 1 });
  assert.equal(behavior.sessionDrawdown.n, 2);
  assert.equal(behavior.sessionDrawdown.value, 17.5);
  assert.equal(behavior.sessionDrawdown.worst, 20);

  // Running results -10, -20, -5 (stop) and -10, -15 (stop).
  const { buckets } = behavior.stopBehavior;
  assert.deepEqual([buckets.down_small.n, buckets.down_small.stops], [4, 1]);
  assert.deepEqual([buckets.flat.n, buckets.flat.stops], [1, 1]);

  // Balances moved on session 1's trades, but their outcomes stay unavailable.
  assert.equal(behavior.inputs.tradesMissingOutcome, 3);
  assert.equal(behavior.postOutcomeStake.excluded.missingOutcome, 3);
  assert.match(behavior.refuel.lowBalance.reason, /incomplete: 3 of 5/);
});

test('missing outcomes stay unavailable: not losses, not wins, not zero', () => {
  const behavior = single(partlyMissingEvents(), { minSampleSize: 1, losingStreakLength: 2, observationEnd: FAR_END });

  assert.equal(behavior.inputs.tradesWithOutcome, 4);
  assert.equal(behavior.inputs.tradesMissingOutcome, 1);

  // Only the two trades before the gap have a known running result. As zero, the
  // missing trade would have landed in "flat".
  const { buckets, excluded } = behavior.stopBehavior;
  assert.equal(buckets.up.n, 1);
  assert.equal(buckets.flat.n, 1);
  assert.equal(buckets.down_small.n, 0);
  assert.equal(excluded.unknownState, 3);

  // The session's running result is incomplete, so it has no drawdown.
  assert.equal(behavior.sessionDrawdown.value, null);
  assert.equal(behavior.sessionDrawdown.incompleteSessions, 1);

  // The missing outcome is neither a push nor a loss. It breaks the loss run, so the
  // loss after it starts a new run (signal 1) instead of extending one (signal 6).
  const stake = behavior.postOutcomeStake;
  assert.equal(stake.excluded.missingOutcome, 1);
  assert.equal(stake.excluded.push, 0);
  assert.equal(stake.excluded.escalationPosition, 0);
  assert.equal(stake.afterLoss.n, 1);
  assert.equal(behavior.escalation.n, 0);
  assert.equal(behavior.refuel.losingStreak.n, 0);

  assert.equal(behavior.reentryLatency.anySession.afterLoss.n, 2);
  assert.equal(behavior.reentryLatency.excluded.missingOutcome, 1);
});

test('a trader with no realized outcomes gets null outcome signals with reasons', () => {
  const t = eventsFor('unknown');
  const events = [t.trade(0, 10, null), t.trade(5, 10, null), t.trade(10, 10, null), t.trade(15, 10), t.trade(20, 10)];
  const behavior = single(events, { minSampleSize: 1, observationEnd: FAR_END });

  assert.equal(behavior.inputs.tradesMissingOutcome, 5);
  for (const value of [
    behavior.postOutcomeStake.afterLoss,
    behavior.postOutcomeStake.afterWin,
    behavior.reentryLatency.anySession.afterLoss,
    behavior.escalation,
    behavior.refuel.losingStreak
  ]) {
    assert.equal(value.value, null);
    assert.equal(value.n, 0);
    assert.match(value.reason, /realized_result unavailable/);
  }
  assert.equal(behavior.sessionDrawdown.value, null);
  assert.equal(behavior.stopBehavior.excluded.unknownState, 5);
  for (const tally of Object.values(behavior.stopBehavior.buckets)) assert.equal(tally.n, 0);

  // The existing summary signals still work on the same data.
  assert.equal(buildSignals(events)[0].missingRealizedOutcomeCount, 5);
});

test('signals below the minimum sample size return null with a reason', () => {
  const strict = single(shrinkerEvents());
  assert.equal(strict.postOutcomeStake.afterLoss.value, null);
  assert.equal(strict.postOutcomeStake.afterLoss.n, 3);
  assert.match(strict.postOutcomeStake.afterLoss.reason, /n=3 is below the minimum sample size of 5/);
  assert.equal(strict.postOutcomeStake.lossMinusWin.value, null);
  assert.match(strict.postOutcomeStake.lossMinusWin.reason, /afterLoss/);

  // A per-signal minimum overrides the global one for that signal only.
  const relaxed = single(shrinkerEvents(), { minSampleSizes: { postOutcomeStake: 3 } });
  assertClose(relaxed.postOutcomeStake.lossMinusWin.value, -0.5, 'loss minus win');
  assert.equal(relaxed.reentryLatency.anySession.afterLoss.value, null);
  assert.equal(relaxed.reentryLatency.anySession.afterWin.value, 5);
});

test('output is deterministic and independent of input order; no market fields needed', () => {
  const events = [
    ...chaserEvents(),
    ...shrinkerEvents(),
    ...quitterEvents(),
    ...refuelerEvents(),
    ...partlyMissingEvents(),
    ...mixedSourceEvents()
  ];
  const quality = validateEvents(events);
  assert.equal(quality.valid, true, quality.errors.join('\n'));
  for (const field of ['market_id', 'market_type', 'side', 'price', 'quantity']) {
    assert.ok(events.every((event) => event[field] === undefined), field);
  }

  const forward = buildBehaviorSignals(events);
  const reversed = buildBehaviorSignals([...events].reverse());
  const interleaved = buildBehaviorSignals(events.filter((_, index) => index % 2).concat(events.filter((_, index) => !(index % 2))));
  assert.deepEqual(reversed, forward);
  assert.deepEqual(interleaved, forward);
  assert.deepEqual(forward.map((record) => record.traderToken), ['balance', 'chaser', 'missing', 'quitter', 'refueler', 'shrinker']);
  assert.ok(forward.every((record) => record.version === BEHAVIOR_VERSION));
});

test('drawdown bucket edges are inclusive toward flat', () => {
  assert.equal(drawdownBucket(5.01, 10), 'up');
  assert.equal(drawdownBucket(5, 10), 'flat');
  assert.equal(drawdownBucket(-5, 10), 'flat');
  assert.equal(drawdownBucket(-5.01, 10), 'down_small');
  assert.equal(drawdownBucket(-20, 10), 'down_small');
  assert.equal(drawdownBucket(-20.01, 10), 'down_large');
  assert.equal(drawdownBucket(-20.01, 10, { largeDrawdownStakes: 3 }), 'down_small');
  assert.equal(drawdownBucket(null, 10), null);
});

test('invalid options are rejected', () => {
  const events = shrinkerEvents();
  assert.throws(() => buildBehaviorSignals(events, { largeDrawdownStakes: 0.25 }), RangeError);
  assert.throws(() => buildBehaviorSignals(events, { minSampleSizes: { chase: 3 } }), RangeError);
  assert.throws(() => buildBehaviorSignals(events, { refuelWindowMinute: 30 }), RangeError);
  assert.throws(() => buildBehaviorSignals(events, { observationEnd: 'not a date' }), RangeError);
});
