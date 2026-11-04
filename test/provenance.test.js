// Data-origin provenance: only the built-in fixture OBJECT loaded through the app's fixture path earns
// BUNDLED_SYNTHETIC_DEMO. Imports, pasted text, merges/reimports, parsed reports, byte-identical copies
// and self-declared SYNTHETIC flags are UNVERIFIED_USER_SUPPLIED. Legacy v1 reports upconvert to
// UNVERIFIED. Forgeries are re-hashed with an independent canonicaliser + node:crypto.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CHART_LABEL, DATA_ORIGIN, LIMITATIONS, ORIGIN_LABELS, ORIGIN_NOTICE, POLICY_DISCLAIMER, SCHEMA_VERSIONS, SYNTHETIC_LABEL,
  addRemediationNote, compareScenarios, createSnapshot, datasetToCsv, datasetToJson, diffSnapshots, generateDrSyn001,
  importDatasetCsv, importDatasetJson, mergeDatasets, parseReportJson, queryContributions, serializeReportCsv,
  serializeReportJson, validateDataset,
} from '../src/index.js';
import { parseCsv } from '../src/primitives.js';
import { ORIGIN_IDLE_TEXT, REIMPORT_EXAMPLES, deltaRows, originBanner, summaryCards } from '../app/ui.js';
import { FIX, M1, codes, importOk, rawFixture, snap, synthetic } from './helpers.js';

const BUNDLED = DATA_ORIGIN.BUNDLED_SYNTHETIC_DEMO;
const UNVERIFIED = DATA_ORIGIN.UNVERIFIED_USER_SUPPLIED;

function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}
function reseal(obj) {
  const { snapshotId, ...content } = obj;
  return { snapshotId: createHash('sha256').update(canon(content)).digest('hex'), ...content };
}
const clone = (v) => JSON.parse(JSON.stringify(v));

function csvLabels(text) {
  const [header, ...rows] = parseCsv(text).rows;
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  return Object.fromEntries(rows.filter((r) => r[col.record_type] === 'LABEL').map((r) => [r[col.metric], r[col.text]]));
}

/** Asserts every output channel (snapshot, JSON report, CSV report) carries exactly `origin`. */
function assertOriginEverywhere(snapshot, origin, session = M1) {
  assert.equal(snapshot.dataOrigin, origin);
  assert.equal(snapshot.schemaVersion, SCHEMA_VERSIONS.SNAPSHOT);
  assert.equal(snapshot.dataClassification, undefined, 'no unconditional v1 classification on snapshots');
  assert.deepEqual(snapshot.labels, { chart: CHART_LABEL, dataOrigin: ORIGIN_LABELS[origin], originNotice: ORIGIN_NOTICE, policyDisclaimer: POLICY_DISCLAIMER });
  assert.deepEqual(snapshot.limitations, LIMITATIONS);
  const json = serializeReportJson(snapshot, session);
  assert.equal(json.ok, true, JSON.stringify(json.errors));
  const doc = JSON.parse(json.text);
  assert.equal(doc.schemaVersion, 'disputeradar.report.v2');
  assert.equal(doc.dataOrigin, origin);
  assert.equal(doc.dataOriginLabel, ORIGIN_LABELS[origin]);
  assert.equal(doc.originNotice, ORIGIN_NOTICE);
  assert.equal(doc.dataClassification, undefined);
  assert.equal(doc.syntheticLabel, undefined);
  const csv = serializeReportCsv(snapshot, session);
  assert.equal(csv.ok, true, JSON.stringify(csv.errors));
  const labels = csvLabels(csv.text);
  assert.equal(labels.report_schema_version, 'disputeradar.report-csv.v2');
  assert.equal(labels.data_origin, origin);
  assert.equal(labels.data_origin_label, ORIGIN_LABELS[origin]);
  assert.equal(labels.origin_notice, ORIGIN_NOTICE);
  assert.equal(labels.synthetic_label, undefined);
  for (const text of [json.text, csv.text]) assert.ok(!text.includes(SYNTHETIC_LABEL), 'legacy unconditional synthetic label never emitted');
  if (origin === UNVERIFIED) {
    for (const text of [json.text, csv.text]) assert.ok(!text.includes(ORIGIN_LABELS[BUNDLED]) && !text.includes(BUNDLED), 'no bundled wording on unverified data');
  }
}

// ---------- Label wording ----------
test('origin labels explicitly disclaim content inspection and real/sensitive-data detection', () => {
  assert.match(ORIGIN_NOTICE, /do not inspect content/);
  assert.match(ORIGIN_NOTICE, /cannot detect or prevent real, personal or sensitive data/);
  assert.match(ORIGIN_LABELS[UNVERIFIED], /^UNVERIFIED USER-SUPPLIED/);
  assert.match(ORIGIN_LABELS[UNVERIFIED], /may contain real or sensitive data/);
  assert.match(ORIGIN_LABELS[UNVERIFIED], /self-asserted and not verified/);
  assert.match(ORIGIN_LABELS[BUNDLED], /^BUNDLED SYNTHETIC DEMO - built-in fixture DR-SYN-001/);
  assert.ok(LIMITATIONS.some((l) => l.includes(ORIGIN_NOTICE) && /self-declared SYNTHETIC classification .* is not proof/.test(l)));
  assert.ok(!LIMITATIONS.some((l) => /^Synthetic data/.test(l)), 'no unconditional synthetic-data limitation');
});

// ---------- Bundled fixture ----------
test('bundled fixture object loaded by the fixture path earns BUNDLED_SYNTHETIC_DEMO on snapshot, JSON and CSV', () => {
  const s = snap(FIX.dataset);
  assertOriginEverywhere(s, BUNDLED);
  // Every generateDrSyn001() call (the app control's source) yields an attested bundled dataset.
  assertOriginEverywhere(snap(generateDrSyn001().dataset), BUNDLED);
  for (const policySet of Object.values(FIX.policySets)) assertOriginEverywhere(snap(FIX.dataset, { policySet }), BUNDLED);
  assertOriginEverywhere(snap(FIX.dataset, { period: '2025-10' }), BUNDLED); // NOT_EVALUATED body
  const c = compareScenarios({ dataset: FIX.dataset, merchantId: 'M1', period: '2026-10', session: M1, baselinePolicySet: FIX.policySets.BASELINE_V1, scenarioPolicySet: FIX.policySets.SCENARIO_V2_UNIQUE_TRANSACTION });
  assert.equal(c.comparison.baseline.dataOrigin, BUNDLED);
  assert.equal(c.comparison.scenario.dataOrigin, BUNDLED);
  // An inert note on a bundled snapshot keeps the (attested) bundled origin and stays exportable.
  const noted = addRemediationNote(s, { author: 'reviewer-1', recordedOn: '2026-11-02', text: 'ok' }, M1);
  assert.equal(noted.ok, true, JSON.stringify(noted.errors));
  assertOriginEverywhere(noted.snapshot, BUNDLED);
  const twice = addRemediationNote(noted.snapshot, { author: 'reviewer-1', recordedOn: '2026-11-03', text: 'again' }, M1);
  assertOriginEverywhere(twice.snapshot, BUNDLED);
});

// ---------- Arbitrary local JSON / CSV imports ----------
test('arbitrary local JSON and CSV imports are UNVERIFIED everywhere, despite declaring SYNTHETIC', () => {
  const raw = synthetic(8, 3);
  assert.equal(raw.dataClassification, 'SYNTHETIC', 'the file self-declares SYNTHETIC');
  const fromJson = importDatasetJson(JSON.stringify(raw));
  assert.equal(fromJson.ok, true);
  assert.equal(fromJson.provenance.dataOrigin, UNVERIFIED);
  assert.equal(fromJson.provenance.declaredDataClassification, 'SYNTHETIC');
  assert.equal(fromJson.provenance.dataClassification, undefined, 'classification is reported as a claim only');
  assert.match(fromJson.provenance.note, /self-asserted .* not verified/);
  assertOriginEverywhere(snap(fromJson.dataset), UNVERIFIED);
  const fromCsv = importDatasetCsv(datasetToCsv(fromJson.dataset));
  assert.equal(fromCsv.ok, true);
  assert.equal(fromCsv.provenance.dataOrigin, UNVERIFIED);
  assertOriginEverywhere(snap(fromCsv.dataset), UNVERIFIED);
  // Calculations are unchanged by the origin label.
  assert.equal(snap(fromJson.dataset).evaluation.numerator, 3);
  assert.equal(snap(fromJson.dataset).evaluation.denominator, 8);
  // Uint8Array upload path too.
  const bytes = importDatasetJson(new TextEncoder().encode(JSON.stringify(raw)));
  assertOriginEverywhere(snap(bytes.dataset), UNVERIFIED);
});

// ---------- Spoofing ----------
test('spoofing: byte-identical fixture JSON/CSV, normalized copies, clones and proxies stay UNVERIFIED', () => {
  const bundled = snap(FIX.dataset);
  const candidates = {
    'fixture JSON bytes': importDatasetJson(FIX.json).dataset,
    'fixture CSV bytes': importDatasetCsv(FIX.csv).dataset,
    'canonical re-export of fixture': importDatasetJson(datasetToJson(FIX.dataset)).dataset,
    'validateDataset normalized copy': validateDataset(FIX.dataset).dataset,
    'structured clone': structuredClone(FIX.dataset),
    'JSON clone': clone(FIX.dataset),
    'plain mutable fixture copy': rawFixture(),
  };
  for (const [name, dataset] of Object.entries(candidates)) {
    assert.deepEqual(validateDataset(dataset).dataset, FIX.dataset, `${name}: same content`);
    const s = snap(dataset);
    assert.equal(s.dataOrigin, UNVERIFIED, name);
    assert.notEqual(s.snapshotId, bundled.snapshotId, `${name}: content match never collides with the bundled snapshot id`);
    assert.deepEqual(s.evaluation, bundled.evaluation, `${name}: identical calculations`);
    assertOriginEverywhere(s, UNVERIFIED);
  }
  const proxied = createSnapshot({ dataset: new Proxy(FIX.dataset, {}), policySet: FIX.policySets.BASELINE_V1, merchantId: 'M1', period: '2026-10', session: M1 });
  assert.ok(!proxied.ok || proxied.snapshot.dataOrigin === UNVERIFIED, 'a Proxy around the fixture is not the fixture');
});

test('spoofing: self-asserted origin fields in input files are rejected by the unchanged input schema', () => {
  const raw = rawFixture();
  assert.deepEqual(codes(importDatasetJson(JSON.stringify({ ...raw, dataOrigin: BUNDLED }))), ['UNKNOWN_FIELD']);
  assert.deepEqual(codes(importDatasetJson(JSON.stringify({ ...raw, fixtureId: 'DR-SYN-001' }))), ['UNKNOWN_FIELD']);
  const [header, ...rest] = FIX.csv.split('\r\n');
  const csv = [`${header},"data_origin"`, ...rest.filter(Boolean).map((l) => `${l},"${BUNDLED}"`), ''].join('\r\n');
  assert.ok(codes(importDatasetCsv(csv)).includes('UNKNOWN_COLUMN'));
  // A filename such as "DR-SYN-001.json" is never an input to the engine; content alone stays UNVERIFIED.
  assert.equal(snap(importDatasetJson(FIX.json).dataset).dataOrigin, UNVERIFIED);
});

test('spoofing: getter on options.dataset is read once, so origin and evaluated data cannot diverge', () => {
  const altered = rawFixture();
  altered.disputes = altered.disputes.filter((d) => d.id !== 'D1');
  let reads = 0;
  const options = { policySet: FIX.policySets.BASELINE_V1, merchantId: 'M1', period: '2026-10', session: M1 };
  Object.defineProperty(options, 'dataset', { enumerable: true, get: () => (reads++ === 0 ? FIX.dataset : altered) });
  const r = createSnapshot(options);
  assert.equal(r.ok, true);
  assert.equal(reads, 1);
  assert.equal(r.snapshot.dataOrigin, BUNDLED);
  assert.deepEqual(r.snapshot.evaluation, snap(FIX.dataset).evaluation, 'bundled origin only with bundled data');
});

test('spoofing: a structurally valid snapshot relabelled BUNDLED is refused by every in-process API', () => {
  const relabel = (s) => reseal({ ...clone(s), dataOrigin: BUNDLED, labels: { ...s.labels, dataOrigin: ORIGIN_LABELS[BUNDLED] } });
  // Relabelling imported fixture-identical data reproduces, byte for byte, the snapshot this process
  // genuinely minted from the bundled fixture (content-addressed id), so nothing new is granted.
  assert.equal(relabel(snap(importOk(rawFixture()))).snapshotId, snap(FIX.dataset).snapshotId);
  const unverified = snap(importOk(synthetic(8, 3)));
  const forged = relabel(unverified);
  for (const r of [
    serializeReportJson(forged, M1), serializeReportCsv(forged, M1), queryContributions(forged, {}),
    addRemediationNote(forged, { author: 'a1', recordedOn: '2026-11-01', text: 'x' }, M1),
    diffSnapshots(forged, unverified), diffSnapshots(unverified, forged),
  ]) assert.deepEqual(codes(r), ['ORIGIN_NOT_ATTESTED']);
  // Reading the forged report as a file is allowed, but its effective origin is UNVERIFIED and the
  // returned snapshot cannot be re-exported with the bundled label.
  const doc = { schemaVersion: 'disputeradar.report.v2', dataOrigin: BUNDLED, dataOriginLabel: ORIGIN_LABELS[BUNDLED], originNotice: ORIGIN_NOTICE, chartLabel: CHART_LABEL, policyDisclaimer: POLICY_DISCLAIMER, snapshot: forged };
  const parsed = parseReportJson(JSON.stringify(doc));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.origin.effective, UNVERIFIED);
  assert.equal(parsed.origin.assertedDataOrigin, BUNDLED);
  assert.equal(parsed.origin.label, ORIGIN_LABELS[UNVERIFIED]);
  assert.deepEqual(codes(serializeReportJson(parsed.snapshot, M1)), ['ORIGIN_NOT_ATTESTED']);
});

test('report v2 envelope: origin must match the snapshot; labels exact; parsed origin is always UNVERIFIED', () => {
  const bundled = snap(FIX.dataset);
  const text = serializeReportJson(bundled, M1).text;
  const parsed = parseReportJson(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.snapshotId, bundled.snapshotId);
  assert.equal(parsed.origin.effective, UNVERIFIED, 'a report file is user-supplied even when it is our own export');
  assert.equal(parsed.origin.assertedDataOrigin, BUNDLED);
  assert.equal(parsed.origin.legacySnapshotId, null);
  const doc = JSON.parse(text);
  const unverifiedDoc = JSON.parse(serializeReportJson(snap(importOk(rawFixture())), M1).text);
  for (const bad of [
    { ...doc, dataOrigin: UNVERIFIED, dataOriginLabel: ORIGIN_LABELS[UNVERIFIED] },
    { ...unverifiedDoc, dataOrigin: BUNDLED, dataOriginLabel: ORIGIN_LABELS[BUNDLED] },
    { ...doc, dataOriginLabel: ORIGIN_LABELS[UNVERIFIED] },
    { ...doc, dataOrigin: 'SYNTHETIC' },
    { ...doc, originNotice: 'Verified synthetic.' },
    { ...doc, dataClassification: 'SYNTHETIC' },
    { ...doc, syntheticLabel: SYNTHETIC_LABEL },
    { ...doc, schemaVersion: 'disputeradar.report.v3' },
  ]) assert.deepEqual(codes(parseReportJson(JSON.stringify(bad))), ['INVALID_REPORT']);
  const { originNotice, ...missing } = doc;
  assert.ok(originNotice);
  assert.deepEqual(codes(parseReportJson(JSON.stringify(missing))), ['INVALID_REPORT']);
});

// ---------- Merges / reimports ----------
test('merges and reimports are UNVERIFIED, including idempotent no-op merges of the fixture with itself', () => {
  const before = snap(FIX.dataset);
  const self = mergeDatasets(FIX.dataset, FIX.dataset);
  assert.equal(self.ok, true);
  assert.equal(self.merge.added.length, 0);
  const noop = snap(self.dataset);
  assert.equal(noop.dataOrigin, UNVERIFIED, 'identical content after a merge is still unverified');
  assert.deepEqual(noop.evaluation, before.evaluation);
  const d0 = diffSnapshots(before, noop);
  assert.deepEqual(d0.diff.dataOrigin, { from: BUNDLED, to: UNVERIFIED });
  assert.deepEqual(d0.diff.explanation, [], 'origin change is reported separately from data/event changes');
  const rows0 = deltaRows(d0.diff, before, noop, self.merge);
  assert.ok(rows0.some((r) => r.startsWith('No counted event or scoped data changed')));
  assert.ok(rows0.includes(`Data origin ${BUNDLED} → ${UNVERIFIED}: merged or imported data is always UNVERIFIED USER-SUPPLIED, even when identical to the built-in fixture or declared SYNTHETIC.`));

  for (const [format, text] of [['JSON', REIMPORT_EXAMPLES.valid], ['CSV', datasetToCsv(importDatasetJson(REIMPORT_EXAMPLES.valid).dataset)]]) {
    const imp = format === 'JSON' ? importDatasetJson(text) : importDatasetCsv(text);
    assert.equal(imp.ok, true, format);
    const merged = mergeDatasets(FIX.dataset, imp.dataset);
    const after = snap(merged.dataset);
    assertOriginEverywhere(after, UNVERIFIED);
    assert.equal(after.evaluation.numerator, 6, `${format}: late event still counted`);
    const again = snap(mergeDatasets(merged.dataset, imp.dataset).dataset);
    assert.equal(again.dataOrigin, UNVERIFIED, `${format}: reimport of the same file stays unverified`);
    assert.equal(again.snapshotId, after.snapshotId);
    // Merging bundled fixture data back in never restores the bundled origin.
    assert.equal(snap(mergeDatasets(merged.dataset, FIX.dataset).dataset).dataOrigin, UNVERIFIED);
    assert.equal(snap(mergeDatasets(imp.dataset, FIX.dataset).dataset).dataOrigin, UNVERIFIED);
  }
  // compareScenarios on merged data: both sides unverified.
  const merged = mergeDatasets(FIX.dataset, importDatasetJson(REIMPORT_EXAMPLES.valid).dataset).dataset;
  const c = compareScenarios({ dataset: merged, merchantId: 'M1', period: '2026-10', session: M1, baselinePolicySet: FIX.policySets.BASELINE_V1, scenarioPolicySet: FIX.policySets.SCENARIO_V3_SETTLED_DATE_WINDOW });
  assert.equal(c.comparison.baseline.dataOrigin, UNVERIFIED);
  assert.equal(c.comparison.scenario.dataOrigin, UNVERIFIED);
});

// ---------- UI ----------
test('UI: origin banner follows the snapshot origin; page has no unconditional synthetic data label', () => {
  const b = originBanner(snap(FIX.dataset));
  assert.deepEqual(b, { kind: BUNDLED, label: ORIGIN_LABELS[BUNDLED], notice: ORIGIN_NOTICE });
  const u = originBanner(snap(importDatasetJson(FIX.json).dataset));
  assert.deepEqual(u, { kind: UNVERIFIED, label: ORIGIN_LABELS[UNVERIFIED], notice: ORIGIN_NOTICE });
  assert.equal(summaryCards(snap(FIX.dataset)).length, 6, 'summary cards unchanged');

  const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('id="synthetic-label"'));
  assert.ok(html.includes(`<p class="label" id="origin-label" role="status" aria-live="polite">${ORIGIN_IDLE_TEXT}</p>`));
  assert.ok(html.includes(`<p class="muted" id="origin-notice">${ORIGIN_NOTICE}</p>`), 'static notice matches the engine notice');
  assert.match(html, /Any accepted import makes the snapshot UNVERIFIED USER-SUPPLIED/);
  assert.doesNotMatch(html, /Paste a synthetic|Synthetic dataset addition|synthetic workbench/i);

  const app = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.ok(!app.includes('SYNTHETIC_LABEL'), 'app never applies the legacy unconditional label');
  assert.match(app, /setText\('origin-label', origin\.label\)/);
  assert.match(app, /setText\('origin-notice', ORIGIN_NOTICE\)/);
  // The only place the app hands the engine the fixture object is the Run control (bundled path).
  assert.equal((app.match(/fixture\.dataset/g) || []).length, 2, 'initial value + run() reset only');
  assert.match(app, /function run\(\) \{\n(?:.*\n){0,4} {2}workingDataset = fixture\.dataset;\n/);
  assert.match(app, /workingDataset = merged\.dataset;/, 'reimport switches to merged (unverified) data');
});

// ---------- Backward compatibility: legacy v1 reports ----------
// Exact v1 wire format (from the v1 source): unconditional SYNTHETIC classification and label.
const V1_LIMITATIONS = [
  'Synthetic data and fictional illustrative rules only; not a network, acquirer or processor monitoring determination.',
  'Results cover only imported records. Network-reported events absent from merchant exports are not represented; completeness is not verified.',
  'Ratios are exact rationals; percent/bps decimals are display-only and rounded half-up.',
  'No historical threshold inference, no FX conversion, no automatic refunds, dispute submissions or merchant notifications.',
  'Refunds are operational context and never remove counted events.',
  'Snapshot hashes are unkeyed integrity fingerprints, not signatures or proof of authorship.',
];
const V1_SYNTHETIC_LABEL = 'SYNTHETIC DEMO DATA - fictional merchants, transactions and events; illustrative rule only.';

function toV1Snapshot(v2, mutate = () => {}) {
  const { snapshotId, dataOrigin, ...rest } = clone(v2);
  const v1 = {
    ...rest,
    schemaVersion: 'disputeradar.snapshot.v1',
    dataClassification: 'SYNTHETIC',
    labels: { chart: CHART_LABEL, synthetic: V1_SYNTHETIC_LABEL, policyDisclaimer: POLICY_DISCLAIMER },
    limitations: V1_LIMITATIONS,
  };
  mutate(v1);
  return reseal(v1);
}
function v1Report(snapshot, envelope = {}) {
  return JSON.stringify({
    schemaVersion: 'disputeradar.report.v1', dataClassification: 'SYNTHETIC', chartLabel: CHART_LABEL,
    syntheticLabel: V1_SYNTHETIC_LABEL, policyDisclaimer: POLICY_DISCLAIMER, snapshot, ...envelope,
  });
}

test('legacy v1 reports are read and upconverted to UNVERIFIED; v1 SYNTHETIC fields are not trusted', () => {
  const bundled = snap(FIX.dataset);
  const noted = addRemediationNote(bundled, { author: 'reviewer-1', recordedOn: '2026-11-02', text: '=legacy <note>' }, M1).snapshot;
  const notEvaluated = snap(FIX.dataset, { period: '2025-10' });
  for (const source of [bundled, noted, notEvaluated, snap(importOk(synthetic(8, 2)))]) {
    const v1 = toV1Snapshot(source);
    const parsed = parseReportJson(v1Report(v1));
    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
    const up = parsed.snapshot;
    assert.equal(parsed.origin.effective, UNVERIFIED);
    assert.equal(parsed.origin.reportSchemaVersion, 'disputeradar.report.v1');
    assert.equal(parsed.origin.assertedDataOrigin, null, 'v1 never asserted an origin; its SYNTHETIC flag is discarded');
    assert.equal(parsed.origin.legacySnapshotId, v1.snapshotId);
    assert.notEqual(up.snapshotId, v1.snapshotId, 'upconversion yields a new content id');
    assert.equal(Object.isFrozen(up), true);
    for (const k of ['scenario', 'scope', 'requestedRuleId', 'provenance', 'parentSnapshotId', 'notes', 'rule', 'evaluation', 'numeratorWindow', 'denominatorWindow', 'contributions', 'exclusions', 'money', 'warnings']) {
      assert.deepEqual(up[k], source[k], `business content preserved: ${k}`);
    }
    // The upconverted snapshot is a first-class v2 snapshot labelled UNVERIFIED on every channel.
    assertOriginEverywhere(up, UNVERIFIED);
    assert.equal(queryContributions(up, {}).ok, true);
    assert.equal(diffSnapshots(source, up).ok, true);
    assert.deepEqual(diffSnapshots(source, up).diff.dataOrigin, { from: source.dataOrigin, to: UNVERIFIED });
    // Re-reading our own v2 export of the upconverted snapshot is stable.
    const again = parseReportJson(serializeReportJson(up, M1).text);
    assert.equal(again.snapshot.snapshotId, up.snapshotId);
    assert.equal(again.origin.assertedDataOrigin, UNVERIFIED);
  }
});

test('legacy v1 reports: tampering, altered v1 labels and smuggled origin claims are rejected', () => {
  const bundled = snap(FIX.dataset);
  const v1 = toV1Snapshot(bundled);
  const text = v1Report(v1);
  assert.deepEqual(codes(parseReportJson(text.replace('"numerator":5', '"numerator":1'))), ['INTEGRITY_MISMATCH']);
  for (const [name, bad] of Object.entries({
    'forged count resealed': toV1Snapshot(bundled, (s) => { s.evaluation.numerator = 1; }),
    'v1 label altered': toV1Snapshot(bundled, (s) => { s.labels.synthetic = 'VERIFIED SYNTHETIC'; }),
    'v1 classification altered': toV1Snapshot(bundled, (s) => { s.dataClassification = 'PRODUCTION'; }),
    'v1 limitations dropped': toV1Snapshot(bundled, (s) => { s.limitations = []; }),
    'bundled origin smuggled into v1': toV1Snapshot(bundled, (s) => { s.dataOrigin = BUNDLED; }),
    'v2 snapshot in v1 envelope': bundled,
  })) assert.deepEqual(codes(parseReportJson(v1Report(bad))), ['INVALID_REPORT'], name);
  assert.deepEqual(codes(parseReportJson(v1Report(v1, { dataClassification: 'PRODUCTION' }))), ['INVALID_REPORT']);
  assert.deepEqual(codes(parseReportJson(v1Report(v1, { syntheticLabel: 'x' }))), ['INVALID_REPORT']);
  assert.deepEqual(codes(parseReportJson(v1Report(v1, { dataOrigin: BUNDLED }))), ['INVALID_REPORT']);
  // A v1 snapshot is not accepted directly by v2 APIs or inside a v2 envelope.
  assert.deepEqual(codes(queryContributions(v1, {})), ['INVALID_REPORT']);
  const v2env = { schemaVersion: 'disputeradar.report.v2', dataOrigin: UNVERIFIED, dataOriginLabel: ORIGIN_LABELS[UNVERIFIED], originNotice: ORIGIN_NOTICE, chartLabel: CHART_LABEL, policyDisclaimer: POLICY_DISCLAIMER, snapshot: v1 };
  assert.deepEqual(codes(parseReportJson(JSON.stringify(v2env))), ['INVALID_REPORT']);
});
