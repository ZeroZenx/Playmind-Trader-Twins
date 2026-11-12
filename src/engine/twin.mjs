import { createRng, stableSeed } from './rng.mjs';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

export function buildTwinProfile(signal) {
  const trainingDays = Math.max(1, signal.trainingDays);
  const lossRate = signal.lossRate ?? 0.5;
  return {
    traderToken: signal.traderToken,
    trainingDays,
    sessionRatePerDay: signal.sessionCount / trainingDays,
    tradesPerSession: Math.max(1, signal.averageTradesPerSession || 1),
    averageStake: Math.max(1, signal.averageStake || 10),
    medianStake: Math.max(1, signal.medianStake || signal.averageStake || 10),
    depositRatePerDay: signal.depositCount / trainingDays,
    averageDeposit: Math.max(1, signal.averageDeposit || 50),
    lossRate,
    policyEventRate: signal.policyEventCount / trainingDays,
    marketMix: signal.marketCounts,
    sourceEventCount: signal.eventCount
  };
}

export function buildTwins(signals, seed = 170000) {
  return signals.map((signal, index) => ({
    twinId: `twin_${signal.traderToken}`,
    modelName: 'transparent-behavioral-baseline',
    modelVersion: '0.1.0',
    randomSeed: stableSeed(`${seed}:${signal.traderToken}:${index}`),
    profile: buildTwinProfile(signal),
    validation: {
      validationWindow: 'held-out synthetic replay required',
      status: 'pending'
    }
  }));
}

function chooseMarket(marketMix, rng) {
  const entries = Object.entries(marketMix);
  if (!entries.length) return 'unknown';
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  let threshold = rng.next() * total;
  for (const [market, count] of entries) {
    threshold -= count;
    if (threshold <= 0) return market;
  }
  return entries.at(-1)[0];
}

function policyBlocksTrade(policy, state, proposedStake, eventTime) {
  if (!policy) return null;
  // stake_limit never blocks: it caps the stake at maxStake below.
  if (policy.type === 'cooldown' && state.cooldownUntil && eventTime < state.cooldownUntil) return 'cooldown';
  return null;
}

export function simulateTwin(twin, options = {}) {
  const horizonDays = options.horizonDays ?? 7;
  const policy = options.policy ?? null;
  const rng = createRng(options.seed ?? twin.randomSeed);
  const profile = twin.profile;
  const state = { cooldownUntil: null, depositsToday: 0, currentDay: null };
  const simulatedEvents = [];
  let policyTriggers = 0;
  let blockedTrades = 0;
  let blockedDeposits = 0;
  let totalStake = 0;
  let totalDeposits = 0;
  let realizedLossCount = 0;
  let realizedOutcomeCount = 0;

  const start = new Date('2026-01-01T12:00:00.000Z');
  const sessionsPerDay = Math.max(0.1, profile.sessionRatePerDay);
  const expectedSessions = Math.max(1, Math.round(sessionsPerDay * horizonDays));

  for (let sessionIndex = 0; sessionIndex < expectedSessions; sessionIndex += 1) {
    const dayOffset = Math.min(horizonDays - 1, Math.floor(sessionIndex / Math.max(1, Math.ceil(expectedSessions / horizonDays))));
    const eventTime = new Date(start.getTime() + (dayOffset * 86400000) + ((sessionIndex % 3) * 3600000));
    const dayKey = eventTime.toISOString().slice(0, 10);
    if (state.currentDay !== dayKey) {
      state.currentDay = dayKey;
      state.depositsToday = 0;
    }

    const desiredDeposit = Math.max(0, roundMoney(profile.averageDeposit * (0.65 + rng.next() * 0.7)));
    let acceptedDeposit = desiredDeposit;
    if (policy?.type === 'deposit_limit' && state.depositsToday + desiredDeposit > policy.dailyLimit) {
      acceptedDeposit = Math.max(0, roundMoney(policy.dailyLimit - state.depositsToday));
      if (acceptedDeposit < desiredDeposit) {
        blockedDeposits += 1;
        policyTriggers += 1;
      }
    }
    state.depositsToday += acceptedDeposit;
    totalDeposits += acceptedDeposit;
    simulatedEvents.push({ type: 'deposit', occurredAt: eventTime.toISOString(), amount: acceptedDeposit });

    const requestedTrades = Math.max(1, Math.round(profile.tradesPerSession * (0.7 + rng.next() * 0.6)));
    for (let tradeIndex = 0; tradeIndex < requestedTrades; tradeIndex += 1) {
      const tradeTime = new Date(eventTime.getTime() + tradeIndex * 12 * 60000);
      const proposedStake = Math.max(1, roundMoney(profile.averageStake * (0.55 + rng.next() * 0.9)));
      const marketType = chooseMarket(profile.marketMix, rng);
      const realizedResult = rng.next() < profile.lossRate
        ? -roundMoney(proposedStake * (0.2 + rng.next() * 0.8))
        : roundMoney(proposedStake * (0.1 + rng.next() * 1.2));
      const blockReason = policyBlocksTrade(policy, state, proposedStake, tradeTime);
      if (blockReason) {
        blockedTrades += 1;
        policyTriggers += 1;
        continue;
      }

      const stake = policy?.type === 'stake_limit' ? Math.min(proposedStake, policy.maxStake) : proposedStake;
      if (stake < proposedStake) policyTriggers += 1;
      const adjustedResult = stake === proposedStake
        ? realizedResult
        : roundMoney(realizedResult * (stake / proposedStake));
      const result = adjustedResult;
      if (result < 0) realizedLossCount += 1;
      realizedOutcomeCount += 1;
      totalStake += stake;
      simulatedEvents.push({
        type: 'trade',
        occurredAt: tradeTime.toISOString(),
        marketType,
        stakeAmount: stake,
        realizedResult: result
      });

      if (policy?.type === 'cooldown' && result < 0) {
        state.cooldownUntil = new Date(tradeTime.getTime() + policy.durationMinutes * 60000);
        policyTriggers += 1;
      }
    }
  }

  const tradeCount = simulatedEvents.filter((event) => event.type === 'trade').length;
  return {
    scenario: policy ? 'policy' : 'baseline',
    horizonDays,
    tradeCount,
    depositCount: simulatedEvents.filter((event) => event.type === 'deposit' && event.amount > 0).length,
    totalStake: roundMoney(totalStake),
    totalDeposits: roundMoney(totalDeposits),
    policyTriggers,
    blockedTrades,
    blockedDeposits,
    realizedOutcomeCount,
    realizedLossCount,
    lossRate: realizedOutcomeCount ? realizedLossCount / realizedOutcomeCount : null,
    events: simulatedEvents
  };
}

export function validateTwin(twin, observedSignal, simulatedResult) {
  const comparisons = [
    ['tradeCount', observedSignal.tradeCount, simulatedResult.tradeCount],
    ['totalDeposits', observedSignal.totalDeposits, simulatedResult.totalDeposits],
    ['totalStake', observedSignal.totalStake, simulatedResult.totalStake]
  ].map(([metric, observed, simulated]) => ({
    metric,
    observed,
    simulated,
    relativeDifference: observed === 0 ? null : Math.abs(simulated - observed) / Math.abs(observed)
  }));
  return {
    twinId: twin.twinId,
    status: 'synthetic-baseline-check',
    comparisons,
    note: 'Synthetic replay is a mechanics check. It is not proof of production model performance.'
  };
}
