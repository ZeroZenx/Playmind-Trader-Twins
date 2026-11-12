import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEHAVIOR_VERSION,
  DEFAULT_BEHAVIOR_OPTIONS,
  buildBehaviorObservations,
  buildBehaviorSignals,
  drawdownBucket,
  lowBalanceRefuelEpisodes
} from '../src/engine/index.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';

// SYNTHETIC data only. buildBehaviorSignals summarizes buildBehaviorObservations, so
// these tests recompute each summary from the observations independently and check that
// it matches the signal. Signal outputs themselves are pinned by test/behavior.test.mjs.

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;

const datasets = {
  balances: generateBehavioralDataset({ seed: 21, mode: 'population', traderCount: 25, sessionsPerTrader: { min: 1, max: 40 } }).events,
  plain: generateBehavioralDataset({ seed: 22, mode: 'population', traderCount: 25, sessionsPerTrader: { min: 1, max: 40 }, includeBalances: false, missingOutcomeShare: 0.2 }).events
};
const OPTIONS = { minSampleSize: 1 };

function pairs(events, options = OPTIONS) {
  const observations = buildBehaviorObservations(events, options);
  const signals = buildBehaviorSignals(events, options);
  assert.equal(observations.length, signals.length);
  return observations.map((record, index) => [record, signals[index]]);
}

test('observations carry the version, token, options, and inputs of the matching signals', () => {
  for (const events of Object.values(datasets)) {
    for (const [record, signal] of pairs(events)) {
      assert.equal(record.version, BEHAVIOR_VERSION);
      assert.equal(record.traderToken, signal.traderToken);
      assert.deepEqual(record.options, signal.options);
      assert.deepEqual(record.inputs, signal.inputs);
      assert.equal(record.trades.length, signal.inputs.tradeCount);
      assert.equal(record.sessions.length, signal.inputs.sessionCount);
      assert.equal(record.deposits.length, signal.inputs.depositCount);
      assert.equal(record.observationEndMs, Date.parse(record.options.observationEnd));
    }
  }
});

test('signal 1 and signal 6 summaries match their observations', () => {
  for (const events of Object.values(datasets)) {
    for (const [record, signal] of pairs(events)) {
      const { loss, win } = record.postOutcomeStake;
      const stake = signal.postOutcomeStake;
      assert.equal(stake.afterLoss.n, loss.length);
      assert.equal(stake.afterWin.n, win.length);
      if (loss.length) {
        assert.equal(stake.afterLoss.value, median(loss.map((episode) => episode.ratio)));
        assert.ok(Math.abs(stake.afterLoss.meanLogRatio - mean(loss.map((episode) => episode.logRatio))) < 1e-12);
      }
      for (const episode of [...loss, ...win]) {
        assert.equal(episode.response, episode.trigger + 1, 'the response is the next trade');
        assert.equal(Math.log(episode.ratio), episode.logRatio);
      }
      assert.deepEqual(stake.excluded, record.postOutcomeStake.excluded);

      const { points, runs } = record.escalation;
      assert.equal(signal.escalation.n, points.length);
      assert.equal(signal.escalation.runs, runs);
      assert.equal(new Set(points.map((point) => point.run)).size, runs);
      if (points.length) {
        const slope = points.reduce((total, point) => total + point.step * point.logRatio, 0)
          / points.reduce((total, point) => total + point.step * point.step, 0);
        assert.ok(Math.abs(signal.escalation.logSlope - slope) < 1e-12);
      }
      // Points from one run share the reference stake: the trade after the run's first loss.
      const references = new Map();
      for (const point of points) {
        if (references.has(point.run)) assert.equal(point.reference, references.get(point.run));
        references.set(point.run, point.reference);
        assert.equal(record.trades[point.reference].previousOutcome, 'loss');
      }
    }
  }
});

test('signal 2 latency summaries match their observations', () => {
  for (const events of Object.values(datasets)) {
    for (const [record, signal] of pairs(events)) {
      for (const scope of ['anySession', 'withinSession']) {
        for (const [side, key] of [['loss', 'afterLoss'], ['win', 'afterWin']]) {
          const values = record.reentryLatency[scope][side];
          assert.equal(signal.reentryLatency[scope][key].n, values.length);
          if (values.length) assert.equal(signal.reentryLatency[scope][key].value, median(values));
        }
      }
      // Within-session latencies never exceed the session gap, by definition.
      for (const minutes of [...record.reentryLatency.withinSession.loss, ...record.reentryLatency.withinSession.win]) {
        assert.ok(minutes <= DEFAULT_BEHAVIOR_OPTIONS.sessionGapMinutes);
      }
    }
  }
});

test('signal 3 and signal 4 summaries match the per-trade and per-session observations', () => {
  for (const events of Object.values(datasets)) {
    for (const [record, signal] of pairs(events)) {
      const complete = record.sessions.filter((session) => session.tradeCount && session.complete);
      assert.equal(signal.sessionDrawdown.n, complete.length);
      if (complete.length) assert.equal(signal.sessionDrawdown.value, median(complete.map((session) => session.maxDrawdown)));

      const tallies = {};
      let unknown = 0;
      let censored = 0;
      for (const trade of record.trades) {
        if (trade.running === null) { unknown += 1; continue; }
        if (trade.censored) { censored += 1; continue; }
        const bucket = drawdownBucket(trade.running, record.inputs.medianStake);
        tallies[bucket] ??= { n: 0, stops: 0 };
        tallies[bucket].n += 1;
        if (trade.endsSession) tallies[bucket].stops += 1;
      }
      assert.deepEqual(signal.stopBehavior.excluded, { unknownState: unknown, censored });
      for (const [bucket, tally] of Object.entries(signal.stopBehavior.buckets)) {
        assert.equal(tally.n, tallies[bucket]?.n ?? 0, bucket);
        assert.equal(tally.stops, tallies[bucket]?.stops ?? 0, bucket);
      }
      // Each session ends after exactly one trade, its last.
      for (const session of record.sessions) {
        const sessionTrades = record.trades.filter((trade) => trade.session === session.index);
        assert.equal(sessionTrades.filter((trade) => trade.endsSession).length, sessionTrades.length ? 1 : 0);
      }
    }
  }
});

test('signal 5 summaries match the refuel episodes, with the threshold passed in', () => {
  for (const events of Object.values(datasets)) {
    for (const [record, signal] of pairs(events)) {
      const count = (episodes) => ({
        n: episodes.filter((episode) => !episode.censored).length,
        refueled: episodes.filter((episode) => episode.refueled).length,
        censored: episodes.filter((episode) => episode.censored).length
      });
      const streak = count(record.refuel.losingStreak);
      assert.equal(signal.refuel.losingStreak.n, streak.n);
      assert.equal(signal.refuel.losingStreak.refueled, streak.refueled);
      assert.equal(signal.refuel.losingStreak.censored, streak.censored);

      const threshold = DEFAULT_BEHAVIOR_OPTIONS.lowBalanceStakeMultiple * record.inputs.medianStake;
      const { episodes, reason } = lowBalanceRefuelEpisodes(record, threshold);
      if (signal.refuel.primary === 'lowBalance') {
        assert.equal(reason, null);
        const low = count(episodes);
        assert.equal(signal.refuel.lowBalance.n, low.n);
        assert.equal(signal.refuel.lowBalance.refueled, low.refueled);
        for (const episode of episodes) {
          const trade = record.trades[episode.trade];
          assert.ok(trade.balanceBefore >= threshold && trade.balanceAfter < threshold);
        }
      } else {
        assert.equal(episodes, null);
        assert.equal(reason, signal.refuel.lowBalance.reason);
      }
    }
  }
});

test('trade observations record the previous outcome, the losing run, and balances', () => {
  const [record] = buildBehaviorObservations(datasets.balances.filter((event) => event.trader_token === 'syn_0001'));
  record.trades.forEach((trade, index) => {
    assert.equal(trade.index, index);
    assert.equal(trade.first, index === 0);
    assert.equal(trade.previousOutcome, index ? record.trades[index - 1].outcome : null);
    const previous = record.trades[index - 1];
    const expectedRun = trade.outcome === 'loss' ? (previous && previous.session === trade.session ? previous.lossRun : 0) + 1 : 0;
    assert.equal(trade.lossRun, expectedRun);
    assert.ok(Number.isFinite(trade.balanceBefore) && Number.isFinite(trade.balanceAfter));
  });
  assert.ok(record.deposits.every((deposit) => deposit.amount > 0 && deposit.refuel));
});

test('lowBalanceRefuelEpisodes needs balance fields on every trade and a finite threshold', () => {
  const [plain] = buildBehaviorObservations(datasets.plain.filter((event) => event.trader_token === 'syn_0001'));
  assert.deepEqual(lowBalanceRefuelEpisodes(plain, 10), { episodes: null, reason: 'balance_before and balance_after unavailable' });
  const [full] = buildBehaviorObservations(datasets.balances.filter((event) => event.trader_token === 'syn_0001'));
  assert.throws(() => lowBalanceRefuelEpisodes(full, null), RangeError);
  assert.throws(() => buildBehaviorObservations(datasets.plain, { refuelWindowMinute: 3 }), /buildBehaviorObservations: unknown option/);
});
