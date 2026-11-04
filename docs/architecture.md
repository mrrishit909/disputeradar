# DisputeRadar engine architecture and snapshot trust boundary

This is a synthetic, fictional, illustrative engine. Nothing in it is VAMP, Mastercard, acquirer
or processor policy.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/constants.js` | Contract constants, enums, labels, limitations, import bounds. Pure data. |
| `src/primitives.js` | Key allowlists, bounded/redacted text checks, strict dates, exact rationals, canonical JSON, pure SHA-256, CSV. |
| `src/dataset.js` | Strict dataset import/validation (JSON/CSV), merge, export. |
| `src/engine.js` | Policy validation, scoped evaluation, sealed snapshots, `verifySnapshot`, diff, scenarios, query, notes. |
| `src/report.js` | Session-scoped JSON/CSV report export and bounded JSON report ingestion. |

## Snapshot trust boundary (`verifySnapshot`)

Every API that accepts a snapshot verifies it before reading any field. These are
`serializeReportJson`, `serializeReportCsv`, `parseReportJson`, `queryContributions`,
`addRemediationNote` and `diffSnapshots`.

Except for `parseReportJson`, which already has `JSON.parse` output, these APIs first take a
single-read, plain-data copy (`verifiedSnapshot`: `JSON.parse(canonicalJson(input))`). They
verify that copy and then read only the deep-frozen copy. This means an accessor or Proxy cannot
show one shape to verification and a different one afterwards. The copy drops symbol and
non-enumerable keys rather than rejecting them, and plain data in a class instance is treated as
plain data. The checks run in this order:

1. **Gate.** The input must be a plain object with a string `snapshotId` and the snapshot
   `schemaVersion`. Otherwise the result is `INVALID_REPORT`.
2. **Fingerprint.** The SHA-256 of the canonical JSON of the content, excluding `snapshotId`, is
   recomputed. Non-JSON data (for example `undefined` or non-finite numbers) gives
   `INVALID_REPORT`, and a stale id gives `INTEGRITY_MISMATCH`. This catches accidental corruption
   and edits where the hash was not recomputed. The documented hashes are unchanged.
3. **Structure and derived invariants** (`checkSnapshotStructure`). A failure gives
   `INVALID_REPORT` with a JSON-pointer-style path. Messages never echo raw values.
   - Exact key sets at every object level. Unknown, missing and sensitive-looking keys are
     rejected, including an own `__proto__` key from JSON.
   - Constants must be exact: `engineContractVersion`, `dataOrigin` (enum), the labels for that
     origin, limitations and the provenance method. Fingerprints must be 64-character lowercase hex.
   - Scope: identifier and region grammar, `USD` only, a valid `YYYY-MM` period, and `window`
     equal to that calendar month.
   - Notes: bounded list. Each note has an author id, a valid date, bounded non-blank inert text
     and `inert: true`. `parentSnapshotId` is null exactly when there are no notes.
   - `rule === null`: the rest of the snapshot must equal the canonical NOT_EVALUATED body for one
     of the three coverage reasons.
   - Evaluated snapshots:
     - The rule passes the same `validateRule` used for policy sets, including canonical sorted
       status lists. Its id matches `requestedRuleId`, its region matches the scope region, and
       it fully covers the period.
     - Numerator and denominator windows are re-derived.
     - Every counted or excluded event is checked for type, status enum, category grammar, date
       and window date. Each exclusion reason must match the event, rule and window. Events must
       be unique, sorted and disjoint between counted and excluded. Counted events must be in the
       window with an included status. Denominator membership must agree across events on one
       transaction and never cover an excluded transaction.
     - Excluded transactions are checked for status/reason consistency and uniqueness.
     - The denominator is checked as an integer in `0..MAX_ROWS` and at least the number of
       in-denominator transactions. These are the only checks on it: the excluded-transaction
       list does not determine the settled count.
     - **Recomputed and compared, not trusted:** `byTransaction`, `byCategory`, `byType`,
       `uniqueTransactionIds`, the numerator (per the rule's numerator definition), the exact
       ratio display, state, threshold and threshold comparison, refund total and USD displays,
       and the warnings. The engine builds these with the same helper functions
       (`contributionsOf`, `evaluationOf`, `moneyOf`, `warningsOf`, `windowsOf`,
       `notEvaluatedBody`), so produced and verified shapes cannot drift apart.
     - Settled gross is bounded by `denominator × MAX_AMOUNT_CENTS`. Arrays are bounded by
       `MAX_ROWS`, text by `MAX_STRING_CHARS` (notes `MAX_NOTE_CHARS`), and the report text by
       `MAX_REPORT_BYTES`.

`parseReportJson` also requires the exact envelope keys and exact `schemaVersion`,
`dataClassification`, `chartLabel`, `syntheticLabel` and `policyDisclaimer`, then runs
`verifySnapshot`. The returned snapshot is deep-frozen.

### What the fingerprint does **not** prove

The hash is **unkeyed**. Anyone can edit a snapshot, keep it self-consistent and recompute the
hash, and every API will accept it. Accepted edits include:

- free text such as `scenarioName`;
- a coherent edit of the counted-event list together with every value derived from it;
- the denominator or settled gross, within bounds.

Other residuals:

- The `query`, `session` and `note` argument objects are validated in place and some fields are
  read more than once. Unlike snapshots, they are not hardened against accessor or Proxy inputs.
- `addRemediationNote` caps note history at `MAX_ROWS`.

A self-hashed report therefore has no proven origin. Proving authenticity would need a keyed
signature or MAC, which is out of scope. The test
`DISCLOSED LIMITATION: a self-consistent edit with a recomputed hash is accepted` pins this
behaviour so it is never mistaken for authentication.

## Acceptance traceability (HIGH: recomputed-hash malformed snapshots)

| Requirement | Implementation | Tests (`test/forgery.test.js` unless noted) |
| --- | --- | --- |
| A `scope=null` clone with a recomputed hash must not crash exports or be accepted by parse/query | `checkSnapshotStructure` scope checks | `...: scope=null`, `scope missing`, `scope.window ...`, `scope.period ...` |
| Missing evaluation, contributions, notes or provenance | exact top-level keys plus per-section checks | `missing evaluation`, `evaluation=null`, `missing contributions`, `contributions.events=null`, `missing notes`, `notes not an array`, `missing provenance`, `provenance hash malformed` |
| Invalid rule, windows or counts | `validateRule` reuse, `windowsOf`, `contributionsOf`, `evaluationOf` comparisons | `rule *`, `numeratorWindow shifted`, `denominatorWindow null`, `numerator forged`, `denominator *`, `ratio display forged`, `state *`, `byType forged`, `byCategory count forged`, `uniqueTransactionIds dropped`, `counted event *` |
| Unknown keys at any level | `exactKeys` (via `checkKeys`) everywhere | `unknown top-level key`, `unknown nested key (scope/event/money)`, `sensitive-looking key` |
| Fabricated `{schemaVersion, snapshotId}` with a valid recomputed hash | structure check after the fingerprint | `fabricated minimal ...` |
| Malformed or stale fingerprints | gate plus fingerprint | `malformed fingerprints ...`; `test/snapshots.test.js` #9 tamper (`INTEGRITY_MISMATCH`) |
| NOT_EVALUATED forgeries | canonical `notEvaluatedBody` comparison | `forged NOT_EVALUATED snapshot is rejected: *` |
| Every public report/query/note/diff API fails safely (no throw, no success) | shared `verifySnapshot` via `verifiedSnapshot` | `assertRejectedEverywhere` covers all 7 call sites for every forgery; `accessor that is valid when verified ...` |
| Bounded report ingestion and exact envelope | `parseReportJson` | `report ingestion: ...`; `test/validation.test.js` bounds |
| Genuine snapshots unaffected; documented hashes preserved | shared builders | `genuine evaluated, annotated, scenario and NOT_EVALUATED ...`; `test/golden.test.js` |
| Unauthenticated self-hashed edits disclosed, not claimed as authentic | docs, README limitations | `DISCLOSED LIMITATION ...` |
