// Acceptance #4, #5, #6, #9 (input side): dates, rules, money, references, bounds, shapes, PAN/CVV/secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  IMPORT_LIMITS, createSnapshot, importDatasetCsv, importDatasetJson, validateDataset, validatePolicySet,
} from '../src/index.js';
import { FIX, M1, codes, importObject, importOk, policy, rawFixture, rule, snap } from './helpers.js';

const mutate = (fn) => { const raw = rawFixture(); fn(raw); return importObject(raw); };
const disputeD1 = (raw) => raw.disputes.find((d) => d.id === 'D1');

test('#4 strict calendar dates: invalid and ambiguous forms are rejected', () => {
  for (const bad of ['2026-10-1', '2026-10-01T00:00Z', '2026-10-01 ', '2026-02-29', '2026-13-01', '10/01/2026', '2026-1-01', 20261001, '']) {
    assert.ok(codes(mutate((raw) => { disputeD1(raw).reportedDate = bad; })).includes('INVALID_DATE'), String(bad));
  }
  assert.equal(mutate((raw) => { raw.transactions.find((t) => t.id === 'T6').settledDate = '2028-02-29'; }).ok, true, 'leap day 2028 valid');
});

test('#4 window boundaries: 09-30 and 11-01 excluded, 10-01 and 10-31 included', () => {
  const s = snap(FIX.dataset);
  const counted = Object.fromEntries(s.contributions.events.map((e) => [e.eventId, e.reportedDate]));
  assert.equal(counted.D3, '2026-10-01');
  assert.equal(counted.F2, '2026-10-31');
  assert.equal(s.exclusions.events[0].reportedDate, '2026-11-01');
  assert.equal(s.exclusions.transactions.find((t) => t.transactionId === 'T0').settledDate, '2026-09-30');
});

test('#4 host timezone cannot move day-boundary events (child processes in extreme zones)', () => {
  const script = fileURLToPath(new URL('./tz-probe.js', import.meta.url));
  const outputs = ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'].map((TZ) => {
    const r = spawnSync(process.execPath, [script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  });
  assert.equal(new Set(outputs).size, 1);
  assert.equal(JSON.parse(outputs[0]).numerator, 5);
});

test('#4 end-before-start, overlapping versions and duplicate versions are rejected', () => {
  assert.deepEqual(codes(validatePolicySet(policy([rule({ effectiveFrom: '2026-10-31', effectiveTo: '2026-10-01' })]))),
    ['RULE_INTERVAL_END_BEFORE_START']);
  assert.deepEqual(codes(validatePolicySet(policy([rule(), rule({ version: 2, effectiveFrom: '2026-06-01', effectiveTo: null })]))),
    ['RULE_VERSION_OVERLAP']);
  assert.deepEqual(codes(validatePolicySet(policy([rule(), rule({ effectiveFrom: '2027-01-01', effectiveTo: null })]))),
    ['DUPLICATE_RULE_VERSION']);
  // Different region scopes may share dates.
  assert.equal(validatePolicySet(policy([rule(), rule({ version: 2, region: 'OTHER' })])).ok, true);
  assert.equal(validatePolicySet(policy([rule({ effectiveTo: '2026-09-30' }), rule({ version: 2, effectiveFrom: '2026-10-01', effectiveTo: null })])).ok, true);
});

test('#4 absent, partial and region-mismatched coverage are NOT_EVALUATED, never a ratio', () => {
  const run = (rules, period = '2026-10') => snap(FIX.dataset, { policySet: policy(rules), period });
  const none = run([rule()], '2027-01');
  assert.equal(none.evaluation.state, 'NOT_EVALUATED');
  assert.equal(none.evaluation.notEvaluatedReason, 'NO_RULE_COVERAGE');
  assert.equal(none.evaluation.numerator, null);
  const partial = run([rule({ effectiveTo: '2026-10-15' })]);
  assert.equal(partial.evaluation.notEvaluatedReason, 'PARTIAL_RULE_COVERAGE');
  const split = run([rule({ effectiveTo: '2026-10-15' }), rule({ version: 2, effectiveFrom: '2026-10-16', effectiveTo: null })]);
  assert.equal(split.evaluation.notEvaluatedReason, 'PARTIAL_RULE_COVERAGE');
  const region = run([rule({ region: 'EU' })]);
  assert.equal(region.evaluation.notEvaluatedReason, 'RULE_REGION_MISMATCH');
  assert.equal(region.evaluation.ratio, null);
});

test('#7 missing/unknown/duplicate status policy lists mean not evaluated, never implicit exclusion', () => {
  const noList = rule();
  delete noList.includedFraudStatuses;
  for (const bad of [noList, rule({ includedDisputeStatuses: ['OPEN', 'CLOSED'] }), rule({ includedFraudStatuses: ['REPORTED', 'REPORTED'] }),
    rule({ includedDisputeStatuses: 'OPEN' })]) {
    const r = createSnapshot({ dataset: FIX.dataset, policySet: policy([bad]), merchantId: 'M1', period: '2026-10', session: M1 });
    assert.equal(r.ok, false);
    assert.equal(r.evaluationState, 'NOT_EVALUATED');
    assert.equal(r.notEvaluatedReason, 'INVALID_RULE_POLICY');
  }
  // An explicit narrower list is honoured and every exclusion is reported with its reason.
  const s = snap(FIX.dataset, { policySet: policy([rule({ includedDisputeStatuses: ['OPEN', 'WON', 'LOST'], includedFraudStatuses: ['REPORTED'] })]) });
  assert.equal(s.evaluation.numerator, 3);
  assert.deepEqual(s.exclusions.events.filter((e) => e.reason === 'STATUS_NOT_INCLUDED_BY_RULE').map((e) => e.eventId).sort(), ['D3', 'F2']);
  assert.ok(s.warnings.some((w) => w.code === 'EVENTS_EXCLUDED_BY_STATUS_POLICY'));
});

test('#5 money: negative, zero, fractional, string, unsafe and huge amounts are rejected', () => {
  for (const [bad, code] of [[-100, 'AMOUNT_OUT_OF_RANGE'], [0, 'AMOUNT_OUT_OF_RANGE'], [100.5, 'INVALID_AMOUNT'], ['10000', 'INVALID_AMOUNT'],
    [2 ** 53, 'INVALID_AMOUNT'], [1_000_000_001, 'AMOUNT_OUT_OF_RANGE'], [null, 'INVALID_AMOUNT']]) {
    assert.deepEqual(codes(mutate((raw) => { raw.transactions.find((t) => t.id === 'T5').amountCents = bad; })), [code], String(bad));
  }
});

test('#5 unsupported currency rejected; no FX', () => {
  assert.deepEqual(codes(mutate((raw) => { raw.merchants[0].currency = 'EUR'; })), ['UNSUPPORTED_CURRENCY']);
});

test('#5 refunds: cumulative partials up to the amount pass; one cent over fails', () => {
  assert.equal(mutate((raw) => {
    raw.refunds.push({ id: 'Q2', transactionId: 'T3', reportedDate: '2026-10-05', amountCents: 4000 });
    raw.refunds.push({ id: 'Q3', transactionId: 'T3', reportedDate: '2026-10-06', amountCents: 6000 });
  }).ok, true);
  assert.deepEqual(codes(mutate((raw) => {
    raw.refunds.push({ id: 'Q2', transactionId: 'T2', reportedDate: '2026-10-21', amountCents: 1 });
  })), ['REFUND_EXCEEDS_TRANSACTION']);
  assert.deepEqual(codes(mutate((raw) => { raw.refunds[0].amountCents = 10001; })), ['REFUND_EXCEEDS_TRANSACTION']);
});

test('#6 missing transaction reference rejects (D3 needs historical T0); cross-merchant references reject', () => {
  const r = mutate((raw) => { raw.transactions = raw.transactions.filter((t) => t.id !== 'T0'); });
  assert.deepEqual(codes(r), ['UNKNOWN_REFERENCE']);
  assert.equal(r.errors[0].path, '/disputes/2/transactionId');
  // T0 moved to unknown merchant M9: T0 itself is an unknown reference and D3 (merchantId M1) now crosses merchants.
  assert.deepEqual(codes(mutate((raw) => { raw.transactions[0].merchantId = 'M9'; })), ['CROSS_MERCHANT_REFERENCE', 'UNKNOWN_REFERENCE']);
  assert.deepEqual(codes(mutate((raw) => { raw.transactions.find((t) => t.id === 'T6').merchantId = 'M9'; })), ['UNKNOWN_REFERENCE']);
  assert.deepEqual(codes(mutate((raw) => { disputeD1(raw).merchantId = 'M2'; })), ['CROSS_MERCHANT_REFERENCE']);
  assert.deepEqual(codes(mutate((raw) => { raw.refunds[0].merchantId = 'M2'; })), ['CROSS_MERCHANT_REFERENCE']);
});

test('status enums and SETTLED date rule', () => {
  assert.deepEqual(codes(mutate((raw) => { raw.transactions[0].status = 'settled'; })), ['INVALID_ENUM']);
  assert.deepEqual(codes(mutate((raw) => { disputeD1(raw).status = 'CLOSED'; })), ['INVALID_ENUM']);
  assert.deepEqual(codes(mutate((raw) => { raw.fraudEvents[0].status = 'CONFIRMED'; })), ['INVALID_ENUM']);
  assert.deepEqual(codes(mutate((raw) => { raw.transactions.find((t) => t.id === 'T5').settledDate = null; })), ['SETTLED_DATE_REQUIRED']);
  assert.deepEqual(codes(mutate((raw) => { disputeD1(raw).reportedDate = '2026-09-15'; })), ['INVALID_DATE'], 'reported before sale');
  // VOID with a historical October date never enters the denominator.
  const s = snap(importOk((() => { const raw = rawFixture(); raw.transactions.find((t) => t.id === 'T11').status = 'VOID'; raw.transactions.find((t) => t.id === 'T11').settledDate = '2026-10-02'; return raw; })()));
  assert.equal(s.evaluation.denominator, 10);
});

test('deeply invalid shapes and prototype keys are rejected without pollution', () => {
  for (const bad of [null, [], 'x', 42, { ...rawFixture(), merchants: {} }]) assert.equal(validateDataset(bad).ok, false);
  const proto = '{"__proto__":{"polluted":true},"schemaVersion":"disputeradar.dataset.v1"}';
  assert.ok(codes(importDatasetJson(proto)).includes('UNKNOWN_FIELD'));
  const nested = rawFixture();
  nested.transactions[0] = JSON.parse('{"__proto__":{"polluted":1},"id":"T1","merchantId":"M1","settledDate":"2026-10-01","amountCents":10000,"status":"SETTLED"}');
  assert.ok(codes(importObject(nested)).includes('UNKNOWN_FIELD'));
  assert.ok(codes(mutate((raw) => { raw.transactions[0].constructor = 'x'; })).includes('UNKNOWN_FIELD'));
  assert.ok(codes(mutate((raw) => { raw.disputes[0] = [1, 2]; })).includes('INVALID_TYPE'));
  assert.ok(codes(mutate((raw) => { raw.disputes[0].id = { $gt: '' }; })).includes('INVALID_TYPE'));
  assert.ok(codes(mutate((raw) => { raw.extra = 1; })).includes('UNKNOWN_FIELD'));
  assert.deepEqual(codes(mutate((raw) => { raw.schemaVersion = 'v0'; })), ['UNSUPPORTED_SCHEMA_VERSION']);
  assert.deepEqual(codes(mutate((raw) => { raw.dataClassification = 'PRODUCTION'; })), ['UNSUPPORTED_CLASSIFICATION']);
  assert.deepEqual(codes(importDatasetJson('{"a":')), ['MALFORMED_JSON']);
  assert.deepEqual(codes(importDatasetJson(new Uint8Array([0x7b, 0xff, 0x7d]))), ['INVALID_UTF8']);
  // Deep nesting inside a field and unterminated deep nesting are bounded failures, not crashes.
  assert.deepEqual(codes(importDatasetJson(`{"schemaVersion":${'['.repeat(100_000)}${']'.repeat(100_000)}}`)).slice(0, 1), ['MISSING_FIELD']);
  assert.deepEqual(codes(importDatasetJson('['.repeat(500_000))), ['MALFORMED_JSON']);
  // Policy sets get the same own-key discipline.
  assert.ok(codes(validatePolicySet(JSON.parse('{"__proto__":{"x":1},"schemaVersion":"disputeradar.policy-set.v1","policySetId":"P","scenarioName":"n","rules":[]}'))).includes('UNKNOWN_FIELD'));
  assert.ok(codes(validatePolicySet(policy([{ ...rule(), extra: true }]))).includes('UNKNOWN_FIELD'));
  assert.ok(codes(validatePolicySet(policy([rule({ illustrativeThresholdBps: 2500.5 })]))).includes('INVALID_RULE'));
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).x, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('#9 CSV cells with PAN-like values are rejected and never echoed', () => {
  const pan = '4111111111111111';
  const csv = FIX.csv.replace('"product-not-received"', `"${pan}"`);
  const r = importDatasetCsv(csv);
  assert.deepEqual(codes(r), ['PAN_LIKE_VALUE_REJECTED']);
  assert.match(r.errors[0].path, /^\/csv\/row\/[0-9]+\/category$/);
  assert.ok(!JSON.stringify(r).includes(pan));
});

test('#9 bounds: 1 MiB accepted at the limit and rejected one byte over; 5000 rows ok, 5001 rejected', () => {
  const json = FIX.json.trimEnd();
  const atLimit = json + ' '.repeat(IMPORT_LIMITS.MAX_UPLOAD_BYTES - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(atLimit), 1_048_576);
  assert.equal(importDatasetJson(atLimit).ok, true);
  assert.deepEqual(codes(importDatasetJson(`${atLimit} `)), ['INPUT_TOO_LARGE']);
  assert.deepEqual(codes(importDatasetJson(new TextEncoder().encode(`${atLimit} `))), ['INPUT_TOO_LARGE']);
  // multibyte: under 1 MiB characters but over 1 MiB bytes
  assert.deepEqual(codes(importDatasetJson(`"${'é'.repeat(600_000)}"`)), ['INPUT_TOO_LARGE']);
  const rows = (n) => {
    const raw = { schemaVersion: 'disputeradar.dataset.v1', dataClassification: 'SYNTHETIC', merchants: [{ id: 'M1', region: 'DEMO', currency: 'USD' }], transactions: [], disputes: [], fraudEvents: [], refunds: [] };
    for (let i = 1; i < n; i += 1) raw.transactions.push({ id: `T${i}`, merchantId: 'M1', settledDate: '2026-10-01', amountCents: 1, status: 'SETTLED' });
    return raw;
  };
  assert.equal(importObject(rows(5000)).ok, true);
  assert.deepEqual(codes(importObject(rows(5001))), ['TOO_MANY_ROWS']);
});

test('#9 bounded strings; PAN-like values, CVV/PAN fields and secrets rejected and redacted', () => {
  assert.deepEqual(codes(mutate((raw) => { disputeD1(raw).category = `a${'b'.repeat(300)}`; })), ['STRING_TOO_LONG']);
  for (const pan of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111']) {
    const r = mutate((raw) => { disputeD1(raw).id = pan; });
    assert.deepEqual(codes(r), ['PAN_LIKE_VALUE_REJECTED']);
    assert.ok(!JSON.stringify(r).includes('1111'), 'PAN never echoed');
  }
  for (const field of ['pan', 'cvv', 'card_number', 'cardNumber', 'cvvCode', 'expiry_date', 'securityCode']) {
    const r = mutate((raw) => { raw.transactions[0][field] = '123'; });
    assert.deepEqual(codes(r), ['SENSITIVE_FIELD_REJECTED'], field);
  }
  const secret = 'sk_live_ABCDEFGH12345678';
  const r = mutate((raw) => { disputeD1(raw).category = secret; });
  assert.deepEqual(codes(r), ['SECRET_LIKE_VALUE_REJECTED']);
  assert.ok(!JSON.stringify(r).includes(secret));
  assert.ok(!JSON.stringify(mutate((raw) => { raw[secret] = 1; })).includes(secret), 'secret-looking key redacted');
});

test('CSV import: unknown, missing, duplicate and sensitive columns; non-applicable fields; strict numbers', () => {
  const [header, ...lines] = FIX.csv.trimEnd().split('\r\n');
  const withHeader = (h, body = lines) => [h, ...body].join('\r\n');
  assert.deepEqual(codes(importDatasetCsv(withHeader(`${header},"notes"`, lines.map((l) => `${l},""`)))), ['UNKNOWN_COLUMN']);
  assert.deepEqual(codes(importDatasetCsv(withHeader(`${header},"cvv"`, lines.map((l) => `${l},""`)))), ['SENSITIVE_FIELD_REJECTED']);
  assert.deepEqual(codes(importDatasetCsv(withHeader(header.replace('"category"', '"status"')))).sort(), ['DUPLICATE_COLUMN', 'MISSING_COLUMN']);
  const t1 = lines.findIndex((l) => l.includes('"TRANSACTION","T1"'));
  const edit = (from, to) => importDatasetCsv(withHeader(header, lines.map((l, i) => (i === t1 ? l.replace(from, to) : l))));
  assert.deepEqual(codes(edit('"10000"', '"100.00"')), ['INVALID_AMOUNT']);
  assert.deepEqual(codes(edit('"10000"', '"1e4"')), ['INVALID_AMOUNT']);
  assert.deepEqual(codes(edit('"10000"', '"-10000"')), ['INVALID_AMOUNT']);
  const r = edit('"10000"', '"10000.5"');
  assert.match(r.errors[0].path, /^\/csv\/row\/[0-9]+\/amountCents$/);
  assert.deepEqual(codes(edit('"SETTLED",""', '"SETTLED","oops"')), ['FIELD_NOT_APPLICABLE']);
  assert.deepEqual(codes(importDatasetCsv(`${header}\r\n"a"`)), ['MALFORMED_CSV']);
  assert.deepEqual(codes(importDatasetCsv(`${header}\r\n\r\n${lines[0]}`)), ['MALFORMED_CSV']);
  assert.deepEqual(codes(importDatasetCsv(`${header}\r\n"unterminated`)), ['MALFORMED_CSV']);
  const many = [header];
  for (let i = 0; i < 5001; i += 1) many.push(lines[0]);
  assert.deepEqual(codes(importDatasetCsv(many.join('\r\n'))), ['TOO_MANY_ROWS']);
});
