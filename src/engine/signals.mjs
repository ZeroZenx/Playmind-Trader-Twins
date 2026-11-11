function numericValues(events, field) {
  return events.map((event) => event[field]).filter((value) => typeof value === 'number' && Number.isFinite(value));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function average(values) {
  return values.length ? sum(values) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function groupByTrader(events) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.trader_token)) groups.set(event.trader_token, []);
    groups.get(event.trader_token).push(event);
  }
  return groups;
}

export function sessionize(events, sessionGapMinutes = 30) {
  const sorted = [...events].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const sessions = [];
  for (const event of sorted) {
    const previous = sessions.at(-1);
    const eventTime = new Date(event.occurred_at);
    const gapMinutes = previous ? (eventTime - new Date(previous.events.at(-1).occurred_at)) / 60000 : Infinity;
    if (!previous || gapMinutes > sessionGapMinutes) {
      sessions.push({ startedAt: event.occurred_at, endedAt: event.occurred_at, events: [event] });
    } else {
      previous.events.push(event);
      previous.endedAt = event.occurred_at;
    }
  }
  return sessions.map((session) => ({
    ...session,
    durationMinutes: (new Date(session.endedAt) - new Date(session.startedAt)) / 60000
  }));
}

export function buildSignals(events, options = {}) {
  const sessionGapMinutes = options.sessionGapMinutes ?? 30;
  const groups = groupByTrader(events);
  const results = [];

  for (const [traderToken, traderEvents] of groups.entries()) {
    const sorted = [...traderEvents].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
    const trades = sorted.filter((event) => event.type === 'trade');
    const deposits = sorted.filter((event) => event.type === 'deposit');
    const withdrawals = sorted.filter((event) => event.type === 'withdrawal');
    const realized = trades.map((event) => event.realized_result).filter((value) => typeof value === 'number' && Number.isFinite(value));
    const stakeValues = numericValues(trades, 'stake_amount');
    const depositValues = numericValues(deposits, 'deposit_amount');
    const sessions = sessionize(sorted, sessionGapMinutes);
    const trainingDays = Math.max(1, (new Date(sorted.at(-1).occurred_at) - new Date(sorted[0].occurred_at)) / 86400000);
    const marketCounts = {};
    for (const trade of trades) {
      marketCounts[trade.market_type ?? 'unknown'] = (marketCounts[trade.market_type ?? 'unknown'] ?? 0) + 1;
    }

    results.push({
      traderToken,
      firstSeenAt: sorted[0].occurred_at,
      lastSeenAt: sorted.at(-1).occurred_at,
      trainingDays,
      eventCount: sorted.length,
      tradeCount: trades.length,
      depositCount: deposits.length,
      withdrawalCount: withdrawals.length,
      sessionCount: sessions.length,
      averageSessionMinutes: average(sessions.map((session) => session.durationMinutes)),
      averageTradesPerSession: sessions.length ? trades.length / sessions.length : 0,
      averageReturnIntervalHours: sessions.length > 1
        ? average(sessions.slice(1).map((session, index) => (new Date(session.startedAt) - new Date(sessions[index].startedAt)) / 3600000))
        : null,
      totalStake: sum(stakeValues),
      averageStake: average(stakeValues),
      medianStake: median(stakeValues),
      totalDeposits: sum(depositValues),
      averageDeposit: average(depositValues),
      realizedOutcomeCount: realized.length,
      missingRealizedOutcomeCount: trades.length - realized.length,
      realizedLossCount: realized.filter((value) => value < 0).length,
      realizedResultSum: sum(realized),
      lossRate: realized.length ? realized.filter((value) => value < 0).length / realized.length : null,
      marketCounts,
      policyEventCount: sorted.filter((event) => event.type === 'policy_event' || event.type === 'restriction_event').length
    });
  }

  return results.sort((a, b) => a.traderToken.localeCompare(b.traderToken));
}

export function aggregateSignals(signals) {
  const totalTrades = sum(signals.map((signal) => signal.tradeCount));
  const totalDeposits = sum(signals.map((signal) => signal.totalDeposits));
  return {
    traderCount: signals.length,
    totalEvents: sum(signals.map((signal) => signal.eventCount)),
    totalTrades,
    totalDeposits,
    averageTradesPerTrader: signals.length ? totalTrades / signals.length : 0,
    averageDepositsPerTrader: signals.length ? totalDeposits / signals.length : 0,
    realizedOutcomeCoverage: signals.reduce((count, signal) => count + signal.realizedOutcomeCount, 0) / Math.max(1, totalTrades)
  };
}
