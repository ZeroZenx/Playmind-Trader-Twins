/**
 * Evidence report v2, version report-0.2.0.
 *
 * buildReportV2 turns one dataset, its twin fit (twin-0.3.0), its held-out validation
 * (holdout-0.1.0), and one policy sweep (policy-0.2.0) into a JSON report with six
 * sections, in this order:
 *   1. data: the label, a dataset summary, field coverage, and which twin parameters the
 *      fields present made estimable;
 *   2. population: chase coefficients, stop behavior by drawdown, refuel rates;
 *   3. validation: held-out results against baseline-0.1 and naive-0.1, calibration
 *      coverage, pass/fail;
 *   4. policy: harm reduction against activity retained for each policy setting, with
 *      bands, one series per response assumption value;
 *   5. affected: which traders a policy affects most, by archetype or parameter range,
 *      never by individual token;
 *   6. assumptions: assumptions and limits, stated plainly.
 * renderReportV2Html renders that JSON (and only that JSON) as one self-contained HTML
 * page with inline SVG charts and no scripts.
 *
 * The report carries no trader token anywhere. Every number in it is either a description
 * of the data, a simulation under stated assumptions (not causal evidence), or held-out
 * validation evidence about a model (not an accuracy headline). It contains model
 * evaluation results, so it belongs in gitignored local output (CLAUDE.md), and a report
 * built from CUSTOMER data is customer-derived data that stays out of the repo.
 *
 * Pure: no I/O. Deterministic except generatedAt, which the caller passes.
 */

import { DRAWDOWN_BUCKETS } from './behavior.mjs';
import { DATA_LABELS, TWIN_MODEL_VERSION, TWIN_PARAMETER_DEFINITIONS, TWIN_PARAMETER_NAMES } from './estimate.mjs';
import { HOLDOUT_METRICS } from './holdout.mjs';
import { POLICY_ASSUMPTIONS } from './policy-sim.mjs';
import { SIMULATOR_VERSION } from './simulate.mjs';
import { median, quantile } from './stats.mjs';

export const REPORT_V2_VERSION = 'report-0.2.0';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const REPORT_V2_DEFAULTS = deepFreeze({
  // Section 5 never shows a group with fewer traders than this.
  minGroupSize: 5,
  // Section 5's parameter ranges. Chase: the 1.25 edge is the chase-episode line (ADR-012).
  chaseRanges: [
    { name: 'scales back after a loss', rule: 'chaseCoefficient < 0.8', below: 0.8 },
    { name: 'about the same after a loss', rule: '0.8 <= chaseCoefficient < 1.25', below: 1.25 },
    { name: 'chases after a loss', rule: 'chaseCoefficient >= 1.25', below: Infinity }
  ],
  // Stop pattern: stopHazard.down_large / stopHazard.flat.
  stopRanges: [
    { name: 'stops about as often when down', rule: 'down_large / flat stop hazard < 1.5', below: 1.5 },
    { name: 'stops more when down', rule: '1.5 <= down_large / flat < 3', below: 3 },
    { name: 'quits when down', rule: 'down_large / flat >= 3', below: Infinity }
  ]
});

export const REPORT_SECTIONS = Object.freeze(['data', 'population', 'validation', 'policy', 'affected', 'assumptions']);

const FIELD_COVERAGE = Object.freeze([
  { field: 'stake_amount', appliesTo: 'trade', role: 'Stakes, chase, escalation, and the drawdown buckets. Needed for most parameters.' },
  { field: 'realized_result', appliesTo: 'trade', role: 'Outcomes, chase, escalation, latencies, and stops. A missing value stays unavailable, never zero.' },
  { field: 'balance_before', appliesTo: 'trade', role: 'With balance_after on every trade: the refuel probability and the voluntary stop hazard.' },
  { field: 'balance_after', appliesTo: 'trade', role: 'With balance_before on every trade: the refuel probability and the voluntary stop hazard.' },
  { field: 'deposit_amount', appliesTo: 'deposit', role: 'Deposit size and spread.' },
  { field: 'withdrawal_amount', appliesTo: 'withdrawal', role: 'Net transfers in the session drawdown. Optional.' },
  { field: 'market_id', appliesTo: 'trade', role: 'Optional. Not used by the twin.' },
  { field: 'market_type', appliesTo: 'trade', role: 'Optional. Not used by the twin.' },
  { field: 'price', appliesTo: 'trade', role: 'Optional. Not used by the twin.' },
  { field: 'quantity', appliesTo: 'trade', role: 'Optional. Not used by the twin.' }
]);

// sqrt(2) steps from 0.25 to 4, so 1 is an edge.
const CHASE_EDGES = Object.freeze(Array.from({ length: 9 }, (_, index) => 2 ** ((index - 4) / 2)));
const PROBABILITY_EDGES = Object.freeze(Array.from({ length: 11 }, (_, index) => index / 10));

// --- Helpers -------------------------------------------------------------------------------

function fail(message, ErrorType = RangeError) {
  throw new ErrorType(`buildReportV2: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function spread(values) {
  const known = values.filter(isFiniteNumber);
  if (!known.length) return { n: 0, median: null, p10: null, p25: null, p75: null, p90: null };
  return {
    n: known.length,
    median: median(known),
    p10: quantile(known, 0.1),
    p25: quantile(known, 0.25),
    p75: quantile(known, 0.75),
    p90: quantile(known, 0.9)
  };
}

/** Counts per bin; values outside the edges go to the end bins and are counted as clipped. */
function histogram(values, edges) {
  const bins = edges.slice(0, -1).map((low, index) => ({ low, high: edges[index + 1], count: 0 }));
  let clipped = 0;
  for (const value of values) {
    if (!isFiniteNumber(value)) continue;
    let index = bins.findIndex((bin, position) => value >= bin.low && (value < bin.high || (position === bins.length - 1 && value <= bin.high)));
    if (index === -1) {
      clipped += 1;
      index = value < edges[0] ? 0 : bins.length - 1;
    }
    bins[index].count += 1;
  }
  return { bins, clipped };
}

function share(part, whole) {
  return whole ? part / whole : null;
}

function pct(value, digits = 0) {
  return value === null || value === undefined ? 'n/a' : `${(100 * value).toFixed(digits)}%`;
}

function num(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const text = Number(value).toFixed(digits);
  return /^-0\.?0*$/.test(text) ? text.slice(1) : text; // no "-0.000"
}

function estimateOf(twin, name, bucket = null) {
  const record = bucket ? twin.parameters?.[name]?.[bucket] : twin.parameters?.[name];
  return record && record.status === 'estimated' && isFiniteNumber(record.estimate) ? record : null;
}

function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

// --- Section 1: data -------------------------------------------------------------------------

function dataSection(dataset, quality, fit, dataLabel) {
  const events = dataset.events;
  const byType = tally(events.map((event) => event.type));
  const traders = new Set(events.map((event) => event.trader_token).filter((token) => !isBlank(token))).size;
  const coverage = FIELD_COVERAGE.map((spec) => {
    const relevant = events.filter((event) => event.type === spec.appliesTo);
    const present = relevant.filter((event) => !isBlank(event[spec.field])).length;
    return { ...spec, present, total: relevant.length, share: share(present, relevant.length) };
  });

  const parameterNames = TWIN_PARAMETER_NAMES.flatMap((name) => (name === 'stopHazard' ? DRAWDOWN_BUCKETS.map((bucket) => `stopHazard.${bucket}`) : [name]));
  const estimability = parameterNames.map((name) => {
    const [head, bucket] = name.split('.');
    const records = fit.twins.map((twin) => (bucket ? twin.parameters?.[head]?.[bucket] : twin.parameters?.[head])).filter(Boolean);
    const counts = tally(records.map((record) => record.status));
    const reasons = Object.entries(tally(records.filter((record) => record.status === 'not_estimable').map((record) => record.reason ?? 'no reason given')))
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count }));
    const estimated = counts.estimated ?? 0;
    const priorOnly = counts.prior_only ?? 0;
    const notEstimable = counts.not_estimable ?? 0;
    return {
      parameter: name,
      description: TWIN_PARAMETER_DEFINITIONS[head].description,
      requires: TWIN_PARAMETER_DEFINITIONS[head].requires,
      estimated,
      priorOnly,
      notEstimable,
      status: notEstimable === records.length ? 'not estimable' : estimated === 0 ? 'prior only' : notEstimable > 0 ? 'estimable for some traders' : 'estimable',
      reasons
    };
  });
  const stopBasis = tally(fit.twins.map((twin) => twin.stopHazardBasis ?? 'unknown'));
  const notEstimable = estimability.filter((row) => row.status === 'not estimable').map((row) => row.parameter);
  const balances = coverage.filter((row) => row.field.startsWith('balance_') && row.appliesTo === 'trade');
  const hasBalances = balances.every((row) => row.share === 1);
  return {
    label: dataLabel,
    name: dataset.name ?? null,
    venueId: dataset.venueId ?? (events[0]?.venue_id ?? null),
    generator: dataset.generator ?? null,
    summary: {
      events: events.length,
      traders,
      trades: byType.trade ?? 0,
      deposits: byType.deposit ?? 0,
      withdrawals: byType.withdrawal ?? 0,
      otherEvents: events.length - (byType.trade ?? 0) - (byType.deposit ?? 0) - (byType.withdrawal ?? 0),
      startsAt: quality?.stats?.startsAt ?? null,
      endsAt: quality?.stats?.endsAt ?? null,
      validation: quality ? { valid: quality.valid, errors: quality.errors.length, warnings: quality.warnings.length } : null
    },
    fieldCoverage: coverage,
    marketFields: 'Market and contract fields are optional. The twin never reads them.',
    estimability,
    stopHazardBasis: stopBasis,
    statement: [
      hasBalances
        ? 'Balance fields are on every trade, so the refuel probability and the voluntary stop hazard are estimable.'
        : 'Balance fields are not on every trade, so the stop hazard is all-cause (it includes running out of money) and refuel is the losing-streak proxy.',
      notEstimable.length ? `Not estimable for any trader: ${notEstimable.join(', ')}.` : 'Every twin parameter is estimable for at least some traders.'
    ].join(' ')
  };
}

// --- Section 2: population ----------------------------------------------------------------------

function chaseStatement(below, above, total, credibleAbove) {
  if (!total) return 'No trader has an estimated chase coefficient, so the data say nothing about stake response after losses.';
  const b = share(below, total);
  const a = share(above, total);
  const credible = `${credibleAbove} of ${total} have a 90% interval entirely above 1.`;
  if (b > 0.5 && a < 0.5) return `Most traders (${pct(b)}) scale back after a loss (estimated chase coefficient below 1); a minority (${pct(a)}) bet more. ${credible}`;
  if (a > 0.5) return `Most traders (${pct(a)}) bet more after a loss (estimated chase coefficient above 1); ${pct(b)} scale back. ${credible}`;
  return `Traders split: ${pct(b)} scale back after a loss and ${pct(a)} bet more. ${credible}`;
}

function populationSection(fit) {
  const chaseRecords = fit.twins.map((twin) => estimateOf(twin, 'chaseCoefficient')).filter(Boolean);
  const chase = chaseRecords.map((record) => record.estimate);
  const below = chase.filter((value) => value < 1).length;
  const above = chase.filter((value) => value > 1).length;
  const credibleBelow = chaseRecords.filter((record) => record.interval?.[1] < 1).length;
  const credibleAbove = chaseRecords.filter((record) => record.interval?.[0] > 1).length;
  const chasePrior = fit.priors?.chaseCoefficient ?? null;

  const buckets = DRAWDOWN_BUCKETS.map((bucket) => {
    const values = fit.twins.map((twin) => estimateOf(twin, 'stopHazard', bucket)?.estimate ?? null);
    const prior = fit.priors?.stopHazard?.[bucket] ?? null;
    return { bucket, traders: spread(values), prior: prior ? { estimate: prior.estimate ?? null, interval: prior.interval ?? null } : null };
  });
  const flat = buckets.find((item) => item.bucket === 'flat').traders.median;
  const large = buckets.find((item) => item.bucket === 'down_large').traders.median;
  const stopStatement = flat === null || large === null
    ? 'Stop hazards by drawdown are not estimable from these fields.'
    : large > flat
      ? `Traders stop more often when down: the median estimated stop hazard is ${num(flat)} per trade when flat and ${num(large)} when down more than the large-drawdown edge.`
      : `Traders don't stop more often when down: the median estimated stop hazard is ${num(flat)} per trade when flat and ${num(large)} when down large.`;
  const basis = tally(fit.twins.map((twin) => twin.stopHazardBasis ?? 'unknown'));

  const refuelBlock = (name) => {
    const values = fit.twins.map((twin) => estimateOf(twin, name)?.estimate ?? null).filter(isFiniteNumber);
    const prior = fit.priors?.[name] ?? null;
    return {
      parameter: name,
      description: TWIN_PARAMETER_DEFINITIONS[name].description,
      traders: spread(values),
      histogram: histogram(values, PROBABILITY_EDGES),
      prior: prior && isFiniteNumber(prior.estimate) ? { estimate: prior.estimate, interval: prior.interval ?? null } : null
    };
  };
  const lowBalance = refuelBlock('refuelProbability');
  const proxy = refuelBlock('refuelAfterLosingStreak');
  const primary = lowBalance.traders.n > 0 ? lowBalance : proxy;
  const refuelStatement = primary.traders.n === 0
    ? 'Refuel behavior is not estimable from these fields.'
    : primary === lowBalance
      ? `After a trade takes the balance below one base stake, the median trader deposits again within the refuel window with estimated probability ${num(lowBalance.traders.median)} (10th-90th percentile across traders ${num(lowBalance.traders.p10)}-${num(lowBalance.traders.p90)}).`
      : `Refuel is proxied: balance fields are missing, so the trigger is a losing streak, not a low balance. After one, the median trader deposits within the refuel window with estimated probability ${num(proxy.traders.median)}.`;

  return {
    chase: {
      parameter: 'chaseCoefficient',
      description: TWIN_PARAMETER_DEFINITIONS.chaseCoefficient.description,
      traders: chase.length,
      scaleBack: below,
      chase: above,
      shareScaleBack: share(below, chase.length),
      shareChase: share(above, chase.length),
      credibleScaleBack: credibleBelow,
      credibleChase: credibleAbove,
      distribution: spread(chase),
      histogram: histogram(chase, CHASE_EDGES),
      scale: 'log2: bin edges are powers of sqrt(2) from 0.25 to 4; values outside go to the end bins',
      prior: chasePrior ? { estimate: chasePrior.estimate ?? null, interval: chasePrior.interval ?? null } : null,
      basis: 'Traders whose chase coefficient is estimated from their own data (status estimated), at the posterior estimate.',
      statement: chaseStatement(below, above, chase.length, credibleAbove)
    },
    stops: { basis, buckets, statement: stopStatement },
    refuel: { primary: primary.parameter, refuelProbability: lowBalance, refuelAfterLosingStreak: proxy, statement: refuelStatement }
  };
}

// --- Section 3: validation ------------------------------------------------------------------------

function validationSection(holdout) {
  const { summary } = holdout;
  const metrics = Object.entries(holdout.metrics).map(([name, metric]) => {
    const cell = summary.perMetric[name];
    const models = Object.fromEntries(Object.entries(metric.models).map(([key, model]) => [key, {
      ksD: model.ksD,
      medianAbsoluteError: model.pointError?.medianAbsoluteError ?? null,
      calibration: model.calibration?.share ?? null
    }]));
    return {
      metric: name,
      description: HOLDOUT_METRICS[name].sample,
      scored: HOLDOUT_METRICS[name].scored,
      ties: HOLDOUT_METRICS[name].ties,
      observedTraders: metric.observed.traders,
      pairedTraders: metric.pairedTraders,
      models,
      calibration: cell.calibration,
      distribution: cell.distribution,
      beats: Object.fromEntries(Object.entries(cell.beats).map(([key, value]) => [key, value.beats])),
      pass: cell.pass,
      diagnosis: cell.diagnosis,
      knownShapeDifference: cell.knownShapeDifference
    };
  });
  return {
    holdoutVersion: holdout.holdoutVersion,
    models: Object.fromEntries(Object.entries(holdout.models).map(([key, model]) => [key, { version: model.version, description: model.description }])),
    split: { rule: holdout.split.rule, trainShare: holdout.split.trainShare, churnCaveat: holdout.split.churnCaveat },
    seed: holdout.seed,
    replicates: holdout.replicates,
    traders: {
      total: holdout.inputs.traders,
      eligible: holdout.inputs.eligible,
      compared: holdout.inputs.compared,
      ineligibleReasons: holdout.inputs.ineligibleReasons,
      exclusionReasons: holdout.inputs.exclusionReasons
    },
    balancePath: holdout.inputs.balancePath,
    tolerances: summary.tolerances,
    metrics,
    overall: {
      beats: summary.overall.beats,
      claimEarned: summary.overall.claim.earned,
      statement: summary.overall.claim.statement,
      calibration: summary.overall.calibration,
      distribution: summary.overall.distribution,
      pass: summary.overall.pass,
      findings: summary.overall.findings
    },
    reading: 'Calibration coverage is the share of traders whose observed test value lies inside their simulated 10th-90th percentile band (nominally 80%). D is the two-sample Kolmogorov-Smirnov distance between the observed and simulated distributions, with no p-value. Point error is the median over traders of the absolute difference between a model\'s point prediction and the observed test value. This is evidence about the model on this data, not an accuracy claim.'
  };
}

// --- Section 4: policy trade-off -------------------------------------------------------------------

function settingValue(label) {
  const text = String(label);
  return text.includes('=') ? text.slice(text.indexOf('=') + 1).replace(/#\d+$/, '') : text;
}

function bandOf(summary) {
  return summary ? { median: summary.median ?? null, p10: summary.p10 ?? null, p90: summary.p90 ?? null } : { median: null, p10: null, p90: null };
}

function policySection(sweep) {
  const policies = sweep.policies.map((policy) => {
    const series = policy.chart.series.map((item) => ({
      id: item.id,
      assumption: item.assumption,
      value: item.value,
      isDefault: item.isDefault,
      points: item.points.map((point) => ({
        setting: settingValue(point.settingLabel),
        settingLabel: point.settingLabel,
        harmReduction: bandOf(point.harmReduction),
        activityRetained: bandOf(point.activityRetained),
        beyondActivityCut: bandOf(point.beyondActivityCut)
      }))
    }));
    const panels = [];
    for (const item of series) {
      const key = item.assumption ?? 'defaults';
      let panel = panels.find((entry) => entry.assumption === key);
      if (!panel) {
        panel = {
          assumption: key,
          description: policy.responseAssumptions[key]?.description ?? 'All response assumptions at their defaults.',
          series: []
        };
        panels.push(panel);
      }
      panel.series.push(item);
    }
    const defaults = policy.cells.filter((cell) => !cell.varied.length);
    return {
      type: policy.type,
      description: policy.description,
      settingKey: policy.settingKey,
      settings: policy.settingLabels.map(settingValue),
      responseAssumptions: policy.responseAssumptions,
      traderCounts: defaults[0]?.traderCounts ?? null,
      panels,
      driver: policy.driver.statement
    };
  });
  return {
    policyVersion: sweep.policyVersion,
    simulatorVersion: sweep.simulatorVersion,
    seed: sweep.seed,
    replicates: sweep.replicates,
    uncertainty: sweep.uncertainty,
    horizon: sweep.horizon,
    design: sweep.design,
    cellCount: sweep.cellCount,
    claim: sweep.claim,
    axes: {
      x: policies[0] ? sweep.policies[0].chart.x : null,
      y: policies[0] ? sweep.policies[0].chart.y : null,
      harmMetric: sweep.primary.harm,
      activityMetric: sweep.primary.activity,
      bands: 'median with the 10th and 90th percentiles across replicates',
      reference: sweep.policies[0]?.chart.reference ?? null
    },
    labels: {
      allCauseStops: sweep.labels.allCauseStops.length,
      proxyRefuel: sweep.labels.proxyRefuel.length,
      moneyNotSimulated: sweep.labels.moneyNotSimulated.length,
      notSimulable: sweep.labels.notSimulable.length
    },
    policies
  };
}

// --- Section 5: affected traders ---------------------------------------------------------------------

function rangeGroup(ranges, value) {
  if (!isFiniteNumber(value)) return null;
  return ranges.find((range) => value < range.below) ?? null;
}

function groupings(sweep, traderGroups, settings) {
  const descriptors = new Map(sweep.traders.filter((trader) => trader.simulable).map((trader) => [trader.traderToken, trader]));
  const list = [
    {
      by: 'chaseCoefficient range',
      groups: settings.chaseRanges.map(({ name, rule }) => ({ name, rule })),
      assign: (token) => rangeGroup(settings.chaseRanges, descriptors.get(token)?.estimates.chaseCoefficient)?.name ?? null
    },
    {
      by: 'stop pattern (down_large / flat stop hazard)',
      groups: settings.stopRanges.map(({ name, rule }) => ({ name, rule })),
      assign: (token) => {
        const estimates = descriptors.get(token)?.estimates;
        const flat = estimates?.['stopHazard.flat'];
        const large = estimates?.['stopHazard.down_large'];
        return isFiniteNumber(flat) && isFiniteNumber(large) && flat > 0 ? rangeGroup(settings.stopRanges, large / flat)?.name ?? null : null;
      }
    }
  ];
  if (traderGroups) {
    const names = [...new Set(Object.values(traderGroups).filter((value) => !isBlank(value)))].sort();
    if (names.length >= 2) list.unshift({ by: 'archetype', groups: names.map((name) => ({ name, rule: `archetype ${name}` })), assign: (token) => traderGroups[token] ?? null });
  }
  return list;
}

function affectedSection(sweep, traderGroups, settings) {
  const dimensions = groupings(sweep, traderGroups, settings);
  const policies = sweep.policies.map((policy) => {
    const focusIndex = Math.floor((policy.settings.length - 1) / 2);
    const cell = policy.cells.find((item) => item.settingIndex === focusIndex && !item.varied.length);
    const rows = (cell?.perTrader ?? []).filter((row) => row.applicable && row.primary);
    const byDimension = dimensions.map((dimension) => {
      const groups = dimension.groups.map((group) => {
        const members = rows.filter((row) => dimension.assign(row.traderToken) === group.name);
        if (members.length < settings.minGroupSize) {
          return { ...group, traders: members.length, suppressed: true, reason: `fewer than ${settings.minGroupSize} traders`, harmReduction: null, activityRetained: null, beyondActivityCut: null, meanHarmChange: null, tradersWithChange: null };
        }
        const changes = members.map((row) => row.difference?.[sweep.primary.harm]?.mean).filter(isFiniteNumber);
        return {
          ...group,
          traders: members.length,
          suppressed: false,
          reason: null,
          harmReduction: spread(members.map((row) => row.primary.harmReduction.median)),
          activityRetained: spread(members.map((row) => row.primary.activityRetained.median)),
          beyondActivityCut: spread(members.map((row) => row.primary.beyondActivityCut.median)),
          // Mean over the group's traders of each trader's mean paired change (policy - baseline).
          meanHarmChange: changes.length ? changes.reduce((total, value) => total + value, 0) / changes.length : null,
          tradersWithChange: members.filter((row) => (row.accounting?.runsWithIntervention ?? 0) > 0).length
        };
      });
      const unassigned = rows.filter((row) => dimension.assign(row.traderToken) === null).length;
      const shown = groups.filter((group) => !group.suppressed && group.harmReduction.median !== null);
      const top = shown.reduce((best, group) => (best === null || group.harmReduction.median > best.harmReduction.median ? group : best), null);
      const tied = top !== null && shown.filter((group) => Math.abs(group.harmReduction.median - top.harmReduction.median) < 1e-9).length > 1;
      let statement;
      if (top === null) statement = `By ${dimension.by}, no group has at least ${settings.minGroupSize} traders with a result.`;
      else if (tied) statement = `By ${dimension.by}, no group stands out on the median: ${shown.length > 1 ? 'the largest group medians are equal' : 'only one group is shown'} (${num(top.harmReduction.median, 3)}). Most traders' runs change little at this setting; the 90th percentiles and the mean change show who the policy reaches.`;
      else statement = `By ${dimension.by}, "${top.name}" (${top.traders} traders) has the largest median harm reduction, ${num(top.harmReduction.median, 3)}, with median activity retained ${num(top.activityRetained.median, 3)}.`;
      return {
        by: dimension.by,
        groups,
        unassigned,
        mostAffected: top && !tied ? top.name : null,
        statement
      };
    });
    return {
      type: policy.type,
      setting: cell ? cell.settingLabel : null,
      cellBasis: `The middle sweep setting (${cell ? cell.settingLabel : 'n/a'}) with every response assumption at its default.`,
      applicableTraders: rows.length,
      dimensions: byDimension
    };
  });
  return {
    basis: `Per-trader medians across replicates of the primary harm reduction (${sweep.primary.harm}) and activity retained (${sweep.primary.activity}), summarized within each group by the median and the 10th to 90th percentile across its traders. The mean change is the group's average of each trader's mean paired difference in ${sweep.primary.harm} (policy minus no policy, in currency; negative means less harm). "Reached" counts traders the policy acted on in at least one replicate. Groups use each trader's fitted parameter estimates${traderGroups ? ' or archetype' : ''}. No individual trader is shown, and a group with fewer than ${settings.minGroupSize} traders is suppressed.`,
    harmMetric: sweep.primary.harm,
    minGroupSize: settings.minGroupSize,
    policies
  };
}

// --- Section 6: assumptions and limits -------------------------------------------------------------

function labelStatement(dataLabel) {
  if (dataLabel === 'SYNTHETIC') return 'The data are SYNTHETIC: generated traders with known parameters. Nothing here describes a real venue or a real trader.';
  if (dataLabel === 'OBSERVATIONAL') return 'The data are OBSERVATIONAL public data. Replaying observed behavior doesn\'t establish causation, and public-market behavior doesn\'t automatically transfer to a venue.';
  return 'The data are CUSTOMER data. This report is customer-derived: keep it out of the repo and share it only under the customer agreement.';
}

function assumptionsSection(dataLabel, fit, holdout, sweep, settings) {
  const withoutBalances = fit.inputs.tradersWithCompleteBalances < fit.inputs.traderCount;
  const plain = [
    'Simulation under stated assumptions, not causal evidence. Nothing here shows what a policy would do to real traders.',
    'There is no intervention data. Every way a trader responds to a policy is an assumption, swept across a range that is itself an assumption. Section 4 says which assumption drives each result.',
    labelStatement(dataLabel),
    'Held-out validation is evidence about the model on this data. It is not an accuracy claim, and it doesn\'t test churn or responses to policies.',
    'A twin is a small set of behavioral parameters, constant over time. It sees only the event stream: no markets, odds, or time of day.',
    withoutBalances
      ? 'Balance fields are missing for some or all traders: their stop hazards are all-cause and double-count running out of money in the simulator, and their refuel behavior is a losing-streak proxy.'
      : 'Balance fields are present, so stop hazards are voluntary and refuel uses the low-balance trigger.',
    `Section 5 groups traders by archetype or parameter range, never by token, and hides groups with fewer than ${settings.minGroupSize} traders.`,
    'PlayMind never contacts traders, places trades, or holds funds.'
  ];
  const limits = [
    'Parameters are fitted once and held constant: drift, learning, and seasonality are not modelled.',
    'Priors are fitted on the same dataset; with few traders they are weak and their own uncertainty is not carried into the intervals.',
    'Simulated parameter draws are independent across parameters, so correlated uncertainty is not represented.',
    'The simulator uses the synthetic generator\'s rules where the twin has no estimate (first-session time, deposit timing, the broke rule).',
    'Thresholds are the same currency amount for every trader, one policy runs at a time, and responses are the same for every trader.',
    'Realized net loss over a horizon is mostly luck, so net-loss bands are wide.'
  ];
  return {
    plain,
    limits,
    detail: [
      { title: `Simulation (${SIMULATOR_VERSION})`, items: sweep.assumptions.simulation },
      { title: 'Policy responses (policy-0.2.0)', items: POLICY_ASSUMPTIONS },
      { title: 'Held-out validation (holdout-0.1.0)', items: holdout.assumptions },
      { title: 'Trader labels', items: sweep.labels.notes ?? [] }
    ]
  };
}

// --- Entry point -------------------------------------------------------------------------------------

function checkInputs({ dataset, fit, holdout, sweep }) {
  if (!isPlainObject(dataset) || !Array.isArray(dataset.events)) fail('dataset must be { events, name? }', TypeError);
  if (!isPlainObject(fit) || !Array.isArray(fit.twins)) fail('fit must be an estimateTwins result', TypeError);
  if (!isPlainObject(holdout) || !isPlainObject(holdout.summary)) fail('holdout must be a runHoldoutValidation result', TypeError);
  if (!isPlainObject(sweep) || !Array.isArray(sweep.policies)) fail('sweep must be a runPolicySweep result', TypeError);
  const labels = new Set([fit.dataLabel, holdout.dataLabel, sweep.dataLabel]);
  if (labels.size !== 1) fail(`the fit, holdout, and sweep carry different data labels (${[...labels].join(', ')})`);
  const [label] = labels;
  if (!DATA_LABELS.includes(label)) fail(`data label must be one of ${DATA_LABELS.join(', ')}`);
  if (fit.modelVersion !== TWIN_MODEL_VERSION || sweep.modelVersion !== TWIN_MODEL_VERSION || holdout.modelVersion !== TWIN_MODEL_VERSION) {
    fail(`every input must come from ${TWIN_MODEL_VERSION}`);
  }
  return label;
}

/**
 * Builds report v2. input: { dataset: { events, name?, venueId?, generator? }, quality
 * (validateEvents result, optional), fit (estimateTwins), holdout (runHoldoutValidation on the
 * same events), sweep (runPolicySweep on the fit), traderGroups? (traderToken -> archetype,
 * SYNTHETIC only), generatedAt?, options? (REPORT_V2_DEFAULTS) }. The fit, holdout, and sweep
 * must carry the same data label. Returns the report JSON: header fields plus `sections`
 * keyed in REPORT_SECTIONS order. It holds no trader token.
 */
export function buildReportV2(input) {
  if (!isPlainObject(input)) fail('input must be an object', TypeError);
  const dataLabel = checkInputs(input);
  const { dataset, quality = null, fit, holdout, sweep, traderGroups = null, generatedAt = null } = input;
  const options = input.options ?? {};
  for (const key of Object.keys(options)) if (!Object.hasOwn(REPORT_V2_DEFAULTS, key)) fail(`unknown option "${key}"`);
  const settings = { ...REPORT_V2_DEFAULTS, ...options };
  if (!Number.isInteger(settings.minGroupSize) || settings.minGroupSize < 1) fail('minGroupSize must be a positive integer');
  if (traderGroups !== null && dataLabel !== 'SYNTHETIC') fail('traderGroups (archetypes) exist only for SYNTHETIC data');

  return {
    reportVersion: REPORT_V2_VERSION,
    reportType: 'twin-evidence-report',
    dataLabel,
    banner: dataLabel === 'SYNTHETIC' ? 'SYNTHETIC DATA: NOT A REAL VENUE OR TRADER' : dataLabel === 'OBSERVATIONAL' ? 'OBSERVATIONAL PUBLIC DATA' : 'CUSTOMER DATA: CONFIDENTIAL, KEEP OUT OF THE REPO',
    title: `Twin evidence report: ${dataset.name ?? 'dataset'}`,
    generatedAt,
    claim: 'Simulation under stated assumptions and held-out evidence about a model. Not causal evidence and not an accuracy claim.',
    versions: {
      report: REPORT_V2_VERSION,
      behavior: fit.behaviorVersion ?? null,
      model: fit.modelVersion,
      simulator: sweep.simulatorVersion,
      policy: sweep.policyVersion,
      holdout: holdout.holdoutVersion,
      baseline: holdout.baselineVersion,
      naive: holdout.naiveVersion,
      generator: dataset.generator ?? null
    },
    sectionOrder: REPORT_SECTIONS,
    sections: {
      data: dataSection(dataset, quality, fit, dataLabel),
      population: populationSection(fit),
      validation: validationSection(holdout),
      policy: policySection(sweep),
      affected: affectedSection(sweep, traderGroups, settings),
      assumptions: assumptionsSection(dataLabel, fit, holdout, sweep, settings)
    }
  };
}

// --- HTML: escaping and SVG -------------------------------------------------------------------------

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const PALETTE = Object.freeze(['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#56B4E9', '#E69F00', '#555555']);
const MODEL_STYLE = Object.freeze({
  twin: { color: '#0072B2', label: TWIN_MODEL_VERSION, shape: 'circle' },
  truth: { color: '#009E73', label: 'truth (reference)', shape: 'diamond' },
  baseline: { color: '#D55E00', label: 'baseline-0.1', shape: 'square' },
  naive: { color: '#CC79A7', label: 'naive-0.1', shape: 'triangle' }
});

function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? raw;
  const ticks = [];
  for (let value = Math.ceil(min / step - 1e-9) * step; value <= max + 1e-9; value += step) ticks.push(Number(value.toFixed(10)));
  return ticks;
}

function tickLabel(value) {
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return Number(value.toPrecision(3)).toString();
}

function scale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  return (value) => r0 + ((value - d0) / (d1 - d0 || 1)) * (r1 - r0);
}

function marker(shape, x, y, size, color, title) {
  const t = title ? `<title>${escapeHtml(title)}</title>` : '';
  const s = size;
  if (shape === 'square') return `<rect x="${(x - s).toFixed(1)}" y="${(y - s).toFixed(1)}" width="${(2 * s).toFixed(1)}" height="${(2 * s).toFixed(1)}" fill="${color}">${t}</rect>`;
  if (shape === 'diamond') return `<path d="M${x.toFixed(1)} ${(y - s * 1.3).toFixed(1)}L${(x + s * 1.3).toFixed(1)} ${y.toFixed(1)}L${x.toFixed(1)} ${(y + s * 1.3).toFixed(1)}L${(x - s * 1.3).toFixed(1)} ${y.toFixed(1)}Z" fill="${color}">${t}</path>`;
  if (shape === 'triangle') return `<path d="M${x.toFixed(1)} ${(y - s * 1.3).toFixed(1)}L${(x + s * 1.2).toFixed(1)} ${(y + s).toFixed(1)}L${(x - s * 1.2).toFixed(1)} ${(y + s).toFixed(1)}Z" fill="${color}">${t}</path>`;
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.toFixed(1)}" fill="${color}">${t}</circle>`;
}

let svgCounter = 0;
function svg(width, height, title, body, description = '') {
  svgCounter += 1;
  const id = `chart${svgCounter}`;
  return `<div class="fig"><div class="fig-title" aria-hidden="true">${escapeHtml(title)}</div><svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${id}t ${id}d" xmlns="http://www.w3.org/2000/svg"><title id="${id}t">${escapeHtml(title)}</title><desc id="${id}d">${escapeHtml(description)}</desc>${body}</svg></div>`;
}

function axes({ x, y, xTicks, yTicks, left, right, top, bottom, xTitle, yTitle, xFormat = tickLabel, yFormat = tickLabel }) {
  const parts = [];
  for (const tick of yTicks) {
    const py = y(tick);
    parts.push(`<line x1="${left}" x2="${right}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" class="grid"/>`);
    parts.push(`<text x="${left - 6}" y="${(py + 4).toFixed(1)}" class="tick" text-anchor="end">${escapeHtml(yFormat(tick))}</text>`);
  }
  for (const tick of xTicks) {
    const px = typeof tick === 'object' ? tick.x : x(tick);
    const label = typeof tick === 'object' ? tick.label : xFormat(tick);
    parts.push(`<text x="${px.toFixed(1)}" y="${bottom + 16}" class="tick" text-anchor="middle">${escapeHtml(label)}</text>`);
  }
  parts.push(`<line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}" class="axis"/>`);
  parts.push(`<line x1="${left}" x2="${left}" y1="${top}" y2="${bottom}" class="axis"/>`);
  if (xTitle) parts.push(`<text x="${((left + right) / 2).toFixed(1)}" y="${bottom + 36}" class="axis-title" text-anchor="middle">${escapeHtml(xTitle)}</text>`);
  if (yTitle) parts.push(`<text transform="translate(14 ${((top + bottom) / 2).toFixed(1)}) rotate(-90)" class="axis-title" text-anchor="middle">${escapeHtml(yTitle)}</text>`);
  return parts.join('');
}

function histogramChart({ bins, title, xTitle, yTitle = 'traders', colorFor, labelFor, description, marks = [] }) {
  const width = 640;
  const height = 276;
  const left = 52;
  const right = width - 16;
  const top = 32;
  const bottom = height - 50;
  const maxCount = Math.max(1, ...bins.map((bin) => bin.count));
  const y = scale([0, maxCount], [bottom, top]);
  const slot = (right - left) / bins.length;
  const bars = bins.map((bin, index) => {
    const x0 = left + index * slot + 2;
    const py = y(bin.count);
    return `<rect x="${x0.toFixed(1)}" y="${py.toFixed(1)}" width="${(slot - 4).toFixed(1)}" height="${(bottom - py).toFixed(1)}" fill="${colorFor(bin)}"><title>${escapeHtml(`${labelFor(bin)}: ${bin.count} traders`)}</title></rect>`
      + (bin.count ? `<text x="${(x0 + (slot - 4) / 2).toFixed(1)}" y="${(py - 4).toFixed(1)}" class="value" text-anchor="middle">${bin.count}</text>` : '');
  }).join('');
  const xTicks = bins.map((bin, index) => ({ x: left + (index + 0.5) * slot, label: labelFor(bin) }));
  const markLines = marks.map((mark) => {
    const index = bins.findIndex((bin) => bin.low === mark.at);
    if (index === -1) return '';
    const px = left + index * slot;
    return `<line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${top - 14}" y2="${bottom}" class="ref"/><text x="${(px + 4).toFixed(1)}" y="${top - 18}" class="note">${escapeHtml(mark.label)}</text>`;
  }).join('');
  const yTicks = niceTicks(0, maxCount, 4).filter((tick) => Number.isInteger(tick));
  return svg(width, height, title, axes({ x: null, y, xTicks, yTicks, left, right, top, bottom, xTitle, yTitle }) + bars + markLines, description);
}

function stopChart(buckets) {
  const width = 640;
  const height = 260;
  const left = 52;
  const right = width - 16;
  const top = 16;
  const bottom = height - 50;
  const maxValue = Math.min(1, Math.max(0.1, ...buckets.flatMap((item) => [item.traders.p90, item.prior?.estimate].filter(isFiniteNumber))) * 1.15);
  const y = scale([0, maxValue], [bottom, top]);
  const slot = (right - left) / buckets.length;
  const body = buckets.map((item, index) => {
    const cx = left + (index + 0.5) * slot;
    const { p10, p90, median: mid, n } = item.traders;
    let out = '';
    if (isFiniteNumber(p10) && isFiniteNumber(p90)) out += `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y(p10).toFixed(1)}" y2="${y(p90).toFixed(1)}" stroke="${PALETTE[0]}" stroke-width="6" stroke-linecap="round" opacity="0.35"/>`;
    if (isFiniteNumber(mid)) out += marker('circle', cx, y(mid), 5, PALETTE[0], `${item.bucket}: median ${num(mid)} across ${n} traders (10th-90th percentile ${num(p10)}-${num(p90)})`);
    if (isFiniteNumber(item.prior?.estimate)) out += marker('diamond', cx + 18, y(item.prior.estimate), 4, PALETTE[1], `${item.bucket}: population prior ${num(item.prior.estimate)}`);
    return out;
  }).join('');
  const xTicks = buckets.map((item, index) => ({ x: left + (index + 0.5) * slot, label: item.bucket.replace('_', ' ') }));
  const legend = `<g transform="translate(${left + 12} ${top})">${marker('circle', 6, 6, 5, PALETTE[0])}<text x="16" y="10" class="tick">median trader (bar: 10th-90th pct)</text>${marker('diamond', 6, 24, 4, PALETTE[1])}<text x="16" y="28" class="tick">population prior</text></g>`;
  return svg(width, height, 'Stop hazard by session drawdown bucket',
    axes({ y, xTicks, yTicks: niceTicks(0, maxValue, 4), left, right, top, bottom, xTitle: 'running session result (bucket edges in base stakes)', yTitle: 'P(session ends after a trade)' }) + body + legend,
    'For each drawdown bucket, the median estimated stop hazard across traders with its 10th to 90th percentile, and the population prior.');
}

function tradeoffPanel(panel, axesInfo, policyType) {
  const width = 640;
  const height = 380;
  const left = 60;
  const right = width - 16;
  const top = 18;
  const bottom = height - 96;
  const points = panel.series.flatMap((item) => item.points);
  const xs = points.flatMap((point) => [point.activityRetained.p10, point.activityRetained.p90, point.activityRetained.median]).filter(isFiniteNumber);
  const ys = points.flatMap((point) => [point.harmReduction.p10, point.harmReduction.p90, point.harmReduction.median]).filter(isFiniteNumber);
  if (!xs.length || !ys.length) return '<p class="muted">No results to chart.</p>';
  const pad = (lo, hi, minimumSpan) => {
    let low = lo;
    let high = hi;
    if (high - low < minimumSpan) {
      const center = (low + high) / 2;
      low = center - minimumSpan / 2;
      high = center + minimumSpan / 2;
    }
    const margin = (high - low) * 0.08;
    return [low - margin, high + margin];
  };
  const xDomain = pad(Math.min(...xs), Math.max(...xs, 1), 0.02);
  const yDomain = pad(Math.min(...ys, 0), Math.max(...ys, 0), 0.02);
  const x = scale(xDomain, [left, right]);
  const y = scale(yDomain, [bottom, top]);
  const clipId = `clip${++svgCounter}`;
  const parts = [`<defs><clipPath id="${clipId}"><rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}"/></clipPath></defs>`];
  parts.push(axes({ x, y, xTicks: niceTicks(...xDomain, 5), yTicks: niceTicks(...yDomain, 5), left, right, top, bottom, xTitle: `activity retained (${axesInfo.activityMetric})`, yTitle: `harm reduction (${axesInfo.harmMetric})` }));
  // Reference line: harm reduction = 1 - activity retained, where a policy that only cuts activity sits.
  parts.push(`<g clip-path="url(#${clipId})"><line x1="${x(xDomain[0]).toFixed(1)}" y1="${y(1 - xDomain[0]).toFixed(1)}" x2="${x(xDomain[1]).toFixed(1)}" y2="${y(1 - xDomain[1]).toFixed(1)}" class="ref"/>`);
  if (yDomain[0] < 0 && yDomain[1] > 0) parts.push(`<line x1="${left}" x2="${right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="zero"/>`);
  panel.series.forEach((item, index) => {
    const color = PALETTE[index % PALETTE.length];
    const valid = item.points.filter((point) => isFiniteNumber(point.activityRetained.median) && isFiniteNumber(point.harmReduction.median));
    const strokeWidth = item.isDefault ? 2.5 : 1.5;
    if (valid.length > 1) parts.push(`<polyline fill="none" stroke="${color}" stroke-width="${strokeWidth}" ${item.isDefault ? '' : 'stroke-dasharray="5 3"'} points="${valid.map((point) => `${x(point.activityRetained.median).toFixed(1)},${y(point.harmReduction.median).toFixed(1)}`).join(' ')}"/>`);
    for (const point of valid) {
      const px = x(point.activityRetained.median);
      const py = y(point.harmReduction.median);
      const a = point.activityRetained;
      const h = point.harmReduction;
      if (isFiniteNumber(a.p10) && isFiniteNumber(a.p90)) parts.push(`<line x1="${x(a.p10).toFixed(1)}" x2="${x(a.p90).toFixed(1)}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" stroke="${color}" stroke-width="1" opacity="0.6"/>`);
      if (isFiniteNumber(h.p10) && isFiniteNumber(h.p90)) parts.push(`<line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${y(h.p10).toFixed(1)}" y2="${y(h.p90).toFixed(1)}" stroke="${color}" stroke-width="1" opacity="0.6"/>`);
      parts.push(marker('circle', px, py, item.isDefault ? 4.5 : 3.5, color, `${policyType} ${point.settingLabel}, ${item.id}: harm reduction ${num(h.median, 3)} [${num(h.p10, 3)}, ${num(h.p90, 3)}], activity retained ${num(a.median, 3)} [${num(a.p10, 3)}, ${num(a.p90, 3)}]`));
      if (item.isDefault) parts.push(`<text x="${(px + 6).toFixed(1)}" y="${(py - 6).toFixed(1)}" class="note">${escapeHtml(point.setting)}</text>`);
    }
  });
  parts.push('</g>');
  const legend = panel.series.map((item, index) => {
    const color = PALETTE[index % PALETTE.length];
    const label = item.assumption === null ? 'all assumptions at defaults' : `${item.assumption.split('.').at(-1)} = ${item.value}${item.isDefault ? ' (default)' : ''}`;
    const lx = left + (index % 2) * 280;
    const ly = bottom + 52 + Math.floor(index / 2) * 18;
    return `<line x1="${lx}" x2="${lx + 22}" y1="${ly - 4}" y2="${ly - 4}" stroke="${color}" stroke-width="${item.isDefault ? 2.5 : 1.5}" ${item.isDefault ? '' : 'stroke-dasharray="5 3"'}/><text x="${lx + 28}" y="${ly}" class="tick">${escapeHtml(label)}</text>`;
  }).join('');
  parts.push(legend);
  parts.push(`<text x="${right}" y="${top + 10}" class="note" text-anchor="end">grey dashed: harm reduction = 1 - activity retained</text>`);
  return svg(width, height, `${policyType}: harm reduction against activity retained, by ${panel.assumption}`, parts.join(''),
    `One series per value of ${panel.assumption}. Points are the policy settings (labelled on the default series); bars are the 10th to 90th percentiles across replicates.`);
}

function dotChart({ rows, models, title, xTitle, band = null, nominal = null, xMax = null, description }) {
  const width = 640;
  const rowHeight = 26;
  const left = 170;
  const right = width - 20;
  const top = 14;
  const bottom = top + rows.length * rowHeight;
  const height = bottom + 64;
  const values = rows.flatMap((row) => models.map((key) => row.values[key])).filter(isFiniteNumber);
  const maxValue = xMax ?? Math.max(0.05, ...values, band ? band[1] : 0) * 1.08;
  const x = scale([0, maxValue], [left, right]);
  const parts = [];
  if (band) parts.push(`<rect x="${x(band[0]).toFixed(1)}" y="${top}" width="${(x(Math.min(band[1], maxValue)) - x(band[0])).toFixed(1)}" height="${bottom - top}" class="band"/>`);
  for (const tick of niceTicks(0, maxValue, 5)) {
    parts.push(`<line x1="${x(tick).toFixed(1)}" x2="${x(tick).toFixed(1)}" y1="${top}" y2="${bottom}" class="grid"/><text x="${x(tick).toFixed(1)}" y="${bottom + 16}" class="tick" text-anchor="middle">${escapeHtml(tickLabel(tick))}</text>`);
  }
  if (nominal !== null) parts.push(`<line x1="${x(nominal).toFixed(1)}" x2="${x(nominal).toFixed(1)}" y1="${top}" y2="${bottom}" class="ref"/>`);
  rows.forEach((row, index) => {
    const cy = top + (index + 0.5) * rowHeight;
    parts.push(`<text x="${left - 8}" y="${(cy + 4).toFixed(1)}" class="tick" text-anchor="end">${escapeHtml(row.label)}</text>`);
    models.forEach((key, position) => {
      const value = row.values[key];
      if (!isFiniteNumber(value)) return;
      const style = MODEL_STYLE[key];
      parts.push(marker(style.shape, x(Math.min(value, maxValue)), cy + (position - (models.length - 1) / 2) * 4, 4.5, style.color, `${row.label}, ${style.label}: ${num(value, 3)}`));
    });
  });
  parts.push(`<text x="${((left + right) / 2).toFixed(1)}" y="${bottom + 34}" class="axis-title" text-anchor="middle">${escapeHtml(xTitle)}</text>`);
  const legend = models.map((key, index) => {
    const style = MODEL_STYLE[key];
    const lx = left + index * 120;
    return `${marker(style.shape, lx, bottom + 52, 4.5, style.color)}<text x="${lx + 10}" y="${bottom + 56}" class="tick">${escapeHtml(style.label)}</text>`;
  }).join('');
  parts.push(legend);
  return svg(width, height, title, parts.join(''), description);
}

// --- HTML: sections -----------------------------------------------------------------------------------

function table(headers, rows, className = '') {
  const head = headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table class="${className}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const yes = (value) => (value === null || value === undefined ? '<span class="muted">n/a</span>' : value ? '<span class="ok">yes</span>' : '<span class="no">no</span>');

function renderData(section) {
  const s = section.summary;
  const summaryRows = [
    ['Data label', `<strong>${escapeHtml(section.label)}</strong>`],
    ['Dataset', escapeHtml(section.name ?? 'n/a')],
    ['Venue', escapeHtml(section.venueId ?? 'n/a')],
    ['Generator', escapeHtml(section.generator ?? 'n/a')],
    ['Events', escapeHtml(s.events)],
    ['Traders', escapeHtml(s.traders)],
    ['Trades / deposits / withdrawals', escapeHtml(`${s.trades} / ${s.deposits} / ${s.withdrawals}`)],
    ['Period', escapeHtml(`${s.startsAt ?? 'n/a'} to ${s.endsAt ?? 'n/a'}`)],
    ['Event validation', s.validation ? escapeHtml(`${s.validation.valid ? 'valid' : 'invalid'}, ${s.validation.errors} errors, ${s.validation.warnings} warnings`) : 'n/a']
  ];
  const coverage = section.fieldCoverage.map((row) => [
    `<code>${escapeHtml(row.field)}</code>`,
    escapeHtml(row.appliesTo),
    escapeHtml(row.total ? `${row.present} of ${row.total}` : 'no such events'),
    escapeHtml(pct(row.share)),
    escapeHtml(row.role)
  ]);
  const estimability = section.estimability.map((row) => [
    `<code>${escapeHtml(row.parameter)}</code>`,
    escapeHtml(row.status),
    escapeHtml(`${row.estimated} / ${row.priorOnly} / ${row.notEstimable}`),
    escapeHtml(row.reasons.length ? row.reasons.slice(0, 2).map((item) => `${item.reason} (${item.count})`).join('; ') : '')
  ]);
  return `
    <p>${escapeHtml(section.statement)}</p>
    ${table(['', ''], summaryRows.map(([label, value]) => [`<strong>${escapeHtml(label)}</strong>`, value]), 'kv')}
    <h3>Field coverage</h3>
    <p class="muted">${escapeHtml(section.marketFields)}</p>
    ${table(['Field', 'On', 'Present', 'Share', 'What it unlocks'], coverage)}
    <h3>Twin parameters estimable from these fields</h3>
    <p class="muted">Counts of traders per status: estimated from their own data / prior only (inputs present, no observations) / not estimable (an input is missing). Stop-hazard basis: ${escapeHtml(Object.entries(section.stopHazardBasis).map(([basis, count]) => `${basis} ${count}`).join(', '))}.</p>
    ${table(['Parameter', 'Status', 'Estimated / prior only / not estimable', 'Why not estimable'], estimability)}`;
}

function renderPopulation(section) {
  const { chase, stops, refuel } = section;
  const chaseChart = histogramChart({
    bins: chase.histogram.bins,
    title: 'Estimated chase coefficient across traders',
    xTitle: 'chase coefficient: stake multiplier on the trade after a loss (log scale)',
    colorFor: (bin) => (bin.high <= 1 ? PALETTE[0] : PALETTE[1]),
    labelFor: (bin) => `${tickLabel(bin.low)}-${tickLabel(bin.high)}`,
    marks: [{ at: 1, label: '1 = same stake as after a win' }],
    description: 'Histogram of estimated chase coefficients. Blue bins are below 1 (scale back after a loss), orange bins above 1 (bet more).'
  });
  const refuelBlock = refuel[refuel.primary];
  const refuelChart = refuelBlock.traders.n ? histogramChart({
    bins: refuelBlock.histogram.bins,
    title: `Estimated ${refuelBlock.parameter} across traders`,
    xTitle: `${refuelBlock.parameter}: probability of a deposit within the refuel window`,
    colorFor: () => PALETTE[2],
    labelFor: (bin) => `${tickLabel(bin.low)}-${tickLabel(bin.high)}`,
    description: `Histogram of estimated ${refuelBlock.parameter}.`
  }) : '';
  const stopRows = stops.buckets.map((item) => [
    escapeHtml(item.bucket), escapeHtml(item.traders.n), escapeHtml(num(item.traders.median)), escapeHtml(`${num(item.traders.p10)} - ${num(item.traders.p90)}`), escapeHtml(num(item.prior?.estimate))
  ]);
  const refuelRows = ['refuelProbability', 'refuelAfterLosingStreak'].map((name) => {
    const block = refuel[name];
    return [`<code>${escapeHtml(name)}</code>`, escapeHtml(block.traders.n), escapeHtml(num(block.traders.median)), escapeHtml(`${num(block.traders.p10)} - ${num(block.traders.p90)}`), escapeHtml(num(block.prior?.estimate)), escapeHtml(block.description)];
  });
  return `
    <h3>Stake after a loss</h3>
    <p class="lead">${escapeHtml(chase.statement)}</p>
    ${chaseChart}
    <p class="muted">${escapeHtml(chase.basis)} ${chase.histogram.clipped ? `${chase.histogram.clipped} values outside 0.25-4 are counted in the end bins.` : ''} Median ${escapeHtml(num(chase.distribution.median))}; population prior ${escapeHtml(num(chase.prior?.estimate))}.</p>
    <h3>Stop behavior by drawdown</h3>
    <p class="lead">${escapeHtml(stops.statement)}</p>
    ${stopChart(stops.buckets)}
    ${table(['Bucket', 'Traders estimated', 'Median', '10th-90th pct', 'Population prior'], stopRows)}
    <p class="muted">Stop-hazard basis: ${escapeHtml(Object.entries(stops.basis).map(([basis, count]) => `${basis} ${count}`).join(', '))}. Voluntary hazards exclude stops from running out of money; all-cause hazards include them.</p>
    <h3>Refuel</h3>
    <p class="lead">${escapeHtml(refuel.statement)}</p>
    ${refuelChart}
    ${table(['Parameter', 'Traders estimated', 'Median', '10th-90th pct', 'Population prior', 'Meaning'], refuelRows)}`;
}

function renderValidation(section) {
  const { overall } = section;
  const modelKeys = ['twin', 'truth', 'baseline', 'naive'].filter((key) => section.models[key]);
  const metricLabel = (row) => `${row.metric}${row.scored ? '' : ' (diagnostic)'}`;
  const calibrationChart = dotChart({
    rows: section.metrics.map((row) => ({ label: metricLabel(row), values: { twin: row.models.twin?.calibration, truth: row.models.truth?.calibration, baseline: row.models.baseline?.calibration } })),
    models: ['twin', 'truth', 'baseline'].filter((key) => section.models[key]),
    title: 'Per-trader calibration coverage by metric',
    xTitle: 'share of traders with the observed value inside their 10th-90th pct band',
    band: section.tolerances.coverage.continuous,
    nominal: section.tolerances.nominalCoverage,
    xMax: 1,
    description: 'Shaded: the tolerance for continuous metrics. Line: the nominal 80%.'
  });
  const ksChart = dotChart({
    rows: section.metrics.map((row) => ({ label: metricLabel(row), values: Object.fromEntries(modelKeys.map((key) => [key, row.models[key]?.ksD])) })),
    models: modelKeys,
    title: 'KS distance D between observed and simulated test distributions',
    xTitle: 'Kolmogorov-Smirnov D (smaller is closer; no p-value)',
    band: [0, section.tolerances.maxKsD],
    description: `Shaded: D within the tolerance of ${section.tolerances.maxKsD}.`
  });
  const rows = section.metrics.map((row) => [
    `<code>${escapeHtml(metricLabel(row))}</code>`,
    escapeHtml(pct(row.calibration.share)),
    yes(row.calibration.pass),
    escapeHtml(modelKeys.map((key) => num(row.models[key]?.ksD, 3)).join(' / ')),
    escapeHtml(['twin', 'baseline', 'naive', 'truth'].filter((key) => section.models[key]).map((key) => num(row.models[key]?.medianAbsoluteError, 3)).join(' / ')),
    `${yes(row.beats.baseline)} / ${yes(row.beats.naive)}`,
    yes(row.pass),
    escapeHtml([row.diagnosis, row.knownShapeDifference ? 'known model-shape difference on synthetic data' : null].filter(Boolean).join('; '))
  ]);
  const findings = overall.findings.length ? `<ul>${overall.findings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="muted">No findings: the twin met every criterion.</p>';
  const beats = Object.entries(overall.beats).map(([key, value]) => `${section.models[key]?.version ?? key}: ${value.metricsBeaten} of ${value.metricsCompared} metrics`).join('; ');
  return `
    <div class="callout ${overall.claimEarned ? 'callout-ok' : 'callout-no'}"><strong>${overall.claimEarned ? 'The twin earns a claim on this data.' : 'The twin does not earn a claim on this data.'}</strong> ${escapeHtml(overall.statement)}</div>
    <p>${escapeHtml(section.split.rule)} ${escapeHtml(section.split.churnCaveat)}</p>
    <p class="muted">${escapeHtml(section.traders.compared)} of ${escapeHtml(section.traders.total)} traders compared (${escapeHtml(section.traders.eligible)} with a usable test window). ${escapeHtml(section.balancePath)}. ${escapeHtml(section.replicates)} replicates, seed ${escapeHtml(section.seed)}.</p>
    <p>${escapeHtml(section.reading)}</p>
    ${table(['Model', 'Version', 'What it is'], Object.entries(section.models).map(([key, model]) => [escapeHtml(key), escapeHtml(model.version), escapeHtml(model.description)]))}
    ${calibrationChart}
    ${ksChart}
    ${table(['Metric', 'Calibration', 'Calibration pass', `D (${modelKeys.join(' / ')})`, `Point error (${['twin', 'baseline', 'naive', 'truth'].filter((key) => section.models[key]).join(' / ')})`, 'Beats baseline / naive', 'Pass', 'Notes'], rows, 'compact')}
    <p><strong>Beats</strong> (lower point error and lower D on a metric; a majority of scored metrics overall): ${escapeHtml(beats)}. Calibration passes on ${escapeHtml(overall.calibration.metricsPassed)} of ${escapeHtml(overall.calibration.metricsScored)} scored metrics, distribution on ${escapeHtml(overall.distribution.metricsPassed)} of ${escapeHtml(overall.distribution.metricsScored)}. Overall pass: ${yes(overall.pass)}.</p>
    <h3>Findings</h3>
    ${findings}`;
}

function renderPolicy(section) {
  const intro = `
    <p>${escapeHtml(section.claim)} ${escapeHtml(section.horizon.days)}-day horizon, ${escapeHtml(section.replicates)} replicates (seed ${escapeHtml(section.seed)}), ${escapeHtml(section.cellCount)} cells, design ${escapeHtml(section.design)}.</p>
    <p class="muted">x: ${escapeHtml(section.axes.x)}. y: ${escapeHtml(section.axes.y)}. Bands: ${escapeHtml(section.axes.bands)}. ${escapeHtml(section.axes.reference?.meaning ?? '')}</p>
    <p class="muted">Trader labels: ${escapeHtml(section.labels.allCauseStops)} all-cause stops, ${escapeHtml(section.labels.proxyRefuel)} proxy refuel, ${escapeHtml(section.labels.moneyNotSimulated)} without a money model, ${escapeHtml(section.labels.notSimulable)} not simulable.</p>`;
  const policies = section.policies.map((policy) => `
    <h3><code>${escapeHtml(policy.type)}</code>: ${escapeHtml(policy.settingKey)} ${escapeHtml(policy.settings.join(', '))}</h3>
    <p class="muted">${escapeHtml(policy.description)}</p>
    <p class="lead">${escapeHtml(policy.driver)}</p>
    <div class="panels">${policy.panels.map((panel) => `<figure>${tradeoffPanel(panel, section.axes, policy.type)}<figcaption>${escapeHtml(panel.assumption)}: ${escapeHtml(panel.description)}</figcaption></figure>`).join('')}</div>`).join('');
  return intro + policies;
}

function renderAffected(section) {
  const policies = section.policies.map((policy) => {
    const dimensions = policy.dimensions.map((dimension) => {
      const rows = dimension.groups.map((group) => [
        escapeHtml(group.name),
        `<code>${escapeHtml(group.rule)}</code>`,
        escapeHtml(group.traders),
        group.suppressed ? `<span class="muted">${escapeHtml(group.reason)}</span>` : escapeHtml(`${num(group.harmReduction.median, 3)} [${num(group.harmReduction.p10, 3)}, ${num(group.harmReduction.p90, 3)}]`),
        group.suppressed ? '' : escapeHtml(`${num(group.activityRetained.median, 3)} [${num(group.activityRetained.p10, 3)}, ${num(group.activityRetained.p90, 3)}]`),
        group.suppressed ? '' : escapeHtml(num(group.beyondActivityCut.median, 3)),
        group.suppressed ? '' : escapeHtml(num(group.meanHarmChange, 2)),
        group.suppressed ? '' : escapeHtml(`${group.tradersWithChange} of ${group.traders}`)
      ]);
      return `<p>${escapeHtml(dimension.statement)}${dimension.unassigned ? ` <span class="muted">${escapeHtml(dimension.unassigned)} traders without the needed estimates are not grouped.</span>` : ''}</p>
        ${table(['Group', 'Rule', 'Traders', 'Harm reduction, median [10th, 90th pct across traders]', 'Activity retained', 'Beyond activity cut', `Mean change in ${section.harmMetric}`, 'Reached'], rows, 'compact')}`;
    }).join('');
    return `<h3><code>${escapeHtml(policy.type)}</code> at ${escapeHtml(policy.setting ?? 'n/a')}</h3><p class="muted">${escapeHtml(policy.cellBasis)} ${escapeHtml(policy.applicableTraders)} traders with a result.</p>${dimensions}`;
  }).join('');
  return `<p>${escapeHtml(section.basis)}</p>${policies}`;
}

function renderAssumptions(section) {
  const list = (items) => `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  const detail = section.detail.map((group) => `<details><summary>${escapeHtml(group.title)} (${group.items.length})</summary>${list(group.items)}</details>`).join('');
  return `<h3>Read this first</h3>${list(section.plain)}<h3>Limits</h3>${list(section.limits)}<h3>Full assumption lists</h3>${detail}`;
}

const SECTION_TITLES = Object.freeze({
  data: 'Data and fields',
  population: 'Population behavior',
  validation: 'Twin validation (held-out)',
  policy: 'Policy trade-off',
  affected: 'Which traders are most affected',
  assumptions: 'Assumptions and limits'
});

const RENDERERS = Object.freeze({
  data: renderData,
  population: renderPopulation,
  validation: renderValidation,
  policy: renderPolicy,
  affected: renderAffected,
  assumptions: renderAssumptions
});

/**
 * Renders a buildReportV2 report as one self-contained HTML page: inline CSS and SVG, no
 * scripts, no external resources. Reads only the report object.
 */
export function renderReportV2Html(report) {
  if (!isPlainObject(report) || report.reportVersion !== REPORT_V2_VERSION) throw new TypeError(`renderReportV2Html: needs a ${REPORT_V2_VERSION} report from buildReportV2`);
  svgCounter = 0;
  const sections = report.sectionOrder.map((key, index) => `
  <section id="${key}">
    <h2><span class="num">${index + 1}</span> ${escapeHtml(SECTION_TITLES[key])}</h2>
    ${RENDERERS[key](report.sections[key])}
  </section>`).join('');
  const versions = Object.entries(report.versions).filter(([, value]) => value).map(([key, value]) => `${key} ${value}`).join(' · ');
  const nav = report.sectionOrder.map((key, index) => `<a href="#${key}">${index + 1}. ${escapeHtml(SECTION_TITLES[key])}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.title)}</title>
<style>
  :root { --ink: #172033; --muted: #5a6577; --line: #dde3ec; --panel: #ffffff; --bg: #f4f6fa; --accent: #0072B2; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
  main { max-width: 1040px; margin: 0 auto; padding: 24px 20px 64px; }
  .banner { background: #fff4d6; border: 1px solid #c98a00; color: #6b4a00; padding: 10px 16px; border-radius: 10px; font-weight: 700; letter-spacing: .02em; }
  h1 { margin: 18px 0 4px; font-size: 26px; }
  h2 { margin: 0 0 12px; font-size: 20px; display: flex; gap: 10px; align-items: center; }
  h2 .num { background: var(--accent); color: #fff; border-radius: 50%; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; }
  h3 { margin: 22px 0 8px; font-size: 16px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px 22px; margin-top: 18px; }
  nav { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 10px 0 0; font-size: 14px; }
  nav a { color: var(--accent); text-decoration: none; }
  .muted { color: var(--muted); font-size: 13.5px; }
  .lead { font-weight: 600; }
  .claim { border-left: 4px solid var(--accent); padding: 6px 12px; background: #eef5fb; }
  .callout { border-radius: 10px; padding: 10px 14px; margin: 4px 0 12px; }
  .callout-ok { background: #e6f4ee; border: 1px solid #2f8f63; }
  .callout-no { background: #fbeee6; border: 1px solid #c4622d; }
  .ok { color: #1d7a50; font-weight: 600; } .no { color: #b3471c; font-weight: 600; }
  code { font: 12.5px ui-monospace, SFMono-Regular, Consolas, monospace; background: #f0f2f6; padding: 1px 4px; border-radius: 4px; }
  .table-wrap { overflow-x: auto; margin: 8px 0 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  table.kv thead { display: none; } table.kv td:first-child { width: 34%; }
  table.compact td, table.compact th { padding: 5px 6px; font-size: 12.5px; }
  svg.chart { width: 100%; max-width: 680px; height: auto; display: block; margin: 8px 0; }
  svg .grid { stroke: #eceff4; } svg .axis { stroke: #9aa3b2; } svg .ref { stroke: #8c8c8c; stroke-dasharray: 4 3; } svg .zero { stroke: #b7bec9; }
  svg .tick { font-size: 11px; fill: #4a5465; } svg .axis-title { font-size: 12px; fill: #2a3345; } svg .note { font-size: 10.5px; fill: #4a5465; } svg .value { font-size: 10.5px; fill: #2a3345; }
  svg .band { fill: #2f8f63; opacity: 0.12; }
  .panels { display: grid; grid-template-columns: 1fr; gap: 14px; }
  figure { margin: 0; } figcaption { font-size: 12.5px; color: var(--muted); max-width: 680px; }
  .fig { margin: 12px 0 4px; } .fig-title { font-weight: 600; font-size: 13.5px; }
  details { margin: 6px 0; } summary { cursor: pointer; font-weight: 600; }
  footer { margin-top: 24px; font-size: 12.5px; color: var(--muted); }
  @media print { body { background: #fff; } section { break-inside: avoid-page; border-color: #ccc; } nav { display: none; } }
</style>
</head>
<body>
<main>
  <div class="banner">${escapeHtml(report.banner)}</div>
  <h1>${escapeHtml(report.title)}</h1>
  <p class="claim">${escapeHtml(report.claim)}</p>
  <p class="muted">${escapeHtml(versions)}${report.generatedAt ? ` · generated ${escapeHtml(report.generatedAt)}` : ''}</p>
  <nav>${nav}</nav>
  ${sections}
  <footer>${escapeHtml(report.dataLabel)} · ${escapeHtml(report.reportVersion)} · Simulation under stated assumptions, not causal evidence. PlayMind never contacts traders, places trades, or holds funds.</footer>
</main>
</body>
</html>
`;
}
