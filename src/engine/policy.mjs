/**
 * The baseline-0.1 policy layer: policies delete or cap trades in simulateTwin, whose
 * stakes don't depend on outcomes, with no response assumptions. Kept so reports can
 * compare; comparePolicy's output is labelled simulatorVersion 'baseline-0.1'. The
 * policy-0.2.0 layer, with explicit response assumptions on simulateTwinV2, is
 * policy-sim.mjs (ADR-013).
 */
import { simulateTwin } from './twin.mjs';

const BASELINE_VERSION = 'baseline-0.1';
const POLICY_TYPES = new Set(['cooldown', 'deposit_limit', 'stake_limit']);

export function validatePolicy(policy) {
  const errors = [];
  if (!policy || !POLICY_TYPES.has(policy.type)) errors.push('Policy type must be cooldown, deposit_limit, or stake_limit.');
  if (policy?.type === 'cooldown' && (!Number.isFinite(policy.durationMinutes) || policy.durationMinutes <= 0)) {
    errors.push('Cooldown durationMinutes must be positive.');
  }
  if (policy?.type === 'deposit_limit' && (!Number.isFinite(policy.dailyLimit) || policy.dailyLimit <= 0)) {
    errors.push('Deposit dailyLimit must be positive.');
  }
  if (policy?.type === 'stake_limit' && (!Number.isFinite(policy.maxStake) || policy.maxStake <= 0)) {
    errors.push('Stake maxStake must be positive.');
  }
  return { valid: errors.length === 0, errors };
}

export function comparePolicy(twins, policy, options = {}) {
  const validation = validatePolicy(policy);
  if (!validation.valid) throw new Error(validation.errors.join(' '));

  const horizonDays = options.horizonDays ?? 7;
  const results = twins.map((twin, index) => {
    const seed = (options.seed ?? 7000) + index;
    const baseline = simulateTwin(twin, { horizonDays, seed });
    const policyResult = simulateTwin(twin, { horizonDays, seed, policy });
    return {
      twinId: twin.twinId,
      traderToken: twin.profile.traderToken,
      baseline: summarizeScenario(baseline),
      policy: summarizeScenario(policyResult),
      delta: {
        tradeCount: policyResult.tradeCount - baseline.tradeCount,
        totalStake: round(policyResult.totalStake - baseline.totalStake),
        totalDeposits: round(policyResult.totalDeposits - baseline.totalDeposits),
        policyTriggers: policyResult.policyTriggers,
        blockedTrades: policyResult.blockedTrades,
        blockedDeposits: policyResult.blockedDeposits
      }
    };
  });

  return {
    simulatorVersion: BASELINE_VERSION,
    policy,
    horizonDays,
    results,
    aggregate: aggregateResults(results)
  };
}

function summarizeScenario(result) {
  return {
    tradeCount: result.tradeCount,
    depositCount: result.depositCount,
    totalStake: result.totalStake,
    totalDeposits: result.totalDeposits,
    policyTriggers: result.policyTriggers,
    blockedTrades: result.blockedTrades,
    blockedDeposits: result.blockedDeposits,
    lossRate: result.lossRate
  };
}

function aggregateResults(results) {
  const sum = (field, scenario) => results.reduce((total, result) => total + result[scenario][field], 0);
  return {
    traderCount: results.length,
    baselineTradeCount: sum('tradeCount', 'baseline'),
    policyTradeCount: sum('tradeCount', 'policy'),
    baselineTotalStake: round(sum('totalStake', 'baseline')),
    policyTotalStake: round(sum('totalStake', 'policy')),
    baselineTotalDeposits: round(sum('totalDeposits', 'baseline')),
    policyTotalDeposits: round(sum('totalDeposits', 'policy')),
    policyTriggers: results.reduce((total, result) => total + result.delta.policyTriggers, 0),
    blockedTrades: results.reduce((total, result) => total + result.delta.blockedTrades, 0),
    blockedDeposits: results.reduce((total, result) => total + result.delta.blockedDeposits, 0)
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export { POLICY_TYPES };
