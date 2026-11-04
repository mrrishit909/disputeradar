// Acceptance #7, #9 (scoping/exports), #10: immutable snapshots, late events, tenant isolation, exports, determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ENGINE_PUBLIC_API } from '../src/constants.js';
import {
  addRemediationNote, compareScenarios, createSnapshot, datasetToCsv, datasetToJson, diffSnapshots, generateDrSyn001,
  importDatasetJson, mergeDatasets, parseReportJson, queryContributions, ratioDisplay, serializeReportCsv,
  serializeReportJson, sha256Hex,
} from '../src/index.js';
import * as api from '../src/index.js';
import { parseCsv } from '../src/primitives.js';
import { BOTH, FIX, M1, codes, importOk, rawFixture, snap } from './helpers.js';

function lateFile() {
  return {
    schemaVersion: 'disputeradar.dataset.v1', dataClassification: 'SYNTHETIC',
    merchants: [{ id: 'M1', region: 'DEMO', currency: 'USD' }],
    transactions: [{ id: 'T5', merchantId: 'M1', settledDate: '2026-10-01', amountCents: 10000, status: 'SETTLED' }],
    disputes: [{ id: 'D5', transactionId: 'T5', reportedDate: '2026-10-31', category: 'cancellation', status: 'LOST' }],
    fraudEvents: [], refunds: [],
  };
}

function multiTenant() {
  const raw = rawFixture();
  raw.transactions.push({ id: 'U1', merchantId: 'M2', settledDate: '2026-10-05', amountCents: 777, status: 'SETTLED' });
  raw.transactions.push({ id: 'U2', merchantId: 'M2', settledDate: '2026-10-06', amountCents: 888, status: 'SETTLED' });
  raw.disputes.push({ id: 'SECRETM2', transactionId: 'U1', reportedDate: '2026-10-07', category: 'm2-only-category', status: 'OPEN' });
  raw.refunds.push({ id: 'QM2', transactionId: 'U2', reportedDate: '2026-10-08', amountCents: 888 });
  return importOk(raw);
}

test('#7 late-event re-import creates a new immutable snapshot with an explained delta', () => {
  const before = snap(FIX.dataset);
  const beforeId = before.snapshotId;
  const merged = mergeDatasets(FIX.dataset, importOk(lateFile()));
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.merge.added, [{ collection: 'disputes', id: 'D5' }]);
  const after = snap(merged.dataset);
  assert.equal(after.evaluation.numerator, 6);
  assert.equal(after.evaluation.ratio.bps, '6000');
  const d = diffSnapshots(before, after);
  assert.equal(d.ok, true);
  assert.equal(d.diff.numerator.delta, 1);
  assert.deepEqual(d.diff.addedEvents.map((e) => e.eventId), ['D5']);
  assert.equal(d.diff.ratioDifference.bps, '1000');
  assert.ok(d.diff.explanation.some((x) => x.includes('DISPUTE:D5')));
  assert.equal(before.snapshotId, beforeId);
  assert.equal(before.evaluation.numerator, 5);
  assert.ok(Object.isFrozen(before) && Object.isFrozen(before.evaluation) && Object.isFrozen(before.contributions.events[0]));
  assert.throws(() => { before.evaluation.numerator = 99; }, TypeError);
});

test('scenarios must be separately named; diffs require the same scope', () => {
  const same = compareScenarios({
    dataset: FIX.dataset, merchantId: 'M1', period: '2026-10', session: M1,
    baselinePolicySet: FIX.policySets.BASELINE_V1, scenarioPolicySet: FIX.policySets.BASELINE_V1,
  });
  assert.deepEqual(codes(same), ['INVALID_RULE']);
  const oct = snap(FIX.dataset);
  const nov = snap(FIX.dataset, { period: '2026-11' });
  assert.equal(nov.evaluation.state, 'UNDEFINED_INSUFFICIENT_DENOMINATOR');
  assert.deepEqual(nov.contributions.events.map((e) => e.eventId), ['D4'], 'late D4 counts in its own report month');
  assert.deepEqual(codes(diffSnapshots(oct, nov)), ['SNAPSHOT_MISMATCH']);
  const forged = { ...oct, evaluation: { ...oct.evaluation, numerator: 0 } };
  assert.deepEqual(codes(diffSnapshots(oct, forged)), ['INTEGRITY_MISMATCH']);
  assert.deepEqual(codes(queryContributions(forged, {})), ['INTEGRITY_MISMATCH']);
});

test('#7 late event needing an unimported historical transaction is rejected, not dropped', () => {
  const late = lateFile();
  late.transactions = [];
  assert.deepEqual(codes(importDatasetJson(JSON.stringify(late))), ['UNKNOWN_REFERENCE']);
});

test('#9 tenant isolation: M1 snapshot/exports never contain M2 data; wrong session denied', () => {
  const ds = multiTenant();
  const s = snap(ds);
  // Strongest isolation check: M1's report is byte-identical whatever M2's data is. Both sides are
  // imported (UNVERIFIED_USER_SUPPLIED) data; the bundled run differs only by its origin.
  const importedFixture = snap(importDatasetJson(FIX.json).dataset);
  assert.equal(s.snapshotId, importedFixture.snapshotId);
  assert.equal(serializeReportCsv(s, M1).text, serializeReportCsv(importedFixture, M1).text);
  assert.deepEqual(s.evaluation, snap(FIX.dataset).evaluation);
  assert.equal(s.evaluation.numerator, 5);
  assert.equal(s.evaluation.denominator, 10);
  assert.equal(s.money.settledGrossCents, 100000);
  const blob = JSON.stringify(s) + serializeReportJson(s, M1).text + serializeReportCsv(s, M1).text;
  for (const leak of ['U1', 'U2', 'SECRETM2', 'm2-only-category', 'QM2', '"M2"']) assert.ok(!blob.includes(leak), leak);
  const m2 = createSnapshot({ dataset: ds, policySet: FIX.policySets.BASELINE_V1, merchantId: 'M2', period: '2026-10', session: M1 });
  assert.deepEqual(codes(m2), ['ACCESS_DENIED']);
  assert.deepEqual(codes(createSnapshot({ dataset: ds, policySet: FIX.policySets.BASELINE_V1, merchantId: 'M1', period: '2026-10', session: { allowedMerchantIds: ['M2'] } })), ['ACCESS_DENIED']);
  assert.deepEqual(codes(createSnapshot({ dataset: ds, policySet: FIX.policySets.BASELINE_V1, merchantId: 'M1', period: '2026-10' })), ['MISSING_FIELD']);
  assert.deepEqual(codes(createSnapshot({ dataset: ds, policySet: FIX.policySets.BASELINE_V1, merchantId: 'M1', period: '2026-10', session: { allowedMerchantIds: ['M1'], admin: true } })), ['ACCESS_DENIED']);
  assert.deepEqual(codes(serializeReportJson(s, { allowedMerchantIds: ['M2'] })), ['ACCESS_DENIED']);
  assert.deepEqual(codes(serializeReportCsv(s, { allowedMerchantIds: ['M2'] })), ['ACCESS_DENIED']);
  const m2ok = snap(ds, { merchantId: 'M2', session: BOTH });
  assert.equal(m2ok.evaluation.numerator, 1);
  assert.equal(m2ok.evaluation.denominator, 2);
  assert.ok(!JSON.stringify(m2ok).includes('"T1"'));
});

test('#9 JSON export is the same scoped snapshot, HTML-safe, round-trips and detects tampering', () => {
  const noted = addRemediationNote(snap(FIX.dataset), { author: 'reviewer-1', recordedOn: '2026-11-02', text: '<script>alert(1)</script> & =HYPERLINK("x")' }, M1);
  assert.equal(noted.ok, true);
  const s = noted.snapshot;
  const out = serializeReportJson(s, M1);
  assert.equal(out.ok, true);
  assert.ok(!out.text.includes('<script>'));
  assert.ok(out.text.includes('\\u003cscript\\u003e'));
  const parsed = parseReportJson(out.text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.snapshot, s);
  assert.equal(parsed.snapshot.notes[0].text, '<script>alert(1)</script> & =HYPERLINK("x")', 'note stored verbatim as inert data');
  const tampered = out.text.replace('"numerator":5', '"numerator":1');
  assert.notEqual(tampered, out.text);
  assert.deepEqual(codes(parseReportJson(tampered)), ['INTEGRITY_MISMATCH']);
  assert.deepEqual(codes(parseReportJson('{"x":1}')), ['INVALID_REPORT']);
});

test('#9 CSV export escapes formula text, keeps numbers numeric and round-trips through the parser', () => {
  const base = snap(FIX.dataset);
  const noted = addRemediationNote(base, { author: 'reviewer-1', recordedOn: '2026-11-02', text: '=cmd|"/c calc"!A1' }, M1).snapshot;
  const out = serializeReportCsv(noted, M1);
  assert.equal(out.ok, true);
  assert.ok(out.text.endsWith('\r\n'));
  const parsed = parseCsv(out.text);
  assert.equal(parsed.ok, true);
  const [header, ...rows] = parsed.rows;
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const by = (type, metric) => rows.find((r) => r[col.record_type] === type && (metric === undefined || r[col.metric] === metric));
  assert.equal(by('NOTE')[col.text], `'=cmd|"/c calc"!A1`);
  assert.equal(by('SUMMARY', 'numerator')[col.count], '5');
  assert.equal(by('SUMMARY', 'denominator')[col.count], '10');
  assert.equal(by('SUMMARY', 'ratio_bps')[col.text], '5000');
  assert.equal(by('SUMMARY', 'settled_gross')[col.amount_usd], '1000.00');
  assert.equal(by('SUMMARY', 'refund_total')[col.amount_usd], '100.00');
  assert.equal(by('LABEL', 'chart_label')[col.text], 'Synthetic / illustrative rule');
  assert.equal(rows.filter((r) => r[col.record_type] === 'CONTRIBUTING_EVENT').length, 5);
  assert.deepEqual(rows.filter((r) => r[col.record_type] === 'EXCLUDED_EVENT').map((r) => [r[col.subject_id], r[col.reason]]), [['D4', 'EVENT_OUTSIDE_WINDOW']]);
  assert.ok(rows.every((r) => r[col.snapshot_id] === noted.snapshotId && r[col.merchant_id] === 'M1'));
  assert.ok(rows.some((r) => r[col.record_type] === 'LIMITATION'));
  // zero denominator exports an empty ratio, never 0/NaN/Infinity
  const empty = serializeReportCsv(snap(FIX.dataset, { merchantId: 'M2', session: BOTH }), BOTH).text;
  assert.ok(!/NaN|Infinity/.test(empty));
  assert.match(empty, /"ratio_bps","","","",""/);
});

test('notes produce a new snapshot; the original is untouched; invalid notes rejected', () => {
  const s = snap(FIX.dataset);
  const n = addRemediationNote(s, { author: 'reviewer-1', recordedOn: '2026-11-02', text: 'Follow up on T1 fulfilment.' }, M1).snapshot;
  assert.equal(n.parentSnapshotId, s.snapshotId);
  assert.notEqual(n.snapshotId, s.snapshotId);
  assert.equal(s.notes.length, 0);
  assert.deepEqual(n.evaluation, s.evaluation);
  assert.deepEqual(codes(addRemediationNote(s, { author: 'r', recordedOn: '2026-11-02', text: 'card 4111111111111111' }, M1)), ['PAN_LIKE_VALUE_REJECTED']);
  assert.deepEqual(codes(addRemediationNote(s, { author: 'r', recordedOn: '2026-11-02', text: 'x'.repeat(2001) }, M1)), ['STRING_TOO_LONG']);
  assert.deepEqual(codes(addRemediationNote(s, { author: 'r', recordedOn: 'now', text: 'x' }, M1)), ['INVALID_DATE']);
  assert.deepEqual(codes(addRemediationNote(s, { author: 'r', recordedOn: '2026-11-02', text: 'x' }, { allowedMerchantIds: ['M2'] })), ['ACCESS_DENIED']);
});

test('search/sort/filter change real results', () => {
  const s = snap(FIX.dataset);
  const q = (query) => queryContributions(s, query);
  assert.equal(q({}).total, 5);
  assert.deepEqual(q({ category: 'product-not-received' }).results.map((e) => e.eventId), ['D3', 'D1']);
  assert.deepEqual(q({ eventType: 'FRAUD' }).results.map((e) => e.eventId), ['F1', 'F2']);
  assert.deepEqual(q({ sortBy: 'reportedDate', order: 'desc' }).results.map((e) => e.eventId), ['F2', 'F1', 'D2', 'D1', 'D3']);
  assert.deepEqual(q({ transactionId: 'T1' }).results.map((e) => e.eventId), ['D1', 'F1']);
  assert.equal(q({ month: '2026-11' }).total, 0);
  assert.equal(q({ month: '2026-10' }).total, 5);
  assert.deepEqual(q({ search: 't3' }).results.map((e) => e.eventId), ['F2']);
  assert.deepEqual(codes(q({ sortBy: 'amount' })), ['INVALID_ENUM']);
  assert.deepEqual(codes(q({ evil: 1 })), ['UNKNOWN_FIELD']);
});

test('#10 determinism: row order, reimport, generator and JSON/CSV round-trips', () => {
  const raw = rawFixture();
  for (const c of ['transactions', 'disputes', 'fraudEvents', 'refunds', 'merchants']) raw[c].reverse();
  const shuffled = importDatasetJson(JSON.stringify(raw));
  const original = importDatasetJson(FIX.json);
  assert.deepEqual(shuffled.dataset, original.dataset);
  assert.equal(shuffled.provenance.datasetSha256, original.provenance.datasetSha256);
  assert.notEqual(shuffled.provenance.inputSha256, original.provenance.inputSha256);
  assert.equal(snap(shuffled.dataset).snapshotId, snap(original.dataset).snapshotId);
  assert.deepEqual(snap(shuffled.dataset).evaluation, snap(FIX.dataset).evaluation);
  assert.equal(generateDrSyn001().json, FIX.json);
  assert.equal(generateDrSyn001().csv, FIX.csv);
  assert.equal(datasetToJson(original.dataset), FIX.json);
  assert.equal(datasetToCsv(original.dataset), FIX.csv);
  assert.equal(ratioDisplay(1, 3).percent, '33.33%');
  assert.equal(ratioDisplay(2, 3).percent, '66.67%');
  assert.equal(ratioDisplay(1, 3).bps, '3333.33');
  assert.equal(ratioDisplay(1, 3).exactBps, false);
});

test('sha256Hex matches node:crypto at padding boundaries', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const s = 'é'.repeat(n % 7) + 'a'.repeat(n);
    assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), String(n));
  }
});

test('architecture: exact public API, relative-only imports, no clock/random/network/process in src', () => {
  assert.deepEqual(Object.keys(api).sort(), [...ENGINE_PUBLIC_API].sort());
  const dir = new URL('../src/', import.meta.url);
  for (const file of readdirSync(dir)) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    for (const m of text.matchAll(/from\s+'([^']+)'/g)) assert.ok(m[1].startsWith('./'), `${file}: ${m[1]}`);
    for (const banned of [/\bnew Date\b/, /\bDate\.(now|parse|UTC)\b/, /\bDate\(/, /Math\.random/, /performance\./, /Intl\./, /\bfetch\(/, /\bprocess\./, /require\(/, /import\(/, /\.localeCompare\(/, /parseFloat/, /toFixed/]) {
      assert.ok(!banned.test(text), `${file} uses ${banned}`);
    }
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
