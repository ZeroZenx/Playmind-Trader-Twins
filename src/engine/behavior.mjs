/**
 * Behavioral signals, definition version behavior-0.2.0.
 *
 * These signals describe how a trader reacts to what just happened. They are
 * computed per trader from timestamps, stakes, deposits, withdrawals, and
 * realized result or balance. No market or contract field is read.
 *
 * Every function here is pure and deterministic: the same events and options
 * give the same output, whatever the input order. Field needs and definitions
 * are in docs/DATA-DICTIONARY.md ("Behavioral signals"). ADR-009 in
 * docs/DECISIONS.md explains why signals 1 and 6 use disjoint post-loss trades.
 */

export const BEHAVIOR_VERSION = 'behavior-0.2.0';

export const DRAWDOWN_BUCKETS = Object.freeze(['up', 'flat', 'down_small', 'down_large']);

export const DEFAULT_BEHAVIOR_OPTIONS = Object.freeze({
  // Same rule as buildSignals: a gap longer than this starts a new session.
  sessionGapMinutes: 30,
  // A signal with fewer observations than this returns value null plus a reason.
  minSampleSize: 5,
  // Per-signal overrides keyed by signal name, e.g. { escalation: 10 }.
  minSampleSizes: Object.freeze({}),
  // Signal 1: the reference stake is the median of up to this many previous stakes,
  rollingWindow: 20,
  // and needs at least this many of them.
  minStakeHistory: 3,
  // Signal 4 bucket edges, in units of the trader's median stake.
  flatBandStakes: 0.5,
  largeDrawdownStakes: 2,
  // Signal 5.
  refuelWindowMinutes: 60,
  lowBalanceStakeMultiple: 1,
  lowBalanceThreshold: null,
  losingStreakLength: 3,
  // End of the observation window. Default: the latest event time in the input.
  observationEnd: null
});

const BASE_FIELDS = ['trader_token', 'occurred_at', 'type'];

function definition(description, requires, anyOf = []) {
  return Object.freeze({
    description,
    requires: Object.freeze([...BASE_FIELDS, ...requires]),
    // At least one group must be fully present.
    anyOf: Object.freeze(anyOf.map((group) => Object.freeze(group)))
  });
}

export const BEHAVIOR_SIGNAL_DEFINITIONS = Object.freeze({
  postOutcomeStake: definition(
    'Stake on the next trade after a realized loss and after a realized win, each divided by the median of the trader\'s previous stakes. A trade after the second or later loss of a same-session losing run belongs to escalation instead.',
    ['stake_amount', 'realized_result']
  ),
  reentryLatency: definition(
    'Minutes from a realized loss or win to the trader\'s next trade, in any session and within the same session.',
    ['realized_result']
  ),
  sessionDrawdown: definition(
    'How far the running result fell below the session start, net of deposits and withdrawals.',
    [],
    [['balance_before', 'balance_after'], ['realized_result']]
  ),
  stopBehavior: definition(
    'Probability that a session ends after a trade, by session drawdown bucket.',
    ['stake_amount'],
    [['balance_before', 'balance_after'], ['realized_result']]
  ),
  refuel: definition(
    'Probability of a deposit within the refuel window after the balance drops below a threshold, or after a losing streak when balances are unavailable.',
    [],
    [['balance_before', 'balance_after', 'stake_amount'], ['realized_result']]
  ),
  escalation: definition(
    'Stake multiplier per additional consecutive loss in a session, from the second loss of a run, relative to the stake after the first loss.',
    ['stake_amount', 'realized_result']
  )
});

const SIGNAL_NAMES = Object.keys(BEHAVIOR_SIGNAL_DEFINITIONS);
const TRADER_ACTIONS = new Set(['trade', 'deposit', 'withdrawal']);
const MINUTE_MS = 60000;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasBalances(event) {
  return isFiniteNumber(event.balance_before) && isFiniteNumber(event.balance_after);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- Options -----------------------------------------------------------------

function check(condition, message) {
  if (!condition) throw new RangeError(`buildBehaviorSignals: ${message}`);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

function parseTime(value) {
  if (value instanceof Date) return value.getTime();
  if (isFiniteNumber(value)) return value;
  return Date.parse(value);
}

function resolveOptions(options, latestEventMs) {
  const supplied = Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined));
  for (const key of Object.keys(supplied)) {
    check(Object.hasOwn(DEFAULT_BEHAVIOR_OPTIONS, key), `unknown option "${key}"`);
  }
  const resolved = { ...DEFAULT_BEHAVIOR_OPTIONS, ...supplied, minSampleSizes: { ...(supplied.minSampleSizes ?? {}) } };

  check(isFiniteNumber(resolved.sessionGapMinutes) && resolved.sessionGapMinutes > 0, 'sessionGapMinutes must be a positive number');
  check(isPositiveInteger(resolved.minSampleSize), 'minSampleSize must be a positive integer');
  for (const [name, value] of Object.entries(resolved.minSampleSizes)) {
    check(SIGNAL_NAMES.includes(name), `minSampleSizes names an unknown signal "${name}"`);
    check(isPositiveInteger(value), `minSampleSizes.${name} must be a positive integer`);
  }
  check(isPositiveInteger(resolved.rollingWindow), 'rollingWindow must be a positive integer');
  check(
    isPositiveInteger(resolved.minStakeHistory) && resolved.minStakeHistory <= resolved.rollingWindow,
    'minStakeHistory must be a positive integer no larger than rollingWindow'
  );
  check(isFiniteNumber(resolved.flatBandStakes) && resolved.flatBandStakes >= 0, 'flatBandStakes must be zero or more');
  check(
    isFiniteNumber(resolved.largeDrawdownStakes) && resolved.largeDrawdownStakes > resolved.flatBandStakes,
    'largeDrawdownStakes must be greater than flatBandStakes'
  );
  check(isFiniteNumber(resolved.refuelWindowMinutes) && resolved.refuelWindowMinutes > 0, 'refuelWindowMinutes must be a positive number');
  check(isFiniteNumber(resolved.lowBalanceStakeMultiple) && resolved.lowBalanceStakeMultiple > 0, 'lowBalanceStakeMultiple must be a positive number');
  check(resolved.lowBalanceThreshold === null || isFiniteNumber(resolved.lowBalanceThreshold), 'lowBalanceThreshold must be null or a finite number');
  check(isPositiveInteger(resolved.losingStreakLength), 'losingStreakLength must be a positive integer');

  let observationEndMs = latestEventMs;
  if (resolved.observationEnd !== null) {
    observationEndMs = parseTime(resolved.observationEnd);
    check(!Number.isNaN(observationEndMs), 'observationEnd must be a valid timestamp');
  }
  resolved.observationEnd = observationEndMs === null ? null : new Date(observationEndMs).toISOString();
  return { resolved, observationEndMs };
}

function minimumFor(signal, options) {
  return options.minSampleSizes[signal] ?? options.minSampleSize;
}

// --- Result shapes -----------------------------------------------------------

// Every signal value carries n and a reason. Below the minimum, value is null.
function gated(n, minimum, emptyReason, compute, nullFields = {}) {
  if (n === 0) return { value: null, ...nullFields, n, reason: emptyReason };
  if (n < minimum) return { value: null, ...nullFields, n, reason: `n=${n} is below the minimum sample size of ${minimum}` };
  return { ...compute(), n, reason: null };
}

// loss minus win. n is the smaller side, because both sides are needed.
function difference(afterLoss, afterWin) {
  const n = Math.min(afterLoss.n, afterWin.n);
  if (afterLoss.value === null || afterWin.value === null) {
    const missing = [];
    if (afterLoss.value === null) missing.push(`afterLoss: ${afterLoss.reason}`);
    if (afterWin.value === null) missing.push(`afterWin: ${afterWin.reason}`);
    return { value: null, n, reason: `needs both sides (${missing.join('; ')})` };
  }
  return { value: afterLoss.value - afterWin.value, n, reason: null };
}

// --- Event structure ---------------------------------------------------------

function outcomeOf(result) {
  if (result === null) return null; // unavailable: never a loss, a win, or a push
  if (result < 0) return 'loss';
  if (result > 0) return 'win';
  return 'push';
}

function compareRows(a, b) {
  if (a.t !== b.t) return a.t - b.t;
  const rowA = isFiniteNumber(a.event.source_row_number) ? a.event.source_row_number : Number.MAX_SAFE_INTEGER;
  const rowB = isFiniteNumber(b.event.source_row_number) ? b.event.source_row_number : Number.MAX_SAFE_INTEGER;
  if (rowA !== rowB) return rowA - rowB;
  return compareText(String(a.event.event_id ?? ''), String(b.event.event_id ?? ''));
}

// Splits a trader's actions into sessions and annotates each trade.
function structure(rows, options) {
  const gapMs = options.sessionGapMinutes * MINUTE_MS;
  const actions = [];
  const sessions = [];
  const trades = [];

  for (const row of rows) {
    const { event } = row;
    if (!TRADER_ACTIONS.has(event.type)) continue;

    let session = sessions.at(-1);
    if (!session || row.t - session.endT > gapMs) {
      session = { index: sessions.length, endT: row.t, actions: [], trades: [] };
      sessions.push(session);
    }
    session.endT = row.t;

    const action = { event, t: row.t, index: actions.length, session: session.index, type: event.type, trade: null };
    actions.push(action);
    session.actions.push(action);
    if (event.type !== 'trade') continue;

    const result = isFiniteNumber(event.realized_result) ? event.realized_result : null;
    const outcome = outcomeOf(result);
    const previous = session.trades.at(-1);
    const trade = {
      action,
      t: row.t,
      session: session.index,
      stake: isFiniteNumber(event.stake_amount) && event.stake_amount > 0 ? event.stake_amount : null,
      result,
      outcome,
      // Consecutive realized losses ending at this trade, within this session.
      lossRunInSession: outcome === 'loss' ? (previous?.lossRunInSession ?? 0) + 1 : 0,
      // Running session result after this trade; null when unknown.
      running: null
    };
    action.trade = trade;
    trades.push(trade);
    session.trades.push(trade);
  }
  return { actions, sessions, trades };
}

// Net money moved into the account by a deposit (positive) or withdrawal (negative).
function transferAmount(event) {
  if (hasBalances(event)) return event.balance_after - event.balance_before;
  if (event.type === 'deposit' && isFiniteNumber(event.deposit_amount)) return event.deposit_amount;
  if (event.type === 'withdrawal' && isFiniteNumber(event.withdrawal_amount)) return -event.withdrawal_amount;
  return null;
}

function balancePathAvailable(session) {
  if (!isFiniteNumber(session.actions[0].event.balance_before)) return false;
  return session.actions.every((action) => (action.trade
    ? isFiniteNumber(action.event.balance_after)
    : transferAmount(action.event) !== null));
}

// Signal 3 state: the running result after each trade, relative to the session start.
function computeRunningResults(sessions) {
  for (const session of sessions) {
    session.source = null;
    session.complete = false;
    session.maxDrawdown = null;
    if (!session.trades.length) continue;

    if (balancePathAvailable(session)) {
      session.source = 'balance';
      const reference = session.actions[0].event.balance_before;
      let netTransfers = 0;
      for (const action of session.actions) {
        if (action.trade) action.trade.running = action.event.balance_after - reference - netTransfers;
        else netTransfers += transferAmount(action.event);
      }
    } else {
      session.source = 'realized_result';
      let cumulative = 0;
      let known = true;
      for (const trade of session.trades) {
        // A missing outcome makes the rest of the session unknown. It is never added as zero.
        known = known && trade.result !== null;
        if (known) cumulative += trade.result;
        trade.running = known ? cumulative : null;
      }
    }

    session.complete = session.trades.every((trade) => trade.running !== null);
    if (session.complete) {
      let lowest = 0;
      for (const trade of session.trades) lowest = Math.min(lowest, trade.running);
      session.maxDrawdown = lowest < 0 ? -lowest : 0;
    }
  }
}

/**
 * Drawdown bucket for a running session result, with edges in units of the
 * trader's median stake. Edges are inclusive toward flat: r = -flatBand is flat,
 * r = -largeDrawdown is down_small. Returns null if the inputs can't be bucketed.
 */
export function drawdownBucket(runningResult, medianStake, options = {}) {
  if (!isFiniteNumber(runningResult) || !isFiniteNumber(medianStake) || medianStake <= 0) return null;
  const flatBand = (options.flatBandStakes ?? DEFAULT_BEHAVIOR_OPTIONS.flatBandStakes) * medianStake;
  const largeDrawdown = (options.largeDrawdownStakes ?? DEFAULT_BEHAVIOR_OPTIONS.largeDrawdownStakes) * medianStake;
  if (runningResult > flatBand) return 'up';
  if (runningResult >= -flatBand) return 'flat';
  if (runningResult >= -largeDrawdown) return 'down_small';
  return 'down_large';
}

// --- Signal 1: post-outcome stake response ----------------------------------

function postOutcomeStakeSignal(trades, context) {
  const { options } = context;
  const minimum = minimumFor('postOutcomeStake', options);
  const ratios = { loss: [], win: [] };
  const excluded = { missingOutcome: 0, push: 0, missingStake: 0, insufficientHistory: 0, escalationPosition: 0 };
  const history = [];

  for (let index = 0; index < trades.length; index += 1) {
    const response = trades[index];
    const trigger = trades[index - 1];
    if (trigger) {
      if (trigger.outcome === null) excluded.missingOutcome += 1;
      else if (trigger.outcome === 'push') excluded.push += 1;
      else if (response.stake === null) excluded.missingStake += 1;
      else if (trigger.outcome === 'loss' && trigger.lossRunInSession >= 2 && response.session === trigger.session) {
        excluded.escalationPosition += 1; // used by signal 6 (ADR-009)
      } else {
        const prior = history.slice(-options.rollingWindow);
        if (prior.length < options.minStakeHistory) excluded.insufficientHistory += 1;
        else ratios[trigger.outcome].push(response.stake / median(prior));
      }
    }
    if (response.stake !== null) history.push(response.stake);
  }

  const summarize = (values, side) => gated(
    values.length,
    minimum,
    context.hasOutcomes ? `no realized ${side} followed by a trade with a usable stake and stake history` : 'realized_result unavailable for every trade',
    () => ({ value: median(values), meanLogRatio: mean(values.map(Math.log)) }),
    { meanLogRatio: null }
  );
  const afterLoss = summarize(ratios.loss, 'loss');
  const afterWin = summarize(ratios.win, 'win');
  const lossMinusWin = difference(afterLoss, afterWin);

  return {
    afterLoss,
    afterWin,
    lossMinusWin: {
      value: lossMinusWin.value,
      logRatioDifference: lossMinusWin.value === null ? null : afterLoss.meanLogRatio - afterWin.meanLogRatio,
      n: lossMinusWin.n,
      reason: lossMinusWin.reason
    },
    excluded
  };
}

// --- Signal 2: re-entry latency ---------------------------------------------

function reentryLatencySignal(trades, context) {
  const minimum = minimumFor('reentryLatency', context.options);
  const anySession = { loss: [], win: [] };
  const withinSession = { loss: [], win: [] };
  const excluded = { missingOutcome: 0, push: 0, noNextTrade: 0 };

  trades.forEach((trigger, index) => {
    if (trigger.outcome === null) { excluded.missingOutcome += 1; return; }
    if (trigger.outcome === 'push') { excluded.push += 1; return; }
    const next = trades[index + 1];
    if (!next) { excluded.noNextTrade += 1; return; }
    const minutes = (next.t - trigger.t) / MINUTE_MS;
    anySession[trigger.outcome].push(minutes);
    if (next.session === trigger.session) withinSession[trigger.outcome].push(minutes);
  });

  const build = (lists, scope) => {
    const summarize = (values, side) => gated(
      values.length,
      minimum,
      context.hasOutcomes ? `no realized ${side} followed by another trade${scope}` : 'realized_result unavailable for every trade',
      () => ({ value: median(values) })
    );
    const afterLoss = summarize(lists.loss, 'loss');
    const afterWin = summarize(lists.win, 'win');
    return { afterLoss, afterWin, lossMinusWin: difference(afterLoss, afterWin) };
  };

  return {
    anySession: build(anySession, ''),
    withinSession: build(withinSession, ' in the same session'),
    excluded
  };
}

// --- Signal 3: session drawdown ---------------------------------------------

function sessionDrawdownSignal(sessions, context) {
  const minimum = minimumFor('sessionDrawdown', context.options);
  const trading = sessions.filter((session) => session.trades.length);
  const complete = trading.filter((session) => session.complete);
  const drawdowns = complete.map((session) => session.maxDrawdown);
  const emptyReason = trading.length
    ? 'no session has a complete running result (realized_result missing on some trade, and balance fields incomplete)'
    : 'no session contains a trade';

  const summary = gated(drawdowns.length, minimum, emptyReason, () => {
    const value = median(drawdowns);
    return {
      value,
      valueInStakes: context.medianStake === null ? null : value / context.medianStake,
      worst: Math.max(...drawdowns)
    };
  }, { valueInStakes: null, worst: null });

  return {
    ...summary,
    sources: {
      balance: complete.filter((session) => session.source === 'balance').length,
      realized_result: complete.filter((session) => session.source === 'realized_result').length
    },
    incompleteSessions: trading.length - complete.length
  };
}

// --- Signal 4: session stop behavior ----------------------------------------

function stopBehaviorSignal(sessions, context) {
  const { options, medianStake, observationEndMs } = context;
  const minimum = minimumFor('stopBehavior', options);
  const gapMs = options.sessionGapMinutes * MINUTE_MS;
  const tallies = Object.fromEntries(DRAWDOWN_BUCKETS.map((bucket) => [bucket, { n: 0, stops: 0 }]));
  const excluded = { unknownState: 0, censored: 0 };

  if (medianStake !== null) {
    for (const session of sessions) {
      session.trades.forEach((trade, position) => {
        const last = position === session.trades.length - 1;
        if (trade.running === null) { excluded.unknownState += 1; return; }
        // The data ends before we can tell whether this session would have continued.
        if (last && observationEndMs - session.endT < gapMs) { excluded.censored += 1; return; }
        const tally = tallies[drawdownBucket(trade.running, medianStake, options)];
        tally.n += 1;
        if (last) tally.stops += 1;
      });
    }
  }

  const emptyReason = medianStake === null
    ? 'no positive stake_amount to set bucket edges'
    : 'no trade with a known session running result fell in this bucket';
  const buckets = Object.fromEntries(DRAWDOWN_BUCKETS.map((bucket) => {
    const { n, stops } = tallies[bucket];
    return [bucket, { ...gated(n, minimum, emptyReason, () => ({ value: stops / n })), stops }];
  }));

  return {
    edges: medianStake === null
      ? null
      : { flatBand: options.flatBandStakes * medianStake, largeDrawdown: options.largeDrawdownStakes * medianStake },
    buckets,
    excluded
  };
}

// --- Signal 5: refuel behavior ----------------------------------------------

function isRefuelDeposit(action) {
  // A deposit recorded with an observed zero amount moved no money, so it is not a refuel.
  return action.type === 'deposit' && !(isFiniteNumber(action.event.deposit_amount) && action.event.deposit_amount <= 0);
}

function refuelSignal(actions, trades, context) {
  const { options, medianStake, observationEndMs } = context;
  const minimum = minimumFor('refuel', options);
  const windowMs = options.refuelWindowMinutes * MINUTE_MS;
  const deposits = actions.filter(isRefuelDeposit);

  const measure = (triggers, emptyReason) => {
    let n = 0;
    let refueled = 0;
    let censored = 0;
    for (const trigger of triggers) {
      // The full window must be observed, or a missing deposit could just be past the data's end.
      if (observationEndMs - trigger.t < windowMs) { censored += 1; continue; }
      n += 1;
      if (deposits.some((deposit) => deposit.index > trigger.index && deposit.t - trigger.t <= windowMs)) refueled += 1;
    }
    const reason = n === 0 && censored > 0
      ? `all ${censored} triggers fall within ${options.refuelWindowMinutes} minutes of the observation end`
      : emptyReason;
    return { ...gated(n, minimum, reason, () => ({ value: refueled / n })), refueled, censored };
  };

  // Low-balance trigger: a trade that takes the balance from at or above the threshold to below it.
  const tradesWithBalances = trades.filter((trade) => hasBalances(trade.action.event)).length;
  const balanceComplete = trades.length > 0 && tradesWithBalances === trades.length;
  const threshold = options.lowBalanceThreshold ?? (medianStake === null ? null : options.lowBalanceStakeMultiple * medianStake);
  let lowBalance;
  if (!balanceComplete || threshold === null) {
    let reason = 'no positive stake_amount to set the low-balance threshold';
    if (!trades.length) reason = 'no trades';
    else if (tradesWithBalances === 0) reason = 'balance_before and balance_after unavailable';
    else if (!balanceComplete) reason = `balance fields incomplete: ${tradesWithBalances} of ${trades.length} trades have both`;
    lowBalance = { value: null, n: 0, reason, refueled: 0, censored: 0 };
  } else {
    const triggers = trades
      .filter((trade) => trade.action.event.balance_before >= threshold && trade.action.event.balance_after < threshold)
      .map((trade) => trade.action);
    lowBalance = measure(triggers, `balance never dropped below ${threshold}`);
  }

  // Losing-streak trigger: the trade that completes K consecutive realized losses.
  // A deposit, win, push, or missing outcome resets the count.
  const streakLength = options.losingStreakLength;
  const streakTriggers = [];
  let streak = 0;
  for (const action of actions) {
    if (isRefuelDeposit(action)) { streak = 0; continue; }
    if (!action.trade) continue;
    streak = action.trade.outcome === 'loss' ? streak + 1 : 0;
    if (streak === streakLength) streakTriggers.push(action);
  }
  const losingStreak = measure(
    streakTriggers,
    context.hasOutcomes ? `no run of ${streakLength} consecutive realized losses` : 'realized_result unavailable for every trade'
  );

  return {
    windowMinutes: options.refuelWindowMinutes,
    primary: balanceComplete ? 'lowBalance' : 'losingStreak',
    lowBalance: { ...lowBalance, threshold },
    losingStreak: { ...losingStreak, streakLength }
  };
}

// --- Signal 6: escalation within session ------------------------------------

function escalationSignal(sessions, context) {
  const minimum = minimumFor('escalation', context.options);
  const points = []; // [m - 1, log(stake after loss m / stake after loss 1)]
  const excluded = { missingStake: 0, sessionEnded: 0 };
  let runs = 0;

  for (const session of sessions) {
    const sessionTrades = session.trades;
    let start = 0;
    while (start < sessionTrades.length) {
      if (sessionTrades[start].outcome !== 'loss') { start += 1; continue; }
      let length = 1;
      while (start + length < sessionTrades.length && sessionTrades[start + length].outcome === 'loss') length += 1;

      if (length >= 2) {
        const base = sessionTrades[start + 1].stake; // stake on the trade after the first loss
        let used = 0;
        for (let m = 2; m <= length; m += 1) {
          const response = sessionTrades[start + m]; // the trade after the m-th loss
          if (!response) excluded.sessionEnded += 1;
          else if (base === null || response.stake === null) excluded.missingStake += 1;
          else {
            points.push([m - 1, Math.log(response.stake / base)]);
            used += 1;
          }
        }
        if (used) runs += 1;
      }
      start += length;
    }
  }

  const emptyReason = context.hasOutcomes
    ? 'no usable stake after the second or later loss of a same-session losing run'
    : 'realized_result unavailable for every trade';
  // Least-squares slope through the origin: at m = 1 the ratio is 1 by construction.
  const summary = gated(points.length, minimum, emptyReason, () => {
    const sxy = points.reduce((total, [x, y]) => total + x * y, 0);
    const sxx = points.reduce((total, [x]) => total + x * x, 0);
    const logSlope = sxy / sxx;
    return { value: Math.exp(logSlope), logSlope };
  }, { logSlope: null });

  return { ...summary, runs, excluded };
}

// --- Entry point ------------------------------------------------------------

function analyzeTrader(traderToken, group, options, observationEndMs) {
  const rows = [...group.rows].sort(compareRows);
  const { actions, sessions, trades } = structure(rows, options);
  computeRunningResults(sessions);

  const medianStake = median(trades.map((trade) => trade.stake).filter((stake) => stake !== null));
  const context = {
    options,
    observationEndMs,
    medianStake,
    hasOutcomes: trades.some((trade) => trade.outcome !== null)
  };

  return {
    version: BEHAVIOR_VERSION,
    traderToken,
    options,
    inputs: {
      tradeCount: trades.length,
      tradesWithStake: trades.filter((trade) => trade.stake !== null).length,
      tradesWithOutcome: trades.filter((trade) => trade.outcome !== null).length,
      tradesMissingOutcome: trades.filter((trade) => trade.outcome === null).length,
      tradesWithBalances: trades.filter((trade) => hasBalances(trade.action.event)).length,
      depositCount: actions.filter((action) => action.type === 'deposit').length,
      withdrawalCount: actions.filter((action) => action.type === 'withdrawal').length,
      sessionCount: sessions.length,
      medianStake,
      skippedInvalidTimestamps: group.invalidTimestamps
    },
    postOutcomeStake: postOutcomeStakeSignal(trades, context),
    reentryLatency: reentryLatencySignal(trades, context),
    sessionDrawdown: sessionDrawdownSignal(sessions, context),
    stopBehavior: stopBehaviorSignal(sessions, context),
    refuel: refuelSignal(actions, trades, context),
    escalation: escalationSignal(sessions, context)
  };
}

/**
 * Computes behavior-0.2.0 signals for every trader in `events`.
 * Returns one record per trader, sorted by trader token. Throws RangeError on
 * invalid options. The input events are not modified.
 */
export function buildBehaviorSignals(events, options = {}) {
  const groups = new Map();
  let latestEventMs = null;

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.trader_token === undefined || event.trader_token === null || event.trader_token === '') continue;
    const token = String(event.trader_token);
    if (!groups.has(token)) groups.set(token, { rows: [], invalidTimestamps: 0 });
    const group = groups.get(token);
    const t = Date.parse(event.occurred_at);
    if (Number.isNaN(t)) {
      group.invalidTimestamps += 1;
      continue;
    }
    group.rows.push({ event, t });
    if (latestEventMs === null || t > latestEventMs) latestEventMs = t;
  }

  const { resolved, observationEndMs } = resolveOptions(options, latestEventMs);
  return [...groups.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([token, group]) => analyzeTrader(token, group, resolved, observationEndMs));
}
