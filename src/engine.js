// Policy validation, scoped evaluation, immutable snapshots, scenarios, diffs, queries and notes.
// Every rule is FICTIONAL and ILLUSTRATIVE; comparisons are exact rationals (never floats).
import {
  CATEGORY_PATTERN,
  CHART_LABEL,
  CURRENCY,
  DATA_CLASSIFICATION,
  DENOMINATOR_DEFINITION,
  DISPUTE_STATUS,
  ENGINE_CONTRACT_VERSION,
  ERROR_CODE,
  EVALUATION_STATE,
  EVENT_TYPE,
  EXCLUSION_REASON,
  FRAUD_STATUS,
  ID_PATTERN,
  IMPORT_LIMITS,
  LIMITATIONS,
  MAX_AMOUNT_CENTS,
  NOT_EVALUATED_REASON,
  NUMERATOR_DEFINITION,
  POLICY_DISCLAIMER,
  REGION_PATTERN,
  SCHEMA_VERSIONS,
  SYNTHETIC_LABEL,
  TRANSACTION_STATUS,
  WARNING_CODE,
  WINDOW_DATE_FIELD,
  deepFreeze,
} from './constants.js';
import {
  canonicalJson,
  checkKeys,
  checkPattern,
  checkText,
  checkedAdd,
  cmp,
  compareRationals,
  err,
  fail,
  formatCents,
  has,
  inWindow,
  isPlainObject,
  isValidDate,
  periodWindow,
  ratioDisplay,
  rationalDifferenceBps,
  sha256Hex,
} from './primitives.js';
import { validateDataset } from './dataset.js';

const RULE_FIELDS = [
  'id', 'version', 'effectiveFrom', 'effectiveTo', 'region', 'windowDateField', 'denominatorDefinition',
  'numeratorDefinition', 'illustrativeThresholdBps', 'includedDisputeStatuses', 'includedFraudStatuses',
];
const MAX_THRESHOLD_BPS = 1_000_000;

// ---------- Policy sets ----------
function checkStatusList(value, allowed, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(err(ERROR_CODE.INVALID_RULE,
      'Status inclusion list is required as an explicit array; absence is never implicit exclusion.', path));
    return false;
  }
  let ok = true;
  const seen = new Set();
  value.forEach((s, i) => {
    if (typeof s !== 'string' || !allowed.includes(s)) {
      errors.push(err(ERROR_CODE.INVALID_ENUM, `Unknown policy status; expected values from ${allowed.join(', ')}.`, `${path}/${i}`));
      ok = false;
    } else if (seen.has(s)) {
      errors.push(err(ERROR_CODE.INVALID_RULE, 'Status inclusion list values must be unique.', `${path}/${i}`));
      ok = false;
    }
    seen.add(s);
  });
  return ok;
}

function validateRule(row, path, errors) {
  if (!isPlainObject(row)) {
    errors.push(err(ERROR_CODE.INVALID_TYPE, 'Rule must be an object.', path));
    return null;
  }
  const before = errors.length;
  checkKeys(row, RULE_FIELDS, [], path, errors);
  if (errors.length > before) return null;
  let ok = checkPattern(row.id, ID_PATTERN, ERROR_CODE.INVALID_ID, 'rule id', `${path}/id`, errors);
  if (!Number.isSafeInteger(row.version) || row.version < 1) {
    errors.push(err(ERROR_CODE.INVALID_RULE, 'Rule version must be a positive integer.', `${path}/version`));
    ok = false;
  }
  const fromOk = typeof row.effectiveFrom === 'string' && isValidDate(row.effectiveFrom);
  const toOk = row.effectiveTo === null || (typeof row.effectiveTo === 'string' && isValidDate(row.effectiveTo));
  if (!fromOk) errors.push(err(ERROR_CODE.INVALID_DATE, 'effectiveFrom must be a YYYY-MM-DD date.', `${path}/effectiveFrom`));
  if (!toOk) errors.push(err(ERROR_CODE.INVALID_DATE, 'effectiveTo must be a YYYY-MM-DD date or null (open-ended).', `${path}/effectiveTo`));
  if (fromOk && toOk && row.effectiveTo !== null && row.effectiveTo < row.effectiveFrom) {
    errors.push(err(ERROR_CODE.RULE_INTERVAL_END_BEFORE_START, 'Rule effectiveTo is before effectiveFrom.', `${path}/effectiveTo`));
    ok = false;
  }
  ok = ok && fromOk && toOk;
  ok = checkPattern(row.region, REGION_PATTERN, ERROR_CODE.INVALID_REGION, 'region', `${path}/region`, errors) && ok;
  for (const [field, allowed] of [['windowDateField', WINDOW_DATE_FIELD], ['denominatorDefinition', DENOMINATOR_DEFINITION],
    ['numeratorDefinition', NUMERATOR_DEFINITION]]) {
    if (typeof row[field] !== 'string' || !allowed.includes(row[field])) {
      errors.push(err(ERROR_CODE.INVALID_ENUM, `${field} must be one of ${allowed.join(', ')}.`, `${path}/${field}`));
      ok = false;
    }
  }
  const t = row.illustrativeThresholdBps;
  if (!Number.isSafeInteger(t) || t < 1 || t > MAX_THRESHOLD_BPS) {
    errors.push(err(ERROR_CODE.INVALID_RULE, `illustrativeThresholdBps must be an integer 1..${MAX_THRESHOLD_BPS}.`, `${path}/illustrativeThresholdBps`));
    ok = false;
  }
  ok = checkStatusList(row.includedDisputeStatuses, DISPUTE_STATUS, `${path}/includedDisputeStatuses`, errors) && ok;
  ok = checkStatusList(row.includedFraudStatuses, FRAUD_STATUS, `${path}/includedFraudStatuses`, errors) && ok;
  if (!ok) return null;
  const rule = {};
  for (const f of RULE_FIELDS) rule[f] = Array.isArray(row[f]) ? [...row[f]].sort(cmp) : row[f];
  return rule;
}

/**
 * Validates a versioned fictional policy set. Versions of one rule id in one region must not
 * overlap and (id, version) must be unique.
 */
export function validatePolicySet(input) {
  if (!isPlainObject(input)) return fail([err(ERROR_CODE.INVALID_TYPE, 'Policy set must be an object.', '')]);
  const errors = [];
  checkKeys(input, ['schemaVersion', 'policySetId', 'scenarioName', 'rules'], [], '', errors);
  if (errors.length > 0) return fail(errors);
  if (input.schemaVersion !== SCHEMA_VERSIONS.POLICY_SET) {
    errors.push(err(ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION, `schemaVersion must be ${SCHEMA_VERSIONS.POLICY_SET}.`, '/schemaVersion'));
  }
  checkPattern(input.policySetId, ID_PATTERN, ERROR_CODE.INVALID_ID, 'policy set id', '/policySetId', errors);
  checkText(input.scenarioName, '/scenarioName', errors);
  if (!Array.isArray(input.rules) || input.rules.length === 0) {
    errors.push(err(ERROR_CODE.INVALID_RULE, 'rules must be a non-empty array.', '/rules'));
    return fail(errors);
  }
  if (input.rules.length > IMPORT_LIMITS.MAX_RULES) {
    return fail([err(ERROR_CODE.TOO_MANY_ROWS, `Policy set exceeds ${IMPORT_LIMITS.MAX_RULES} rules.`, '/rules')]);
  }
  const rules = input.rules.map((r, i) => validateRule(r, `/rules/${i}`, errors));
  if (errors.length > 0) return fail(errors);
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const a = rules[i];
      const b = rules[j];
      if (a.id !== b.id) continue;
      if (a.version === b.version) {
        errors.push(err(ERROR_CODE.DUPLICATE_RULE_VERSION, 'Duplicate rule id/version.', `/rules/${j}/version`));
      } else if (a.region === b.region
        && a.effectiveFrom <= (b.effectiveTo ?? '9999-12-31') && b.effectiveFrom <= (a.effectiveTo ?? '9999-12-31')) {
        errors.push(err(ERROR_CODE.RULE_VERSION_OVERLAP,
          'Rule versions for the same id and region overlap; coverage would be ambiguous.', `/rules/${j}`));
      }
    }
  }
  if (errors.length > 0) return fail(errors);
  rules.sort((a, b) => cmp(a.id, b.id) || a.version - b.version);
  return {
    ok: true,
    policySet: deepFreeze({
      schemaVersion: SCHEMA_VERSIONS.POLICY_SET, policySetId: input.policySetId, scenarioName: input.scenarioName, rules,
    }),
  };
}

// ---------- Sessions ----------
function checkSession(session, merchantId) {
  if (!isPlainObject(session) || !has(session, 'allowedMerchantIds') || !Array.isArray(session.allowedMerchantIds)
    || Reflect.ownKeys(session).length !== 1) {
    return err(ERROR_CODE.ACCESS_DENIED, 'A session with an explicit allowedMerchantIds array is required.', '/session');
  }
  if (!session.allowedMerchantIds.some((m) => typeof m === 'string' && m === merchantId)) {
    return err(ERROR_CODE.ACCESS_DENIED, 'Session is not scoped to the requested merchant.', '/session');
  }
  return null;
}

// ---------- Snapshots ----------
function contentOf(snapshot) {
  const content = {};
  for (const key of Object.keys(snapshot)) if (key !== 'snapshotId') content[key] = snapshot[key];
  return content;
}

function seal(content) {
  return deepFreeze({ snapshotId: sha256Hex(canonicalJson(content)), ...content });
}

/**
 * Recomputes the unkeyed content fingerprint (accidental-corruption / edit detection), then
 * enforces the full snapshot schema and re-derives every count, ratio, contribution summary and
 * warning. The fingerprint is never treated as proof of schema or authenticity: anyone can
 * recompute it, so a self-consistent edited snapshot with a recomputed hash is unauthenticated.
 */
export function verifySnapshot(snapshot) {
  if (!isPlainObject(snapshot) || typeof snapshot.snapshotId !== 'string'
    || snapshot.schemaVersion !== SCHEMA_VERSIONS.SNAPSHOT) {
    return err(ERROR_CODE.INVALID_REPORT, 'Not a DisputeRadar snapshot.');
  }
  let hash;
  try {
    hash = sha256Hex(canonicalJson(contentOf(snapshot)));
  } catch {
    return err(ERROR_CODE.INVALID_REPORT, 'Snapshot is not canonical JSON data.');
  }
  if (hash !== snapshot.snapshotId) {
    return err(ERROR_CODE.INTEGRITY_MISMATCH, 'Snapshot content does not match its snapshotId fingerprint.');
  }
  try {
    checkSnapshotStructure(snapshot);
  } catch (e) {
    if (e instanceof ShapeError) return err(ERROR_CODE.INVALID_REPORT, `Snapshot structure is invalid: ${e.message}`, e.path);
    return err(ERROR_CODE.INVALID_REPORT, 'Snapshot structure is invalid.');
  }
  return null;
}

/**
 * Verifies a single-read, plain-data, deep-frozen copy. Callers must use only the returned copy so
 * accessors or Proxies cannot present one shape to verification and another afterwards.
 */
function verifiedSnapshot(input) {
  let copy;
  try {
    copy = JSON.parse(canonicalJson(input));
  } catch {
    return { error: err(ERROR_CODE.INVALID_REPORT, 'Snapshot is not canonical JSON data.') };
  }
  const bad = verifySnapshot(copy);
  return bad ? { error: bad } : { snapshot: deepFreeze(copy) };
}

// ---------- Strict snapshot structure (schema, enums, types, bounds, derived invariants) ----------
const HEX64 = /^[0-9a-f]{64}$/;
const SNAPSHOT_KEYS = [
  'snapshotId', 'schemaVersion', 'engineContractVersion', 'dataClassification', 'labels', 'limitations', 'scenario',
  'scope', 'requestedRuleId', 'provenance', 'parentSnapshotId', 'notes', 'rule', 'evaluation', 'numeratorWindow',
  'denominatorWindow', 'contributions', 'exclusions', 'money', 'warnings',
];
const EVENT_KEYS = ['eventType', 'eventId', 'transactionId', 'reportedDate', 'category', 'status', 'windowDate'];
const PROVENANCE_METHOD = 'Deterministic pure evaluation; no clock, network, locale or randomness.';
const COMPARISON_METHOD = 'Exact BigInt cross-multiplication numerator*10000 vs thresholdBps*denominator; displays are rounded half-up.';
const MONEY_NOTE = 'Refunds are operational context only; they never remove counted events or reduce the settled transaction count.';

class ShapeError extends Error {
  constructor(path, message) {
    super(message);
    this.path = path;
  }
}

function need(condition, path, message) {
  if (!condition) throw new ShapeError(path, message);
}

function same(actual, expected, path, message) {
  need(canonicalJson(actual) === canonicalJson(expected), path, message);
}

function exactKeys(value, keys, path) {
  need(isPlainObject(value), path, 'Expected an object.');
  const errors = [];
  checkKeys(value, keys, [], path, errors);
  need(errors.length === 0, errors[0]?.path ?? path, 'Unknown or missing field.');
}

function boundedArray(value, path) {
  need(Array.isArray(value) && value.length <= IMPORT_LIMITS.MAX_ROWS, path, `Expected an array of at most ${IMPORT_LIMITS.MAX_ROWS} entries.`);
}

function textOk(value, path, max = IMPORT_LIMITS.MAX_STRING_CHARS) {
  need(checkText(value, path, [], max), path, 'Expected bounded inert text.');
}

function idOk(value, path, pattern = ID_PATTERN) {
  need(checkPattern(value, pattern, ERROR_CODE.INVALID_ID, 'identifier', path, []), path, 'Invalid identifier.');
}

function hexOk(value, path) {
  need(typeof value === 'string' && HEX64.test(value), path, 'Expected a lowercase SHA-256 hex fingerprint.');
}

function notEvaluatedBody(reason) {
  return {
    rule: null,
    evaluation: {
      state: EVALUATION_STATE.NOT_EVALUATED, notEvaluatedReason: reason, numerator: null, denominator: null,
      ratio: null, threshold: null, thresholdComparison: null,
    },
    numeratorWindow: null,
    denominatorWindow: null,
    contributions: { events: [], byTransaction: [], byCategory: [], byType: { DISPUTE: 0, FRAUD: 0 }, uniqueTransactionIds: [] },
    exclusions: { events: [], transactions: [] },
    money: null,
    warnings: [{ code: WARNING_CODE.IMPORTED_DATA_COMPLETENESS_UNVERIFIED, message: WARNING_TEXT[WARNING_CODE.IMPORTED_DATA_COMPLETENESS_UNVERIFIED] }],
  };
}

function windowsOf(rule, window) {
  return {
    numeratorWindow: { dateField: rule.windowDateField, start: window.start, end: window.end },
    denominatorWindow: { dateField: 'TRANSACTION_SETTLED_DATE', status: 'SETTLED', start: window.start, end: window.end },
  };
}

/** Summaries derived only from the counted events (shared by evaluation and verification). */
function contributionsOf(counted) {
  const perTxn = new Map();
  const inDenominator = new Map();
  const perCategory = new Map();
  const byType = { DISPUTE: 0, FRAUD: 0 };
  for (const ev of counted) {
    perTxn.set(ev.transactionId, (perTxn.get(ev.transactionId) ?? 0) + 1);
    inDenominator.set(ev.transactionId, ev.transactionInDenominator);
    perCategory.set(ev.category, (perCategory.get(ev.category) ?? 0) + 1);
    byType[ev.eventType] += 1;
  }
  const uniqueTransactionIds = [...perTxn.keys()].sort(cmp);
  return {
    events: counted,
    byTransaction: uniqueTransactionIds.map((id) => ({ transactionId: id, eventCount: perTxn.get(id), inDenominator: inDenominator.get(id) })),
    byCategory: [...perCategory.keys()].sort(cmp).map((category) => ({ category, count: perCategory.get(category) })),
    byType,
    uniqueTransactionIds,
  };
}

function numeratorOf(rule, contributions) {
  return rule.numeratorDefinition === 'UNIQUE_TRANSACTION_COUNT' ? contributions.uniqueTransactionIds.length : contributions.events.length;
}

function evaluationOf(rule, numerator, denominator) {
  let state;
  let ratio = null;
  let thresholdComparison = null;
  if (denominator === 0) {
    state = EVALUATION_STATE.UNDEFINED_INSUFFICIENT_DENOMINATOR;
  } else {
    const c = compareRationals(numerator, denominator, rule.illustrativeThresholdBps, 10000);
    state = c >= 0 ? EVALUATION_STATE.ILLUSTRATIVE_ALERT : EVALUATION_STATE.BELOW_ILLUSTRATIVE_THRESHOLD;
    thresholdComparison = c > 0 ? 'ABOVE' : c === 0 ? 'EQUAL' : 'BELOW';
    ratio = ratioDisplay(numerator, denominator);
  }
  return {
    state,
    notEvaluatedReason: null,
    numeratorDefinition: rule.numeratorDefinition,
    denominatorDefinition: rule.denominatorDefinition,
    numerator,
    denominator,
    ratio,
    threshold: { bps: rule.illustrativeThresholdBps, fraction: `${rule.illustrativeThresholdBps}/10000`, label: 'Illustrative fictional threshold' },
    thresholdComparison,
    comparisonMethod: COMPARISON_METHOD,
  };
}

function warningsOf(evaluation, excludedEvents, counted) {
  const warnings = [];
  const warn = (code) => warnings.push({ code, message: WARNING_TEXT[code] });
  if (evaluation.denominator === 0) {
    warn(evaluation.numerator > 0 ? WARNING_CODE.EVENTS_WITHOUT_SETTLED_DENOMINATOR : WARNING_CODE.EMPTY_PERIOD_NOT_ALL_CLEAR);
  }
  if (excludedEvents.some((e) => e.reason === EXCLUSION_REASON.STATUS_NOT_INCLUDED_BY_RULE)) warn(WARNING_CODE.EVENTS_EXCLUDED_BY_STATUS_POLICY);
  if (counted.some((e) => !e.transactionInDenominator)) warn(WARNING_CODE.NUMERATOR_EVENT_ON_OUT_OF_WINDOW_SALE);
  warn(WARNING_CODE.IMPORTED_DATA_COMPLETENESS_UNVERIFIED);
  return warnings;
}

function moneyOf(settledGrossCents, refunds) {
  let refundTotalCents = 0;
  for (const r of refunds) refundTotalCents = checkedAdd(refundTotalCents, r.amountCents);
  return {
    currency: CURRENCY,
    settledGrossCents,
    settledGrossUsd: formatCents(settledGrossCents),
    refundTotalCents,
    refundTotalUsd: formatCents(refundTotalCents),
    refunds,
    note: MONEY_NOTE,
  };
}

/** Common event fields; returns the inclusion list that applies to the event's type. */
function checkEventShape(e, path, extraKey, rule, seen) {
  exactKeys(e, [...EVENT_KEYS, extraKey], path);
  need(e.eventType === EVENT_TYPE.DISPUTE || e.eventType === EVENT_TYPE.FRAUD, `${path}/eventType`, 'Unknown event type.');
  idOk(e.eventId, `${path}/eventId`);
  idOk(e.transactionId, `${path}/transactionId`);
  need(isValidDate(e.reportedDate), `${path}/reportedDate`, 'Expected a YYYY-MM-DD date.');
  const isDispute = e.eventType === EVENT_TYPE.DISPUTE;
  need(typeof e.status === 'string' && (isDispute ? DISPUTE_STATUS : FRAUD_STATUS).includes(e.status), `${path}/status`, 'Unknown event status.');
  if (isDispute) idOk(e.category, `${path}/category`, CATEGORY_PATTERN);
  else need(e.category === 'fraud', `${path}/category`, 'Fraud events use the fixed category "fraud".');
  need(e.windowDate === null || isValidDate(e.windowDate), `${path}/windowDate`, 'Expected a YYYY-MM-DD date or null.');
  if (rule.windowDateField === 'EVENT_REPORTED_DATE') need(e.windowDate === e.reportedDate, `${path}/windowDate`, 'Window date must be the reported date under this rule.');
  const key = eventKey(e);
  need(!seen.has(key), path, 'Event appears more than once.');
  seen.add(key);
  return isDispute ? rule.includedDisputeStatuses : rule.includedFraudStatuses;
}

function checkEventOrder(list, path) {
  for (let i = 1; i < list.length; i += 1) {
    need((cmp(list[i - 1].eventType, list[i].eventType) || cmp(list[i - 1].eventId, list[i].eventId)) < 0, `${path}/${i}`, 'Events must be sorted by type then id.');
  }
}

function checkSnapshotStructure(s) {
  exactKeys(s, SNAPSHOT_KEYS, '');
  hexOk(s.snapshotId, '/snapshotId');
  need(s.engineContractVersion === ENGINE_CONTRACT_VERSION, '/engineContractVersion', 'Unsupported engine contract version.');
  need(s.dataClassification === DATA_CLASSIFICATION, '/dataClassification', 'Only SYNTHETIC data is supported.');
  same(s.labels, { chart: CHART_LABEL, synthetic: SYNTHETIC_LABEL, policyDisclaimer: POLICY_DISCLAIMER }, '/labels', 'Required labels are missing or altered.');
  same(s.limitations, LIMITATIONS, '/limitations', 'Required limitations are missing or altered.');

  exactKeys(s.scenario, ['policySetId', 'scenarioName'], '/scenario');
  idOk(s.scenario.policySetId, '/scenario/policySetId');
  textOk(s.scenario.scenarioName, '/scenario/scenarioName');

  exactKeys(s.scope, ['merchantId', 'region', 'currency', 'period', 'window'], '/scope');
  idOk(s.scope.merchantId, '/scope/merchantId');
  idOk(s.scope.region, '/scope/region', REGION_PATTERN);
  need(s.scope.currency === CURRENCY, '/scope/currency', 'Unsupported currency.');
  const window = periodWindow(s.scope.period);
  need(window !== null, '/scope/period', 'period must be YYYY-MM.');
  same(s.scope.window, window, '/scope/window', 'Scope window must be the calendar month of the period.');
  idOk(s.requestedRuleId, '/requestedRuleId');

  exactKeys(s.provenance, ['scopedDataSha256', 'policySetSha256', 'engineContractVersion', 'method'], '/provenance');
  hexOk(s.provenance.scopedDataSha256, '/provenance/scopedDataSha256');
  hexOk(s.provenance.policySetSha256, '/provenance/policySetSha256');
  need(s.provenance.engineContractVersion === ENGINE_CONTRACT_VERSION, '/provenance/engineContractVersion', 'Unsupported engine contract version.');
  need(s.provenance.method === PROVENANCE_METHOD, '/provenance/method', 'Unexpected provenance method.');

  boundedArray(s.notes, '/notes');
  if (s.parentSnapshotId === null) need(s.notes.length === 0, '/parentSnapshotId', 'Annotated snapshots must link their parent snapshot.');
  else {
    hexOk(s.parentSnapshotId, '/parentSnapshotId');
    need(s.notes.length > 0, '/parentSnapshotId', 'Only annotated snapshots have a parent snapshot.');
  }
  for (let i = 0; i < s.notes.length; i += 1) {
    const n = s.notes[i];
    const p = `/notes/${i}`;
    exactKeys(n, ['author', 'recordedOn', 'text', 'inert'], p);
    idOk(n.author, `${p}/author`);
    need(isValidDate(n.recordedOn), `${p}/recordedOn`, 'Expected a YYYY-MM-DD date.');
    textOk(n.text, `${p}/text`, IMPORT_LIMITS.MAX_NOTE_CHARS);
    need(n.text.trim() !== '', `${p}/text`, 'Note text must not be blank.');
    need(n.inert === true, `${p}/inert`, 'Notes are always inert data.');
  }

  if (s.rule === null) {
    need(isPlainObject(s.evaluation), '/evaluation', 'Expected an object.');
    const reasons = [NOT_EVALUATED_REASON.NO_RULE_COVERAGE, NOT_EVALUATED_REASON.PARTIAL_RULE_COVERAGE, NOT_EVALUATED_REASON.RULE_REGION_MISMATCH];
    need(reasons.includes(s.evaluation.notEvaluatedReason), '/evaluation/notEvaluatedReason', 'Unknown not-evaluated reason.');
    const body = notEvaluatedBody(s.evaluation.notEvaluatedReason);
    for (const key of Object.keys(body)) same(s[key], body[key], `/${key}`, 'Does not match the not-evaluated snapshot shape.');
    return;
  }

  const ruleErrors = [];
  const rule = validateRule(s.rule, '/rule', ruleErrors);
  need(rule !== null, ruleErrors[0]?.path ?? '/rule', 'Invalid rule.');
  same(s.rule, rule, '/rule', 'Rule status lists must be in canonical sorted order.');
  need(rule.id === s.requestedRuleId, '/rule/id', 'Rule id must match the requested rule id.');
  need(rule.region === s.scope.region, '/rule/region', 'Rule region must match the scoped merchant region.');
  need(rule.effectiveFrom <= window.start && (rule.effectiveTo === null || rule.effectiveTo >= window.end), '/rule', 'Rule must fully cover the scoped period.');
  const windows = windowsOf(rule, window);
  same(s.numeratorWindow, windows.numeratorWindow, '/numeratorWindow', 'Numerator window does not match rule and period.');
  same(s.denominatorWindow, windows.denominatorWindow, '/denominatorWindow', 'Denominator window does not match the period.');

  exactKeys(s.contributions, ['events', 'byTransaction', 'byCategory', 'byType', 'uniqueTransactionIds'], '/contributions');
  exactKeys(s.exclusions, ['events', 'transactions'], '/exclusions');
  const counted = s.contributions.events;
  const excluded = s.exclusions.events;
  const excludedTxns = s.exclusions.transactions;
  boundedArray(counted, '/contributions/events');
  boundedArray(excluded, '/exclusions/events');
  boundedArray(excludedTxns, '/exclusions/transactions');

  const excludedTxnIds = new Set();
  for (let i = 0; i < excludedTxns.length; i += 1) {
    const t = excludedTxns[i];
    const p = `/exclusions/transactions/${i}`;
    exactKeys(t, ['transactionId', 'status', 'settledDate', 'reason'], p);
    idOk(t.transactionId, `${p}/transactionId`);
    need(!excludedTxnIds.has(t.transactionId), p, 'Transaction appears more than once.');
    excludedTxnIds.add(t.transactionId);
    need(typeof t.status === 'string' && TRANSACTION_STATUS.includes(t.status), `${p}/status`, 'Unknown transaction status.');
    need(t.settledDate === null || isValidDate(t.settledDate), `${p}/settledDate`, 'Expected a YYYY-MM-DD date or null.');
    if (t.status === 'SETTLED') {
      need(t.reason === EXCLUSION_REASON.TRANSACTION_SETTLED_OUTSIDE_WINDOW && t.settledDate !== null && !inWindow(t.settledDate, window),
        `${p}/reason`, 'A settled transaction is only excluded when it settled outside the window.');
    } else {
      need(t.reason === EXCLUSION_REASON.TRANSACTION_NOT_SETTLED, `${p}/reason`, 'Unsettled transactions are excluded as not settled.');
    }
  }

  const seen = new Set();
  const flagByTxn = new Map();
  for (let i = 0; i < counted.length; i += 1) {
    const e = counted[i];
    const p = `/contributions/events/${i}`;
    const included = checkEventShape(e, p, 'transactionInDenominator', rule, seen);
    need(e.windowDate !== null && inWindow(e.windowDate, window), `${p}/windowDate`, 'Counted events must fall inside the numerator window.');
    need(included.includes(e.status), `${p}/status`, 'Counted event status is not included by the rule.');
    need(typeof e.transactionInDenominator === 'boolean', `${p}/transactionInDenominator`, 'Expected a boolean.');
    need(e.transactionInDenominator === !excludedTxnIds.has(e.transactionId), `${p}/transactionInDenominator`,
      'Denominator membership must be exactly the complement of the excluded transactions.');
    if (rule.windowDateField === 'TRANSACTION_SETTLED_DATE') need(e.transactionInDenominator, `${p}/transactionInDenominator`, 'Settled-date windows only count in-window settled sales.');
    need(!flagByTxn.has(e.transactionId) || flagByTxn.get(e.transactionId) === e.transactionInDenominator, `${p}/transactionInDenominator`,
      'Events on one transaction must agree on denominator membership.');
    flagByTxn.set(e.transactionId, e.transactionInDenominator);
  }
  checkEventOrder(counted, '/contributions/events');
  for (let i = 0; i < excluded.length; i += 1) {
    const e = excluded[i];
    const p = `/exclusions/events/${i}`;
    const included = checkEventShape(e, p, 'reason', rule, seen);
    if (e.reason === EXCLUSION_REASON.WINDOW_DATE_UNAVAILABLE) {
      need(e.windowDate === null && rule.windowDateField === 'TRANSACTION_SETTLED_DATE', `${p}/reason`, 'Window date is only unavailable for settled-date windows.');
    } else if (e.reason === EXCLUSION_REASON.EVENT_OUTSIDE_WINDOW) {
      need(e.windowDate !== null && !inWindow(e.windowDate, window), `${p}/reason`, 'Event is not outside the window.');
    } else {
      need(e.reason === EXCLUSION_REASON.STATUS_NOT_INCLUDED_BY_RULE && e.windowDate !== null && inWindow(e.windowDate, window)
        && !included.includes(e.status), `${p}/reason`, 'Exclusion reason does not match the event and rule.');
    }
  }
  checkEventOrder(excluded, '/exclusions/events');

  need(isPlainObject(s.evaluation), '/evaluation', 'Expected an object.');
  const { denominator } = s.evaluation;
  need(Number.isSafeInteger(denominator) && denominator >= 0 && denominator <= IMPORT_LIMITS.MAX_ROWS, '/evaluation/denominator',
    `Denominator must be an integer 0..${IMPORT_LIMITS.MAX_ROWS}.`);
  const inDenominatorTxns = [...flagByTxn.values()].filter(Boolean).length;
  need(inDenominatorTxns <= denominator, '/evaluation/denominator', 'Denominator is smaller than the counted in-window settled transactions.');
  const contributions = contributionsOf(counted);
  same(s.contributions, contributions, '/contributions', 'Contribution summaries must equal those derived from the counted events.');
  const evaluation = evaluationOf(rule, numeratorOf(rule, contributions), denominator);
  same(s.evaluation, evaluation, '/evaluation', 'Evaluation must equal the exact result derived from counted events, denominator and rule.');

  exactKeys(s.money, ['currency', 'settledGrossCents', 'settledGrossUsd', 'refundTotalCents', 'refundTotalUsd', 'refunds', 'note'], '/money');
  const gross = s.money.settledGrossCents;
  need(Number.isSafeInteger(gross) && gross >= 0 && gross <= denominator * MAX_AMOUNT_CENTS, '/money/settledGrossCents',
    'Settled gross must be non-negative integer cents bounded by the denominator.');
  boundedArray(s.money.refunds, '/money/refunds');
  const refundIds = new Set();
  for (let i = 0; i < s.money.refunds.length; i += 1) {
    const r = s.money.refunds[i];
    const p = `/money/refunds/${i}`;
    exactKeys(r, ['refundId', 'transactionId', 'reportedDate', 'amountCents', 'amountUsd'], p);
    idOk(r.refundId, `${p}/refundId`);
    need(!refundIds.has(r.refundId), p, 'Refund appears more than once.');
    refundIds.add(r.refundId);
    idOk(r.transactionId, `${p}/transactionId`);
    need(isValidDate(r.reportedDate) && inWindow(r.reportedDate, window), `${p}/reportedDate`, 'Refunds must be reported inside the window.');
    need(Number.isSafeInteger(r.amountCents) && r.amountCents >= 0 && r.amountCents <= MAX_AMOUNT_CENTS, `${p}/amountCents`, 'Invalid refund amount.');
    need(r.amountUsd === formatCents(r.amountCents), `${p}/amountUsd`, 'Refund display amount must match its cents.');
  }
  same(s.money, moneyOf(gross, s.money.refunds), '/money', 'Money totals must equal those derived from the listed amounts.');
  same(s.warnings, warningsOf(evaluation, excluded, counted), '/warnings', 'Warnings must equal those derived from the evaluation.');
}

function selectRule(rules, ruleId, region, window) {
  const sameId = rules.filter((r) => r.id === ruleId);
  if (sameId.length === 0) return { reason: NOT_EVALUATED_REASON.NO_RULE_COVERAGE };
  const scoped = sameId.filter((r) => r.region === region);
  if (scoped.length === 0) return { reason: NOT_EVALUATED_REASON.RULE_REGION_MISMATCH };
  const intersecting = scoped.filter((r) => r.effectiveFrom <= window.end && (r.effectiveTo === null || r.effectiveTo >= window.start));
  if (intersecting.length === 0) return { reason: NOT_EVALUATED_REASON.NO_RULE_COVERAGE };
  const full = intersecting.filter((r) => r.effectiveFrom <= window.start && (r.effectiveTo === null || r.effectiveTo >= window.end));
  if (intersecting.length !== 1 || full.length !== 1) return { reason: NOT_EVALUATED_REASON.PARTIAL_RULE_COVERAGE };
  return { rule: full[0] };
}

const WARNING_TEXT = {
  [WARNING_CODE.EVENTS_WITHOUT_SETTLED_DENOMINATOR]:
    'Events counted but zero settled transactions in the denominator window: ratio undefined; investigate missing settlements.',
  [WARNING_CODE.EMPTY_PERIOD_NOT_ALL_CLEAR]:
    'No settled transactions and no counted events: insufficient data, not an all-clear.',
  [WARNING_CODE.EVENTS_EXCLUDED_BY_STATUS_POLICY]:
    'Some events were excluded because the explicit rule status lists do not include their status.',
  [WARNING_CODE.NUMERATOR_EVENT_ON_OUT_OF_WINDOW_SALE]:
    'Some counted events reference sales outside the denominator window (deliberate fictional report-date definition).',
  [WARNING_CODE.IMPORTED_DATA_COMPLETENESS_UNVERIFIED]:
    'Only imported records are represented; network-reported events missing from exports are not visible.',
};

function evaluate(ds, merchantId, rule, window) {
  const txns = ds.transactions.filter((t) => t.merchantId === merchantId);
  const txnById = new Map(txns.map((t) => [t.id, t]));
  const excludedTransactions = [];
  const denominatorIds = new Set();
  let settledGrossCents = 0;
  for (const t of txns) {
    let reason = null;
    if (t.status !== 'SETTLED') reason = EXCLUSION_REASON.TRANSACTION_NOT_SETTLED;
    else if (!inWindow(t.settledDate, window)) reason = EXCLUSION_REASON.TRANSACTION_SETTLED_OUTSIDE_WINDOW;
    if (reason) {
      excludedTransactions.push({ transactionId: t.id, status: t.status, settledDate: t.settledDate, reason });
    } else {
      denominatorIds.add(t.id);
      settledGrossCents = checkedAdd(settledGrossCents, t.amountCents);
    }
  }
  const events = [
    ...ds.disputes.filter((e) => e.merchantId === merchantId).map((e) => ({
      eventType: EVENT_TYPE.DISPUTE, eventId: e.id, transactionId: e.transactionId,
      reportedDate: e.reportedDate, category: e.category, status: e.status,
    })),
    ...ds.fraudEvents.filter((e) => e.merchantId === merchantId).map((e) => ({
      eventType: EVENT_TYPE.FRAUD, eventId: e.id, transactionId: e.transactionId,
      reportedDate: e.reportedDate, category: 'fraud', status: e.status,
    })),
  ].sort((a, b) => cmp(a.eventType, b.eventType) || cmp(a.eventId, b.eventId));
  const counted = [];
  const excludedEvents = [];
  for (const ev of events) {
    const txn = txnById.get(ev.transactionId);
    let windowDate = ev.reportedDate;
    if (rule.windowDateField === 'TRANSACTION_SETTLED_DATE') windowDate = txn.status === 'SETTLED' ? txn.settledDate : null;
    const included = ev.eventType === EVENT_TYPE.DISPUTE ? rule.includedDisputeStatuses : rule.includedFraudStatuses;
    let reason = null;
    if (windowDate === null) reason = EXCLUSION_REASON.WINDOW_DATE_UNAVAILABLE;
    else if (!inWindow(windowDate, window)) reason = EXCLUSION_REASON.EVENT_OUTSIDE_WINDOW;
    else if (!included.includes(ev.status)) reason = EXCLUSION_REASON.STATUS_NOT_INCLUDED_BY_RULE;
    if (reason) excludedEvents.push({ ...ev, windowDate, reason });
    else counted.push({ ...ev, windowDate, transactionInDenominator: denominatorIds.has(ev.transactionId) });
  }
  const contributions = contributionsOf(counted);
  const evaluation = evaluationOf(rule, numeratorOf(rule, contributions), denominatorIds.size);
  const refunds = ds.refunds.filter((r) => r.merchantId === merchantId && inWindow(r.reportedDate, window))
    .map((r) => ({ refundId: r.id, transactionId: r.transactionId, reportedDate: r.reportedDate, amountCents: r.amountCents, amountUsd: formatCents(r.amountCents) }));
  return {
    evaluation,
    ...windowsOf(rule, window),
    contributions,
    exclusions: { events: excludedEvents, transactions: excludedTransactions },
    money: moneyOf(settledGrossCents, refunds),
    warnings: warningsOf(evaluation, excludedEvents, counted),
  };
}

/**
 * Fingerprint of only this merchant's records, so a merchant-scoped snapshot never changes
 * (or signals anything) when another tenant's data changes.
 */
function scopedDataSha256(ds, merchantId) {
  const mine = (r) => r.merchantId === merchantId;
  return sha256Hex(canonicalJson({
    merchant: ds.merchants.find((m) => m.id === merchantId),
    transactions: ds.transactions.filter(mine),
    disputes: ds.disputes.filter(mine),
    fraudEvents: ds.fraudEvents.filter(mine),
    refunds: ds.refunds.filter(mine),
  }));
}

/**
 * Evaluates one merchant/month under one policy set and returns an immutable, content-addressed
 * snapshot. Errors: invalid input -> {ok:false}; invalid policy -> {ok:false, evaluationState:NOT_EVALUATED}.
 */
export function createSnapshot(options) {
  if (!isPlainObject(options)) return fail([err(ERROR_CODE.INVALID_TYPE, 'Options must be an object.', '')]);
  const errors = [];
  checkKeys(options, ['dataset', 'policySet', 'merchantId', 'period', 'session'], ['ruleId'], '', errors);
  if (errors.length > 0) return fail(errors);
  const denied = checkSession(options.session, options.merchantId);
  if (denied) return fail([denied]);
  const window = periodWindow(options.period);
  if (!window) return fail([err(ERROR_CODE.INVALID_PERIOD, 'period must be YYYY-MM.', '/period')]);
  const ds = validateDataset(options.dataset);
  if (!ds.ok) return ds;
  const merchant = ds.dataset.merchants.find((m) => m.id === options.merchantId);
  if (!merchant) return fail([err(ERROR_CODE.UNKNOWN_MERCHANT, 'Merchant is not in the dataset.', '/merchantId')]);
  const ps = validatePolicySet(options.policySet);
  if (!ps.ok) {
    return {
      ok: false,
      evaluationState: EVALUATION_STATE.NOT_EVALUATED,
      notEvaluatedReason: NOT_EVALUATED_REASON.INVALID_RULE_POLICY,
      errors: ps.errors,
    };
  }
  const policySet = ps.policySet;
  const ruleIds = [...new Set(policySet.rules.map((r) => r.id))];
  let ruleId = options.ruleId;
  if (ruleId === undefined) {
    if (ruleIds.length !== 1) return fail([err(ERROR_CODE.UNKNOWN_RULE, 'Policy set has several rule ids; ruleId is required.', '/ruleId')]);
    [ruleId] = ruleIds;
  } else if (!checkPattern(ruleId, ID_PATTERN, ERROR_CODE.INVALID_ID, 'rule id', '/ruleId', errors)) return fail(errors);

  const selected = selectRule(policySet.rules, ruleId, merchant.region, window);
  const base = {
    schemaVersion: SCHEMA_VERSIONS.SNAPSHOT,
    engineContractVersion: ENGINE_CONTRACT_VERSION,
    dataClassification: DATA_CLASSIFICATION,
    labels: { chart: CHART_LABEL, synthetic: SYNTHETIC_LABEL, policyDisclaimer: POLICY_DISCLAIMER },
    limitations: LIMITATIONS,
    scenario: { policySetId: policySet.policySetId, scenarioName: policySet.scenarioName },
    scope: { merchantId: merchant.id, region: merchant.region, currency: merchant.currency, period: options.period, window },
    requestedRuleId: ruleId,
    provenance: {
      scopedDataSha256: scopedDataSha256(ds.dataset, merchant.id),
      policySetSha256: sha256Hex(canonicalJson(policySet)),
      engineContractVersion: ENGINE_CONTRACT_VERSION,
      method: PROVENANCE_METHOD,
    },
    parentSnapshotId: null,
    notes: [],
  };
  if (!selected.rule) {
    return { ok: true, snapshot: seal({ ...base, ...notEvaluatedBody(selected.reason) }) };
  }
  return { ok: true, snapshot: seal({ ...base, rule: selected.rule, ...evaluate(ds.dataset, merchant.id, selected.rule, window) }) };
}

function eventKey(e) {
  return `${e.eventType}:${e.eventId}`;
}

function ratioDifference(a, b) {
  if (a.evaluation.ratio === null || b.evaluation.ratio === null) return null;
  return rationalDifferenceBps(b.evaluation.numerator, b.evaluation.denominator, a.evaluation.numerator, a.evaluation.denominator);
}

/**
 * Explains the delta between two snapshots of the same merchant/period (e.g. after a late-event
 * re-import). Both snapshots stay unchanged.
 */
export function diffSnapshots(fromInput, toInput) {
  const checked = [];
  for (const s of [fromInput, toInput]) {
    const v = verifiedSnapshot(s);
    if (v.error) return fail([v.error]);
    checked.push(v.snapshot);
  }
  const [from, to] = checked;
  if (from.scope.merchantId !== to.scope.merchantId || from.scope.period !== to.scope.period) {
    return fail([err(ERROR_CODE.SNAPSHOT_MISMATCH, 'Snapshots must share merchant and period scope.')]);
  }
  const fromKeys = new Set(from.contributions.events.map(eventKey));
  const toKeys = new Set(to.contributions.events.map(eventKey));
  const addedEvents = to.contributions.events.filter((e) => !fromKeys.has(eventKey(e)));
  const removedEvents = from.contributions.events.filter((e) => !toKeys.has(eventKey(e)));
  const delta = (a, b) => (a === null || b === null ? null : b - a);
  const explanation = [
    ...addedEvents.map((e) => `${eventKey(e)} (transaction ${e.transactionId}, reported ${e.reportedDate}) is newly counted.`),
    ...removedEvents.map((e) => `${eventKey(e)} is no longer counted.`),
  ];
  if (from.provenance.scopedDataSha256 !== to.provenance.scopedDataSha256) explanation.push('Imported data for this merchant changed.');
  if (from.provenance.policySetSha256 !== to.provenance.policySetSha256) explanation.push('Policy set changed (separately named scenario).');
  return {
    ok: true,
    diff: deepFreeze({
      fromSnapshotId: from.snapshotId,
      toSnapshotId: to.snapshotId,
      scope: { merchantId: to.scope.merchantId, period: to.scope.period },
      numerator: { from: from.evaluation.numerator, to: to.evaluation.numerator, delta: delta(from.evaluation.numerator, to.evaluation.numerator) },
      denominator: { from: from.evaluation.denominator, to: to.evaluation.denominator, delta: delta(from.evaluation.denominator, to.evaluation.denominator) },
      state: { from: from.evaluation.state, to: to.evaluation.state },
      ratioDifference: ratioDifference(from, to),
      addedEvents,
      removedEvents,
      explanation,
    }),
  };
}

/**
 * Runs a baseline and a separately named scenario policy set on the same scoped data.
 * Each result is its own immutable snapshot with its own provenance.
 */
export function compareScenarios(options) {
  if (!isPlainObject(options)) return fail([err(ERROR_CODE.INVALID_TYPE, 'Options must be an object.', '')]);
  const errors = [];
  checkKeys(options, ['dataset', 'merchantId', 'period', 'session', 'baselinePolicySet', 'scenarioPolicySet'], ['ruleId'], '', errors);
  if (errors.length > 0) return fail(errors);
  const run = (policySet) => createSnapshot({
    dataset: options.dataset, policySet, merchantId: options.merchantId, period: options.period, session: options.session,
    ...(has(options, 'ruleId') ? { ruleId: options.ruleId } : {}),
  });
  const baseline = run(options.baselinePolicySet);
  if (!baseline.ok) return baseline;
  const scenario = run(options.scenarioPolicySet);
  if (!scenario.ok) return scenario;
  const b = baseline.snapshot;
  const s = scenario.snapshot;
  if (b.scenario.policySetId === s.scenario.policySetId || b.scenario.scenarioName === s.scenario.scenarioName) {
    return fail([err(ERROR_CODE.INVALID_RULE, 'Scenario must be a separately named policy set (distinct id and name).')]);
  }
  const keys = (snap) => new Set(snap.contributions.events.map(eventKey));
  const bk = keys(b);
  const sk = keys(s);
  return {
    ok: true,
    comparison: deepFreeze({
      label: CHART_LABEL,
      baseline: b,
      scenario: s,
      numeratorDelta: b.evaluation.numerator === null || s.evaluation.numerator === null ? null : s.evaluation.numerator - b.evaluation.numerator,
      ratioDifference: ratioDifference(b, s),
      eventsCountedOnlyInBaseline: [...bk].filter((k) => !sk.has(k)).sort(cmp),
      eventsCountedOnlyInScenario: [...sk].filter((k) => !bk.has(k)).sort(cmp),
      note: 'Scenario rules are fictional alternatives; they never rewrite the baseline snapshot.',
    }),
  };
}

const QUERY_KEYS = ['eventType', 'category', 'status', 'month', 'transactionId', 'search', 'sortBy', 'order'];
const SORT_KEYS = ['reportedDate', 'eventId', 'transactionId', 'category', 'eventType'];

/** Search/sort/filter over the counted events of one snapshot (scoped to the snapshot's merchant). */
export function queryContributions(input, query = {}) {
  const v = verifiedSnapshot(input);
  if (v.error) return fail([v.error]);
  const { snapshot } = v;
  if (!isPlainObject(query)) return fail([err(ERROR_CODE.INVALID_TYPE, 'Query must be an object.', '')]);
  const errors = [];
  checkKeys(query, [], QUERY_KEYS, '', errors);
  for (const k of Object.keys(query)) if (QUERY_KEYS.includes(k)) checkText(query[k], `/${k}`, errors);
  if (has(query, 'sortBy') && !SORT_KEYS.includes(query.sortBy)) errors.push(err(ERROR_CODE.INVALID_ENUM, `sortBy must be one of ${SORT_KEYS.join(', ')}.`, '/sortBy'));
  if (has(query, 'order') && !['asc', 'desc'].includes(query.order)) errors.push(err(ERROR_CODE.INVALID_ENUM, 'order must be asc or desc.', '/order'));
  if (has(query, 'month') && !periodWindow(query.month)) errors.push(err(ERROR_CODE.INVALID_PERIOD, 'month must be YYYY-MM.', '/month'));
  if (errors.length > 0) return fail(errors);
  const needle = has(query, 'search') ? query.search.toLowerCase() : null;
  const monthWindow = has(query, 'month') ? periodWindow(query.month) : null;
  const sortBy = query.sortBy ?? 'reportedDate';
  const dir = query.order === 'desc' ? -1 : 1;
  const results = snapshot.contributions.events.filter((e) => (!has(query, 'eventType') || e.eventType === query.eventType)
    && (!has(query, 'category') || e.category === query.category)
    && (!has(query, 'status') || e.status === query.status)
    && (!has(query, 'transactionId') || e.transactionId === query.transactionId)
    && (!monthWindow || inWindow(e.reportedDate, monthWindow))
    && (!needle || [e.eventId, e.transactionId, e.category, e.status, e.eventType].some((v) => v.toLowerCase().includes(needle))))
    .sort((a, b) => dir * (cmp(a[sortBy], b[sortBy]) || cmp(a.eventType, b.eventType) || cmp(a.eventId, b.eventId)));
  return { ok: true, total: results.length, results: deepFreeze(results.map((e) => ({ ...e }))) };
}

/**
 * Records an inert remediation note by producing a NEW snapshot (parentSnapshotId links history).
 * Note text is stored verbatim as data; it is never executed, rendered as HTML or evaluated.
 */
export function addRemediationNote(input, note, session) {
  const v = verifiedSnapshot(input);
  if (v.error) return fail([v.error]);
  const { snapshot } = v;
  const denied = checkSession(session, snapshot.scope.merchantId);
  if (denied) return fail([denied]);
  if (snapshot.notes.length >= IMPORT_LIMITS.MAX_ROWS) {
    return fail([err(ERROR_CODE.INVALID_NOTE, `A snapshot holds at most ${IMPORT_LIMITS.MAX_ROWS} notes.`, '/note')]);
  }
  if (!isPlainObject(note)) return fail([err(ERROR_CODE.INVALID_NOTE, 'Note must be an object.', '/note')]);
  const errors = [];
  checkKeys(note, ['author', 'text', 'recordedOn'], [], '/note', errors);
  if (errors.length > 0) return fail(errors);
  checkPattern(note.author, ID_PATTERN, ERROR_CODE.INVALID_ID, 'author id', '/note/author', errors);
  if (checkText(note.text, '/note/text', errors, IMPORT_LIMITS.MAX_NOTE_CHARS) && note.text.trim() === '') {
    errors.push(err(ERROR_CODE.INVALID_NOTE, 'Note text must not be blank.', '/note/text'));
  }
  if (typeof note.recordedOn !== 'string' || !isValidDate(note.recordedOn)) {
    errors.push(err(ERROR_CODE.INVALID_DATE, 'recordedOn must be a caller-supplied YYYY-MM-DD date.', '/note/recordedOn'));
  }
  if (errors.length > 0) return fail(errors);
  const content = contentOf(snapshot);
  return {
    ok: true,
    snapshot: seal({
      ...content,
      parentSnapshotId: snapshot.snapshotId,
      notes: [...snapshot.notes, { author: note.author, recordedOn: note.recordedOn, text: note.text, inert: true }],
    }),
  };
}

export { checkSession, verifiedSnapshot };
