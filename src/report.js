// Safe, session-scoped JSON/CSV report exports of an immutable snapshot, and tamper-checked JSON parse.
import {
  CHART_LABEL,
  CSV_EXPORT_COLUMNS,
  DATA_CLASSIFICATION,
  DATA_ORIGIN,
  ERROR_CODE,
  IMPORT_LIMITS,
  LEGACY_SCHEMA_VERSIONS,
  ORIGIN_LABELS,
  ORIGIN_NOTICE,
  POLICY_DISCLAIMER,
  SCHEMA_VERSIONS,
  SYNTHETIC_LABEL,
  deepFreeze,
} from './constants.js';
import { canonicalJson, csvRow, err, escapeFormula, fail, formatCents, isPlainObject } from './primitives.js';
import { checkSession, upconvertV1Snapshot, verifiedSnapshot, verifySnapshot } from './engine.js';

/** Returns {blocked} or the verified plain-data copy; exporters read only that copy. */
function guard(input, session) {
  const v = verifiedSnapshot(input);
  if (v.error) return { blocked: fail([v.error]) };
  const denied = checkSession(session, v.snapshot.scope.merchantId);
  return denied ? { blocked: fail([denied]) } : { snapshot: v.snapshot };
}

/** Escapes characters that could break out of an HTML <script> context; JSON.parse restores them. */
const HTML_UNSAFE = new RegExp('[<>&\\u2028\\u2029]', 'g');
function htmlSafeJson(text) {
  return text.replace(HTML_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Exports exactly the scoped snapshot (same snapshotId) as canonical, HTML-safe JSON (report v2).
 * The envelope origin fields are copied from the verified snapshot, whose bundled origin (if any)
 * was attested by verifiedSnapshot; they are never derived from data content.
 */
export function serializeReportJson(input, session) {
  const { blocked, snapshot } = guard(input, session);
  if (blocked) return blocked;
  const doc = {
    schemaVersion: SCHEMA_VERSIONS.REPORT,
    dataOrigin: snapshot.dataOrigin,
    dataOriginLabel: ORIGIN_LABELS[snapshot.dataOrigin],
    originNotice: ORIGIN_NOTICE,
    chartLabel: CHART_LABEL,
    policyDisclaimer: POLICY_DISCLAIMER,
    snapshot,
  };
  return { ok: true, text: `${htmlSafeJson(canonicalJson(doc))}\n` };
}

const REPORT_V2_KEYS = ['chartLabel', 'dataOrigin', 'dataOriginLabel', 'originNotice', 'policyDisclaimer', 'schemaVersion', 'snapshot'];
const REPORT_V1_KEYS = ['chartLabel', 'dataClassification', 'policyDisclaimer', 'schemaVersion', 'snapshot', 'syntheticLabel'];
const notReport = () => fail([err(ERROR_CODE.INVALID_REPORT, 'Not a DisputeRadar report document.')]);

/** Origin of anything read back from a report file: always unverified, whatever the file asserts. */
function parsedOrigin(reportSchemaVersion, assertedDataOrigin, legacySnapshotId) {
  return deepFreeze({
    effective: DATA_ORIGIN.UNVERIFIED_USER_SUPPLIED,
    label: ORIGIN_LABELS.UNVERIFIED_USER_SUPPLIED,
    notice: ORIGIN_NOTICE,
    reportSchemaVersion,
    assertedDataOrigin,
    legacySnapshotId,
    note: 'A parsed report is a file supplied to the app. Its origin assertion (and any v1 SYNTHETIC claim) is recorded but never trusted.',
  });
}

/**
 * Parses an exported JSON report and verifies the snapshot fingerprint and structure.
 * - report v2: exact envelope; envelope origin must match the snapshot. Returns the snapshot as-is.
 * - report v1 (legacy): exact v1 envelope, v1 hash verified, then upconverted to a v2 snapshot with
 *   origin UNVERIFIED_USER_SUPPLIED (new snapshotId); the v1 unconditional SYNTHETIC fields are discarded.
 * In both cases `origin.effective` is UNVERIFIED_USER_SUPPLIED. A returned snapshot that asserts the
 * bundled origin is still refused by every other API unless this app instance minted it.
 */
export function parseReportJson(text) {
  if (typeof text !== 'string') return fail([err(ERROR_CODE.INVALID_TYPE, 'Report must be a string.')]);
  if (text.length > IMPORT_LIMITS.MAX_REPORT_BYTES) return fail([err(ERROR_CODE.INPUT_TOO_LARGE, 'Report is too large.')]);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return fail([err(ERROR_CODE.MALFORMED_JSON, 'Report is not well-formed JSON.')]);
  }
  if (!isPlainObject(doc)) return notReport();
  const keys = Object.keys(doc).sort().join();
  if (doc.schemaVersion === SCHEMA_VERSIONS.REPORT) {
    if (keys !== REPORT_V2_KEYS.join() || typeof doc.dataOrigin !== 'string' || !Object.values(DATA_ORIGIN).includes(doc.dataOrigin)
      || doc.dataOriginLabel !== ORIGIN_LABELS[doc.dataOrigin] || doc.originNotice !== ORIGIN_NOTICE
      || doc.chartLabel !== CHART_LABEL || doc.policyDisclaimer !== POLICY_DISCLAIMER) return notReport();
    const bad = verifySnapshot(doc.snapshot);
    if (bad) return fail([bad]);
    if (doc.snapshot.dataOrigin !== doc.dataOrigin) return notReport();
    return { ok: true, snapshot: deepFreeze(doc.snapshot), origin: parsedOrigin(doc.schemaVersion, doc.dataOrigin, null) };
  }
  if (doc.schemaVersion === LEGACY_SCHEMA_VERSIONS.REPORT_V1) {
    if (keys !== REPORT_V1_KEYS.join() || doc.dataClassification !== DATA_CLASSIFICATION || doc.chartLabel !== CHART_LABEL
      || doc.syntheticLabel !== SYNTHETIC_LABEL || doc.policyDisclaimer !== POLICY_DISCLAIMER) return notReport();
    const up = upconvertV1Snapshot(doc.snapshot);
    if (up.error) return fail([up.error]);
    return { ok: true, snapshot: up.snapshot, origin: parsedOrigin(doc.schemaVersion, null, up.legacySnapshotId) };
  }
  return notReport();
}

/**
 * Exports the scoped snapshot as quote-all CRLF CSV. Text cells beginning with = + - @ tab CR LF
 * are prefixed with a single quote (formula-injection defence); count/amount cells are numeric only.
 */
export function serializeReportCsv(input, session) {
  const { blocked, snapshot: s } = guard(input, session);
  if (blocked) return blocked;
  const ev = s.evaluation;
  const base = {
    snapshot_id: s.snapshotId,
    merchant_id: s.scope.merchantId,
    period: s.scope.period,
    rule_id: s.rule ? s.rule.id : '',
    rule_version: s.rule ? String(s.rule.version) : '',
  };
  const rows = [];
  const add = (recordType, fields) => {
    const row = { ...base, record_type: recordType, ...fields };
    rows.push(CSV_EXPORT_COLUMNS.map((col) => {
      const v = row[col];
      if (v === undefined || v === null) return '';
      if (col === 'count') return String(v);
      if (col === 'amount_usd') return v;
      return escapeFormula(String(v));
    }));
  };
  add('LABEL', { metric: 'report_schema_version', text: SCHEMA_VERSIONS.REPORT_CSV });
  add('LABEL', { metric: 'data_origin', text: s.dataOrigin });
  add('LABEL', { metric: 'data_origin_label', text: ORIGIN_LABELS[s.dataOrigin] });
  add('LABEL', { metric: 'origin_notice', text: ORIGIN_NOTICE });
  add('LABEL', { metric: 'chart_label', text: CHART_LABEL });
  add('LABEL', { metric: 'policy_disclaimer', text: POLICY_DISCLAIMER });
  add('SUMMARY', { metric: 'scenario', text: `${s.scenario.policySetId}: ${s.scenario.scenarioName}` });
  add('SUMMARY', { metric: 'evaluation_state', text: ev.state, reason: ev.notEvaluatedReason });
  add('SUMMARY', { metric: 'numerator', count: ev.numerator, text: s.rule ? s.rule.numeratorDefinition : '' });
  add('SUMMARY', { metric: 'denominator', count: ev.denominator, text: s.rule ? s.rule.denominatorDefinition : '' });
  add('SUMMARY', { metric: 'ratio_fraction', text: ev.ratio ? ev.ratio.fraction : '' });
  add('SUMMARY', { metric: 'ratio_bps', text: ev.ratio ? ev.ratio.bps : '' });
  add('SUMMARY', { metric: 'ratio_percent_display', text: ev.ratio ? ev.ratio.percent : '' });
  add('SUMMARY', { metric: 'illustrative_threshold_bps', count: ev.threshold ? ev.threshold.bps : null });
  add('SUMMARY', { metric: 'threshold_comparison', text: ev.thresholdComparison });
  if (s.numeratorWindow) {
    add('SUMMARY', { metric: 'numerator_window', text: `${s.numeratorWindow.start}..${s.numeratorWindow.end} by ${s.numeratorWindow.dateField}` });
    add('SUMMARY', { metric: 'denominator_window', text: `${s.denominatorWindow.start}..${s.denominatorWindow.end} by ${s.denominatorWindow.dateField}` });
  }
  if (s.money) {
    add('SUMMARY', { metric: 'settled_gross', amount_usd: formatCents(s.money.settledGrossCents) });
    add('SUMMARY', { metric: 'refund_total', amount_usd: formatCents(s.money.refundTotalCents), text: s.money.note });
  }
  add('SUMMARY', { metric: 'scoped_data_sha256', text: s.provenance.scopedDataSha256 });
  add('SUMMARY', { metric: 'policy_set_sha256', text: s.provenance.policySetSha256 });
  for (const e of s.contributions.events) {
    add('CONTRIBUTING_EVENT', {
      subject_type: e.eventType, subject_id: e.eventId, transaction_id: e.transactionId, metric: e.category, count: 1,
      text: `${e.status} reported ${e.reportedDate}`,
    });
  }
  for (const t of s.contributions.byTransaction) {
    add('TRANSACTION_CONTRIBUTION', { subject_type: 'TRANSACTION', subject_id: t.transactionId, transaction_id: t.transactionId, metric: 'event_count', count: t.eventCount });
  }
  for (const c of s.contributions.byCategory) add('CATEGORY', { metric: c.category, count: c.count });
  for (const e of s.exclusions.events) {
    add('EXCLUDED_EVENT', {
      subject_type: e.eventType, subject_id: e.eventId, transaction_id: e.transactionId, reason: e.reason,
      text: `${e.status} reported ${e.reportedDate}`,
    });
  }
  for (const t of s.exclusions.transactions) {
    add('EXCLUDED_TRANSACTION', { subject_type: 'TRANSACTION', subject_id: t.transactionId, transaction_id: t.transactionId, reason: t.reason, text: t.status });
  }
  if (s.money) {
    for (const r of s.money.refunds) {
      add('REFUND', { subject_type: 'REFUND', subject_id: r.refundId, transaction_id: r.transactionId, amount_usd: r.amountUsd, text: `reported ${r.reportedDate}` });
    }
  }
  for (const w of s.warnings) add('WARNING', { reason: w.code, text: w.message });
  for (const l of s.limitations) add('LIMITATION', { text: l });
  for (const n of s.notes) add('NOTE', { subject_type: 'AUTHOR', subject_id: n.author, metric: n.recordedOn, text: n.text });
  return { ok: true, text: `${[csvRow(CSV_EXPORT_COLUMNS), ...rows.map(csvRow)].join('\r\n')}\r\n` };
}
