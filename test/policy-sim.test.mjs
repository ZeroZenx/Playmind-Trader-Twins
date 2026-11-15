import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_METRICS,
  BASELINE_SIMULATOR_VERSION,
  HARM_METRICS,
  NO_INTERVENTION,
  POLICY_PRIMARY_METRICS,
  POLICY_VERSION,
  RESPONSE_ASSUMPTIONS,
  SIMULATOR_VERSION,
  buildBehaviorObservations,
  buildSignals,
  buildTwins,
  comparePolicy,
  comparePolicyV2,
  estimateTwins,
  prepareSimulation,
  runPolicySweep,
  simulateReplicate,
  simulateTwinV2,
  validatePolicy,
  validatePolicyV2,
  validateResponseAssumptions
} from '../src/engine/index.mjs';
import { quantile, sum } from '../src/engine/stats.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';
import { truthFit } from '../src/synthetic/truth-twins.mjs';

// policy-0.2.0 on SYNTHETIC twins. Populations, horizons, and replicate counts are small so
// the file runs in a few seconds; the default sweep (200 replicates, 28 days) is for
// `npm run policy:sweep`. Policy results go only in thresholds here and in gitignored
// output: never in docs or commit messages.

const LABEL = 'SYNTHETIC';
const archetypes = truthFit(generateBehavioralDataset({ seed: 42, mode: 'archetypes', sessionsPerTrader: 150 }));
const tokenOf = Object.fromEntries(archetypes.twins.map((twin) => [twin.archetype, twin.traderToken]));
const population = generateBehavioralDataset({ seed: 43, mode: 'population', traderCount: 12, sessionsPerTrader: { min: 5, max: 60, scale: 'log' } });
const fit = estimateTwins(population.events, { dataLabel: LABEL });
const GAP_SECONDS = archetypes.behaviorOptions.sessionGapMinutes * 60;
const DAY = 86400;

const seconds = (event) => Date.parse(event.occurred_at) / 1000;
const trades = (run) => run.events.filter((event) => event.type === 'trade');
const mean = (values) => sum(values) / values.length;
const pairsOf = (result) => result.perTrader.flatMap((trader) => trader.runs ?? []);

// Policies whose trigger can't be reached in any run.
const NEVER = [
  { type: 'cooldown', durationMinutes: 30, lossStreak: 10000 },
  { type: 'stake_limit', maxStake: 1e9 },
  { type: 'deposit_limit', dailyLimit: 1e9 },
  { type: 'session_loss_limit', lossLimit: 1e9 }
];

test('policy configs are validated, with defaults filled in and the version attached', () => {
  const cooldown = validatePolicyV2({ type: 'cooldown', durationMinutes: 15 });
  assert.equal(cooldown.valid, true);
  assert.deepEqual(cooldown.policy, { type: 'cooldown', durationMinutes: 15, lossStreak: 3, drawdownThreshold: null, version: POLICY_VERSION });
  assert.equal(validatePolicyV2({ type: 'cooldown', durationMinutes: 15, lossStreak: null, drawdownThreshold: 50 }).valid, true);
  assert.equal(validatePolicyV2({ type: 'stake_limit', maxStake: 25, name: 'cap 25' }).policy.name, 'cap 25');
  assert.equal(validatePolicyV2({ type: 'deposit_limit', dailyLimit: 100 }).valid, true);
  assert.equal(validatePolicyV2({ type: 'session_loss_limit', lossLimit: 50 }).valid, true);

  const invalid = [
    [{ type: 'self_exclusion' }, /type must be one of/],
    [null, /type must be one of/],
    [{ type: 'cooldown' }, /durationMinutes is required/],
    [{ type: 'cooldown', durationMinutes: 0 }, /durationMinutes must be a positive number/],
    [{ type: 'cooldown', durationMinutes: 10, lossStreak: 2.5 }, /lossStreak must be a positive integer/],
    [{ type: 'cooldown', durationMinutes: 10, drawdownThreshold: -5 }, /drawdownThreshold must be a currency amount/],
    [{ type: 'cooldown', durationMinutes: 10, lossStreak: null, drawdownThreshold: null }, /needs a trigger/],
    [{ type: 'stake_limit', maxStake: 0.001 }, /maxStake must be a currency amount of at least 0.01/],
    [{ type: 'stake_limit', maxStake: '25' }, /maxStake must be a currency amount/],
    [{ type: 'deposit_limit', dailyLimit: Number.NaN }, /dailyLimit must be a currency amount/],
    [{ type: 'session_loss_limit' }, /lossLimit is required/],
    [{ type: 'session_loss_limit', lossLimit: 50, maxStake: 5 }, /has no field "maxStake"/],
    [{ type: 'stake_limit', maxStake: 25, version: 'policy-0.1.0' }, /version must be policy-0.2.0/],
    [{ type: 'stake_limit', maxStake: 25, name: '' }, /name must be a non-empty string/]
  ];
  for (const [policy, pattern] of invalid) {
    const result = validatePolicyV2(policy);
    assert.equal(result.valid, false, JSON.stringify(policy));
    assert.equal(result.policy, null);
    assert.ok(result.errors.some((error) => pattern.test(error)), `${JSON.stringify(policy)}: ${result.errors.join('; ')}`);
  }
});

test('response assumptions are validated, and missing ones take their defaults', () => {
  for (const [type, specs] of Object.entries(RESPONSE_ASSUMPTIONS)) {
    const { valid, values } = validateResponseAssumptions(type);
    assert.equal(valid, true);
    for (const [name, spec] of Object.entries(specs)) {
      assert.equal(values[name], spec.default, `${type}.${name}`);
      assert.ok(spec.range.includes(spec.default), `${type}.${name}: the default is in the range`);
      assert.ok(spec.description.length > 20);
    }
  }
  assert.deepEqual(RESPONSE_ASSUMPTIONS.cooldown.reboundMultiplier.range, [0.5, 1, 1.5]);
  assert.deepEqual(RESPONSE_ASSUMPTIONS.cooldown.leaveProbability.range, [0, 0.25, 0.5]);
  assert.deepEqual(RESPONSE_ASSUMPTIONS.cooldown.referencePoint.range, ['carry', 'reset']);
  assert.deepEqual(RESPONSE_ASSUMPTIONS.stake_limit.resubmitProbability.range, [0, 0.5, 1]);
  assert.deepEqual(RESPONSE_ASSUMPTIONS.deposit_limit.carryoverShare.range, [0, 0.5, 1]);
  assert.deepEqual(RESPONSE_ASSUMPTIONS.session_loss_limit.quickReturnProbability.range, [0, 0.5, 1]);

  const invalid = [
    ['cooldown', { reboundMultiplier: 0 }, /reboundMultiplier must be a positive number/],
    ['cooldown', { reboundTrades: 1.5 }, /reboundTrades must be a positive integer/],
    ['cooldown', { leaveProbability: 1.2 }, /leaveProbability must be a number from 0 to 1/],
    ['cooldown', { referencePoint: 'session' }, /referencePoint must be one of carry, reset/],
    ['stake_limit', { resubmitProbability: -0.1 }, /resubmitProbability must be a number from 0 to 1/],
    ['deposit_limit', { carryoverShare: 2 }, /carryoverShare must be a number from 0 to 1/],
    ['session_loss_limit', { quickReturnProbability: '1' }, /quickReturnProbability must be a number from 0 to 1/],
    ['stake_limit', { leaveProbability: 0.5 }, /has no response assumption "leaveProbability"/],
    ['self_exclusion', {}, /type must be one of/]
  ];
  for (const [type, assumptions, pattern] of invalid) {
    const result = validateResponseAssumptions(type, assumptions);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => pattern.test(error)), `${type} ${JSON.stringify(assumptions)}: ${result.errors.join('; ')}`);
  }
});

test('comparison and sweep options are validated; a policy comparison needs a days horizon', () => {
  const spec = { policy: { type: 'stake_limit', maxStake: 25 } };
  assert.throws(() => comparePolicyV2(archetypes, spec, { sessions: 20 }), /days horizon/);
  assert.throws(() => comparePolicyV2(archetypes, spec, { replicate: 3 }), /unknown option "replicate"/);
  assert.throws(() => comparePolicyV2(archetypes, { policy: { type: 'stake_limit' } }), /maxStake is required/);
  assert.throws(() => comparePolicyV2(archetypes, { ...spec, assumptions: { resubmitProbability: 3 } }), /resubmitProbability/);
  assert.throws(() => comparePolicyV2(archetypes, spec, { primary: { harm: 'trades' } }), /primary.harm must be a harm metric/);
  assert.throws(() => runPolicySweep(archetypes, { design: 'random' }), /design must be one of/);
  assert.throws(() => runPolicySweep(archetypes, { policies: ['self_exclusion'] }), /unknown policy type/);
  assert.throws(() => runPolicySweep(archetypes, { policies: ['stake_limit'], settings: { stake_limit: [{ maxStake: -1 }] } }), /maxStake/);
  assert.throws(() => runPolicySweep(archetypes, { policies: ['stake_limit'], settings: { cooldown: [] } }), /not in policies/);
  assert.throws(() => runPolicySweep(archetypes, { policies: ['stake_limit'], assumptions: { stake_limit: { resubmitProbability: { range: [0, 0.5] } } } }), /must include its default/);
  assert.throws(() => runPolicySweep(archetypes, {}, { onProgress: 'yes' }), /onProgress must be a function/);
});

test('a hook that returns every proposal unchanged gives exactly the no-policy run', () => {
  const prepared = prepareSimulation(fit, { replicates: 3, horizonDays: 14, keepEvents: true });
  const calls = { sessionStart: 0, beforeStake: 0, beforeDeposit: 0, afterTrade: 0 };
  const identity = () => (point, proposal) => {
    calls[point] += 1;
    return proposal;
  };
  for (const plan of prepared.plans) {
    for (let replicate = 0; replicate < 3; replicate += 1) {
      const plain = simulateReplicate(prepared, plan, replicate);
      const hooked = simulateReplicate(prepared, plan, replicate, identity);
      assert.deepEqual(hooked.metrics, plain.metrics);
      assert.deepEqual(hooked.events, plain.events);
      assert.equal(hooked.intervention.attempts, plain.metrics.trades);
      assert.equal(plain.intervention, undefined, 'a run without a hook reports no hook accounting');
    }
  }
  assert.ok(Object.values(calls).every((count) => count > 0), JSON.stringify(calls));
  const proposal = { seconds: 1, earliestSeconds: 1, lastEventSeconds: null };
  assert.equal(NO_INTERVENTION('sessionStart', proposal), proposal);

  // A hook that breaks the contract fails loudly.
  const plan = prepared.plans[0];
  assert.throws(() => simulateReplicate(prepared, plan, 0, () => (point, proposal) => (point === 'beforeStake' ? { stakeCents: 0 } : proposal)), /beforeStake/);
  assert.throws(() => simulateReplicate(prepared, plan, 0, () => (point, proposal) => (point === 'beforeDeposit' ? { amountCents: proposal.amountCents + 1 } : proposal)), /beforeDeposit/);
  assert.throws(() => simulateReplicate(prepared, plan, 0, () => (point, proposal) => (point === 'afterTrade' ? { endSession: false, reset: true } : proposal)), /reset without resumeAtSeconds/);
});

test('regression: a session with no event still moves the clock, so session starts never go backwards', () => {
  // Bug in simulator-0.2.0, unreachable without a policy: the next idle time was measured
  // from the last event, so after a session with no event (a fully blocked deposit) the next
  // session could start before the empty one, and a days horizon might never be reached.
  // Here the first deposit is cut to 1 cent and every later one is blocked, so every session
  // is a forced stop and only the first has an event.
  const prepared = prepareSimulation(archetypes, { replicates: 4, horizonDays: 21, traders: [tokenOf.steady] });
  const plan = prepared.plans[0];
  for (let replicate = 0; replicate < 4; replicate += 1) {
    const starts = [];
    let deposits = 0;
    const run = simulateReplicate(prepared, plan, replicate, () => (point, proposal) => {
      if (point === 'sessionStart') {
        starts.push(proposal.seconds);
        if (starts.length > 5000) throw new Error('session starts are not advancing');
      }
      if (point === 'beforeDeposit') {
        deposits += 1;
        return { amountCents: deposits === 1 ? 1 : 0 };
      }
      return proposal;
    });
    assert.ok(starts.length > 5, 'empty sessions keep coming until the horizon');
    for (let index = 1; index < starts.length; index += 1) {
      assert.ok(starts[index] > starts[index - 1] + GAP_SECONDS, `session ${index} starts ${starts[index] - starts[index - 1]} s after the one before`);
    }
    assert.equal(run.metrics.trades, 0);
    assert.equal(run.metrics.sessions, 0, 'a session with no trade is not counted');
    assert.equal(run.metrics.forcedStops, starts.length - 1, 'every session is a forced stop; the last start is past the horizon');
  }
});

test('a policy that never triggers gives runs identical to simulateTwinV2: harm reduction 0, activity retained 1', () => {
  const options = { replicates: 4, horizonDays: 14 };
  const reference = simulateTwinV2(fit, { ...options, keepRuns: true });
  for (const policy of NEVER) {
    const result = comparePolicyV2(fit, { policy }, { ...options, keepRuns: true });
    assert.deepEqual(result.baseline.population, reference.population, `${policy.type}: the baseline is simulateTwinV2's`);
    assert.equal(result.accounting.runsWithIntervention, 0);
    result.perTrader.forEach((trader, index) => {
      const runs = reference.traders[index].runs;
      for (const pair of trader.runs) {
        assert.deepEqual(pair.baseline, runs[pair.replicate].metrics);
        assert.deepEqual(pair.policy, runs[pair.replicate].metrics, `${policy.type}: the policy run is the no-policy run`);
      }
    });
    for (const scope of [result.population, ...result.perTrader]) {
      for (const name of HARM_METRICS) {
        const { median, p10, p90, n } = scope.harmReduction[name];
        if (n) assert.deepEqual([median, p10, p90], [0, 0, 0], `${policy.type} ${name}`);
      }
      for (const name of ACTIVITY_METRICS) {
        const { median, p10, p90, n } = scope.activityRetained[name];
        if (n) assert.deepEqual([median, p10, p90], [1, 1, 1], `${policy.type} ${name}`);
      }
      assert.equal(scope.difference.totalNetLoss.median, 0);
    }
  }
});

test('a policy run is identical to its baseline up to its first intervention', () => {
  const binding = [
    [{ type: 'cooldown', durationMinutes: 30 }, { referencePoint: 'reset', reboundMultiplier: 1.5 }],
    [{ type: 'stake_limit', maxStake: 25 }, { resubmitProbability: 0 }],
    [{ type: 'deposit_limit', dailyLimit: 100 }, { carryoverShare: 1 }],
    [{ type: 'session_loss_limit', lossLimit: 50 }, { quickReturnProbability: 1 }]
  ];
  for (const [policy, assumptions] of binding) {
    const result = comparePolicyV2(fit, { policy, assumptions }, { replicates: 3, horizonDays: 10, keepRuns: true, keepEvents: true });
    let intervened = 0;
    let differs = 0;
    for (const pair of pairsOf(result)) {
      const first = pair.accounting.firstInterventionSeconds;
      if (first === null) {
        assert.deepEqual(pair.policyRun.events, pair.baselineRun.events);
        continue;
      }
      intervened += 1;
      const before = (run) => run.events.filter((event) => seconds(event) < first);
      assert.deepEqual(before(pair.policyRun), before(pair.baselineRun), `${policy.type}: events before the first intervention`);
      if (JSON.stringify(pair.policyRun.events) !== JSON.stringify(pair.baselineRun.events)) differs += 1;
    }
    assert.ok(intervened >= 10 && differs >= 10, `${policy.type}: ${intervened} runs intervened, ${differs} differ`);
  }
});

test('stake_limit: no placed stake above the cap; resubmit 0 skips the trade, resubmit 1 places it at the cap', () => {
  const policy = { type: 'stake_limit', maxStake: 25 };
  const options = { replicates: 4, horizonDays: 10, keepRuns: true, keepEvents: true, traders: [tokenOf.chaser, tokenOf.steady] };
  const skip = comparePolicyV2(archetypes, { policy, assumptions: { resubmitProbability: 0 } }, options);
  const resubmit = comparePolicyV2(archetypes, { policy, assumptions: { resubmitProbability: 1 } }, options);
  for (const pair of pairsOf(skip)) assert.ok(trades(pair.policyRun).every((event) => event.stake_amount <= 25));
  for (const pair of pairsOf(resubmit)) assert.ok(trades(pair.policyRun).every((event) => event.stake_amount <= 25));
  assert.ok(skip.accounting.totals.skipped > 0);
  assert.equal(skip.accounting.totals.resubmitted, 0);
  assert.equal(skip.accounting.totals.skippedAttempts, skip.accounting.totals.skipped);
  assert.ok(resubmit.accounting.totals.resubmitted > 0);
  assert.equal(resubmit.accounting.totals.skipped, 0);
  for (const pair of pairsOf(resubmit)) {
    // A resubmitted stake is placed at exactly the cap unless the broke rule stops it.
    const resubmittedAt = new Set(pair.log.filter((entry) => entry.response === 'resubmit').map((entry) => entry.seconds));
    const placed = trades(pair.policyRun).filter((event) => resubmittedAt.has(seconds(event)));
    assert.ok(placed.every((event) => event.stake_amount === 25));
    assert.ok(placed.length >= pair.accounting.resubmitted - pair.policy.forcedStops);
    // The first capped attempt keeps its own outcome draw, with the ratio applied to the cap.
    const first = pair.policyRun.trace.findIndex((row, index) => row.stakeCents !== pair.baselineRun.trace[index]?.stakeCents);
    if (first < 0) continue;
    const capped = pair.policyRun.trace[first];
    const original = pair.baselineRun.trace[first];
    assert.equal(capped.stakeCents, 2500);
    assert.ok(original.stakeCents > 2500);
    assert.equal(capped.outcomeDraw, original.outcomeDraw);
    assert.equal(capped.outcome, original.outcome);
    const ratio = (run, index) => trades(run)[index].realized_result / trades(run)[index].stake_amount;
    assert.ok(Math.abs(ratio(pair.policyRun, first) - ratio(pair.baselineRun, first)) < 0.002);
  }
  // Skipping places fewer trades than resubmitting at the cap.
  assert.ok(sum(pairsOf(skip).map((pair) => pair.policy.trades)) < sum(pairsOf(resubmit).map((pair) => pair.policy.trades)));
});

test('deposit_limit: no UTC day above the limit; carryover 1 moves the blocked amount to the next day, carryover 0 drops it', () => {
  const policy = { type: 'deposit_limit', dailyLimit: 100 };
  const options = { replicates: 4, horizonDays: 14, keepRuns: true, keepEvents: true, traders: [tokenOf.refueler, tokenOf.chaser] };
  const dropped = comparePolicyV2(archetypes, { policy, assumptions: { carryoverShare: 0 } }, options);
  const moved = comparePolicyV2(archetypes, { policy, assumptions: { carryoverShare: 1 } }, options);
  for (const result of [dropped, moved]) {
    for (const pair of pairsOf(result)) {
      const byDay = new Map();
      for (const event of pair.policyRun.events.filter((item) => item.type === 'deposit')) {
        const day = Math.floor(seconds(event) / DAY);
        byDay.set(day, (byDay.get(day) ?? 0) + Math.round(event.deposit_amount * 100));
      }
      for (const [day, cents] of byDay) assert.ok(cents <= 10000, `day ${day}: ${cents} cents deposited`);
    }
    assert.ok(result.accounting.totals.blockedCents > 0, 'the limit binds');
  }
  assert.equal(dropped.accounting.totals.carriedCents, 0);
  assert.equal(dropped.accounting.totals.deferredDeposits, 0);
  const totals = moved.accounting.totals;
  assert.equal(totals.carriedCents, totals.blockedCents, 'carryover 1 carries every blocked cent');
  assert.equal(totals.carriedCents, totals.deferredProposedCents + totals.pendingCentsAtEnd, 'every carried cent is deposited later or still pending at the horizon');
  assert.ok(totals.deferredDeposits > 0);
  let checked = 0;
  for (const pair of pairsOf(moved)) {
    const events = pair.policyRun.events;
    const sessionStarts = events.filter((event, index) => index === 0 || seconds(event) - seconds(events[index - 1]) > GAP_SECONDS).map(seconds);
    // Replay the log: every blocked amount waits until a later UTC day, then lands whole.
    let queue = [];
    for (const entry of pair.log) {
      const day = Math.floor(entry.seconds / DAY);
      if (entry.depositKind === 'deferred') {
        const due = queue.filter((item) => item.day < day);
        queue = queue.filter((item) => item.day >= day);
        assert.equal(entry.requestedCents, sum(due.map((item) => item.cents)), 'the deferred deposit is exactly the blocked amounts from earlier days');
        // At the start of the trader's first session after the earliest of those days.
        const earliest = Math.min(...due.map((item) => item.day));
        assert.equal(sessionStarts.find((start) => start >= (earliest + 1) * DAY), entry.seconds);
        checked += 1;
      }
      if (entry.blockedCents > 0) queue.push({ cents: entry.blockedCents, day });
    }
    assert.equal(sum(queue.map((item) => item.cents)), pair.accounting.pendingCentsAtEnd);
  }
  assert.ok(checked > 3);
});

test('cooldown: no trade inside a cooldown, and none for the rest of the UTC day when the trader leaves', () => {
  for (const referencePoint of ['carry', 'reset']) {
    const result = comparePolicyV2(archetypes, {
      policy: { type: 'cooldown', durationMinutes: 45 },
      assumptions: { leaveProbability: 0.5, referencePoint }
    }, { replicates: 4, horizonDays: 14, keepRuns: true, keepEvents: true });
    let leaves = 0;
    let pauses = 0;
    for (const pair of pairsOf(result)) {
      const times = trades(pair.policyRun).map(seconds);
      for (const entry of pair.log) {
        assert.ok(times.every((t) => t <= entry.seconds || t >= entry.untilSeconds), `${referencePoint}: a trade inside the cooldown`);
        if (entry.response === 'leave') {
          leaves += 1;
          assert.equal(entry.leaveUntilSeconds % DAY, 0);
          assert.ok(times.every((t) => t <= entry.seconds || t >= entry.leaveUntilSeconds + GAP_SECONDS), 'a trade later the same UTC day');
        }
        if (entry.response === 'pause') pauses += 1;
      }
    }
    assert.ok(leaves > 5 && pauses > 5, `${referencePoint}: ${leaves} leaves, ${pauses} pauses`);
    assert.equal(result.accounting.totals.resets, referencePoint === 'reset' ? pauses : 0);
    assert.equal(result.accounting.totals.pausesLongerThanSessionGap, pauses, 'a 45-minute cooldown is longer than the 30-minute session gap');
  }
});

test('session_loss_limit: no session continues past the limit, and quickReturn 1 starts the next session within the hour', () => {
  const limitCents = 6000;
  const options = { replicates: 4, horizonDays: 14, keepRuns: true, keepEvents: true };
  for (const quickReturnProbability of [0, 1]) {
    const result = comparePolicyV2(archetypes, { policy: { type: 'session_loss_limit', lossLimit: 60 }, assumptions: { quickReturnProbability } }, options);
    let forced = 0;
    for (const pair of pairsOf(result)) {
      for (const row of pair.policyRun.trace) {
        if (-row.runningCents >= limitCents) assert.notEqual(row.ends, null, 'the session ends at the trade that reaches the limit');
      }
      const events = pair.policyRun.events;
      for (const entry of pair.log.filter((item) => item.response !== 'ownStop')) {
        forced += 1;
        const at = events.findIndex((event) => event.type === 'trade' && seconds(event) === entry.seconds);
        let last = at;
        while (last + 1 < events.length && seconds(events[last + 1]) - seconds(events[last]) <= GAP_SECONDS) last += 1;
        if (last + 1 >= events.length) continue; // the horizon ended first
        const idle = seconds(events[last + 1]) - seconds(events[last]);
        assert.ok(idle > GAP_SECONDS);
        if (quickReturnProbability === 1) assert.ok(idle <= 3600, `next session ${idle} s after the forced end`);
      }
    }
    assert.ok(forced > 10);
    assert.equal(result.accounting.totals.quickReturns, quickReturnProbability === 1 ? result.accounting.totals.forcedEnds : 0);
  }
});

test('a cooldown that only delays (rebound 1, nobody leaves, carry) never raises trades, stake, or chase episodes, and not population net loss', () => {
  // The policy run is the baseline run delayed, so in a days horizon it loses a suffix of
  // attempts. The suffix's net loss is noisy (about 0.3 SD per trader), so the population
  // median needs enough replicates to sit reliably at or below 0.
  for (const [label, target, replicates] of [['archetypes', archetypes, 60], ['fitted population', fit, 30]]) {
    for (const durationMinutes of [5, 30, 60]) {
      const result = comparePolicyV2(target, { policy: { type: 'cooldown', durationMinutes } }, { replicates, keepRuns: true });
      for (const assumption of result.responseAssumptions.filter((item) => item.name !== 'cooldown.reboundTrades')) assert.equal(assumption.isDefault, true);
      for (const pair of pairsOf(result)) {
        for (const name of ['trades', 'totalStake', 'chaseEpisodes']) {
          assert.ok(pair.policy[name] <= pair.baseline[name], `${label} ${durationMinutes} min, ${name}: ${pair.policy[name]} > ${pair.baseline[name]}`);
        }
      }
      assert.ok(result.population.difference.totalNetLoss.median <= 0, `${label} ${durationMinutes} min: population net loss rose`);
      assert.ok(result.accounting.totals.pauses > 0);
    }
  }
});

test('a high rebound deepens the chaser\'s session drawdowns; chase episodes rise only where after-loss stakes are not already over the line', (t) => {
  const options = { replicates: 60, uncertainty: false, keepRuns: true };
  const policy = { type: 'cooldown', durationMinutes: 15 };
  const chaser = comparePolicyV2(archetypes, { policy, assumptions: { reboundMultiplier: 2 } }, { ...options, traders: [tokenOf.chaser] });
  const { difference, harmReduction } = chaser.population;
  assert.ok(difference.maxSessionDrawdown.median > 0, 'max session drawdown rises');
  assert.ok(harmReduction.maxSessionDrawdown.median < 0);
  assert.ok(difference.forcedStops.median > 0, 'the doubled stakes run the balance out more often');
  // Finding: the chaser already stakes 1.8x base after a loss, so about 97% of its
  // after-loss trades clear the 1.25x chase line without a rebound. Doubling adds almost no
  // chase episodes (the share per trade barely moves), and the extra forced stops cut
  // trades, so the count of chase episodes falls.
  const pairs = pairsOf(chaser);
  const perTrade = (side) => sum(pairs.map((pair) => pair[side].chaseEpisodes)) / sum(pairs.map((pair) => pair[side].trades));
  assert.ok(Math.abs(perTrade('policy') - perTrade('baseline')) < 0.02, `chase episodes per trade ${perTrade('policy')} vs ${perTrade('baseline')}`);
  assert.ok(difference.chaseEpisodes.median <= 0, 'the chase-episode count does not rise for the chaser');

  // Where after-loss stakes are not saturated (steady), the same rebound raises the count.
  const steady = comparePolicyV2(archetypes, { policy, assumptions: { reboundMultiplier: 2 } }, { ...options, traders: [tokenOf.steady] });
  assert.ok(steady.population.difference.chaseEpisodes.median > 0, 'chase episodes rise for steady');
  assert.ok(steady.population.difference.maxSessionDrawdown.median > 0);
  t.diagnostic(`chaser, rebound 2: max session drawdown median difference ${difference.maxSessionDrawdown.median.toFixed(2)}, chase episodes ${difference.chaseEpisodes.median}, per trade ${perTrade('baseline').toFixed(3)} -> ${perTrade('policy').toFixed(3)}, forced stops ${difference.forcedStops.median}; steady: chase episodes ${steady.population.difference.chaseEpisodes.median}`);
});

test('reset reference point: a cooldown makes quits-when-down play longer, so harm can rise (finding, reported)', (t) => {
  const options = { replicates: 200, uncertainty: false, keepRuns: true, traders: [tokenOf['quits-when-down']] };
  const policy = { type: 'cooldown', durationMinutes: 15 };
  const reset = comparePolicyV2(archetypes, { policy, assumptions: { referencePoint: 'reset' } }, options);
  const carry = comparePolicyV2(archetypes, { policy }, options);
  const meanDifference = (result, name) => mean(pairsOf(result).map((pair) => pair.policy[name] - pair.baseline[name]));
  // Returning flat puts the trader back on the flat bucket's stop hazard (0.08) instead of
  // down_large's (0.6), so trades rise on average. Carry can't raise them.
  assert.ok(meanDifference(reset, 'trades') > 0);
  assert.ok(meanDifference(carry, 'trades') <= 0);
  assert.ok(pairsOf(reset).filter((pair) => pair.policy.trades > pair.baseline.trades).length > 60);
  // Session drawdown restarts at a reset return by definition, so it falls even for steady,
  // whose stopping doesn't depend on drawdown: an accounting effect, not a harm reduction.
  const steady = comparePolicyV2(archetypes, { policy, assumptions: { referencePoint: 'reset' } }, { ...options, traders: [tokenOf.steady] });
  assert.ok(steady.population.harmReduction.maxSessionDrawdown.median > 0.2);
  assert.ok(steady.population.activityRetained.trades.median >= 0.99);
  t.diagnostic(`quits-when-down, 15-minute cooldown: reset changes trades by ${meanDifference(reset, 'trades').toFixed(2)} and net loss by ${meanDifference(reset, 'totalNetLoss').toFixed(2)} on average per run (median net loss difference ${reset.population.difference.totalNetLoss.median.toFixed(2)}); carry changes them by ${meanDifference(carry, 'trades').toFixed(2)} and ${meanDifference(carry, 'totalNetLoss').toFixed(2)}`);
});

test('population aggregates sum each replicate across traders, then take the ratio, then percentiles', () => {
  const result = comparePolicyV2(fit, { policy: { type: 'session_loss_limit', lossLimit: 50 } }, { replicates: 9, horizonDays: 10, keepRuns: true });
  const replicates = Array.from({ length: 9 }, (_, replicate) => result.perTrader.map((trader) => trader.runs[replicate]));
  const stakeRatios = replicates.map((pairs) => sum(pairs.map((pair) => pair.policy.totalStake)) / sum(pairs.map((pair) => pair.baseline.totalStake)));
  const retained = result.population.activityRetained.totalStake;
  assert.ok(Math.abs(retained.median - quantile(stakeRatios, 0.5)) < 1e-12);
  assert.ok(Math.abs(retained.p10 - quantile(stakeRatios, 0.1)) < 1e-12);
  assert.ok(Math.abs(retained.p90 - quantile(stakeRatios, 0.9)) < 1e-12);
  // Drawdowns are averaged over the traders with a value in both runs, then divided.
  const drawdown = replicates.map((pairs) => {
    const both = pairs.filter((pair) => pair.policy.maxSessionDrawdown !== null && pair.baseline.maxSessionDrawdown !== null);
    return 1 - mean(both.map((pair) => pair.policy.maxSessionDrawdown)) / mean(both.map((pair) => pair.baseline.maxSessionDrawdown));
  });
  assert.ok(Math.abs(result.population.harmReduction.maxSessionDrawdown.median - quantile(drawdown, 0.5)) < 1e-12);
  const lossDifferences = replicates.map((pairs) => sum(pairs.map((pair) => pair.policy.totalNetLoss - pair.baseline.totalNetLoss)));
  assert.ok(Math.abs(result.population.difference.totalNetLoss.median - quantile(lossDifferences, 0.5)) < 1e-6);
  // Not the median of per-trader medians.
  const perTraderMedians = quantile(result.perTrader.map((trader) => trader.activityRetained.totalStake.median), 0.5);
  assert.notEqual(retained.median, perTraderMedians);
  // beyondActivityCut is harm reduction above the line 1 - activity retained, per replicate.
  const lossRatios = replicates.map((pairs) => 1 - sum(pairs.map((pair) => pair.policy.totalNetLoss)) / sum(pairs.map((pair) => pair.baseline.totalNetLoss)));
  const beyond = lossRatios.map((value, index) => value + stakeRatios[index] - 1);
  assert.ok(Math.abs(result.population.primary.beyondActivityCut.median - quantile(beyond, 0.5)) < 1e-12);
  assert.deepEqual(result.population.primary.activityRetained, retained);
});

test('a zero baseline gives null, never 0 or 1', () => {
  // The shrinker stakes 0.6x base after a loss, so it almost never has a chase episode.
  const replicates = 8;
  const result = comparePolicyV2(archetypes, { policy: { type: 'stake_limit', maxStake: 25 } }, { replicates, horizonDays: 10, keepRuns: true, traders: [tokenOf.shrinker] });
  const [trader] = result.perTrader;
  let zeros = 0;
  for (const name of [...HARM_METRICS, ...ACTIVITY_METRICS]) {
    const usable = trader.runs.filter((pair) => pair.baseline[name] !== null && pair.policy[name] !== null && pair.baseline[name] !== 0).length;
    const summary = (HARM_METRICS.includes(name) ? trader.harmReduction : trader.activityRetained)[name];
    assert.equal(summary.n, usable, name);
    if (usable === 0) assert.equal(summary.median, null, name);
    zeros += replicates - usable;
  }
  assert.ok(trader.runs.some((pair) => pair.baseline.chaseEpisodes === 0));
  assert.ok(zeros > 0, 'the test reaches the zero-baseline path');
});

test('traders without the money model get null for deposit_limit, never a zero effect', () => {
  const noDeposits = population.events.filter((event) => event.type !== 'deposit').map(({ balance_before: _b, balance_after: _a, ...event }) => event);
  const bare = estimateTwins(noDeposits, { dataLabel: LABEL });
  const result = comparePolicyV2(bare, { policy: { type: 'deposit_limit', dailyLimit: 100 } }, { replicates: 3, horizonDays: 7 });
  const simulable = result.traders.filter((trader) => trader.simulable).length;
  assert.ok(simulable > 5);
  assert.deepEqual(result.traderCounts, { applicable: 0, notApplicable: simulable });
  assert.equal(result.labels.moneyNotSimulated.length, simulable);
  assert.equal(result.population.harmReduction, null);
  assert.equal(result.population.primary, null);
  for (const trader of result.perTrader) {
    assert.equal(trader.applicable, false);
    assert.match(trader.reason, /not zero/);
    assert.equal(trader.harmReduction, null);
  }
  // Other policies still apply to them; their money metrics are unavailable, not zero.
  const cooldown = comparePolicyV2(bare, { policy: { type: 'cooldown', durationMinutes: 30 } }, { replicates: 3, horizonDays: 7 });
  assert.ok(cooldown.perTrader.every((trader) => trader.applicable));
  assert.equal(cooldown.population.harmReduction.depositsAfterLoss.n, 0);
  assert.equal(cooldown.population.harmReduction.depositsAfterLoss.median, null);
  assert.ok(cooldown.population.activityRetained.trades.n > 0);
});

test('every result carries labels, versions, seed, replicates, the policy config, every assumption, and the claim', () => {
  const plain = population.events.map(({ balance_before: _b, balance_after: _a, ...event }) => event);
  const plainFit = estimateTwins(plain, { dataLabel: LABEL });
  const options = { replicates: 3, horizonDays: 7, seed: 99 };
  const result = comparePolicyV2(plainFit, { policy: { type: 'cooldown', durationMinutes: 15 }, assumptions: { leaveProbability: 0.25 } }, options);
  assert.equal(result.dataLabel, LABEL);
  assert.equal(result.modelVersion, 'twin-0.3.0');
  assert.equal(result.simulatorVersion, SIMULATOR_VERSION);
  assert.equal(result.policyVersion, POLICY_VERSION);
  assert.equal(POLICY_VERSION, 'policy-0.2.0');
  assert.equal(result.seed, 99);
  assert.equal(result.replicates, 3);
  assert.deepEqual(result.horizon, { days: 7 });
  assert.match(result.claim, /assumed rather than estimated from intervention data/);
  assert.match(result.claim, /not a causal claim/i);
  assert.match(result.claim, /not a recommendation to act on any trader/);
  assert.deepEqual(result.assumptions.simulation, simulateTwinV2(plainFit, options).assumptions);
  assert.ok(result.assumptions.policy.some((line) => /common random numbers/.test(line)));
  assert.ok(result.assumptions.policy.some((line) => /Days horizon only/.test(line)));
  assert.deepEqual(result.policy, { type: 'cooldown', durationMinutes: 15, lossStreak: 3, drawdownThreshold: null, version: POLICY_VERSION });
  assert.deepEqual(result.responseAssumptions.map((item) => [item.name, item.value, item.isDefault]), [
    ['cooldown.reboundMultiplier', 1, true],
    ['cooldown.reboundTrades', 3, true],
    ['cooldown.leaveProbability', 0.25, false],
    ['cooldown.referencePoint', 'carry', true]
  ]);
  assert.deepEqual(result.primary, POLICY_PRIMARY_METRICS);
  // No balance fields: every trader is all-cause and proxy-refuel, and keeps those labels.
  const simulable = result.traders.filter((trader) => trader.simulable);
  assert.ok(simulable.length > 5);
  assert.deepEqual(result.labels.allCauseStops, simulable.map((trader) => trader.traderToken));
  assert.deepEqual(result.labels.proxyRefuel, simulable.map((trader) => trader.traderToken));
  assert.ok(simulable.every((trader) => trader.stopBasis === 'all-cause' && trader.refuelTrigger === 'losingStreak (proxy)'));
  assert.ok(simulable.every((trader) => Number.isFinite(trader.estimates.chaseCoefficient) && 'stopHazard.down_large' in trader.estimates));
});

test('the sweep crosses settings with assumptions one at a time or as a grid, with chart series and a driver statement', () => {
  const sweep = {
    policies: ['cooldown', 'stake_limit'],
    settings: { cooldown: [{ durationMinutes: 5 }, { durationMinutes: 60 }], stake_limit: [{ maxStake: 25 }, { maxStake: 50 }] }
  };
  const options = { replicates: 4, horizonDays: 7, traders: archetypes.twins.slice(0, 3).map((twin) => twin.traderToken) };
  let progress = 0;
  const result = runPolicySweep(archetypes, sweep, { ...options, onProgress: () => { progress += 1; } });
  assert.equal(progress, 3);
  assert.equal(result.design, 'one-at-a-time');
  assert.equal(result.policyVersion, POLICY_VERSION);
  const [cooldown, stake] = result.policies;
  // cooldown: defaults + 2 rebound + 2 leave + 1 reset per setting; stake_limit: defaults + 2.
  assert.equal(cooldown.cells.length, 2 * 6);
  assert.equal(stake.cells.length, 2 * 3);
  assert.equal(result.cellCount, 18);
  assert.equal(new Set(result.policies.flatMap((policy) => policy.cells.map((cell) => cell.id))).size, 18);
  for (const cell of cooldown.cells) {
    assert.ok(cell.varied.length <= 1);
    assert.equal(cell.perTrader.length, 3);
    assert.equal(cell.responseAssumptions.length, 4);
  }
  assert.deepEqual(cooldown.chart.series.map((series) => series.id), [
    'cooldown.reboundMultiplier=0.5', 'cooldown.reboundMultiplier=1', 'cooldown.reboundMultiplier=1.5',
    'cooldown.leaveProbability=0', 'cooldown.leaveProbability=0.25', 'cooldown.leaveProbability=0.5',
    'cooldown.referencePoint=carry', 'cooldown.referencePoint=reset'
  ]);
  for (const series of [...cooldown.chart.series, ...stake.chart.series]) {
    assert.equal(series.points.length, 2);
    for (const pointItem of series.points) {
      for (const key of ['harmReduction', 'activityRetained', 'beyondActivityCut']) assert.ok(Number.isFinite(pointItem[key].median) && 'p10' in pointItem[key] && 'p90' in pointItem[key]);
    }
  }
  assert.equal(cooldown.chart.harmMetric, 'totalNetLoss');
  assert.equal(cooldown.chart.reference.line, 'y = 1 - x');
  for (const policy of result.policies) {
    assert.ok(policy.driver.largest);
    assert.match(policy.driver.statement, new RegExp(`^${policy.type}: `));
    assert.match(policy.driver.statement, policy.driver.largest.endsWith(policy.settingKey) ? /policy setting drives/ : /assumed rather than estimated/);
    const spreads = [policy.driver.setting.spread, ...Object.values(policy.driver.assumptions).map((item) => item.spread)].filter((value) => value !== null);
    const largest = policy.driver.largest === policy.driver.setting.name ? policy.driver.setting.spread : policy.driver.assumptions[policy.driver.largest].spread;
    assert.equal(largest, Math.max(...spreads));
  }
  // The baseline is simulateTwinV2's, computed once and shared by every cell.
  assert.deepEqual(result.baseline.population, simulateTwinV2(archetypes, options).population);

  const grid = runPolicySweep(archetypes, { ...sweep, policies: ['cooldown'], settings: { cooldown: [{ durationMinutes: 5 }] }, design: 'grid' }, options);
  assert.equal(grid.policies[0].cells.length, 3 * 1 * 3 * 2);
  assert.ok(grid.policies[0].cells.some((cell) => cell.varied.length === 3));
});

test('deterministic under a seed, and different under another', () => {
  const sweep = { policies: ['session_loss_limit', 'deposit_limit'], settings: { session_loss_limit: [{ lossLimit: 50 }], deposit_limit: [{ dailyLimit: 100 }] } };
  const options = { replicates: 3, horizonDays: 7 };
  const first = runPolicySweep(fit, sweep, options);
  assert.deepEqual(runPolicySweep(fit, sweep, options), first);
  const other = runPolicySweep(fit, sweep, { ...options, seed: 8 });
  assert.notDeepEqual(other.policies[0].cells[0].population, first.policies[0].cells[0].population);
  // A trader's result doesn't depend on which other traders are in the run.
  const token = fit.twins[2].traderToken;
  const alone = comparePolicyV2(fit, { policy: { type: 'session_loss_limit', lossLimit: 50 } }, { ...options, traders: [token] });
  assert.deepEqual(alone.perTrader[0], first.policies[0].cells[0].perTrader[2]);
});

test('the old comparison is kept and labelled baseline-0.1', () => {
  const [twin] = buildTwins(buildSignals(population.events.slice(0, 400)));
  const run = comparePolicy([twin], { type: 'cooldown', durationMinutes: 30 }, { horizonDays: 3, seed: 5 });
  assert.equal(run.simulatorVersion, BASELINE_SIMULATOR_VERSION);
  assert.equal(validatePolicy({ type: 'stake_limit', maxStake: 20 }).valid, true);
  assert.equal(validatePolicy({ type: 'session_loss_limit', lossLimit: 20 }).valid, false, 'the old layer has only its three types');
});

test('the event data agrees: a carry pause longer than the session gap splits the session there', () => {
  const result = comparePolicyV2(archetypes, { policy: { type: 'cooldown', durationMinutes: 45 } }, { replicates: 2, horizonDays: 7, keepRuns: true, keepEvents: true, traders: [tokenOf.chaser] });
  for (const pair of pairsOf(result)) {
    const observed = buildBehaviorObservations(pair.policyRun.events, archetypes.behaviorOptions)[0];
    const simulated = pair.policy.sessions;
    // The chaser never refuels, so no deposit can bridge the pause.
    const splits = pair.accounting.pausesLongerThanSessionGap - Number(pair.accounting.horizonReachedInPause);
    assert.equal(observed.sessions.filter((session) => session.tradeCount > 0).length - simulated, splits);
  }
});
