import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCENARIOS, scenarioById, esc, summaryCards, findingLabel, resultState, errorSummary, looksLikePan, exportFilename, filterOptions, buildQuery, explanationRows, comparisonRows, REIMPORT_EXAMPLES, detectFormat, scopeViolations, deltaRows } from './ui.js';
import { generateDrSyn001, createSnapshot, serializeReportCsv, compareScenarios, queryContributions, importDatasetJson, mergeDatasets, diffSnapshots } from '../src/index.js';

const fx = generateDrSyn001();
const run = (id) => {
  const sc = scenarioById(id);
  const session = { allowedMerchantIds: [sc.sessionMerchantId] };
  return { session, result: createSnapshot({ dataset: fx.dataset, policySet: fx.policySets[sc.policySet], merchantId: sc.merchantId, period: fx.period, session }) };
};

test('esc neutralises HTML', () => assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'));

test('summary cards mirror the engine snapshot, no literals', () => {
  const { result } = run('M1_BASELINE');
  const cards = summaryCards(result.snapshot);
  const by = Object.fromEntries(cards.map((c) => [c.label, c.value]));
  assert.equal(by['Numerator (events)'], String(result.snapshot.evaluation.numerator));
  assert.equal(by['Denominator (settled sales)'], String(result.snapshot.evaluation.denominator));
  assert.equal(by['Ratio (bps)'], String(result.snapshot.evaluation.ratio.bps));
  assert.equal(by['Counted findings'], String(result.snapshot.contributions.events.length));
  assert.equal(resultState(result), 'findings');
  assert.match(findingLabel(result.snapshot.contributions.events[0]), /^(DISPUTE|FRAUD) /);
});

test('empty, zero-findings, and error states are distinct', () => {
  assert.equal(resultState(null), 'empty');
  const zero = run('M2_EMPTY').result;
  assert.equal(zero.ok, true);
  assert.equal(resultState(zero), 'zero');
  const denied = run('CROSS_TENANT').result;
  assert.equal(resultState(denied), 'error');
  assert.match(errorSummary(denied).join(), /ACCESS_DENIED/);
});

test('CSV export cells neutralise formula triggers', () => {
  const { result, session } = run('M1_BASELINE');
  const out = serializeReportCsv(result.snapshot, session);
  assert.equal(out.ok, true);
  for (const line of out.text.split('\r\n').slice(1).filter(Boolean)) {
    for (const cell of line.split(',')) assert.doesNotMatch(cell.replace(/^"/, ''), /^[=+\-@\t\r]/, `cell ${cell}`);
  }
});

test('PAN-like text is detected; filenames derive from the snapshot', () => {
  assert.equal(looksLikePan('4111 1111 1111 1111'), true);
  assert.equal(looksLikePan('T1 2026-10-03'), false);
  const { result } = run('M1_BASELINE');
  assert.match(exportFilename(result.snapshot, 'csv'), /^disputeradar-M1-2026-10-[0-9a-f]{12}\.csv$/);
});

test('index.html structural requirements', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<html lang="en">/);
  assert.equal((html.match(/<main[\s>]/g) || []).length, 1);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /inert/);
  assert.equal(SCENARIOS.length, 5);
});

test('journey helpers: filters come from counted events and drive real engine queries', () => {
  const { result } = run('M1_BASELINE');
  const o = filterOptions(result.snapshot);
  assert.deepEqual(o.eventType, ['DISPUTE', 'FRAUD']);
  assert.deepEqual(o.month, ['2026-10']);
  assert.deepEqual(buildQuery({ category: '', eventType: 'FRAUD', search: '', sortBy: 'eventId' }), { eventType: 'FRAUD', sortBy: 'eventId' });
  const q = queryContributions(result.snapshot, buildQuery({ eventType: 'FRAUD' }));
  assert.equal(q.total, result.snapshot.contributions.byType.FRAUD);
});

// Literal orders derived by hand from the fixture dates/ids (ties: eventType, then eventId).
const SORT_LITERALS = {
  reportedDate: ['D3', 'D1', 'D2', 'F1', 'F2'],
  eventId: ['D1', 'D2', 'D3', 'F1', 'F2'],
  transactionId: ['D3', 'D1', 'F1', 'D2', 'F2'],
  category: ['D2', 'F1', 'F2', 'D1', 'D3'],
  eventType: ['D1', 'D2', 'D3', 'F1', 'F2'],
};

test('sort options produce literal event orders (every option of the page select)', () => {
  const { result } = run('M1_BASELINE');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const sel = /<select id="f-sort">(.*?)<\/select>/.exec(html)[1];
  assert.deepEqual([...sel.matchAll(/value="([^"]+)"/g)].map((m) => m[1]).sort(), Object.keys(SORT_LITERALS).sort());
  for (const [sortBy, ids] of Object.entries(SORT_LITERALS)) {
    assert.deepEqual(queryContributions(result.snapshot, buildQuery({ sortBy })).results.map((e) => e.eventId), ids, sortBy);
  }
});

const reimportOf = (text, base = fx.dataset) => {
  const imp = importDatasetJson(text);
  return imp.ok ? { imp, merged: mergeDatasets(base, imp.dataset) } : { imp };
};

test('valid late-event reimport: new snapshot plus literal diffSnapshots delta; baseline retained', () => {
  const { result: before, session } = run('M1_BASELINE');
  const { imp, merged } = reimportOf(REIMPORT_EXAMPLES.valid);
  assert.equal(detectFormat(REIMPORT_EXAMPLES.valid), 'JSON');
  assert.deepEqual(scopeViolations(imp.dataset, 'M1'), []);
  assert.equal(merged.ok, true);
  const after = createSnapshot({ dataset: merged.dataset, policySet: fx.policySets.BASELINE_V1, merchantId: 'M1', period: fx.period, session });
  const d = diffSnapshots(before.snapshot, after.snapshot);
  assert.equal(d.ok, true);
  const rows = deltaRows(d.diff, before.snapshot, after.snapshot, merged.merge);
  assert.match(rows[0], /retained unchanged.*merchant M1, period 2026-10, rule DEMO-EVENT-COUNT v1\.$/);
  assert.equal(rows[1], 'Numerator 5 → 6 (delta +1); denominator 10 → 10 (delta 0).');
  assert.match(rows[2], /^Ratio 5000 bps → 6000 bps; exact difference 1\/10 \(\+1000 bps\); state /);
  assert.ok(rows.includes('DISPUTE:D5 (transaction T5, reported 2026-10-31) is newly counted.'));
  assert.ok(rows.includes('Merge: 1 new record(s): disputes D5; 2 identical record(s) ignored as idempotent re-imports.'));
  assert.deepEqual(queryContributions(after.snapshot, {}).results.map((e) => e.eventId), ['D3', 'D1', 'D2', 'F1', 'D5', 'F2']);
  assert.equal(before.snapshot.evaluation.numerator, 5, 'baseline snapshot is not rewritten');
  // Reimporting the same file again is an idempotent no-op: same snapshot id, zero delta.
  const again = mergeDatasets(merged.dataset, imp.dataset);
  const same = createSnapshot({ dataset: again.dataset, policySet: fx.policySets.BASELINE_V1, merchantId: 'M1', period: fx.period, session }).snapshot;
  assert.equal(same.snapshotId, after.snapshot.snapshotId);
  const d2 = diffSnapshots(after.snapshot, same).diff;
  assert.equal(deltaRows(d2, after.snapshot, same, again.merge)[1], 'Numerator 6 → 6 (delta 0); denominator 10 → 10 (delta 0).');
});

test('invalid and other-merchant reimports are rejected before any merge', () => {
  const conflict = reimportOf(REIMPORT_EXAMPLES.conflict);
  assert.equal(conflict.imp.ok, true);
  assert.match(errorSummary(conflict.merged).join(), /CONFLICTING_DUPLICATE_ID/);
  const other = reimportOf(REIMPORT_EXAMPLES.otherMerchant);
  assert.deepEqual(scopeViolations(other.imp.dataset, 'M1'), ['merchant M2', 'transactions U9 (merchant M2)', 'disputes D9 (merchant M2)']);
  assert.match(errorSummary(importDatasetJson('{not json')).join(), /MALFORMED_JSON/);
  assert.equal(detectFormat('schema_version,data_classification'), 'CSV');
});

test('journey helpers: refund and late-report explanations and the rule-2 comparison come from the engine', () => {
  const { result, session } = run('M1_BASELINE');
  const why = explanationRows(result.snapshot);
  assert.ok(why.some((r) => r.startsWith('Refunds: ')));
  for (const e of result.snapshot.exclusions.events) assert.ok(why.some((r) => r.includes(e.eventId) && r.includes(e.reason)));
  const c = compareScenarios({ dataset: fx.dataset, merchantId: 'M1', period: fx.period, session, baselinePolicySet: fx.policySets.BASELINE_V1, scenarioPolicySet: fx.policySets.SCENARIO_V2_UNIQUE_TRANSACTION });
  const rows = comparisonRows(c.comparison);
  assert.ok(rows[0].includes(c.comparison.baseline.evaluation.ratio.percent));
  assert.ok(rows[1].includes(c.comparison.scenario.evaluation.ratio.percent));
  assert.ok(rows[2].includes(String(c.comparison.numeratorDelta)));
});

test('numerator label: baseline v1 keeps "events" wording', () => {
  const { result } = run('M1_BASELINE');
  assert.equal(result.snapshot.evaluation.numeratorDefinition, 'DISPUTE_AND_FRAUD_EVENT_COUNT');
  assert.deepEqual(summaryCards(result.snapshot).map((c) => c.label),
    ['Evaluation state', 'Numerator (events)', 'Denominator (settled sales)', 'Ratio (bps)', 'Threshold (bps)', 'Counted findings']);
  assert.equal(summaryCards(result.snapshot)[1].value, '5');
});

test('numerator label: unique-transaction v2 says "unique transactions", never "events"', () => {
  const { result } = run('M1_V2');
  assert.equal(result.snapshot.evaluation.numeratorDefinition, 'UNIQUE_TRANSACTION_COUNT');
  const by = Object.fromEntries(summaryCards(result.snapshot).map((c) => [c.label, c.value]));
  assert.equal(by['Numerator (unique transactions)'], '4');
  assert.equal(by['Numerator (events)'], undefined);
});

test('comparison rows label each side by its own numerator unit, in either direction', () => {
  const session = { allowedMerchantIds: ['M1'] };
  const cmp = (b, s) => comparisonRows(compareScenarios({ dataset: fx.dataset, merchantId: 'M1', period: fx.period, session, baselinePolicySet: fx.policySets[b], scenarioPolicySet: fx.policySets[s] }).comparison);
  const v1v2 = cmp('BASELINE_V1', 'SCENARIO_V2_UNIQUE_TRANSACTION');
  assert.equal(v1v2[0], 'Baseline DEMO-EVENT-COUNT v1 (numerator counts events): 5/10 = 50.00% (5000 bps), ILLUSTRATIVE_ALERT');
  assert.equal(v1v2[1], 'Scenario DEMO-EVENT-COUNT v2 (numerator counts unique transactions): 4/10 = 40.00% (4000 bps), ILLUSTRATIVE_ALERT');
  assert.match(v1v2[2], /^Numerator delta -1 \(scenario unique transactions minus baseline events\); /);
  const v2v1 = cmp('SCENARIO_V2_UNIQUE_TRANSACTION', 'BASELINE_V1');
  assert.match(v2v1[0], /^Baseline DEMO-EVENT-COUNT v2 \(numerator counts unique transactions\): 4\/10 /);
  assert.match(v2v1[1], /^Scenario DEMO-EVENT-COUNT v1 \(numerator counts events\): 5\/10 /);
  assert.match(v2v1[2], /^Numerator delta 1 \(scenario events minus baseline unique transactions\); /);
  const v1v3 = cmp('BASELINE_V1', 'SCENARIO_V3_SETTLED_DATE_WINDOW');
  assert.match(v1v3[1], /^Scenario DEMO-EVENT-COUNT v3 \(numerator counts events\): /);
  assert.match(v1v3[2], /^Numerator delta -?\d+; ratio difference /);
});
