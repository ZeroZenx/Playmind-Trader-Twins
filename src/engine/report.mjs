function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildReport({ dataset, quality, signals, twins, policyRun }) {
  return {
    reportVersion: '0.1.0',
    reportType: 'responsible-trading-policy-test',
    label: dataset.isSynthetic ? 'SYNTHETIC DEMO ONLY' : 'CUSTOMER DATA',
    generatedAt: new Date().toISOString(),
    dataset: {
      name: dataset.name,
      venueId: dataset.venueId,
      isSynthetic: dataset.isSynthetic,
      eventCount: dataset.eventCount,
      traderCount: dataset.traderCount,
      startsAt: quality.stats.startsAt,
      endsAt: quality.stats.endsAt
    },
    evidenceStatus: {
      observed: 'Signals describe supplied event history.',
      simulated: 'Policy results describe seeded twin simulations.',
      assumed: 'Policy settings, horizon, and model behavior assumptions appear in the experiment inputs.',
      unavailable: 'Missing realized outcomes do not support outcome claims.'
    },
    dataQuality: quality,
    signalSummary: {
      traderCount: signals.length,
      averageTradesPerTrader: signals.length
        ? signals.reduce((sum, signal) => sum + signal.tradeCount, 0) / signals.length
        : 0,
      realizedOutcomeCoverage: signals.reduce((sum, signal) => sum + signal.realizedOutcomeCount, 0)
        / Math.max(1, signals.reduce((sum, signal) => sum + signal.tradeCount, 0))
    },
    model: {
      name: 'transparent-behavioral-baseline',
      version: '0.1.0',
      twinCount: twins.length,
      limitation: 'Synthetic replay tests mechanics and reproducibility. It does not prove production model performance or causal impact.'
    },
    policyExperiment: policyRun,
    limitations: [
      'Synthetic demo only.',
      'No live venue connection.',
      'No identity matching.',
      'No causal impact claim.',
      'No production regulatory conclusion.',
      'Results depend on supplied fields, signal definitions, policy configuration, and random seed.'
    ]
  };
}

export function renderHtmlReport(report) {
  const aggregate = report.policyExperiment.aggregate;
  const rows = [
    ['Dataset', report.dataset.name],
    ['Venue', report.dataset.venueId],
    ['Events', report.dataset.eventCount],
    ['Traders', report.dataset.traderCount],
    ['Baseline trades', aggregate.baselineTradeCount],
    ['Policy trades', aggregate.policyTradeCount],
    ['Blocked trades', aggregate.blockedTrades],
    ['Blocked deposits', aggregate.blockedDeposits],
    ['Realized outcome coverage', `${(report.signalSummary.realizedOutcomeCoverage * 100).toFixed(1)}%`]
  ];
  const table = rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
  const limitations = report.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(report.reportType)} - ${escapeHtml(report.dataset.name)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; color: #172033; background: #f4f7fb; }
    main { max-width: 920px; margin: 40px auto; padding: 0 24px 48px; }
    .banner { background: #dcecff; border: 1px solid #2f76d2; color: #174b88; padding: 14px 18px; border-radius: 12px; font-weight: 700; }
    section { background: #fff; margin-top: 18px; padding: 22px; border: 1px solid #d9e1ec; border-radius: 12px; }
    h1 { margin-bottom: 6px; } h2 { margin-top: 0; }
    table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 10px; border-bottom: 1px solid #e5eaf1; } th { width: 42%; color: #596579; }
    li { margin: 8px 0; }
    .muted { color: #596579; }
  </style>
</head>
<body>
  <main>
    <div class="banner">${escapeHtml(report.label)}</div>
    <h1>Responsible-trading policy test</h1>
    <p class="muted">Generated ${escapeHtml(report.generatedAt)}</p>
    <section><h2>Summary</h2><table>${table}</table></section>
    <section><h2>Evidence status</h2><p><strong>Observed:</strong> ${escapeHtml(report.evidenceStatus.observed)}</p><p><strong>Simulated:</strong> ${escapeHtml(report.evidenceStatus.simulated)}</p><p><strong>Unavailable:</strong> ${escapeHtml(report.evidenceStatus.unavailable)}</p></section>
    <section><h2>Limitations</h2><ul>${limitations}</ul></section>
  </main>
</body>
</html>`;
}
