// DisputeRadar v1 contract constants. Pure data only: no I/O, clock or platform APIs.
// Every rule here is FICTIONAL and ILLUSTRATIVE. Nothing in this file is VAMP, Mastercard,
// acquirer or processor policy, and no real network threshold is encoded.

/** @param {any} value */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export const ENGINE_CONTRACT_VERSION = '1.0.0';

export const SCHEMA_VERSIONS = deepFreeze({
  DATASET_JSON: 'disputeradar.dataset.v1',
  DATASET_CSV: 'disputeradar.dataset-csv.v1',
  POLICY_SET: 'disputeradar.policy-set.v1',
  SNAPSHOT: 'disputeradar.snapshot.v1',
  REPORT: 'disputeradar.report.v1',
  REPORT_CSV: 'disputeradar.report-csv.v1',
});

export const DATA_CLASSIFICATION = 'SYNTHETIC';
/** Literal label required on every chart, snapshot and export (spec). */
export const CHART_LABEL = 'Synthetic / illustrative rule';
export const SYNTHETIC_LABEL =
  'SYNTHETIC DEMO DATA - fictional merchants, transactions and events; illustrative rule only.';
export const POLICY_DISCLAIMER =
  'Fictional illustrative policy. NOT Visa VAMP, NOT Mastercard, NOT acquirer or processor policy; ' +
  'no real network threshold, counting rule or compliance determination is represented.';

export const LIMITATIONS = deepFreeze([
  'Synthetic data and fictional illustrative rules only; not a network, acquirer or processor monitoring determination.',
  'Results cover only imported records. Network-reported events absent from merchant exports are not represented; completeness is not verified.',
  'Ratios are exact rationals; percent/bps decimals are display-only and rounded half-up.',
  'No historical threshold inference, no FX conversion, no automatic refunds, dispute submissions or merchant notifications.',
  'Refunds are operational context and never remove counted events.',
  'Snapshot hashes are unkeyed integrity fingerprints, not signatures or proof of authorship.',
]);

export const FIXTURE_ID = 'DR-SYN-001';
export const CURRENCY = 'USD';
export const MONEY_UNIT = 'USD_CENTS';

export const IMPORT_LIMITS = deepFreeze({
  MAX_UPLOAD_BYTES: 1_048_576,
  MAX_ROWS: 5_000,
  MAX_STRING_CHARS: 200,
  MAX_NOTE_CHARS: 2_000,
  MAX_ERRORS_REPORTED: 100,
  MAX_RULES: 50,
  MAX_REPORT_BYTES: 8_388_608,
});

/** $10,000,000.00 per amount; 5,000-row sums stay far below Number.MAX_SAFE_INTEGER. */
export const MAX_AMOUNT_CENTS = 1_000_000_000;

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CATEGORY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const REGION_PATTERN = /^[A-Z][A-Z0-9_-]{0,31}$/;
export const PERIOD_PATTERN = /^([0-9]{4})-([0-9]{2})$/;
export const MIN_YEAR = 1970;
export const MAX_YEAR = 2999;

export const TRANSACTION_STATUS = deepFreeze(['SETTLED', 'PENDING', 'VOID']);
export const DISPUTE_STATUS = deepFreeze(['OPEN', 'WON', 'LOST', 'WITHDRAWN', 'REVERSED']);
export const FRAUD_STATUS = deepFreeze(['REPORTED', 'RETRACTED']);

export const WINDOW_DATE_FIELD = deepFreeze(['EVENT_REPORTED_DATE', 'TRANSACTION_SETTLED_DATE']);
export const DENOMINATOR_DEFINITION = deepFreeze(['SETTLED_TRANSACTION_COUNT']);
export const NUMERATOR_DEFINITION = deepFreeze(['DISPUTE_AND_FRAUD_EVENT_COUNT', 'UNIQUE_TRANSACTION_COUNT']);

export const EVENT_TYPE = deepFreeze({ DISPUTE: 'DISPUTE', FRAUD: 'FRAUD' });

export const EVALUATION_STATE = deepFreeze({
  /** Exact ratio >= illustrative threshold (equality triggers). */
  ILLUSTRATIVE_ALERT: 'ILLUSTRATIVE_ALERT',
  /** Exact ratio < illustrative threshold. Deliberately not "compliant" or "clear". */
  BELOW_ILLUSTRATIVE_THRESHOLD: 'BELOW_ILLUSTRATIVE_THRESHOLD',
  /** Zero settled denominator: ratio undefined. Never 0, never infinite, never all-clear. */
  UNDEFINED_INSUFFICIENT_DENOMINATOR: 'UNDEFINED_INSUFFICIENT_DENOMINATOR',
  /** Rule coverage absent/partial or rule policy unusable. */
  NOT_EVALUATED: 'NOT_EVALUATED',
});

export const EXCLUSION_REASON = deepFreeze({
  EVENT_OUTSIDE_WINDOW: 'EVENT_OUTSIDE_WINDOW',
  STATUS_NOT_INCLUDED_BY_RULE: 'STATUS_NOT_INCLUDED_BY_RULE',
  TRANSACTION_NOT_SETTLED: 'TRANSACTION_NOT_SETTLED',
  TRANSACTION_SETTLED_OUTSIDE_WINDOW: 'TRANSACTION_SETTLED_OUTSIDE_WINDOW',
  WINDOW_DATE_UNAVAILABLE: 'WINDOW_DATE_UNAVAILABLE',
});

export const NOT_EVALUATED_REASON = deepFreeze({
  NO_RULE_COVERAGE: 'NO_RULE_COVERAGE',
  PARTIAL_RULE_COVERAGE: 'PARTIAL_RULE_COVERAGE',
  RULE_REGION_MISMATCH: 'RULE_REGION_MISMATCH',
  INVALID_RULE_POLICY: 'INVALID_RULE_POLICY',
});

export const WARNING_CODE = deepFreeze({
  EVENTS_WITHOUT_SETTLED_DENOMINATOR: 'EVENTS_WITHOUT_SETTLED_DENOMINATOR',
  EMPTY_PERIOD_NOT_ALL_CLEAR: 'EMPTY_PERIOD_NOT_ALL_CLEAR',
  EVENTS_EXCLUDED_BY_STATUS_POLICY: 'EVENTS_EXCLUDED_BY_STATUS_POLICY',
  NUMERATOR_EVENT_ON_OUT_OF_WINDOW_SALE: 'NUMERATOR_EVENT_ON_OUT_OF_WINDOW_SALE',
  IMPORTED_DATA_COMPLETENESS_UNVERIFIED: 'IMPORTED_DATA_COMPLETENESS_UNVERIFIED',
});

export const ERROR_CODE = deepFreeze({
  INPUT_TOO_LARGE: 'INPUT_TOO_LARGE',
  TOO_MANY_ROWS: 'TOO_MANY_ROWS',
  INVALID_UTF8: 'INVALID_UTF8',
  MALFORMED_JSON: 'MALFORMED_JSON',
  MALFORMED_CSV: 'MALFORMED_CSV',
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
  UNSUPPORTED_CLASSIFICATION: 'UNSUPPORTED_CLASSIFICATION',
  INVALID_TYPE: 'INVALID_TYPE',
  MISSING_FIELD: 'MISSING_FIELD',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  MISSING_COLUMN: 'MISSING_COLUMN',
  UNKNOWN_COLUMN: 'UNKNOWN_COLUMN',
  DUPLICATE_COLUMN: 'DUPLICATE_COLUMN',
  FIELD_NOT_APPLICABLE: 'FIELD_NOT_APPLICABLE',
  SENSITIVE_FIELD_REJECTED: 'SENSITIVE_FIELD_REJECTED',
  PAN_LIKE_VALUE_REJECTED: 'PAN_LIKE_VALUE_REJECTED',
  SECRET_LIKE_VALUE_REJECTED: 'SECRET_LIKE_VALUE_REJECTED',
  STRING_TOO_LONG: 'STRING_TOO_LONG',
  INVALID_ID: 'INVALID_ID',
  DUPLICATE_ID: 'DUPLICATE_ID',
  CONFLICTING_DUPLICATE_ID: 'CONFLICTING_DUPLICATE_ID',
  UNKNOWN_REFERENCE: 'UNKNOWN_REFERENCE',
  CROSS_MERCHANT_REFERENCE: 'CROSS_MERCHANT_REFERENCE',
  INVALID_ENUM: 'INVALID_ENUM',
  INVALID_DATE: 'INVALID_DATE',
  INVALID_PERIOD: 'INVALID_PERIOD',
  SETTLED_DATE_REQUIRED: 'SETTLED_DATE_REQUIRED',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  AMOUNT_OUT_OF_RANGE: 'AMOUNT_OUT_OF_RANGE',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  REFUND_EXCEEDS_TRANSACTION: 'REFUND_EXCEEDS_TRANSACTION',
  INVALID_CATEGORY: 'INVALID_CATEGORY',
  INVALID_REGION: 'INVALID_REGION',
  INVALID_RULE: 'INVALID_RULE',
  RULE_INTERVAL_END_BEFORE_START: 'RULE_INTERVAL_END_BEFORE_START',
  RULE_VERSION_OVERLAP: 'RULE_VERSION_OVERLAP',
  DUPLICATE_RULE_VERSION: 'DUPLICATE_RULE_VERSION',
  UNKNOWN_RULE: 'UNKNOWN_RULE',
  UNKNOWN_MERCHANT: 'UNKNOWN_MERCHANT',
  ACCESS_DENIED: 'ACCESS_DENIED',
  SNAPSHOT_MISMATCH: 'SNAPSHOT_MISMATCH',
  INVALID_NOTE: 'INVALID_NOTE',
  INVALID_REPORT: 'INVALID_REPORT',
  INTEGRITY_MISMATCH: 'INTEGRITY_MISMATCH',
});

/** Field/column names that would indicate cardholder data. They are never accepted. */
export const SENSITIVE_FIELD_PATTERN =
  /(^|[^a-z])(pan|cvv2?|cvc2?|cid)([^a-z]|$)|card.?number|cardnum|security.?code|primary.?account|expir|track.?data|pin.?block/i;

/** Single-quote prefix is applied to CSV text cells that start with these characters. */
export const CSV_FORMULA_TRIGGER_PREFIXES = deepFreeze(['=', '+', '-', '@', '\t', '\r', '\n']);

export const CSV_IMPORT_COLUMNS = deepFreeze([
  'schema_version',
  'data_classification',
  'record_type',
  'id',
  'merchant_id',
  'transaction_id',
  'region',
  'currency',
  'settled_date',
  'reported_date',
  'amount_cents',
  'status',
  'category',
]);

export const CSV_RECORD_TYPES = deepFreeze(['MERCHANT', 'TRANSACTION', 'DISPUTE', 'FRAUD', 'REFUND']);

export const CSV_EXPORT_COLUMNS = deepFreeze([
  'record_type',
  'snapshot_id',
  'merchant_id',
  'period',
  'rule_id',
  'rule_version',
  'subject_type',
  'subject_id',
  'transaction_id',
  'metric',
  'count',
  'amount_usd',
  'reason',
  'text',
]);

/**
 * Versioned FICTIONAL policies. Baseline v1 is the only version in the default policy set;
 * v2 and v3 are separately named scenario versions evaluated in their own policy sets so they
 * never overlap v1 or rewrite a historical v1 report.
 */
const ALL_DISPUTE = ['OPEN', 'WON', 'LOST', 'WITHDRAWN', 'REVERSED'];
const ALL_FRAUD = ['REPORTED', 'RETRACTED'];
export const FICTIONAL_RULES = deepFreeze({
  V1_EVENT_COUNT: {
    id: 'DEMO-EVENT-COUNT',
    version: 1,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    region: 'DEMO',
    windowDateField: 'EVENT_REPORTED_DATE',
    denominatorDefinition: 'SETTLED_TRANSACTION_COUNT',
    numeratorDefinition: 'DISPUTE_AND_FRAUD_EVENT_COUNT',
    illustrativeThresholdBps: 2500,
    includedDisputeStatuses: ALL_DISPUTE,
    includedFraudStatuses: ALL_FRAUD,
  },
  V2_UNIQUE_TRANSACTION: {
    id: 'DEMO-EVENT-COUNT',
    version: 2,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    region: 'DEMO',
    windowDateField: 'EVENT_REPORTED_DATE',
    denominatorDefinition: 'SETTLED_TRANSACTION_COUNT',
    numeratorDefinition: 'UNIQUE_TRANSACTION_COUNT',
    illustrativeThresholdBps: 2500,
    includedDisputeStatuses: ALL_DISPUTE,
    includedFraudStatuses: ALL_FRAUD,
  },
  V3_SETTLED_DATE_WINDOW: {
    id: 'DEMO-EVENT-COUNT',
    version: 3,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    region: 'DEMO',
    windowDateField: 'TRANSACTION_SETTLED_DATE',
    denominatorDefinition: 'SETTLED_TRANSACTION_COUNT',
    numeratorDefinition: 'DISPUTE_AND_FRAUD_EVENT_COUNT',
    illustrativeThresholdBps: 2500,
    includedDisputeStatuses: ALL_DISPUTE,
    includedFraudStatuses: ALL_FRAUD,
  },
});

/** Exact public surface of src/index.js (enforced by test/architecture.test.js). */
export const ENGINE_PUBLIC_API = deepFreeze([
  'CHART_LABEL',
  'DATA_CLASSIFICATION',
  'ENGINE_CONTRACT_VERSION',
  'ERROR_CODE',
  'EVALUATION_STATE',
  'EXCLUSION_REASON',
  'FICTIONAL_RULES',
  'FIXTURE_ID',
  'IMPORT_LIMITS',
  'LIMITATIONS',
  'NOT_EVALUATED_REASON',
  'POLICY_DISCLAIMER',
  'SCHEMA_VERSIONS',
  'SYNTHETIC_LABEL',
  'WARNING_CODE',
  'addRemediationNote',
  'compareRationals',
  'compareScenarios',
  'createSnapshot',
  'datasetToCsv',
  'datasetToJson',
  'diffSnapshots',
  'formatCents',
  'generateDrSyn001',
  'importDatasetCsv',
  'importDatasetJson',
  'mergeDatasets',
  'parseReportJson',
  'queryContributions',
  'ratioDisplay',
  'serializeReportCsv',
  'serializeReportJson',
  'sha256Hex',
  'validateDataset',
  'validatePolicySet',
]);
