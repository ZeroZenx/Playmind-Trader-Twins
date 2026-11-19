import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateTwins } from '../src/engine/estimate.mjs';
import { runHoldoutValidation } from '../src/engine/holdout.mjs';
import { runPolicySweep } from '../src/engine/policy-sim.mjs';
import { REPORT_SECTIONS, REPORT_V2_VERSION, buildReportV2, escapeHtml, renderReportV2Html } from '../src/engine/report-v2.mjs';
import { lastObservedBalances } from '../src/engine/simulate.mjs';
import { validateEvents } from '../src/engine/validate.mjs';
import * as engine from '../src/engine/index.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';
import { REPORT_DEMO_DEFAULTS, runReportDemo } from '../src/synthetic/report-demo.mjs';
import { truthFit } from '../src/synthetic/truth-twins.mjs';

// Report v2 (report-0.2.0) at a small scale. The default demo (npm run demo) runs the same
// pipeline at a larger scale and writes to gitignored demo/output/.

const dataset = generateBehavioralDataset({ seed: 77, name: 'report-unit', mode: 'population', traderCount: 18, sessionsPerTrader: { min: 20, max: 40 } });
const behaviorOptions = dataset.truth.options.behaviorOptions;
const fit = estimateTwins(dataset.events, { dataLabel: 'SYNTHETIC', behaviorOptions });
const holdout = runHoldoutValidation(dataset.events, { dataLabel: 'SYNTHETIC', behaviorOptions, replicates: 4, reference: { fit: truthFit(dataset) } });
const sweep = runPolicySweep(fit, { policies: ['stake_limit', 'cooldown'] }, { seed: 3, replicates: 3, horizonDays: 7, startingBalances: lastObservedBalances(dataset.events) });
const input = { dataset: { events: dataset.events, name: 'report-unit' }, quality: validateEvents(dataset.events), fit, holdout, sweep, generatedAt: '2026-11-12T00:00:00.000Z' };
const report = buildReportV2(input);
const html = renderReportV2Html(report);
const json = JSON.stringify(report);

test('the report has the six sections in order, with its label and versions', () => {
  assert.equal(report.reportVersion, REPORT_V2_VERSION);
  assert.deepEqual(report.sectionOrder, ['data', 'population', 'validation', 'policy', 'affected', 'assumptions']);
  assert.deepEqual(Object.keys(report.sections), REPORT_SECTIONS);
  assert.equal(report.dataLabel, 'SYNTHETIC');
  assert.equal(report.sections.data.label, 'SYNTHETIC');
  assert.match(report.banner, /SYNTHETIC/);
  assert.deepEqual(
    [report.versions.model, report.versions.simulator, report.versions.policy, report.versions.holdout, report.versions.baseline, report.versions.naive],
    ['twin-0.3.0', 'simulator-0.3.0', 'policy-0.2.0', 'holdout-0.1.0', 'baseline-0.1', 'naive-0.1']
  );
  assert.match(report.claim, /Not causal evidence and not an accuracy claim/);
  assert.equal(engine.buildReportV2, buildReportV2);
  // Deterministic given generatedAt.
  assert.deepEqual(buildReportV2(input), report);
  assert.equal(renderReportV2Html(buildReportV2(input)), html);
});

test('section 1: dataset summary, field coverage, and estimable parameters', () => {
  const { data } = report.sections;
  assert.equal(data.summary.events, dataset.events.length);
  assert.equal(data.summary.traders, 18);
  assert.equal(data.summary.trades + data.summary.deposits + data.summary.withdrawals + data.summary.otherEvents, dataset.events.length);
  const coverage = Object.fromEntries(data.fieldCoverage.map((row) => [row.field, row]));
  assert.equal(coverage.stake_amount.share, 1);
  assert.equal(coverage.balance_before.share, 1);
  assert.equal(coverage.market_type.share, 0, 'market fields are optional and absent');
  assert.equal(coverage.withdrawal_amount.share, null, 'no withdrawals: no share, not 0');
  const parameters = data.estimability.map((row) => row.parameter);
  assert.ok(parameters.includes('stopHazard.down_large') && parameters.includes('refuelProbability'));
  for (const row of data.estimability) assert.equal(row.estimated + row.priorOnly + row.notEstimable, 18, row.parameter);

  // Without balance fields, refuelProbability is not estimable, and the report says why.
  const plain = generateBehavioralDataset({ seed: 77, name: 'report-unit', mode: 'population', traderCount: 18, sessionsPerTrader: { min: 20, max: 40 }, includeBalances: false });
  const plainFit = estimateTwins(plain.events, { dataLabel: 'SYNTHETIC', behaviorOptions });
  const plainReport = buildReportV2({ ...input, dataset: { events: plain.events }, fit: plainFit });
  const refuel = plainReport.sections.data.estimability.find((row) => row.parameter === 'refuelProbability');
  assert.equal(refuel.status, 'not estimable');
  assert.match(refuel.reasons[0].reason, /balance/);
  assert.match(plainReport.sections.data.statement, /all-cause.*losing-streak proxy/);
  assert.equal(plainReport.sections.population.refuel.primary, 'refuelAfterLosingStreak');
  assert.match(plainReport.sections.population.refuel.statement, /proxied/);
});

test('section 2: the chase statement follows the data, never an assumed direction', () => {
  const { chase } = report.sections.population;
  assert.equal(chase.scaleBack + chase.chase <= chase.traders, true);
  assert.equal(chase.histogram.bins.reduce((total, bin) => total + bin.count, 0), chase.traders);
  // Force the estimates to one side, then the other: the statement follows.
  const shifted = (value) => ({
    ...fit,
    twins: fit.twins.map((twin) => ({ ...twin, parameters: { ...twin.parameters, chaseCoefficient: { ...twin.parameters.chaseCoefficient, status: 'estimated', estimate: value, interval: [value * 0.9, value * 1.1] } } }))
  });
  const back = buildReportV2({ ...input, fit: shifted(0.7) }).sections.population.chase;
  assert.equal(back.shareScaleBack, 1);
  assert.match(back.statement, /^Most traders \(100%\) scale back after a loss/);
  const up = buildReportV2({ ...input, fit: shifted(1.6) }).sections.population.chase;
  assert.match(up.statement, /^Most traders \(100%\) bet more after a loss/);
  assert.match(up.statement, /18 of 18 have a 90% interval entirely above 1/);
  assert.equal(report.sections.population.stops.buckets.length, 4);
});

test('section 3 reports held-out validation against both baselines, with no accuracy headline', () => {
  const { validation } = report.sections;
  assert.equal(validation.overall.claimEarned, holdout.summary.overall.claim.earned);
  assert.equal(validation.overall.statement, holdout.summary.overall.claim.statement);
  assert.deepEqual(Object.keys(validation.models).sort(), ['baseline', 'naive', 'truth', 'twin']);
  assert.equal(validation.metrics.length, Object.keys(holdout.metrics).length);
  for (const row of validation.metrics) {
    assert.equal(row.calibration.share, holdout.metrics[row.metric].models.twin.calibration.share);
    assert.ok('baseline' in row.beats && 'naive' in row.beats);
  }
  assert.match(validation.split.churnCaveat, /not tested on churn/);
  for (const text of [json, html]) {
    assert.doesNotMatch(text, /\bAUC\b|AUROC|average precision|p-value\s*[=:<]|accuracy\s*[=:]/i);
    const mentions = text.match(/[^.]{0,30}accuracy[^.]{0,10}/gi) ?? [];
    assert.ok(mentions.every((mention) => /not an accuracy|no accuracy/i.test(mention)), `accuracy only in denials: ${mentions.join(' | ')}`);
  }
});

test('section 4: one series per response assumption value, a point per setting, with bands', () => {
  const { policy } = report.sections;
  assert.deepEqual(policy.policies.map((item) => item.type), ['stake_limit', 'cooldown']);
  for (const [index, item] of policy.policies.entries()) {
    const chart = sweep.policies[index].chart;
    const series = item.panels.flatMap((panel) => panel.series);
    assert.deepEqual(series.map((entry) => entry.id), chart.series.map((entry) => entry.id));
    for (const entry of series) {
      assert.equal(entry.points.length, item.settings.length);
      for (const point of entry.points) assert.ok('p10' in point.harmReduction && 'p90' in point.activityRetained);
    }
    assert.match(item.driver, new RegExp(item.type));
  }
  assert.equal(policy.policies[1].panels.length, 3, 'cooldown: rebound, leave, and reference point are swept');
  assert.match(policy.claim, /assumed rather than estimated/);
});

test('section 5 groups traders by parameter range, never by token, and hides small groups', () => {
  assert.doesNotMatch(json, /syn_\d/, 'no trader token in the JSON');
  assert.doesNotMatch(html, /syn_\d/, 'no trader token in the HTML');
  for (const policy of report.sections.affected.policies) {
    for (const dimension of policy.dimensions) {
      const counted = dimension.groups.reduce((total, group) => total + group.traders, 0) + dimension.unassigned;
      assert.equal(counted, policy.applicableTraders, `${policy.type} ${dimension.by}`);
      for (const group of dimension.groups) {
        if (group.traders < 5) {
          assert.equal(group.suppressed, true);
          assert.equal(group.harmReduction, null);
          assert.equal(group.meanHarmChange, null);
        }
      }
    }
  }
  const hidden = buildReportV2({ ...input, options: { minGroupSize: 1000 } }).sections.affected;
  assert.ok(hidden.policies.every((policy) => policy.dimensions.every((dimension) => dimension.groups.every((group) => group.suppressed) && dimension.mostAffected === null)));
  // Archetypes are a grouping only when there are at least two.
  const archetypes = Object.fromEntries(dataset.truth.traders.map((trader, index) => [trader.traderToken, index % 2 ? 'chaser' : 'steady']));
  const grouped = buildReportV2({ ...input, traderGroups: archetypes, options: { minGroupSize: 1 } }).sections.affected;
  assert.equal(grouped.policies[0].dimensions[0].by, 'archetype');
  assert.equal(buildReportV2({ ...input, traderGroups: { x: 'population' } }).sections.affected.policies[0].dimensions[0].by, 'chaseCoefficient range');
});

test('section 6 states assumptions and limits plainly', () => {
  const { assumptions } = report.sections;
  assert.match(assumptions.plain[0], /not causal evidence/);
  assert.ok(assumptions.plain.some((line) => /no intervention data/i.test(line)));
  assert.ok(assumptions.plain.some((line) => /SYNTHETIC/.test(line)));
  assert.ok(assumptions.plain.some((line) => /never contacts traders, places trades, or holds funds/.test(line)));
  assert.deepEqual(assumptions.detail.map((group) => group.title), ['Simulation (simulator-0.3.0)', 'Policy responses (policy-0.2.0)', 'Held-out validation (holdout-0.1.0)', 'Trader labels']);
  assert.equal(assumptions.detail[2].items, holdout.assumptions);
});

test('the HTML is self-contained, in section order, with inline SVG and no scripts', () => {
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script|<link|<iframe|<img|@import|url\(\s*['"]?http/i);
  assert.doesNotMatch(html, /\s(src|href)\s*=\s*["']?(https?:)?\/\//i, 'no external resources');
  assert.ok((html.match(/<svg /g) ?? []).length >= 8, 'charts are inline SVG');
  const positions = REPORT_SECTIONS.map((key) => html.indexOf(`<section id="${key}">`));
  assert.ok(positions.every((position) => position > 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'sections in order');
  assert.match(html, /SYNTHETIC DATA: NOT A REAL VENUE OR TRADER/);
  // Text is escaped.
  const tricky = renderReportV2Html(buildReportV2({ ...input, dataset: { events: dataset.events, name: '<img src=x onerror=alert(1)>' } }));
  assert.doesNotMatch(tricky, /<img src=x/);
  assert.match(tricky, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(escapeHtml('a"b\'c&'), 'a&quot;b&#39;c&amp;');
  assert.throws(() => renderReportV2Html({ reportVersion: '0.1.0' }), /report-0\.2\.0/);
});

test('labels must agree, and archetype groups are SYNTHETIC only', () => {
  assert.throws(() => buildReportV2({ ...input, sweep: { ...sweep, dataLabel: 'CUSTOMER' } }), /different data labels/);
  assert.throws(() => buildReportV2({ ...input, options: { minGroup: 3 } }), /unknown option "minGroup"/);
  const customer = (value) => ({ ...value, dataLabel: 'CUSTOMER' });
  const customerReport = buildReportV2({ ...input, fit: customer(fit), holdout: customer(holdout), sweep: customer(sweep) });
  assert.equal(customerReport.dataLabel, 'CUSTOMER');
  assert.match(customerReport.banner, /CUSTOMER DATA: CONFIDENTIAL/);
  assert.ok(customerReport.sections.assumptions.plain.some((line) => /customer-derived/.test(line)));
  assert.throws(() => buildReportV2({ ...input, fit: customer(fit), holdout: customer(holdout), sweep: customer(sweep), traderGroups: { a: 'b' } }), /only for SYNTHETIC/);
});

test('npm run demo builds report v2 from the behavioral synthetic population', async () => {
  assert.equal(REPORT_DEMO_DEFAULTS.sessionsPerTrader.min >= 20, true);
  const small = runReportDemo({ traderCount: 8, holdoutReplicates: 2, sweepReplicates: 2, horizonDays: 5, policies: ['session_loss_limit'], sessionsPerTrader: { min: 20, max: 30 } });
  assert.equal(small.report.dataLabel, 'SYNTHETIC');
  assert.match(small.report.versions.generator, /behavioral-synthetic-0\.1\.0 \(population mode/);
  assert.throws(() => runReportDemo({ traders: 3 }), /unknown option "traders"/);

  const directory = await mkdtemp(join(tmpdir(), 'playmind-demo-'));
  try {
    const run = spawnSync(process.execPath, ['demo/run.mjs', '--traders', '6', '--holdout-replicates', '2', '--sweep-replicates', '2', '--horizon-days', '5', '--policies', 'stake_limit', '--no-balances', '--out', directory], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.label, 'SYNTHETIC');
    assert.equal(summary.reportVersion, REPORT_V2_VERSION);
    assert.equal(summary.balances, false);
    assert.deepEqual((await readdir(directory)).sort(), ['report-v2.html', 'report-v2.json', 'synthetic-events.json']);
    const written = JSON.parse(await readFile(join(directory, 'report-v2.json'), 'utf8'));
    assert.equal(written.dataLabel, 'SYNTHETIC');
    assert.match(written.sections.data.statement, /all-cause/);
    const page = await readFile(join(directory, 'report-v2.html'), 'utf8');
    assert.match(page, /<svg /);
    assert.doesNotMatch(page, /<script/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
