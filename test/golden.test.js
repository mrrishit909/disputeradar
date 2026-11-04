// Acceptance #1, #2, #3, #8: golden DR-SYN-001 oracles (hardcoded, independent of engine output).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVALUATION_STATE, compareRationals, compareScenarios, createSnapshot, importDatasetCsv, mergeDatasets, ratioDisplay,
} from '../src/index.js';
import { BOTH, FIX, M1, codes, importObject, importOk, rawFixture, snap, synthetic } from './helpers.js';

const evKeys = (s) => s.contributions.events.map((e) => `${e.eventType}:${e.eventId}`).sort();

test('#1 golden v1: 5 events / 10 settled = 5000 bps illustrative alert with exact contributions', () => {
  const s = snap(FIX.dataset);
  assert.equal(s.evaluation.numerator, 5);
  assert.equal(s.evaluation.denominator, 10);
  assert.equal(s.evaluation.ratio.fraction, '5/10');
  assert.equal(s.evaluation.ratio.reduced, '1/2');
  assert.equal(s.evaluation.ratio.bps, '5000');
  assert.equal(s.evaluation.ratio.percent, '50.00%');
  assert.equal(s.evaluation.state, EVALUATION_STATE.ILLUSTRATIVE_ALERT);
  assert.equal(s.evaluation.thresholdComparison, 'ABOVE');
  assert.deepEqual(evKeys(s), ['DISPUTE:D1', 'DISPUTE:D2', 'DISPUTE:D3', 'FRAUD:F1', 'FRAUD:F2']);
  assert.deepEqual(s.contributions.byTransaction.map((t) => [t.transactionId, t.eventCount, t.inDenominator]),
    [['T0', 1, false], ['T1', 2, true], ['T2', 1, true], ['T3', 1, true]]);
  assert.deepEqual(s.contributions.byCategory, [
    { category: 'cancellation', count: 1 }, { category: 'fraud', count: 2 }, { category: 'product-not-received', count: 2 }]);
  assert.deepEqual(s.contributions.byType, { DISPUTE: 3, FRAUD: 2 });
  // D4 late (reported 2026-11-01) excluded; T11 pending and T0 (September sale) out of the denominator.
  assert.deepEqual(s.exclusions.events.map((e) => [e.eventId, e.reason]), [['D4', 'EVENT_OUTSIDE_WINDOW']]);
  assert.deepEqual(s.exclusions.transactions.map((t) => [t.transactionId, t.reason]).sort(),
    [['T0', 'TRANSACTION_SETTLED_OUTSIDE_WINDOW'], ['T11', 'TRANSACTION_NOT_SETTLED']]);
  assert.equal(s.money.settledGrossCents, 100000);
  assert.equal(s.money.settledGrossUsd, '1000.00');
  assert.equal(s.money.refundTotalCents, 10000);
  assert.equal(s.money.refundTotalUsd, '100.00');
  assert.ok(s.warnings.some((w) => w.code === 'NUMERATOR_EVENT_ON_OUT_OF_WINDOW_SALE'), 'D3 on September sale flagged');
  assert.deepEqual(s.numeratorWindow, { dateField: 'EVENT_REPORTED_DATE', start: '2026-10-01', end: '2026-10-31' });
  assert.equal(s.labels.chart, 'Synthetic / illustrative rule');
  assert.match(s.labels.policyDisclaimer, /NOT Visa VAMP, NOT Mastercard/);
  assert.equal(s.rule.version, 1);
});

test('#1 rule v2 scenario: unique transactions {T0,T1,T2,T3} = 4000 bps, difference -1000 bps', () => {
  const r = compareScenarios({
    dataset: FIX.dataset, merchantId: 'M1', period: '2026-10', session: M1,
    baselinePolicySet: FIX.policySets.BASELINE_V1, scenarioPolicySet: FIX.policySets.SCENARIO_V2_UNIQUE_TRANSACTION,
  });
  assert.equal(r.ok, true);
  const { baseline, scenario } = r.comparison;
  assert.equal(scenario.evaluation.numerator, 4);
  assert.equal(scenario.evaluation.denominator, 10);
  assert.equal(scenario.evaluation.ratio.bps, '4000');
  assert.deepEqual(scenario.contributions.uniqueTransactionIds, ['T0', 'T1', 'T2', 'T3']);
  assert.equal(scenario.evaluation.state, EVALUATION_STATE.ILLUSTRATIVE_ALERT);
  assert.equal(r.comparison.ratioDifference.bps, '-1000');
  assert.equal(r.comparison.ratioDifference.differenceFraction, '-1/10');
  assert.equal(r.comparison.numeratorDelta, -1);
  assert.notEqual(baseline.snapshotId, scenario.snapshotId);
  assert.notEqual(baseline.provenance.policySetSha256, scenario.provenance.policySetSha256);
  assert.equal(baseline.evaluation.numerator, 5, 'scenario never rewrites the baseline');
});

test('#1 exact rational threshold comparison never uses floats', () => {
  assert.equal(compareRationals(5, 10, 2500, 10000), 1);
  assert.equal(compareRationals(2, 8, 2500, 10000), 0);
  assert.equal(compareRationals(1, 8, 2500, 10000), -1);
  // 0.1+0.2 style traps: 3/10 vs 3000 bps is exactly equal.
  assert.equal(compareRationals(3, 10, 3000, 10000), 0);
  const big = Number.MAX_SAFE_INTEGER;
  assert.equal(compareRationals(big, big - 1, 10000, 10000), 1, 'float division would call this equal');
});

test('#2 duplicate D1 in one import fails; identical re-import is idempotent; conflicting re-import fails', () => {
  const dup = rawFixture();
  dup.disputes.push({ ...dup.disputes[0] });
  assert.deepEqual(codes(importObject(dup)), ['DUPLICATE_ID']);

  const again = importOk(rawFixture());
  const merged = mergeDatasets(FIX.dataset, again);
  assert.equal(merged.ok, true);
  assert.equal(merged.merge.added.length, 0);
  assert.equal(snap(merged.dataset).evaluation.numerator, 5, 'idempotent re-import never increments numerator');

  const changed = rawFixture();
  changed.disputes.find((d) => d.id === 'D1').status = 'LOST';
  assert.deepEqual(codes(mergeDatasets(FIX.dataset, importOk(changed))), ['CONFLICTING_DUPLICATE_ID']);
});

test('#2 D1+F1 on T1 are two events under v1 and one transaction under v2; shared ids across types allowed', () => {
  const s1 = snap(FIX.dataset);
  const s2 = snap(FIX.dataset, { policySet: FIX.policySets.SCENARIO_V2_UNIQUE_TRANSACTION });
  assert.equal(s1.contributions.events.filter((e) => e.transactionId === 'T1').length, 2);
  assert.equal(s2.contributions.uniqueTransactionIds.filter((t) => t === 'T1').length, 1);
  const raw = rawFixture();
  raw.fraudEvents.push({ id: 'D1', transactionId: 'T5', reportedDate: '2026-10-09', status: 'REPORTED' });
  const s = snap(importOk(raw));
  assert.equal(s.evaluation.numerator, 6, 'FRAUD:D1 and DISPUTE:D1 are distinct events');
});

test('#3 exact equality 2/8 = 2500 bps triggers; 1/8 does not', () => {
  const eq = snap(importOk(synthetic(8, 2)));
  assert.equal(eq.evaluation.ratio.bps, '2500');
  assert.equal(eq.evaluation.thresholdComparison, 'EQUAL');
  assert.equal(eq.evaluation.state, EVALUATION_STATE.ILLUSTRATIVE_ALERT);
  const below = snap(importOk(synthetic(8, 1)));
  assert.equal(below.evaluation.ratio.bps, '1250');
  assert.equal(below.evaluation.state, EVALUATION_STATE.BELOW_ILLUSTRATIVE_THRESHOLD);
});

test('#3 zero denominator with events is undefined plus investigation warning, never 0 or infinite', () => {
  const s = snap(importOk(synthetic(0, 3)));
  assert.equal(s.evaluation.state, EVALUATION_STATE.UNDEFINED_INSUFFICIENT_DENOMINATOR);
  assert.equal(s.evaluation.numerator, 3);
  assert.equal(s.evaluation.denominator, 0);
  assert.equal(s.evaluation.ratio, null);
  assert.equal(s.evaluation.thresholdComparison, null);
  assert.ok(s.warnings.some((w) => w.code === 'EVENTS_WITHOUT_SETTLED_DENOMINATOR'));
  assert.equal(ratioDisplay(3, 0), null);
});

test('#3 M2 with no data is insufficient-denominator, explicitly not all-clear', () => {
  const s = snap(FIX.dataset, { merchantId: 'M2', session: BOTH });
  assert.equal(s.evaluation.state, EVALUATION_STATE.UNDEFINED_INSUFFICIENT_DENOMINATOR);
  assert.equal(s.evaluation.ratio, null);
  assert.ok(s.warnings.some((w) => w.code === 'EMPTY_PERIOD_NOT_ALL_CLEAR'));
  assert.notEqual(s.evaluation.state, EVALUATION_STATE.BELOW_ILLUSTRATIVE_THRESHOLD);
});

test('#8 adding refunds leaves numerator 5 / denominator 10 unchanged; refunds stay operational context', () => {
  const raw = rawFixture();
  raw.refunds.push({ id: 'Q2', transactionId: 'T1', reportedDate: '2026-10-21', amountCents: 2500 });
  raw.refunds.push({ id: 'Q3', transactionId: 'T1', reportedDate: '2026-10-22', amountCents: 7500 });
  const s = snap(importOk(raw));
  assert.equal(s.evaluation.numerator, 5);
  assert.equal(s.evaluation.denominator, 10);
  assert.equal(s.money.refundTotalCents, 20000);
  assert.equal(s.money.refundTotalUsd, '200.00');
});

test('#8 v3 settled-date window is a separately named scenario with its own provenance', () => {
  const base = snap(FIX.dataset);
  const v3 = snap(FIX.dataset, { policySet: FIX.policySets.SCENARIO_V3_SETTLED_DATE_WINDOW });
  assert.deepEqual(evKeys(v3), ['DISPUTE:D1', 'DISPUTE:D2', 'DISPUTE:D4', 'FRAUD:F1', 'FRAUD:F2']);
  assert.deepEqual(v3.exclusions.events.map((e) => [e.eventId, e.reason]), [['D3', 'EVENT_OUTSIDE_WINDOW']]);
  assert.equal(v3.scenario.policySetId, 'DEMO-SCENARIO-V3');
  assert.notEqual(v3.provenance.policySetSha256, base.provenance.policySetSha256);
  assert.deepEqual(evKeys(snap(FIX.dataset)), evKeys(base), 'baseline unchanged');
});

test('#10 CSV import of the fixture yields the identical normalized dataset and snapshot', () => {
  const r = importDatasetCsv(FIX.csv);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.dataset, FIX.dataset);
  assert.equal(snap(r.dataset).snapshotId, snap(FIX.dataset).snapshotId);
  assert.equal(createSnapshot({ dataset: r.dataset, policySet: FIX.policySets.BASELINE_V1, merchantId: 'M1', period: '2026-10', session: M1 }).ok, true);
});
