// HIGH regression: a recomputed (unkeyed) fingerprint must never be treated as schema or authenticity.
// Forgeries are re-hashed here with an independent canonicaliser + node:crypto, not the engine's own code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CHART_LABEL, POLICY_DISCLAIMER, SYNTHETIC_LABEL, addRemediationNote, diffSnapshots, parseReportJson, queryContributions,
  serializeReportCsv, serializeReportJson,
} from '../src/index.js';
import { FIX, M1, codes, snap } from './helpers.js';

function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}

function reseal(obj) {
  const { snapshotId, ...content } = obj;
  return { snapshotId: createHash('sha256').update(canon(content)).digest('hex'), ...content };
}

const GENUINE = snap(FIX.dataset);
const NOT_EVALUATED = snap(FIX.dataset, { period: '2025-10' });
const NOTE = { author: 'analyst-1', text: 'Reviewed.', recordedOn: '2026-11-01' };

function forge(base, mutate) {
  const copy = JSON.parse(JSON.stringify(base));
  mutate(copy);
  return reseal(copy);
}

function reportText(snapshot) {
  return JSON.stringify({
    schemaVersion: 'disputeradar.report.v1', dataClassification: 'SYNTHETIC', chartLabel: CHART_LABEL,
    syntheticLabel: SYNTHETIC_LABEL, policyDisclaimer: POLICY_DISCLAIMER, snapshot,
  });
}

/** Every public report/query/note/diff API must fail safely (no throw, no success) on the forgery. */
function assertRejectedEverywhere(forged, expected = 'INVALID_REPORT') {
  const results = {
    serializeReportJson: serializeReportJson(forged, M1),
    serializeReportCsv: serializeReportCsv(forged, M1),
    parseReportJson: parseReportJson(reportText(forged)),
    queryContributions: queryContributions(forged, {}),
    addRemediationNote: addRemediationNote(forged, NOTE, M1),
    diffFrom: diffSnapshots(forged, GENUINE),
    diffTo: diffSnapshots(GENUINE, forged),
  };
  for (const [api, result] of Object.entries(results)) assert.deepEqual(codes(result), [expected], api);
}

const FORGERIES = {
  'scope=null': (s) => { s.scope = null; },
  'scope missing': (s) => { delete s.scope; },
  'scope.window mismatched to period': (s) => { s.scope.window.end = '2026-10-30'; },
  'scope.period malformed': (s) => { s.scope.period = '2026-13'; },
  'missing evaluation': (s) => { delete s.evaluation; },
  'evaluation=null': (s) => { s.evaluation = null; },
  'missing contributions': (s) => { delete s.contributions; },
  'contributions.events=null': (s) => { s.contributions.events = null; },
  'missing notes': (s) => { delete s.notes; },
  'notes not an array': (s) => { s.notes = { 0: 'x' }; },
  'notes without parent link': (s) => { s.notes = [{ author: 'a1', recordedOn: '2026-11-01', text: 'x', inert: true }]; },
  'note not inert': (s) => { s.parentSnapshotId = GENUINE.snapshotId; s.notes = [{ author: 'a1', recordedOn: '2026-11-01', text: 'x', inert: false }]; },
  'note text not a string': (s) => { s.parentSnapshotId = GENUINE.snapshotId; s.notes = [{ author: 'a1', recordedOn: '2026-11-01', text: 7, inert: true }]; },
  'missing provenance': (s) => { delete s.provenance; },
  'provenance hash malformed': (s) => { s.provenance.policySetSha256 = 'abc'; },
  'missing rule': (s) => { delete s.rule; },
  'rule not an object': (s) => { s.rule = 'DEMO-EVENT-COUNT'; },
  'rule threshold 0': (s) => { s.rule.illustrativeThresholdBps = 0; },
  'rule threshold fractional': (s) => { s.rule.illustrativeThresholdBps = 2500.5; },
  'rule unknown window field': (s) => { s.rule.windowDateField = 'WHENEVER'; },
  'rule status lists missing': (s) => { delete s.rule.includedFraudStatuses; },
  'rule region mismatch': (s) => { s.rule.region = 'OTHER'; },
  'rule id differs from requested': (s) => { s.requestedRuleId = 'OTHER-RULE'; },
  'rule does not cover period': (s) => { s.rule.effectiveFrom = '2026-10-15'; },
  'numeratorWindow shifted': (s) => { s.numeratorWindow.start = '2026-09-01'; },
  'denominatorWindow null': (s) => { s.denominatorWindow = null; },
  'numerator forged': (s) => { s.evaluation.numerator = 1; },
  'denominator negative': (s) => { s.evaluation.denominator = -1; },
  'denominator string': (s) => { s.evaluation.denominator = '10'; },
  'denominator unbounded': (s) => { s.evaluation.denominator = 1e15; },
  'ratio display forged': (s) => { s.evaluation.ratio.percent = '1.00%'; },
  'state forged': (s) => { s.evaluation.state = 'BELOW_ILLUSTRATIVE_THRESHOLD'; },
  'state unknown enum': (s) => { s.evaluation.state = 'COMPLIANT'; },
  'byType forged': (s) => { s.contributions.byType.DISPUTE += 1; },
  'byCategory count forged': (s) => { s.contributions.byCategory[0].count += 1; },
  'uniqueTransactionIds dropped': (s) => { s.contributions.uniqueTransactionIds = []; },
  'counted event dropped (counts stale)': (s) => { s.contributions.events.pop(); },
  'counted event duplicated': (s) => { s.contributions.events.push(s.contributions.events[0]); },
  'counted event outside window': (s) => { s.contributions.events[0].reportedDate = '2026-09-30'; s.contributions.events[0].windowDate = '2026-09-30'; },
  'counted event unknown status': (s) => { s.contributions.events[0].status = 'PAID'; },
  'counted event non-string id': (s) => { s.contributions.events[0].eventId = 42; },
  'unknown top-level key': (s) => { s.extra = 1; },
  'unknown nested key (scope)': (s) => { s.scope.extra = 1; },
  'unknown nested key (event)': (s) => { s.contributions.events[0].extra = 1; },
  'unknown nested key (money)': (s) => { s.money.extra = 1; },
  'sensitive-looking key': (s) => { s.cardNumber = 'x'; },
  'labels altered': (s) => { s.labels.chart = 'Visa VAMP determination'; },
  'limitations dropped': (s) => { s.limitations = []; },
  'engine contract version': (s) => { s.engineContractVersion = '9.9.9'; },
  'dataClassification': (s) => { s.dataClassification = 'PRODUCTION'; },
  'warnings removed': (s) => { s.warnings = []; },
  'refund total forged': (s) => { s.money.refundTotalCents += 1; },
  'settled gross display forged': (s) => { s.money.settledGrossUsd = '0.00'; },
  'settled gross negative': (s) => { s.money.settledGrossCents = -5; s.money.settledGrossUsd = '-0.05'; },
  'money=null on evaluated snapshot': (s) => { s.money = null; },
  'excluded transaction bad reason': (s) => { s.exclusions.transactions.push({ transactionId: 'TX-NEW', status: 'PENDING', settledDate: null, reason: 'EVENT_OUTSIDE_WINDOW' }); },
};

for (const [name, mutate] of Object.entries(FORGERIES)) {
  test(`forged snapshot with recomputed hash is rejected by every public API: ${name}`, () => {
    assertRejectedEverywhere(forge(GENUINE, mutate));
  });
}

const NOT_EVALUATED_FORGERIES = {
  'numerator invented': (s) => { s.evaluation.numerator = 3; },
  'unknown not-evaluated reason': (s) => { s.evaluation.notEvaluatedReason = 'MADE_UP'; },
  'contributions injected': (s) => { s.contributions.events = GENUINE.contributions.events; },
  'money injected': (s) => { s.money = GENUINE.money; },
  'rule injected without evaluation': (s) => { s.rule = GENUINE.rule; },
};

for (const [name, mutate] of Object.entries(NOT_EVALUATED_FORGERIES)) {
  test(`forged NOT_EVALUATED snapshot is rejected: ${name}`, () => {
    assertRejectedEverywhere(forge(NOT_EVALUATED, mutate));
  });
}

test('fabricated minimal {schemaVersion, snapshotId} with a valid recomputed hash is rejected', () => {
  assertRejectedEverywhere(reseal({ schemaVersion: 'disputeradar.snapshot.v1' }));
  assertRejectedEverywhere(reseal({ schemaVersion: 'disputeradar.snapshot.v1', scope: { merchantId: 'M1' } }));
});

test('malformed fingerprints: non-string, wrong case and stale ids fail safely', () => {
  assertRejectedEverywhere({ ...GENUINE, snapshotId: 7 });
  assertRejectedEverywhere({ ...GENUINE, snapshotId: GENUINE.snapshotId.toUpperCase() }, 'INTEGRITY_MISMATCH');
  assertRejectedEverywhere({ ...GENUINE, evaluation: { ...GENUINE.evaluation, numerator: 1 } }, 'INTEGRITY_MISMATCH');
  for (const v of [null, undefined, 'x', [], 5]) assert.deepEqual(codes(queryContributions(v, {})), ['INVALID_REPORT']);
});

test('accessor that is valid when verified and null afterwards cannot crash any API (single-read verified copy)', () => {
  const flipping = () => {
    const obj = JSON.parse(JSON.stringify(GENUINE));
    let reads = 0;
    const scope = obj.scope;
    Object.defineProperty(obj, 'scope', { enumerable: true, get: () => (reads++ === 0 ? scope : null) });
    return obj;
  };
  for (const run of [
    (s) => serializeReportJson(s, M1), (s) => serializeReportCsv(s, M1), (s) => queryContributions(s, {}),
    (s) => addRemediationNote(s, NOTE, M1), (s) => diffSnapshots(s, GENUINE), (s) => diffSnapshots(GENUINE, s),
  ]) {
    const r = run(flipping());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  }
});

test('report ingestion: wrong document labels and non-JSON-data are rejected', () => {
  const doc = JSON.parse(reportText(GENUINE));
  assert.deepEqual(codes(parseReportJson(JSON.stringify({ ...doc, syntheticLabel: 'real data' }))), ['INVALID_REPORT']);
  assert.deepEqual(codes(parseReportJson(JSON.stringify({ ...doc, policyDisclaimer: '' }))), ['INVALID_REPORT']);
  assert.deepEqual(codes(parseReportJson(JSON.stringify({ ...doc, snapshot: null }))), ['INVALID_REPORT']);
  const proto = reportText(GENUINE).replace('"snapshotId":', '"__proto__":{"polluted":true},"snapshotId":');
  assert.deepEqual(codes(parseReportJson(proto)), ['INVALID_REPORT']);
  assert.equal({}.polluted, undefined);
});

test('genuine evaluated, annotated, scenario and NOT_EVALUATED snapshots still verify everywhere', () => {
  const noted = addRemediationNote(GENUINE, NOTE, M1);
  assert.equal(noted.ok, true);
  const all = [GENUINE, NOT_EVALUATED, noted.snapshot, ...Object.values(FIX.policySets).map((policySet) => snap(FIX.dataset, { policySet }))];
  for (const s of all) {
    for (const r of [serializeReportJson(s, M1), serializeReportCsv(s, M1), queryContributions(s, {}), diffSnapshots(s, s)]) {
      assert.equal(r.ok, true, JSON.stringify(r.errors));
    }
    const parsed = parseReportJson(serializeReportJson(s, M1).text);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
    assert.equal(parsed.snapshot.snapshotId, s.snapshotId);
  }
});

test('DISCLOSED LIMITATION: a self-consistent edit with a recomputed hash is accepted (fingerprint is not authenticity)', () => {
  // Only fields that are free text and not derivable can be edited this way; derived counts cannot.
  const edited = forge(GENUINE, (s) => { s.scenario.scenarioName = 'Edited by a third party'; });
  assert.notEqual(edited.snapshotId, GENUINE.snapshotId);
  assert.equal(queryContributions(edited, {}).ok, true);
});
