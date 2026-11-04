import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCENARIOS, scenarioById, esc, summaryCards, findingLabel, resultState, errorSummary, looksLikePan, exportFilename, filterOptions, buildQuery, explanationRows, comparisonRows } from './ui.js';
import { generateDrSyn001, createSnapshot, serializeReportCsv, compareScenarios, queryContributions } from '../src/index.js';

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
