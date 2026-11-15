/**
 * Policy simulation with explicit behavioral-response assumptions, version policy-0.2.0
 * (ADR-013). Runs on simulateTwinV2 (simulator-0.3.0) through its intervention hook.
 *
 * We have no intervention data, so every way a trader responds to a policy is a named
 * assumption with a default value and a default range, swept and reported with every
 * result. Results are simulations under stated assumptions: never causal claims, and
 * never a recommendation to act on any trader.
 *
 * Four policies (POLICY_DEFINITIONS), thresholds in currency as an operator sets them:
 * - cooldown: pauses trading for durationMinutes when the session first reaches
 *   lossStreak consecutive realized losses, or a drawdown of drawdownThreshold.
 * - deposit_limit: caps deposits per UTC day.
 * - stake_limit: caps each stake.
 * - session_loss_limit: ends the session when its drawdown reaches lossLimit.
 * Their response assumptions are in RESPONSE_ASSUMPTIONS.
 *
 * How a policy acts: only through the hook. Each run gets its own intervention, whose
 * randomness comes only from the run's 'policy' stream (seeded by name from the run seed,
 * like every other stream), with a fixed number of draws per policy event: cooldown 1
 * per trigger (leave), stake_limit 1 per over-cap attempt (resubmit), session_loss_limit 2
 * per limit hit (quick return, its time), deposit_limit none (the carryover is a share).
 * Using the draw whether or not it matters keeps cells with different assumption values
 * on the same uniforms, so a higher probability never flips a decision the other way.
 *
 * How a policy is compared: for each trader and replicate, the policy run and the
 * no-policy run share the seed, the parameter draws, and every trader stream (common
 * random numbers). The no-policy run is computed once and reused for every cell. Per
 * trader, harm reduction (1 - policy / baseline) and activity retained (policy /
 * baseline) are computed per replicate, then summarized (median, p10, p90); a zero
 * baseline gives null. The population sums each replicate across traders first (averages
 * drawdowns), then takes the ratio, then the percentiles.
 *
 * Pure and deterministic: the same fit, sweep, and options give the same result.
 */

import {
  SIMULATION_METRICS,
  SIMULATOR_VERSION,
  prepareSimulation,
  simulateReplicate,
  summarizeDistribution
} from './simulate.mjs';

export const POLICY_VERSION = 'policy-0.2.0';
export const POLICY_V2_TYPES = Object.freeze(['cooldown', 'deposit_limit', 'stake_limit', 'session_loss_limit']);

const DAY_SECONDS = 86400;
const QUICK_RETURN_WINDOW_SECONDS = 3600;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Each policy's config fields, its main setting (the one the sweep varies and the chart
 * labels), and the default sweep settings.
 *
 * Default settings are in currency and are starting points to re-pick for a real
 * dataset's scale. On the behavioral-synthetic population (median base stake 20, median
 * deposit about 6 base stakes) the lowest setting binds for most traders and the highest
 * for few, so each sweep runs from tight to loose:
 * - cooldown: 5, 15, 30, and 60 minutes after 3 consecutive realized losses in a session
 *   (the same losing-run length as the refuel proxy), with no drawdown trigger.
 * - stake_limit: 25, 50, 100 per trade.
 * - deposit_limit: 100, 250, 500 per UTC day.
 * - session_loss_limit: 50, 100, 200 of session drawdown.
 */
export const POLICY_DEFINITIONS = deepFreeze({
  cooldown: {
    description: 'Pauses trading for durationMinutes when the session first reaches lossStreak consecutive realized losses (the losing run escalation uses) or a session drawdown of drawdownThreshold. It fires on the crossing, not again while the condition holds.',
    settingKey: 'durationMinutes',
    fields: {
      durationMinutes: { kind: 'positive', required: true, description: 'Cooldown length, in minutes.' },
      lossStreak: { kind: 'count', nullable: true, default: 3, description: 'Consecutive realized losses in the current session that trigger a cooldown, or null.' },
      drawdownThreshold: { kind: 'currency', nullable: true, default: null, description: 'Session drawdown (currency, net of deposits) that triggers a cooldown, or null.' }
    },
    sweepSettings: [5, 15, 30, 60].map((durationMinutes) => ({ durationMinutes, lossStreak: 3, drawdownThreshold: null }))
  },
  deposit_limit: {
    description: 'Caps the total a trader can deposit per UTC day at dailyLimit. A deposit that would pass it is cut to what is left.',
    settingKey: 'dailyLimit',
    fields: { dailyLimit: { kind: 'currency', required: true, description: 'Deposit limit per UTC day (currency).' } },
    sweepSettings: [100, 250, 500].map((dailyLimit) => ({ dailyLimit }))
  },
  stake_limit: {
    description: 'Caps each stake at maxStake. The trader resubmits an over-cap stake at the cap or skips the trade (resubmitProbability).',
    settingKey: 'maxStake',
    fields: { maxStake: { kind: 'currency', required: true, description: 'Largest stake allowed per trade (currency).' } },
    sweepSettings: [25, 50, 100].map((maxStake) => ({ maxStake }))
  },
  session_loss_limit: {
    description: 'Ends the session after the trade that takes its drawdown (net of deposits) to lossLimit or more.',
    settingKey: 'lossLimit',
    fields: { lossLimit: { kind: 'currency', required: true, description: 'Session drawdown that ends the session (currency).' } },
    sweepSettings: [50, 100, 200].map((lossLimit) => ({ lossLimit }))
  }
});

/**
 * How traders respond to each policy. Assumptions, not estimates: there is no
 * intervention data. Each has a default value and a default range for the sensitivity
 * sweep. The ranges are assumptions too.
 *
 * Defaults are the policy's rule applied as written, with no further response from the
 * trader: a cooldown only delays (no rebound, nobody leaves, the session carries on), an
 * over-cap stake is placed at the cap, a blocked deposit is lost, and a forced session end
 * is followed by the normal idle time.
 */
export const RESPONSE_ASSUMPTIONS = deepFreeze({
  cooldown: {
    reboundMultiplier: {
      kind: 'positive', default: 1, range: [0.5, 1, 1.5],
      description: 'Stake multiplier on the first reboundTrades trades after the trader returns from a cooldown. 1 means no rebound.'
    },
    reboundTrades: {
      kind: 'count', default: 3, range: [3],
      description: 'How many trades after the return the rebound multiplier applies to. It ends early if the session the trader returns to ends.'
    },
    leaveProbability: {
      kind: 'probability', default: 0, range: [0, 0.25, 0.5],
      description: 'Probability that the trader leaves for the day at the cooldown instead of returning. The next session starts no earlier than the next UTC midnight plus the trader\'s normal idle time.'
    },
    referencePoint: {
      kind: 'choice', values: ['carry', 'reset'], default: 'carry', range: ['carry', 'reset'],
      description: 'carry: the pause keeps the session\'s running result and losing run. reset: the trader returns in a new session, flat, with the losing run at 0, so a stop hazard that rises with drawdown falls back to the flat bucket\'s.'
    }
  },
  deposit_limit: {
    carryoverShare: {
      kind: 'probability', default: 0, range: [0, 0.5, 1],
      description: 'Share of each blocked amount the trader deposits at the start of their first session on a later UTC day, subject to that day\'s limit.'
    }
  },
  stake_limit: {
    resubmitProbability: {
      kind: 'probability', default: 1, range: [0, 0.5, 1],
      description: 'Probability that the trader resubmits an over-cap stake at the cap rather than skipping the trade.'
    }
  },
  session_loss_limit: {
    quickReturnProbability: {
      kind: 'probability', default: 0, range: [0, 0.5, 1],
      description: 'Probability that the trader starts a new session within an hour of the forced end (between sessionGapMinutes and 60 minutes after the session\'s last event) rather than after the normal idle time.'
    }
  }
});

const metricsInGroup = (group) => Object.freeze(Object.keys(SIMULATION_METRICS).filter((name) => SIMULATION_METRICS[name].group === group));
export const HARM_METRICS = metricsInGroup('harm');
export const ACTIVITY_METRICS = metricsInGroup('activity');
const COMPARED_METRICS = Object.freeze([...HARM_METRICS, ...ACTIVITY_METRICS]);

/**
 * The trade-off chart's default axes (ADR-013). Harm: total net loss, the money the trader
 * loses, which is a sum over trades and so means the same thing whatever the session
 * accounting (session drawdown restarts at a 'reset' return by definition). Activity:
 * total stake, which also shows a stake cap that leaves the trade count alone. Under a
 * negative edge, net loss falls roughly in proportion to stake, so a policy that only cuts
 * activity sits on the line harm reduction = 1 - activity retained. beyondActivityCut is
 * the distance above that line. Both are configurable (`primary`).
 */
export const POLICY_PRIMARY_METRICS = deepFreeze({ harm: 'totalNetLoss', activity: 'totalStake' });

export const POLICY_SWEEP_DESIGNS = Object.freeze(['one-at-a-time', 'grid']);

export const DEFAULT_POLICY_SWEEP = deepFreeze({
  policies: POLICY_V2_TYPES,
  // one-at-a-time: each assumption across its range with the others at their defaults.
  // grid: every combination. Both always include the all-defaults cell.
  design: 'one-at-a-time',
  primary: POLICY_PRIMARY_METRICS,
  // type -> list of settings (config fields without `type`). Missing types use sweepSettings.
  settings: {},
  // type -> assumption -> { default?, range? }. Missing entries use RESPONSE_ASSUMPTIONS.
  assumptions: {}
});

export const POLICY_CLAIM = 'Simulation under stated assumptions, with every trader response to the policy assumed rather than estimated from intervention data. Not a causal claim, and not a recommendation to act on any trader.';

export const POLICY_ASSUMPTIONS = Object.freeze([
  'Every response to a policy is an assumption (RESPONSE_ASSUMPTIONS), swept across a range that is itself an assumption. There is no intervention data to estimate them from.',
  'Paired comparison on common random numbers: for each trader and replicate, the policy run and the no-policy run share the seed, the parameter draws, and every trader stream (outcomes, stake noise, latency, stops, refuel, deposits, idle). Policy and response randomness comes only from the separate policy stream. The no-policy run is computed once per trader and replicate and reused for every cell.',
  'Per-attempt draws: an attempt that reaches the outcome (placed, capped, or skipped) uses its 4 outcome, 1 stop, and 2 latency draws, and the next stake its 2 stake-noise draws; an attempt the broke rule ends uses none, as without a policy. A capped stake keeps its own outcome draw, with the payout or loss ratio applied to the capped stake. A skipped attempt places nothing; the trader then stops with their own hazard at the unchanged bucket, or tries again after the latency for the last outcome.',
  'Policies never overrule the trader\'s own stop: after each trade the stop draw is made first, and a policy can only end or pause a session the trader would have continued. A cooldown that fires as the trader stops still blocks trading until it ends, so it can delay the next session.',
  'Days horizon only: a cooldown, a leave, or a delayed session costs activity only when the horizon is fixed in time. With a fixed number of sessions the time a policy takes away would cost nothing. An attempt that a pause pushes to or past the horizon end is not made.',
  'One policy at a time, with the same currency thresholds for every trader.',
  'Edge cases: a reduced session-start deposit that leaves the first stake unaffordable ends that session as a forced stop with no trade, and the session is not counted (the next idle time runs from its start); leaving for the day means the next session starts no earlier than the next UTC midnight, then the trader\'s normal idle time; a deferred deposit lands at the start of the trader\'s first session on a later UTC day, before the session-start deposit rule, and counts toward that day\'s limit; a quick return starts between sessionGapMinutes and 60 minutes after the session\'s last event, or after the normal idle time if that is sooner.',
  'Cooldown referencePoint carry: the simulator keeps the paused session as one session, so session counts and drawdowns are measured from the trader\'s reference point. A pause longer than sessionGapMinutes would show as two sessions in event data (counted in pausesLongerThanSessionGap). reset: the return is a new session, so session drawdown restarts there by definition; total net loss is not affected by that accounting.',
  'deposit_limit applies only to traders with the money model. For the others it is not applicable (null), never a zero effect. Proxy-refuel and all-cause-stop traders keep their labels (labels).',
  'Harm reduction = 1 - policy / baseline and activity retained = policy / baseline, per replicate; a zero baseline gives null. Paired differences are policy - baseline in natural units. A trader-replicate pair where either run has no value (a metric that needs the money model, or a drawdown in a run with no session) is left out of that metric. Bands are the 10th and 90th percentiles across replicates: they carry the twin\'s parameter uncertainty and process noise, not uncertainty about the responses, which the sweep shows instead.'
]);

// --- Validation -----------------------------------------------------------------------------

function checkValue(spec, value, label) {
  if (value === null) return spec.nullable ? null : `${label} must not be null`;
  switch (spec.kind) {
    case 'positive':
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? null : `${label} must be a positive number`;
    case 'currency':
      return typeof value === 'number' && Number.isFinite(value) && Math.round(value * 100) >= 1 ? null : `${label} must be a currency amount of at least 0.01`;
    case 'count':
      return Number.isInteger(value) && value >= 1 ? null : `${label} must be a positive integer`;
    case 'probability':
      return typeof value === 'number' && value >= 0 && value <= 1 ? null : `${label} must be a number from 0 to 1`;
    case 'choice':
      return spec.values.includes(value) ? null : `${label} must be one of ${spec.values.join(', ')}`;
    default:
      return `${label} has an unknown kind`;
  }
}

/**
 * Validates a policy-0.2.0 config: { type, name?, ...fields } (POLICY_DEFINITIONS).
 * Returns { valid, errors, policy }, where policy is the config with defaults filled in and
 * the version, or null when invalid. validatePolicy (baseline-0.1) is unchanged.
 */
export function validatePolicyV2(policy) {
  const errors = [];
  if (!isPlainObject(policy) || !POLICY_V2_TYPES.includes(policy.type)) {
    return { valid: false, errors: [`policy type must be one of ${POLICY_V2_TYPES.join(', ')}`], policy: null };
  }
  const definition = POLICY_DEFINITIONS[policy.type];
  const resolved = { type: policy.type };
  if (policy.name !== undefined) {
    if (typeof policy.name !== 'string' || !policy.name) errors.push('name must be a non-empty string');
    else resolved.name = policy.name;
  }
  for (const key of Object.keys(policy)) {
    if (key !== 'type' && key !== 'name' && key !== 'version' && !Object.hasOwn(definition.fields, key)) errors.push(`${policy.type} has no field "${key}"`);
  }
  if (policy.version !== undefined && policy.version !== POLICY_VERSION) errors.push(`version must be ${POLICY_VERSION}`);
  for (const [field, spec] of Object.entries(definition.fields)) {
    let value = policy[field];
    if (value === undefined) {
      if (spec.required) {
        errors.push(`${policy.type}.${field} is required`);
        continue;
      }
      value = spec.default;
    }
    const error = checkValue(spec, value, `${policy.type}.${field}`);
    if (error) errors.push(error);
    else resolved[field] = value;
  }
  if (policy.type === 'cooldown' && !errors.length && resolved.lossStreak === null && resolved.drawdownThreshold === null) {
    errors.push('cooldown needs a trigger: lossStreak, drawdownThreshold, or both');
  }
  resolved.version = POLICY_VERSION;
  return errors.length ? { valid: false, errors, policy: null } : { valid: true, errors: [], policy: resolved };
}

/**
 * Validates response assumptions for a policy type (RESPONSE_ASSUMPTIONS). Missing ones
 * take their defaults. Returns { valid, errors, values }.
 */
export function validateResponseAssumptions(type, assumptions = {}) {
  if (!POLICY_V2_TYPES.includes(type)) return { valid: false, errors: [`policy type must be one of ${POLICY_V2_TYPES.join(', ')}`], values: null };
  if (!isPlainObject(assumptions)) return { valid: false, errors: ['assumptions must be an object'], values: null };
  const specs = RESPONSE_ASSUMPTIONS[type];
  const errors = [];
  for (const key of Object.keys(assumptions)) {
    if (!Object.hasOwn(specs, key)) errors.push(`${type} has no response assumption "${key}" (assumptions: ${Object.keys(specs).join(', ')})`);
  }
  const values = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = assumptions[name] === undefined ? spec.default : assumptions[name];
    const error = checkValue({ ...spec, nullable: false }, value, `${type}.${name}`);
    if (error) errors.push(error);
    else values[name] = value;
  }
  return errors.length ? { valid: false, errors, values: null } : { valid: true, errors: [], values };
}

function fail(name, message, ErrorType = RangeError) {
  throw new ErrorType(`${name}: ${message}`);
}

function resolvePolicyOrThrow(name, policy) {
  const result = validatePolicyV2(policy);
  if (!result.valid) fail(name, result.errors.join('; '));
  return result.policy;
}

const SIMULATION_OPTION_KEYS = Object.freeze(['seed', 'replicates', 'uncertainty', 'horizonDays', 'start', 'traders', 'startingBalances', 'maxTradesPerSession', 'reseedStreams']);

function splitOptions(name, options, ownKeys) {
  if (options !== undefined && !isPlainObject(options)) fail(name, 'options must be an object', TypeError);
  const simulation = {};
  const own = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value === undefined) continue;
    if (key === 'sessions') {
      fail(name, 'policy comparisons need a days horizon (horizonDays), not a session count: with a fixed number of sessions, the time a cooldown takes away costs nothing');
    }
    if (SIMULATION_OPTION_KEYS.includes(key)) simulation[key] = value;
    else if (ownKeys.includes(key)) own[key] = value;
    else fail(name, `unknown option "${key}"`);
  }
  return { simulation, own };
}

function resolvePrimary(name, primary = {}) {
  if (!isPlainObject(primary)) fail(name, 'primary must be { harm, activity }', TypeError);
  for (const key of Object.keys(primary)) if (!['harm', 'activity'].includes(key)) fail(name, `primary has no key "${key}"`);
  const resolved = { ...POLICY_PRIMARY_METRICS, ...primary };
  if (!HARM_METRICS.includes(resolved.harm)) fail(name, `primary.harm must be a harm metric (${HARM_METRICS.join(', ')})`);
  if (!ACTIVITY_METRICS.includes(resolved.activity)) fail(name, `primary.activity must be an activity metric (${ACTIVITY_METRICS.join(', ')})`);
  return resolved;
}

// --- Interventions (one per run) ---------------------------------------------------------

const dayOf = (seconds) => Math.floor(seconds / DAY_SECONDS);

function cooldownIntervention(policy, a, info, log) {
  const stream = info.policyStream;
  const durationSeconds = Math.round(policy.durationMinutes * 60);
  const gapSeconds = info.behavior.sessionGapMinutes * 60;
  const thresholdCents = policy.drawdownThreshold === null ? null : Math.round(policy.drawdownThreshold * 100);
  const accounting = {
    triggers: 0, ownStopsAtTrigger: 0, pauses: 0, leaves: 0, resets: 0, pausesLongerThanSessionGap: 0,
    delayedSessionStarts: 0, reboundTrades: 0, firstInterventionSeconds: null
  };
  let wasMet = false;
  let cooldownUntil = -Infinity;
  let leaveMidnight = null;
  let reboundLeft = 0;
  const met = (state) => (policy.lossStreak !== null && state.lossRun >= policy.lossStreak)
    || (thresholdCents !== null && -state.runningCents >= thresholdCents);

  const hook = (point, proposal, state) => {
    if (point === 'sessionStart') {
      // A new session: the condition starts unmet, and any rebound has ended.
      wasMet = false;
      reboundLeft = 0;
      let { seconds } = proposal;
      if (leaveMidnight !== null) {
        // No earlier than the next UTC midnight, then the trader's normal idle time.
        seconds += Math.max(0, leaveMidnight - (proposal.lastEventSeconds ?? proposal.seconds));
        leaveMidnight = null;
      }
      if (seconds < cooldownUntil) seconds = cooldownUntil;
      if (seconds !== proposal.seconds) accounting.delayedSessionStarts += 1;
      return { seconds };
    }
    if (point === 'beforeStake') {
      return reboundLeft > 0 ? { stakeCents: Math.max(1, Math.round(proposal.stakeCents * a.reboundMultiplier)) } : proposal;
    }
    if (point !== 'afterTrade') return proposal;

    if (reboundLeft > 0) {
      reboundLeft -= 1;
      accounting.reboundTrades += 1;
    }
    const now = met(state);
    const crossing = now && !wasMet;
    wasMet = now;
    if (!crossing) return proposal;

    accounting.triggers += 1;
    const leaveDraw = stream.next(); // one draw per trigger, used or not
    cooldownUntil = state.seconds + durationSeconds;
    if (accounting.firstInterventionSeconds === null) accounting.firstInterventionSeconds = state.seconds;
    const entry = log ? { kind: 'cooldown', seconds: state.seconds, untilSeconds: cooldownUntil, session: state.session } : null;
    if (proposal.endSession) {
      accounting.ownStopsAtTrigger += 1;
      if (log) log.push({ ...entry, response: 'ownStop' });
      return proposal;
    }
    if (leaveDraw < a.leaveProbability) {
      accounting.leaves += 1;
      leaveMidnight = (dayOf(state.seconds) + 1) * DAY_SECONDS;
      if (log) log.push({ ...entry, response: 'leave', leaveUntilSeconds: leaveMidnight });
      return { endSession: true };
    }
    accounting.pauses += 1;
    if (durationSeconds > gapSeconds) accounting.pausesLongerThanSessionGap += 1;
    reboundLeft = a.reboundMultiplier === 1 ? 0 : a.reboundTrades;
    const reset = a.referencePoint === 'reset';
    if (reset) {
      accounting.resets += 1;
      wasMet = false; // the return starts a new session, flat with no losing run
    }
    if (log) log.push({ ...entry, response: 'pause', reset });
    return { endSession: false, resumeAtSeconds: cooldownUntil, reset };
  };
  return { hook, accounting, finish: () => accounting };
}

function stakeLimitIntervention(policy, a, info, log) {
  const stream = info.policyStream;
  const capCents = Math.round(policy.maxStake * 100);
  const accounting = { overCapAttempts: 0, resubmitted: 0, skipped: 0, firstInterventionSeconds: null };
  const hook = (point, proposal, state) => {
    if (point !== 'beforeStake' || proposal.stakeCents <= capCents) return proposal;
    accounting.overCapAttempts += 1;
    if (accounting.firstInterventionSeconds === null) accounting.firstInterventionSeconds = state.seconds;
    const resubmit = stream.next() < a.resubmitProbability; // one draw per over-cap attempt
    if (log) log.push({ kind: 'overCap', seconds: state.seconds, stakeCents: proposal.stakeCents, response: resubmit ? 'resubmit' : 'skip' });
    if (resubmit) {
      accounting.resubmitted += 1;
      return { stakeCents: capCents };
    }
    accounting.skipped += 1;
    return { skip: true };
  };
  return { hook, accounting, finish: () => accounting };
}

function depositLimitIntervention(policy, a, info, log) {
  const limitCents = Math.round(policy.dailyLimit * 100);
  const accounting = {
    blockedDeposits: 0, blockedCents: 0, carriedCents: 0, deferredProposed: 0, deferredProposedCents: 0,
    deferredGrantedCents: 0, pendingCentsAtEnd: 0, firstInterventionSeconds: null
  };
  let day = null;
  let depositedToday = 0;
  let pending = []; // { cents, day }: carried amounts not yet deposited
  let releaseBefore = null; // a session start released the entries from days before this one
  const hook = (point, proposal, state) => {
    if (point === 'sessionStart') {
      const startDay = dayOf(proposal.seconds);
      const due = pending.filter((entry) => entry.day < startDay);
      if (!due.length) return proposal;
      releaseBefore = startDay;
      return { seconds: proposal.seconds, depositCents: due.reduce((total, entry) => total + entry.cents, 0) };
    }
    if (point !== 'beforeDeposit') return proposal;
    const depositDay = dayOf(proposal.seconds);
    if (depositDay !== day) {
      day = depositDay;
      depositedToday = 0;
    }
    if (proposal.kind === 'deferred') {
      // Entries leave `pending` only when their deposit is made, so a session start past the
      // horizon leaves them pending at the end.
      pending = pending.filter((entry) => entry.day >= releaseBefore);
      accounting.deferredProposed += 1;
      accounting.deferredProposedCents += proposal.amountCents;
    }
    const granted = Math.min(proposal.amountCents, Math.max(0, limitCents - depositedToday));
    const blocked = proposal.amountCents - granted;
    depositedToday += granted;
    let carried = 0;
    if (blocked > 0) {
      accounting.blockedDeposits += 1;
      accounting.blockedCents += blocked;
      if (accounting.firstInterventionSeconds === null) accounting.firstInterventionSeconds = proposal.seconds;
      carried = Math.round(a.carryoverShare * blocked);
      if (carried > 0) {
        pending.push({ cents: carried, day: depositDay });
        accounting.carriedCents += carried;
      }
    }
    if (proposal.kind === 'deferred') accounting.deferredGrantedCents += granted;
    if (log && (blocked > 0 || proposal.kind === 'deferred')) {
      log.push({ kind: 'deposit', seconds: proposal.seconds, depositKind: proposal.kind, requestedCents: proposal.amountCents, grantedCents: granted, blockedCents: blocked, carriedCents: carried });
    }
    return { amountCents: granted };
  };
  const finish = () => {
    accounting.pendingCentsAtEnd = pending.reduce((total, entry) => total + entry.cents, 0);
    return accounting;
  };
  return { hook, accounting, finish };
}

function sessionLossLimitIntervention(policy, a, info, log) {
  const stream = info.policyStream;
  const limitCents = Math.round(policy.lossLimit * 100);
  const accounting = { limitHits: 0, ownStopsAtLimit: 0, forcedEnds: 0, quickReturns: 0, firstInterventionSeconds: null };
  let quickDraw = null;
  const hook = (point, proposal, state) => {
    if (point === 'afterTrade') {
      if (-state.runningCents < limitCents) return proposal;
      accounting.limitHits += 1;
      if (accounting.firstInterventionSeconds === null) accounting.firstInterventionSeconds = state.seconds;
      const decisionDraw = stream.next(); // two draws per limit hit, used or not
      const timeDraw = stream.next();
      if (proposal.endSession) {
        accounting.ownStopsAtLimit += 1;
        if (log) log.push({ kind: 'limitHit', seconds: state.seconds, runningCents: state.runningCents, response: 'ownStop' });
        return proposal;
      }
      accounting.forcedEnds += 1;
      const quick = decisionDraw < a.quickReturnProbability;
      if (quick) {
        accounting.quickReturns += 1;
        quickDraw = timeDraw;
      }
      if (log) log.push({ kind: 'limitHit', seconds: state.seconds, runningCents: state.runningCents, response: quick ? 'quickReturn' : 'normalReturn' });
      return { endSession: true };
    }
    if (point === 'sessionStart' && quickDraw !== null) {
      // Between sessionGapMinutes (earliestSeconds) and 60 minutes after the session's last
      // event, or the normal idle time if that is sooner.
      const low = proposal.earliestSeconds;
      const high = Math.max(low, proposal.lastEventSeconds + QUICK_RETURN_WINDOW_SECONDS);
      const quickStart = low + Math.floor(quickDraw * (high - low + 1));
      quickDraw = null;
      return { seconds: Math.min(proposal.seconds, quickStart) };
    }
    return proposal;
  };
  return { hook, accounting, finish: () => accounting };
}

const INTERVENTIONS = Object.freeze({
  cooldown: cooldownIntervention,
  deposit_limit: depositLimitIntervention,
  stake_limit: stakeLimitIntervention,
  session_loss_limit: sessionLossLimitIntervention
});

// --- Paired comparison ---------------------------------------------------------------------

function pairedRatio(group, policyValue, baselineValue) {
  if (policyValue === null || baselineValue === null || baselineValue === 0) return null;
  return group === 'harm' ? 1 - policyValue / baselineValue : policyValue / baselineValue;
}

const pairedDifference = (policyValue, baselineValue) => (policyValue === null || baselineValue === null ? null : policyValue - baselineValue);

// Harm reduction above the line a pure activity cut follows: hr - (1 - ar), per replicate.
const beyondActivityCut = (harmReduction, activityRetained) => (harmReduction === null || activityRetained === null ? null : harmReduction + activityRetained - 1);

function primarySummary(primary, harmRatios, activityRatios) {
  return {
    harmMetric: primary.harm,
    activityMetric: primary.activity,
    harmReduction: summarizeDistribution(harmRatios),
    activityRetained: summarizeDistribution(activityRatios),
    beyondActivityCut: summarizeDistribution(harmRatios.map((value, index) => beyondActivityCut(value, activityRatios[index])))
  };
}

function traderComparison(pairs, primary) {
  const harmReduction = {};
  const activityRetained = {};
  const difference = {};
  const ratios = {};
  for (const name of COMPARED_METRICS) {
    const group = SIMULATION_METRICS[name].group;
    ratios[name] = pairs.map((pair) => pairedRatio(group, pair.policy[name], pair.baseline[name]));
    (group === 'harm' ? harmReduction : activityRetained)[name] = summarizeDistribution(ratios[name]);
    difference[name] = summarizeDistribution(pairs.map((pair) => pairedDifference(pair.policy[name], pair.baseline[name])));
  }
  return { primary: primarySummary(primary, ratios[primary.harm], ratios[primary.activity]), harmReduction, activityRetained, difference };
}

// Population, paired: sum (or average) each replicate across traders, then the ratio.
function pairedPopulation(replicates) {
  const acc = Object.fromEntries(COMPARED_METRICS.map((name) => [name, {
    policy: new Float64Array(replicates), baseline: new Float64Array(replicates), count: new Int32Array(replicates)
  }]));
  return {
    add(replicate, policyMetrics, baselineMetrics) {
      for (const name of COMPARED_METRICS) {
        const policyValue = policyMetrics[name];
        const baselineValue = baselineMetrics[name];
        if (policyValue === null || baselineValue === null) continue;
        const slot = acc[name];
        slot.policy[replicate] += policyValue;
        slot.baseline[replicate] += baselineValue;
        slot.count[replicate] += 1;
      }
    },
    summary(primary) {
      const harmReduction = {};
      const activityRetained = {};
      const difference = {};
      const perReplicate = {};
      for (const name of COMPARED_METRICS) {
        const { group, population } = SIMULATION_METRICS[name];
        const slot = acc[name];
        const ratios = [];
        const differences = [];
        for (let replicate = 0; replicate < replicates; replicate += 1) {
          const count = slot.count[replicate];
          if (!count) {
            ratios.push(null);
            differences.push(null);
            continue;
          }
          const divisor = population.kind === 'mean' ? count : 1;
          const policyValue = slot.policy[replicate] / divisor;
          const baselineValue = slot.baseline[replicate] / divisor;
          ratios.push(pairedRatio(group, policyValue, baselineValue));
          differences.push(policyValue - baselineValue);
        }
        perReplicate[name] = ratios;
        (group === 'harm' ? harmReduction : activityRetained)[name] = summarizeDistribution(ratios);
        difference[name] = summarizeDistribution(differences);
      }
      return { primary: primarySummary(primary, perReplicate[primary.harm], perReplicate[primary.activity]), harmReduction, activityRetained, difference };
    }
  };
}

// The no-policy population, aggregated exactly as simulateTwinV2 does it.
function baselinePopulation(replicates) {
  const acc = Object.fromEntries(Object.keys(SIMULATION_METRICS).map((name) => [name, {
    top: new Float64Array(replicates), bottom: new Float64Array(replicates), count: new Int32Array(replicates)
  }]));
  let traders = 0;
  return {
    add(runs) {
      traders += 1;
      for (const [name, spec] of Object.entries(SIMULATION_METRICS)) {
        const slot = acc[name];
        for (const run of runs) {
          const metrics = run.metrics;
          if (spec.population.kind === 'ratio') {
            const top = metrics[spec.population.numerator];
            const bottom = metrics[spec.population.denominator];
            if (top === null || bottom === null) continue;
            slot.top[run.replicate] += top;
            slot.bottom[run.replicate] += bottom;
          } else {
            const value = metrics[name];
            if (value === null) continue;
            slot.top[run.replicate] += value;
            slot.count[run.replicate] += 1;
          }
        }
      }
    },
    summary(notSimulable) {
      const metrics = {};
      for (const [name, spec] of Object.entries(SIMULATION_METRICS)) {
        const slot = acc[name];
        const perReplicate = [];
        for (let replicate = 0; replicate < replicates; replicate += 1) {
          if (spec.population.kind === 'ratio') perReplicate.push(slot.bottom[replicate] > 0 ? slot.top[replicate] / slot.bottom[replicate] : null);
          else if (!slot.count[replicate]) perReplicate.push(null);
          else perReplicate.push(spec.population.kind === 'sum' ? slot.top[replicate] : slot.top[replicate] / slot.count[replicate]);
        }
        metrics[name] = summarizeDistribution(perReplicate);
      }
      return { traders, metrics, notSimulable };
    }
  };
}

function applicability(policy, plan) {
  if (policy.type === 'deposit_limit' && !plan.mechanisms.money.simulated) {
    return { applicable: false, reason: 'deposit_limit does not apply: deposits are not simulated for this trader (no money model), so the effect is unavailable, not zero' };
  }
  return { applicable: true, reason: null };
}

function addAccounting(totals, accounting) {
  for (const [key, value] of Object.entries(accounting)) {
    if (key === 'firstInterventionSeconds') continue;
    if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
    else if (typeof value === 'boolean') totals[key] = (totals[key] ?? 0) + Number(value);
  }
}

function perRunMeans(totals, runs) {
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, runs ? value / runs : null]));
}

/**
 * Runs every cell against the shared baseline. Trader by trader: the trader's baseline runs
 * once, then each cell's policy runs, so per-trader summaries are computed at once and only
 * the population's per-replicate sums are kept.
 */
function runCells(prepared, cells, primary, { keepRuns = false, onProgress = null } = {}) {
  const { settings } = prepared;
  const replicates = settings.replicates;
  const keepLog = settings.keepEvents;
  const baseline = baselinePopulation(replicates);
  const states = cells.map((cell) => ({
    cell,
    population: pairedPopulation(replicates),
    perTrader: [],
    totals: {},
    runs: 0,
    runsWithIntervention: 0,
    applicable: 0,
    notApplicable: 0
  }));
  const simulable = prepared.plans.filter((plan) => plan.simulable);
  let done = 0;
  for (const plan of simulable) {
    const baselineRuns = [];
    for (let replicate = 0; replicate < replicates; replicate += 1) baselineRuns.push(simulateReplicate(prepared, plan, replicate));
    baseline.add(baselineRuns);
    for (const state of states) {
      const { cell } = state;
      const { applicable, reason } = applicability(cell.policy, plan);
      if (!applicable) {
        state.notApplicable += 1;
        state.perTrader.push({ traderToken: plan.traderToken, applicable: false, reason, primary: null, harmReduction: null, activityRetained: null, difference: null, accounting: null });
        continue;
      }
      state.applicable += 1;
      const pairs = [];
      const traderTotals = {};
      let traderIntervened = 0;
      for (let replicate = 0; replicate < replicates; replicate += 1) {
        let built = null;
        const log = keepLog ? [] : null;
        const run = simulateReplicate(prepared, plan, replicate, (info) => {
          built = INTERVENTIONS[cell.policy.type](cell.policy, cell.values, info, log);
          return built.hook;
        });
        const accounting = { ...run.intervention, ...built.finish() };
        state.population.add(replicate, run.metrics, baselineRuns[replicate].metrics);
        addAccounting(traderTotals, accounting);
        if (accounting.firstInterventionSeconds !== null) traderIntervened += 1;
        const pair = { replicate, policy: run.metrics, baseline: baselineRuns[replicate].metrics };
        if (keepRuns) Object.assign(pair, { accounting, policyRun: run, baselineRun: baselineRuns[replicate], log });
        pairs.push(pair);
      }
      addAccounting(state.totals, traderTotals);
      state.runs += replicates;
      state.runsWithIntervention += traderIntervened;
      const row = {
        traderToken: plan.traderToken,
        applicable: true,
        ...traderComparison(pairs, primary),
        accounting: { runsWithIntervention: traderIntervened, perRun: perRunMeans(traderTotals, replicates) }
      };
      if (keepRuns) row.runs = pairs;
      state.perTrader.push(row);
    }
    done += 1;
    if (onProgress) onProgress({ traders: done, of: simulable.length });
  }
  return {
    baseline: baseline.summary(prepared.plans.length - simulable.length),
    states: states.map((state) => ({ ...state, summary: state.applicable ? state.population.summary(primary) : null }))
  };
}

// --- Output pieces -------------------------------------------------------------------------

function flatEstimates(twin) {
  const estimates = {};
  for (const [name, record] of Object.entries(twin.parameters ?? {})) {
    if (record && typeof record === 'object' && 'status' in record) estimates[name] = record.status === 'not_estimable' ? null : record.estimate ?? null;
    else if (record && typeof record === 'object') {
      for (const [bucket, inner] of Object.entries(record)) estimates[`${name}.${bucket}`] = inner?.status === 'not_estimable' ? null : inner?.estimate ?? null;
    }
  }
  return estimates;
}

function traderDescriptors(prepared) {
  return prepared.plans.map((plan, index) => {
    const twin = prepared.settings.twins[index];
    if (!plan.simulable) return { traderToken: plan.traderToken, simulable: false, reasons: plan.reasons };
    return {
      traderToken: plan.traderToken,
      simulable: true,
      archetype: twin.archetype ?? null,
      stopBasis: plan.stopBasis,
      refuelTrigger: plan.refuel.trigger,
      moneySimulated: plan.mechanisms.money.simulated,
      estimates: flatEstimates(twin)
    };
  });
}

function traderLabels(prepared) {
  const simulable = prepared.plans.filter((plan) => plan.simulable);
  return {
    allCauseStops: simulable.filter((plan) => plan.stopBasis === 'all-cause').map((plan) => plan.traderToken),
    proxyRefuel: simulable.filter((plan) => plan.refuel.trigger === 'losingStreak (proxy)').map((plan) => plan.traderToken),
    moneyNotSimulated: simulable.filter((plan) => !plan.mechanisms.money.simulated).map((plan) => plan.traderToken),
    notSimulable: prepared.plans.filter((plan) => !plan.simulable).map((plan) => plan.traderToken),
    notes: [
      'allCauseStops: no balance fields in training, so the stop hazard already includes running out of money and the simulated broke rule double-counts stopping in low-balance states (ADR-012 point 3). Policies that act on low balances (deposit_limit) inherit that.',
      'proxyRefuel: refuel uses the losing-streak proxy trigger, not the low-balance one (ADR-012 point 4).',
      'moneyNotSimulated: no deposit model, so deposit_limit is not applicable to these traders and money metrics are null.'
    ]
  };
}

function header(fit, prepared, primary) {
  const { settings } = prepared;
  return {
    dataLabel: fit.dataLabel,
    modelVersion: fit.modelVersion,
    simulatorVersion: SIMULATOR_VERSION,
    policyVersion: POLICY_VERSION,
    behaviorVersion: fit.behaviorVersion ?? null,
    seed: settings.seed,
    replicates: settings.replicates,
    uncertainty: settings.uncertainty,
    horizon: settings.horizon,
    start: settings.start,
    maxTradesPerSession: settings.maxTradesPerSession,
    claim: POLICY_CLAIM,
    assumptions: { simulation: prepared.assumptions, policy: POLICY_ASSUMPTIONS },
    primary,
    metrics: {
      harm: HARM_METRICS,
      activity: ACTIVITY_METRICS,
      definitions: Object.fromEntries(COMPARED_METRICS.map((name) => [name, SIMULATION_METRICS[name]]))
    }
  };
}

function responseAssumptionList(type, values, specs) {
  return Object.entries(specs).map(([name, spec]) => ({
    name: `${type}.${name}`,
    value: values[name],
    default: spec.default,
    isDefault: values[name] === spec.default,
    range: spec.range,
    description: spec.description
  }));
}

function cellOutput(state, specs) {
  const { cell } = state;
  return {
    id: cell.id,
    policy: cell.policy,
    settingIndex: cell.settingIndex,
    settingLabel: cell.settingLabel,
    responseAssumptions: responseAssumptionList(cell.policy.type, cell.values, specs),
    assumptionValues: cell.values,
    varied: cell.varied,
    traderCounts: { applicable: state.applicable, notApplicable: state.notApplicable },
    population: state.summary ?? { primary: null, harmReduction: null, activityRetained: null, difference: null },
    accounting: {
      runs: state.runs,
      runsWithIntervention: state.runsWithIntervention,
      totals: state.totals,
      perRun: perRunMeans(state.totals, state.runs)
    },
    perTrader: state.perTrader
  };
}

// --- Single comparison ------------------------------------------------------------------------

/**
 * One policy with one set of response assumptions, paired against the no-policy baseline.
 * spec: { policy, assumptions? } (validatePolicyV2, validateResponseAssumptions). options:
 * simulateTwinV2's options except `sessions` (a days horizon is required), plus primary,
 * keepRuns (each trader's paired runs with accounting), and keepEvents (events, traces,
 * and the policy's decision log on those runs).
 * Returns the header (labels, versions, seed, replicates, claim, assumptions), traders,
 * labels, baseline (simulateTwinV2's population summary), and the cell: policy,
 * responseAssumptions, population { harmReduction, activityRetained, difference },
 * accounting, and perTrader. Throws on invalid input.
 */
export function comparePolicyV2(fit, spec, options = {}) {
  const name = 'comparePolicyV2';
  if (!isPlainObject(spec)) fail(name, 'spec must be { policy, assumptions? }', TypeError);
  const policy = resolvePolicyOrThrow(name, spec.policy);
  const specs = RESPONSE_ASSUMPTIONS[policy.type];
  const checked = validateResponseAssumptions(policy.type, spec.assumptions ?? {});
  if (!checked.valid) fail(name, checked.errors.join('; '));
  const { simulation, own } = splitOptions(name, options, ['primary', 'keepRuns', 'keepEvents']);
  if (own.keepEvents !== undefined) simulation.keepEvents = own.keepEvents;
  const primary = resolvePrimary(name, own.primary);
  const prepared = prepareSimulation(fit, simulation);
  const varied = Object.keys(specs).filter((key) => checked.values[key] !== specs[key].default);
  const cell = {
    id: `${policy.type}:${POLICY_DEFINITIONS[policy.type].settingKey}=${policy[POLICY_DEFINITIONS[policy.type].settingKey]}:${varied.length ? varied.map((key) => `${key}=${checked.values[key]}`).join(',') : 'defaults'}`,
    policy,
    values: checked.values,
    settingIndex: 0,
    settingLabel: `${POLICY_DEFINITIONS[policy.type].settingKey}=${policy[POLICY_DEFINITIONS[policy.type].settingKey]}`,
    varied
  };
  const { baseline, states } = runCells(prepared, [cell], primary, { keepRuns: own.keepRuns === true });
  return {
    ...header(fit, prepared, primary),
    traders: traderDescriptors(prepared),
    labels: traderLabels(prepared),
    baseline: { population: baseline },
    ...cellOutput(states[0], specs)
  };
}

// --- Sweep -------------------------------------------------------------------------------------

function sameValue(a, b) {
  return a === b;
}

function resolveSweep(sweep) {
  const name = 'runPolicySweep';
  if (!isPlainObject(sweep)) fail(name, 'sweep must be an object', TypeError);
  for (const key of Object.keys(sweep)) if (!Object.hasOwn(DEFAULT_POLICY_SWEEP, key)) fail(name, `sweep has no key "${key}"`);
  const resolved = { ...DEFAULT_POLICY_SWEEP, ...sweep };
  if (!POLICY_SWEEP_DESIGNS.includes(resolved.design)) fail(name, `design must be one of ${POLICY_SWEEP_DESIGNS.join(', ')}`);
  if (!Array.isArray(resolved.policies) || !resolved.policies.length) fail(name, 'policies must be a non-empty array of policy types');
  for (const type of resolved.policies) if (!POLICY_V2_TYPES.includes(type)) fail(name, `unknown policy type "${type}"`);
  if (new Set(resolved.policies).size !== resolved.policies.length) fail(name, 'policies lists a type twice');
  if (!isPlainObject(resolved.settings)) fail(name, 'settings must be an object of type -> list of settings', TypeError);
  if (!isPlainObject(resolved.assumptions)) fail(name, 'assumptions must be an object of type -> assumption -> { default, range }', TypeError);
  for (const type of [...Object.keys(resolved.settings), ...Object.keys(resolved.assumptions)]) {
    if (!resolved.policies.includes(type)) fail(name, `settings or assumptions name "${type}", which is not in policies`);
  }
  const primary = resolvePrimary(name, resolved.primary);

  const policies = resolved.policies.map((type) => {
    const definition = POLICY_DEFINITIONS[type];
    const rawSettings = resolved.settings[type] ?? definition.sweepSettings;
    if (!Array.isArray(rawSettings) || !rawSettings.length) fail(name, `settings.${type} must be a non-empty array`);
    const settings = rawSettings.map((setting, index) => {
      if (!isPlainObject(setting)) fail(name, `settings.${type}[${index}] must be an object`, TypeError);
      return resolvePolicyOrThrow(`${name}: settings.${type}[${index}]`, { ...setting, type });
    });
    const overrides = resolved.assumptions[type] ?? {};
    if (!isPlainObject(overrides)) fail(name, `assumptions.${type} must be an object`, TypeError);
    const specs = {};
    for (const [key, base] of Object.entries(RESPONSE_ASSUMPTIONS[type])) {
      const override = overrides[key] ?? {};
      if (!isPlainObject(override)) fail(name, `assumptions.${type}.${key} must be { default?, range? }`, TypeError);
      for (const field of Object.keys(override)) if (!['default', 'range'].includes(field)) fail(name, `assumptions.${type}.${key} has no field "${field}"`);
      const spec = { ...base, ...override };
      if (!Array.isArray(spec.range) || !spec.range.length) fail(name, `assumptions.${type}.${key}.range must be a non-empty array`);
      for (const value of [spec.default, ...spec.range]) {
        const error = checkValue({ ...spec, nullable: false }, value, `assumptions.${type}.${key}`);
        if (error) fail(name, error);
      }
      if (new Set(spec.range).size !== spec.range.length) fail(name, `assumptions.${type}.${key}.range repeats a value`);
      if (!spec.range.some((value) => sameValue(value, spec.default))) fail(name, `assumptions.${type}.${key}.range must include its default (${spec.default})`);
      specs[key] = spec;
    }
    for (const key of Object.keys(overrides)) if (!Object.hasOwn(specs, key)) fail(name, `${type} has no response assumption "${key}"`);
    const settingKey = definition.settingKey;
    const labels = settings.map((setting) => `${settingKey}=${setting[settingKey]}`);
    const settingLabels = labels.map((label, index) => (labels.indexOf(label) === labels.lastIndexOf(label) ? label : `${label}#${index}`));
    return { type, settingKey, settings, settingLabels, specs };
  });
  return { design: resolved.design, primary, policies };
}

function combinations(specs) {
  let rows = [{}];
  for (const [key, spec] of Object.entries(specs)) {
    rows = rows.flatMap((row) => spec.range.map((value) => ({ ...row, [key]: value })));
  }
  return rows;
}

function buildCells(policyPlan, design) {
  const { type, settings, settingLabels, specs } = policyPlan;
  const defaults = Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, spec.default]));
  const valueSets = design === 'grid'
    ? combinations(specs)
    : [defaults, ...Object.entries(specs).flatMap(([key, spec]) => spec.range.filter((value) => !sameValue(value, spec.default)).map((value) => ({ ...defaults, [key]: value })))];
  const cells = [];
  settings.forEach((policy, settingIndex) => {
    const seen = new Set();
    for (const values of valueSets) {
      const varied = Object.keys(specs).filter((key) => !sameValue(values[key], specs[key].default));
      const id = `${type}:${settingLabels[settingIndex]}:${varied.length ? varied.map((key) => `${key}=${values[key]}`).join(',') : 'defaults'}`;
      if (seen.has(id)) continue;
      seen.add(id);
      cells.push({ id, policy, values, settingIndex, settingLabel: settingLabels[settingIndex], varied });
    }
  });
  return cells;
}

function point(cell) {
  const summary = cell.population.primary;
  return {
    settingIndex: cell.settingIndex,
    settingLabel: cell.settingLabel,
    cellId: cell.id,
    harmReduction: summary ? summary.harmReduction : null,
    activityRetained: summary ? summary.activityRetained : null,
    beyondActivityCut: summary ? summary.beyondActivityCut : null
  };
}

// The cell for one setting with `key` at `value` and every other assumption at its default.
function sliceCell(cells, specs, settingIndex, key, value) {
  return cells.find((cell) => cell.settingIndex === settingIndex
    && Object.entries(specs).every(([name, spec]) => sameValue(cell.assumptionValues[name], name === key ? value : spec.default)));
}

function chartFor(policyPlan, cells, primary) {
  const { type, settings, specs } = policyPlan;
  const swept = Object.entries(specs).filter(([, spec]) => spec.range.length > 1);
  const series = [];
  const settingsList = settings.map((_, index) => index);
  if (!swept.length) {
    series.push({ id: 'defaults', assumption: null, value: null, isDefault: true, points: settingsList.map((index) => point(sliceCell(cells, specs, index, null, null))) });
  }
  for (const [key, spec] of swept) {
    for (const value of spec.range) {
      series.push({
        id: `${type}.${key}=${value}`,
        assumption: `${type}.${key}`,
        value,
        isDefault: sameValue(value, spec.default),
        points: settingsList.map((index) => point(sliceCell(cells, specs, index, key, value)))
      });
    }
  }
  return {
    harmMetric: primary.harm,
    activityMetric: primary.activity,
    x: `activity retained: ${primary.activity} under the policy / without it (population, paired)`,
    y: `harm reduction: 1 - ${primary.harm} under the policy / without it (population, paired)`,
    bands: 'median with the 10th and 90th percentiles across replicates',
    reference: {
      line: 'y = 1 - x',
      meaning: `Where a policy that only cuts activity would sit if ${primary.harm} scaled with ${primary.activity}, as net loss does with stake under a constant edge. beyondActivityCut is each point's distance above it, per replicate.`
    },
    series
  };
}

function spreadOf(values) {
  const known = values.filter((value) => value !== null && Number.isFinite(value));
  return known.length >= 2 ? Math.max(...known) - Math.min(...known) : null;
}

const format = (value) => (value === null ? 'n/a' : value.toFixed(3));

function driverFor(policyPlan, cells, primary) {
  const { type, settingKey, settings, specs } = policyPlan;
  const medianAt = (cell) => cell?.population.harmReduction?.[primary.harm]?.median ?? null;
  const defaultsBySetting = settings.map((_, index) => medianAt(sliceCell(cells, specs, index, null, null)));
  const setting = {
    name: `${type}.${settingKey}`,
    values: settings.map((policy) => policy[settingKey]),
    medians: defaultsBySetting,
    spread: settings.length > 1 ? spreadOf(defaultsBySetting) : null
  };
  const assumptions = {};
  for (const [key, spec] of Object.entries(specs)) {
    if (spec.range.length < 2) continue;
    const bySetting = settings.map((_, index) => spreadOf(spec.range.map((value) => medianAt(sliceCell(cells, specs, index, key, value)))));
    let at = null;
    bySetting.forEach((spread, index) => {
      if (spread !== null && (at === null || spread > bySetting[at])) at = index;
    });
    assumptions[`${type}.${key}`] = {
      range: spec.range,
      spreadBySetting: bySetting,
      spread: at === null ? null : bySetting[at],
      atSetting: at === null ? null : policyPlan.settingLabels[at]
    };
  }
  const candidates = [
    ...(setting.spread === null ? [] : [{ name: setting.name, kind: 'setting', spread: setting.spread }]),
    ...Object.entries(assumptions).filter(([, item]) => item.spread !== null).map(([name, item]) => ({ name, kind: 'assumption', spread: item.spread }))
  ];
  const largest = candidates.reduce((best, item) => (best === null || item.spread > best.spread ? item : best), null);
  const harm = primary.harm;
  let statement;
  if (largest === null) {
    statement = `${type}: the primary harm reduction (${harm}) is unavailable or not swept in enough cells to name what drives it.`;
  } else {
    const strongestAssumption = Object.entries(assumptions).filter(([, item]) => item.spread !== null)
      .reduce((best, entry) => (best === null || entry[1].spread > best[1].spread ? entry : best), null);
    const settingText = `the policy setting (${settingKey} ${setting.values.join(', ')}) moves the population median by ${format(setting.spread)}`;
    if (largest.kind === 'setting') {
      statement = strongestAssumption
        ? `${type}: the policy setting drives the primary harm reduction (${harm}) more than any response assumption: ${settingText}, against at most ${format(strongestAssumption[1].spread)} across ${strongestAssumption[0]} (at ${strongestAssumption[1].atSetting}).`
        : `${type}: ${settingText}; no response assumption is swept.`;
    } else {
      const item = assumptions[largest.name];
      statement = `${type}: the response assumption ${largest.name}, which is assumed rather than estimated, drives the primary harm reduction (${harm}) more than the policy setting does: across its range (${item.range.join(', ')}) it moves the population median by ${format(item.spread)} (at ${item.atSetting}), while ${settingText}.`;
    }
  }
  return { harmMetric: harm, basis: 'population median of the primary harm reduction', setting, assumptions, largest: largest ? largest.name : null, statement };
}

/**
 * The sensitivity sweep. For each policy in sweep.policies, crosses its settings with its
 * response assumptions (DEFAULT_POLICY_SWEEP: one-at-a-time by default, or the full grid)
 * and compares every cell with the shared no-policy baseline on common random numbers.
 * options: simulateTwinV2's options except `sessions`, plus onProgress({ traders, of }).
 * To scale down, lower replicates, pass fewer traders, policies, or settings, or shorten
 * ranges.
 *
 * Returns the header (labels, versions, seed, replicates, claim, assumptions, primary),
 * traders (descriptors with parameter estimates, for grouping by archetype or parameter
 * range), labels, baseline, and policies: per type its settings, response assumptions,
 * cells (each with population and per-trader results), chart (harm reduction against
 * activity retained, one series per response assumption value, with bands), and driver
 * (which of the setting and the assumptions moves the primary harm reduction most, with
 * a plain statement). Throws on invalid input.
 */
export function runPolicySweep(fit, sweep = {}, options = {}) {
  const name = 'runPolicySweep';
  const plan = resolveSweep(sweep);
  const { simulation, own } = splitOptions(name, options, ['onProgress']);
  if (own.onProgress !== undefined && typeof own.onProgress !== 'function') fail(name, 'onProgress must be a function', TypeError);
  const prepared = prepareSimulation(fit, simulation);
  const cellsByPolicy = plan.policies.map((policyPlan) => buildCells(policyPlan, plan.design));
  const allCells = cellsByPolicy.flat();
  const { baseline, states } = runCells(prepared, allCells, plan.primary, { onProgress: own.onProgress ?? null });

  let offset = 0;
  const policies = plan.policies.map((policyPlan, index) => {
    const count = cellsByPolicy[index].length;
    const cells = states.slice(offset, offset + count).map((state) => cellOutput(state, policyPlan.specs));
    offset += count;
    return {
      type: policyPlan.type,
      description: POLICY_DEFINITIONS[policyPlan.type].description,
      settingKey: policyPlan.settingKey,
      settings: policyPlan.settings,
      settingLabels: policyPlan.settingLabels,
      responseAssumptions: Object.fromEntries(Object.entries(policyPlan.specs).map(([key, spec]) => [`${policyPlan.type}.${key}`, {
        default: spec.default, range: spec.range, description: spec.description
      }])),
      cells,
      chart: chartFor(policyPlan, cells, plan.primary),
      driver: driverFor(policyPlan, cells, plan.primary)
    };
  });

  return {
    ...header(fit, prepared, plan.primary),
    design: plan.design,
    cellCount: allCells.length,
    traders: traderDescriptors(prepared),
    labels: traderLabels(prepared),
    baseline: { population: baseline },
    policies
  };
}
