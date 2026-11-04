# DisputeRadar: synthetic vertical slice (engine only)

> **Synthetic / illustrative rule.** All merchants, transactions and events are fictional. Rule
> `DEMO-EVENT-COUNT` and its versions are fictional and illustrative. They are **not** Visa VAMP,
> Mastercard, acquirer or processor policy. No real network threshold, counting rule or compliance
> determination is represented. Nothing here promises to avoid fines or monitoring programmes, or to recover revenue.

This repository implements the pure engine for the contract in
`../atlas/docs/specs/DISPUTERADAR-VERTICAL-SLICE.md` (fixture `DR-SYN-001`). It has no UI and has
not been released, deployed, CI-verified or independently audited. There are no runtime
dependencies, and it uses no network, clock, randomness or locale APIs. ESM on Node.js >= 24, built-ins only.

```
npm test        # equivalent: node --test "test/*.test.js"
```

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/constants.js` | Frozen contract data: schema versions, enums, limits, error/warning codes, fictional rule versions v1–v3, labels, limitations and `ENGINE_PUBLIC_API`. |
| `src/primitives.js` | Pure helpers: own-key allowlists, strict `YYYY-MM-DD` calendar dates (string comparison only, so the host timezone is irrelevant), integer cents, exact BigInt rationals, half-up display rounding, canonical JSON, pure SHA-256, RFC 4180 CSV parsing, formula escaping, and PAN (Luhn) and secret detection. |
| `src/dataset.js` | `validateDataset` (field-by-field rebuild into fresh, id-sorted, deep-frozen records), strict `importDatasetJson`/`importDatasetCsv` with byte and row bounds, idempotent `mergeDatasets`, and canonical `datasetToJson`/`datasetToCsv`. |
| `src/engine.js` | `validatePolicySet` (intervals, overlap, duplicate versions, explicit status lists), session-scoped `createSnapshot`, `compareScenarios`, `diffSnapshots`, `queryContributions` and `addRemediationNote`. |
| `src/report.js` | Session-scoped `serializeReportJson` (HTML-safe canonical JSON), fingerprint- and schema-checked `parseReportJson`, and `serializeReportCsv` (formula-escaped, CRLF). |
| `src/fixture.js` | `generateDrSyn001()`: the literal fixture plus baseline/scenario policy sets, byte-identical on every call. |
| `src/index.js` | Explicit public surface, equal to `ENGINE_PUBLIC_API` (enforced by a test). |

Data flow: **bytes → `importDataset*` (bounds, UTF-8, parse, validate, normalize, provenance) → `createSnapshot`
(session check → period window → rule coverage → evaluation) → immutable snapshot (`snapshotId` = SHA-256 of
canonical content) → query, diff, compare, note (each note yields a new snapshot) → JSON/CSV export.**

Results are `{ ok: true, ... }` or `{ ok: false, errors: [{ code, message, path }] }`. Errors are sorted
and capped at 100. They never echo submitted values. Unknown field and column names are echoed only after
sanitizing: non-printable characters are replaced, names are truncated, and PAN- or secret-like names are
redacted.

## Dataset schema `disputeradar.dataset.v1`

All arrays are required (they may be empty), unknown fields are rejected, and IDs match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.

| Collection | Fields |
| --- | --- |
| `merchants` | `id`, `region` (`^[A-Z][A-Z0-9_-]*$`), `currency` (`USD` only; no FX) |
| `transactions` | `id`, `merchantId`, `settledDate` (date or `null`; `null` only for `PENDING`/`VOID`), `amountCents` (safe integer 1..1,000,000,000), `status` `SETTLED`\|`PENDING`\|`VOID` |
| `disputes` | `id`, `transactionId`, `reportedDate`, `category` (`^[a-z][a-z0-9-]*$`), `status` `OPEN`\|`WON`\|`LOST`\|`WITHDRAWN`\|`REVERSED`, optional `merchantId` (must match the transaction's merchant) |
| `fraudEvents` | `id`, `transactionId`, `reportedDate`, `status` `REPORTED`\|`RETRACTED`, optional `merchantId` |
| `refunds` | `id`, `transactionId`, `reportedDate`, `amountCents`, optional `merchantId`. Cumulative refunds per transaction must be <= its amount. |

Top level: `schemaVersion: "disputeradar.dataset.v1"`, `dataClassification: "SYNTHETIC"`, plus the five arrays.

Validation rules:
- IDs are unique per record type, so `DISPUTE:D1` and `FRAUD:D1` may coexist.
- Every event or refund must reference an imported transaction, including historical sales outside the window. Unresolved references are rejected, never dropped.
- `reportedDate` must not precede a known `settledDate`.
- Limits: 1 MiB (1,048,576 bytes), 5,000 records, 200-character strings (2,000 for notes).
- PAN/CVV/expiry-style field names, Luhn-valid 13–19 digit values and credential-like values are rejected.
- Normalized events always carry `merchantId`.

**CSV `disputeradar.dataset-csv.v1`**
- Columns (any order, each exactly once): `schema_version, data_classification, record_type, id, merchant_id, transaction_id, region, currency, settled_date, reported_date, amount_cents, status, category`.
- `record_type` is one of `MERCHANT|TRANSACTION|DISPUTE|FRAUD|REFUND`.
- Columns that do not apply to a row's type must be empty.
- `amount_cents` must be a plain digit string.
- An empty `settled_date` means `null`.
- Errors point at `/csv/row/<n>/...`.

## Policy set schema `disputeradar.policy-set.v1`

`{ schemaVersion, policySetId, scenarioName, rules: [rule] }`. Each rule has `id, version,
effectiveFrom, effectiveTo|null, region, windowDateField (EVENT_REPORTED_DATE|TRANSACTION_SETTLED_DATE),
denominatorDefinition (SETTLED_TRANSACTION_COUNT), numeratorDefinition
(DISPUTE_AND_FRAUD_EVENT_COUNT|UNIQUE_TRANSACTION_COUNT), illustrativeThresholdBps,
includedDisputeStatuses[], includedFraudStatuses[]`.

- Status lists are required, unique, known-enum arrays. A missing or unknown status list makes the result `NOT_EVALUATED` / `INVALID_RULE_POLICY`; it is never treated as an implicit exclusion.
- Overlapping versions for the same id and region are rejected, as are duplicate versions and `effectiveTo` before `effectiveFrom`.
- A rule version must cover the whole month, otherwise the result is `NOT_EVALUATED`:
  - `NO_RULE_COVERAGE` when no version applies;
  - `PARTIAL_RULE_COVERAGE` when versions only partly cover or split the month;
  - `RULE_REGION_MISMATCH` when no version matches the merchant's region.

Fixture policy sets:

| Set | Rule version | Definition |
| --- | --- | --- |
| `DEMO-BASELINE-V1` | v1 | Event count by report date |
| `DEMO-SCENARIO-V2` | v2 | Unique transaction count |
| `DEMO-SCENARIO-V3` | v3 | Event window by the sale's settled date |

All three are fictional and use an illustrative 2500 bps threshold. Scenarios are separate, named policy sets with their own snapshots and provenance, so they never rewrite the baseline.

## Evaluation semantics

- **Denominator:** the merchant's `SETTLED` transactions whose `settledDate` falls in the month. `PENDING`/`VOID` never count, whatever their date.
- **Numerator:**
  - v1 counts dispute plus fraud events whose window date (the `reportedDate`) falls in the month and whose status is in the rule's explicit lists.
  - v2 counts the distinct transaction IDs among those events.
  - Refunds never subtract.
- **Alert test:** `numerator × 10000` is compared with `thresholdBps × denominator` using exact BigInt arithmetic. Equality triggers `ILLUSTRATIVE_ALERT`; otherwise the state is `BELOW_ILLUSTRATIVE_THRESHOLD`.
- **Zero denominator:** `UNDEFINED_INSUFFICIENT_DENOMINATOR` with `ratio: null`, plus warning `EVENTS_WITHOUT_SETTLED_DENOMINATOR` or `EMPTY_PERIOD_NOT_ALL_CLEAR`.
- Percent/bps strings are display-only and rounded half-up.
- Snapshots list:
  - counted events, per-transaction and per-category contributions;
  - excluded events and transactions with reasons;
  - numerator and denominator windows, the rule version and the policy disclaimer;
  - refunds as context, settled gross, warnings, limitations, labels and provenance:
    - `scopedDataSha256` covers only this merchant's records, so another tenant's data never changes or signals anything in this report;
    - `policySetSha256` identifies the policy set.

## Usage

```js
import { generateDrSyn001, importDatasetJson, createSnapshot, compareScenarios, queryContributions,
  addRemediationNote, serializeReportJson, serializeReportCsv } from './src/index.js';

const fx = generateDrSyn001();
const { dataset, provenance } = importDatasetJson(fx.json);          // or importDatasetCsv(fx.csv)
const session = { allowedMerchantIds: ['M1'] };                         // tenant scope (required)
const { snapshot } = createSnapshot({ dataset, policySet: fx.policySets.BASELINE_V1,
  merchantId: 'M1', period: '2026-10', session });                      // 5/10 = 5000 bps ILLUSTRATIVE_ALERT
queryContributions(snapshot, { category: 'product-not-received', sortBy: 'reportedDate' });
const cmp = compareScenarios({ dataset, merchantId: 'M1', period: '2026-10', session,
  baselinePolicySet: fx.policySets.BASELINE_V1,
  scenarioPolicySet: fx.policySets.SCENARIO_V2_UNIQUE_TRANSACTION });  // 4000 bps, difference -1000 bps
const noted = addRemediationNote(snapshot, { author: 'reviewer-1', recordedOn: '2026-11-02',
  text: 'Investigate T1 fulfilment.' }, session).snapshot;              // new snapshot; original unchanged
serializeReportJson(noted, session).text; serializeReportCsv(noted, session).text;
```

## Acceptance traceability (spec §"Acceptance and adversarial cases")

| # | Requirement | Tests |
| --- | --- | --- |
| 1 | Golden counts, fractions, contributions, D3 in, D4/T11 out, no float comparison | `golden.test.js`: "#1 golden v1…", "#1 rule v2 scenario…", "#1 exact rational…" |
| 2 | Duplicate D1 fails/idempotent; D1+F1 two events in v1, one transaction in v2 | `golden.test.js`: "#2 duplicate D1…", "#2 D1+F1…" |
| 3 | Zero denominator undefined plus warning; empty is not all-clear; 2/8 triggers, 1/8 does not | `golden.test.js`: "#3 …" (three tests) |
| 4 | Invalid dates, end-before-start, overlaps, absent coverage; timezone independence | `validation.test.js`: "#4 …" (five tests, including child processes under `Pacific/Kiritimati`/`Pacific/Pago_Pago`) |
| 5 | Negative/overprecision/unsafe money, currency, refund cumulative bound | `validation.test.js`: "#5 …" |
| 6 | Missing reference rejects; historical reference required; cross-merchant rejects | `validation.test.js`: "#6 …"; `snapshots.test.js`: "#7 late event needing…" |
| 7 | Status lists explicit; unsupported means not evaluated; late reimport gives a new snapshot plus delta | `validation.test.js`: "#7 missing/unknown…"; `snapshots.test.js`: "#7 late-event…" |
| 8 | Refund leaves 5/10; v3 is a separately named scenario that never rewrites history | `golden.test.js`: "#8 …" |
| 9 | 1 MiB/5000 bounds, strings, PAN/CVV/secrets, inert notes, CSV formula escaping, tenant isolation, export equals snapshot | `validation.test.js`: "#9 bounds…", "#9 bounded strings…", "#9 CSV cells with PAN-like values…", "deeply invalid shapes…", "CSV import…"; `snapshots.test.js`: "#9 tenant isolation…" (M1 snapshot byte-identical with or without M2 data), "#9 JSON export…", "#9 CSV export…", "notes produce a new snapshot…", "scenarios must be separately named…" |
| 10 | Row-order/reimport determinism, cents, display rounding, export round-trip, report contents | `snapshots.test.js`: "#10 determinism…", "#9 CSV export…"; `golden.test.js`: "#10 CSV import…" |

Further checks:
- SHA-256 against `node:crypto` at padding boundaries.
- Architecture: exact export set, relative imports only, and no `Date`, `Math.random`, `fetch`, `process` or float formatting in `src/`.
- Search, sort and filter change real results.

## Limitations

- Synthetic data and fictional illustrative rules only. This is not a VAMP, Mastercard, acquirer or processor determination. Before any live use, official definitions, effective dates, regions, exclusions and counting semantics must be verified and separately versioned, and a specialist must approve them.
- Completeness is unverified: only imported records are represented, and network-reported events missing from exports are invisible.
- `JSON.parse` keeps the last value of a duplicated JSON key; duplicate keys are not detected.
- Over-precise amounts:
  - JSON: `JSON.parse` turns `10000.0` and `1e4` into the integer 10000, so they are accepted; true fractions such as `100.5` are rejected.
  - CSV: `amount_cents` must be plain digits.
- Every snapshot-consuming API (`parseReportJson`, `serializeReportJson`, `serializeReportCsv`, `queryContributions`, `addRemediationNote`, `diffSnapshots`) first recomputes the fingerprint (`INTEGRITY_MISMATCH` on a stale id). It then enforces the full snapshot schema: exact keys, enums, types and bounds. It also re-derives the numerator, ratio, state, threshold comparison, contribution summaries, money totals and warnings from the snapshot's own data (`INVALID_REPORT` with a path). Forged or incomplete objects fail safely and never throw. See `docs/architecture.md`.
- Re-hashed reports are unauthenticated. Because the hash is unkeyed, anyone can edit a snapshot, keep it self-consistent and recompute the hash, and it will be accepted. Examples are free-text fields such as `scenarioName`, and coherent edits to the counted-event list together with every value derived from it. The denominator and settled gross are only bounds-checked (the excluded-transaction list does not determine them). Proving where a report came from would need a keyed signature, which is not implemented.
- PAN and secret detection is heuristic (Luhn runs and known token shapes), so other sensitive text could still pass.
- Snapshot hashes are unkeyed fingerprints. They detect accidental corruption and edits where the hash was not recomputed. They are not signatures and they do not prove schema validity or authenticity.
- The upload `inputSha256` is kept in import provenance, not in `snapshotId`, so row order does not change snapshot identity.
- CSV formula escaping is one-way: exported cells keep the leading `'`.
- Sessions are caller-supplied scope objects, not authentication.
- Note dates are supplied by the caller; the engine reads no clock.
- Not built: UI, keyboard/mobile/accessibility/reduced-motion checks, persistence, CI, deployment and an independent audit. These remain release prerequisites. Nothing here is released.
