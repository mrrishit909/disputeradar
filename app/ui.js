// Pure UI helpers for the DisputeRadar workbench. No DOM, no engine imports; everything is escaped text.

/** Shown before any snapshot exists (no data has been loaded, so no origin is claimed). */
export const ORIGIN_IDLE_TEXT = 'No data loaded yet. Data origin is shown here once a snapshot exists.';

/**
 * Origin banner text for the shown snapshot, read only from the engine snapshot's dataOrigin/labels
 * (set by load path, never by content). Anything but the attested bundled origin reads as unverified.
 */
export function originBanner(snapshot) {
  const bundled = snapshot.dataOrigin === 'BUNDLED_SYNTHETIC_DEMO';
  return {
    kind: bundled ? 'BUNDLED_SYNTHETIC_DEMO' : 'UNVERIFIED_USER_SUPPLIED',
    label: snapshot.labels.dataOrigin,
    notice: snapshot.labels.originNotice,
  };
}

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

/** What the snapshot's numerator counts, read from the engine evaluation (v1/v3 events, v2 unique transactions). */
export function numeratorUnit(snapshot) {
  return snapshot.evaluation.numeratorDefinition === 'UNIQUE_TRANSACTION_COUNT' ? 'unique transactions' : 'events';
}

/** Summary cards computed only from the engine snapshot (never literals). */
export function summaryCards(snapshot) {
  const ev = snapshot.evaluation;
  return [
    { label: 'Evaluation state', value: ev.state },
    { label: `Numerator (${numeratorUnit(snapshot)})`, value: String(ev.numerator) },
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
    return `${name} ${s.rule.id} v${s.rule.version} (numerator counts ${numeratorUnit(s)}): ${ev.numerator}/${ev.denominator} = ${ratio}, ${ev.state}`;
  };
  const ids = (xs) => xs.map((e) => e.eventId ?? String(e)).join(', ') || 'none';
  const diff = c.ratioDifference ? `${c.ratioDifference.differenceFraction} (${c.ratioDifference.bps} bps)` : 'undefined';
  const bu = numeratorUnit(c.baseline);
  const su = numeratorUnit(c.scenario);
  const mixed = bu === su ? '' : ` (scenario ${su} minus baseline ${bu})`;
  return [
    side('Baseline', c.baseline),
    side('Scenario', c.scenario),
    `Numerator delta ${c.numeratorDelta}${mixed}; ratio difference ${diff}`,
    `Counted only in baseline: ${ids(c.eventsCountedOnlyInBaseline)}; only in scenario: ${ids(c.eventsCountedOnlyInScenario)}`,
    c.note,
  ];
}

// ---------- Late-event reimport (all synthetic; files are fictional DR-SYN-001 additions) ----------
const file = (rest) => JSON.stringify({
  schemaVersion: 'disputeradar.dataset.v1', dataClassification: 'SYNTHETIC',
  merchants: [], transactions: [], disputes: [], fraudEvents: [], refunds: [], ...rest,
}, null, 2);
const M1_ROW = { id: 'M1', region: 'DEMO', currency: 'USD' };
const T5_ROW = { id: 'T5', merchantId: 'M1', settledDate: '2026-10-01', amountCents: 10000, status: 'SETTLED' };

/** Seeded synthetic reimport files: one valid late event, one conflicting duplicate, one other-merchant file. */
export const REIMPORT_EXAMPLES = Object.freeze({
  valid: file({ merchants: [M1_ROW], transactions: [T5_ROW], disputes: [{ id: 'D5', transactionId: 'T5', reportedDate: '2026-10-31', category: 'cancellation', status: 'LOST' }] }),
  conflict: file({ merchants: [M1_ROW], transactions: [{ ...T5_ROW, id: 'T1' }], disputes: [{ id: 'D1', transactionId: 'T1', reportedDate: '2026-10-03', category: 'product-not-received', status: 'LOST' }] }),
  otherMerchant: file({
    merchants: [{ id: 'M2', region: 'DEMO', currency: 'USD' }],
    transactions: [{ id: 'U9', merchantId: 'M2', settledDate: '2026-10-05', amountCents: 2500, status: 'SETTLED' }],
    disputes: [{ id: 'D9', transactionId: 'U9', reportedDate: '2026-10-20', category: 'cancellation', status: 'OPEN' }],
  }),
});

/** 'JSON' when the text starts with '{', otherwise 'CSV' (the engine's strict importers do the real validation). */
export function detectFormat(text) {
  return String(text ?? '').trimStart().startsWith('{') ? 'JSON' : 'CSV';
}

/** Records in a validated import that belong to any merchant other than the session's (never merged). */
export function scopeViolations(dataset, merchantId) {
  const out = [];
  for (const m of dataset.merchants) if (m.id !== merchantId) out.push(`merchant ${m.id}`);
  for (const c of ['transactions', 'disputes', 'fraudEvents', 'refunds']) {
    for (const r of dataset[c]) if (r.merchantId !== merchantId) out.push(`${c} ${r.id} (merchant ${r.merchantId})`);
  }
  return out;
}

const signed = (n) => (n === null ? 'undefined' : n > 0 ? `+${n}` : String(n));
const signedBps = (s) => (s.startsWith('-') || /^0(\.0+)?$/.test(s) ? s : `+${s}`);
const bpsOf = (snap) => (snap.evaluation.ratio ? `${snap.evaluation.ratio.bps} bps` : 'undefined');

/** Plain-text explanation of a diffSnapshots() delta between the retained baseline and the new snapshot. */
export function deltaRows(diff, from, to, merge) {
  const rule = to.rule ? `${to.rule.id} v${to.rule.version}` : `${to.requestedRuleId} (not evaluated)`;
  const rd = diff.ratioDifference;
  const list = (xs) => xs.map((x) => `${x.collection} ${x.id}`).join(', ') || 'none';
  return [
    `Baseline snapshot ${diff.fromSnapshotId.slice(0, 12)} is retained unchanged; new snapshot ${diff.toSnapshotId.slice(0, 12)} covers the same scope: merchant ${diff.scope.merchantId}, period ${diff.scope.period}, rule ${rule}.`,
    `Numerator ${diff.numerator.from} → ${diff.numerator.to} (delta ${signed(diff.numerator.delta)}); denominator ${diff.denominator.from} → ${diff.denominator.to} (delta ${signed(diff.denominator.delta)}).`,
    `Ratio ${bpsOf(from)} → ${bpsOf(to)}; exact difference ${rd ? `${rd.differenceFraction} (${signedBps(rd.bps)} bps)` : 'undefined (a zero denominator on either side)'}; state ${diff.state.from} → ${diff.state.to}.`,
    ...(diff.explanation.length ? diff.explanation : ['No counted event or scoped data changed: every re-imported record was already present (idempotent no-op).']),
    `Merge: ${merge.added.length} new record(s): ${list(merge.added)}; ${merge.unchanged.length} identical record(s) ignored as idempotent re-imports.`,
    `Data origin ${diff.dataOrigin.from} → ${diff.dataOrigin.to}: merged or imported data is always UNVERIFIED USER-SUPPLIED, even when identical to the built-in fixture or declared SYNTHETIC.`,
    ...(from.notes.length ? [`${from.notes.length} remediation note(s) stay on the baseline snapshot; the new snapshot starts with none.`] : []),
  ];
}

export function exportFilename(snapshot, ext) {
  return `disputeradar-${snapshot.scope.merchantId}-${snapshot.scope.period}-${snapshot.snapshotId.slice(0, 12)}.${ext}`;
}
