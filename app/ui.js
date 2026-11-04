// Pure UI helpers for the DisputeRadar workbench. No DOM, no engine imports; everything is escaped text.
export const SCENARIOS = Object.freeze([
  { id: 'M1_BASELINE', label: 'DR-SYN-001 merchant M1, baseline v1 (event count)', merchantId: 'M1', policySet: 'BASELINE_V1', sessionMerchantId: 'M1' },
  { id: 'M1_V2', label: 'DR-SYN-001 merchant M1, scenario v2 (unique transactions)', merchantId: 'M1', policySet: 'SCENARIO_V2_UNIQUE_TRANSACTION', sessionMerchantId: 'M1' },
  { id: 'M1_V3', label: 'DR-SYN-001 merchant M1, scenario v3 (settled-date window)', merchantId: 'M1', policySet: 'SCENARIO_V3_SETTLED_DATE_WINDOW', sessionMerchantId: 'M1' },
  { id: 'M2_EMPTY', label: 'DR-SYN-001 merchant M2 (no settled sales)', merchantId: 'M2', policySet: 'BASELINE_V1', sessionMerchantId: 'M2' },
  { id: 'CROSS_TENANT', label: 'Cross-tenant attempt: session M2 requests M1 (must be rejected)', merchantId: 'M1', policySet: 'BASELINE_V1', sessionMerchantId: 'M2' },
]);

export function scenarioById(id) {
  return SCENARIOS.find((s) => s.id === id) || null;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Summary cards computed only from the engine snapshot (never literals). */
export function summaryCards(snapshot) {
  const ev = snapshot.evaluation;
  return [
    { label: 'Evaluation state', value: ev.state },
    { label: 'Numerator (events)', value: String(ev.numerator) },
    { label: 'Denominator (settled sales)', value: String(ev.denominator) },
    { label: 'Ratio (bps)', value: ev.ratio ? String(ev.ratio.bps) : 'undefined' },
    { label: 'Threshold (bps)', value: ev.threshold ? String(ev.threshold.bps) : 'n/a' },
    { label: 'Counted findings', value: String(snapshot.contributions.events.length) },
  ];
}

export function findingLabel(e) {
  return `${e.eventType} ${e.eventId} on ${e.transactionId} (${e.reportedDate}, ${e.status})`;
}

export function findingDetail(e) {
  return Object.entries(e).map(([k, v]) => ({ key: k, value: String(v) }));
}

/** 'empty' before any run, 'zero' when a run counted no findings, 'findings' otherwise, 'error' on rejection. */
export function resultState(result) {
  if (result === null || result === undefined) return 'empty';
  if (!result.ok) return 'error';
  return result.snapshot.contributions.events.length === 0 ? 'zero' : 'findings';
}

export function errorSummary(result) {
  return (result.errors || []).map((e) => `${e.code}: ${e.message}`);
}

/** Rejects anything that looks like a card number (13-19 digits, optional separators) before it reaches the DOM. */
export function looksLikePan(text) {
  return /(?:\d[ -]?){13,19}/.test(String(text ?? ''));
}

/** Distinct sorted filter values taken from the counted events only. */
export function filterOptions(snapshot) {
  const ev = snapshot.contributions.events;
  const uniq = (xs) => [...new Set(xs)].sort();
  return { category: uniq(ev.map((e) => e.category)), eventType: uniq(ev.map((e) => e.eventType)), month: uniq(ev.map((e) => e.reportedDate.slice(0, 7))) };
}

/** queryContributions() query from form values; a blank value means no filter on that field. */
export function buildQuery(values) {
  const q = {};
  for (const k of ['category', 'eventType', 'month', 'search', 'sortBy', 'order']) if (values[k]) q[k] = values[k];
  return q;
}

/** Plain-text rows for refunds, excluded records and warnings, read straight from the snapshot. */
export function explanationRows(snapshot) {
  const m = snapshot.money;
  return [
    `Refunds: ${m.refunds.length}, USD ${m.refundTotalUsd} of USD ${m.settledGrossUsd} settled gross. ${m.note}`,
    ...m.refunds.map((r) => `Refund ${r.refundId} on ${r.transactionId} (${r.reportedDate}): USD ${r.amountUsd}`),
    ...snapshot.exclusions.events.map((e) => `Excluded event ${e.eventType} ${e.eventId} on ${e.transactionId} (reported ${e.reportedDate}): ${e.reason}`),
    ...snapshot.exclusions.transactions.map((t) => `Excluded transaction ${t.transactionId} (${t.status}, settled ${t.settledDate ?? 'never'}): ${t.reason}`),
    ...snapshot.warnings.map((w) => `Warning ${w.code}: ${w.message}`),
  ];
}

/** Plain-text rows for a compareScenarios() comparison. */
export function comparisonRows(c) {
  const side = (name, s) => {
    const ev = s.evaluation;
    const ratio = ev.ratio ? `${ev.ratio.percent} (${ev.ratio.bps} bps)` : 'undefined';
    return `${name} ${s.rule.id} v${s.rule.version}: ${ev.numerator}/${ev.denominator} = ${ratio}, ${ev.state}`;
  };
  const ids = (xs) => xs.map((e) => e.eventId ?? String(e)).join(', ') || 'none';
  const diff = c.ratioDifference ? `${c.ratioDifference.differenceFraction} (${c.ratioDifference.bps} bps)` : 'undefined';
  return [
    side('Baseline', c.baseline),
    side('Scenario', c.scenario),
    `Numerator delta ${c.numeratorDelta}; ratio difference ${diff}`,
    `Counted only in baseline: ${ids(c.eventsCountedOnlyInBaseline)}; only in scenario: ${ids(c.eventsCountedOnlyInScenario)}`,
    c.note,
  ];
}

export function exportFilename(snapshot, ext) {
  return `disputeradar-${snapshot.scope.merchantId}-${snapshot.scope.period}-${snapshot.snapshotId.slice(0, 12)}.${ext}`;
}
