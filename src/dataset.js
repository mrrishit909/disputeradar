// Dataset schema validation, strict JSON/CSV import, idempotent merge and canonical export.
// Records are rebuilt field-by-field into fresh frozen objects; raw input is never spread.
import {
  CATEGORY_PATTERN,
  CSV_IMPORT_COLUMNS,
  CSV_RECORD_TYPES,
  CURRENCY,
  DATA_CLASSIFICATION,
  DATA_ORIGIN,
  DISPUTE_STATUS,
  ERROR_CODE,
  FRAUD_STATUS,
  ID_PATTERN,
  IMPORT_LIMITS,
  MAX_AMOUNT_CENTS,
  REGION_PATTERN,
  SCHEMA_VERSIONS,
  TRANSACTION_STATUS,
  deepFreeze,
} from './constants.js';
import {
  canonicalJson,
  checkKeys,
  checkPattern,
  checkText,
  cmp,
  csvRow,
  decodeUpload,
  err,
  fail,
  has,
  isPlainObject,
  isSensitiveName,
  isValidDate,
  parseCsv,
  safeKey,
  sha256Hex,
} from './primitives.js';

export const COLLECTIONS = deepFreeze(['merchants', 'transactions', 'disputes', 'fraudEvents', 'refunds']);

const SHAPES = {
  merchants: { required: ['id', 'region', 'currency'], optional: [] },
  transactions: { required: ['id', 'merchantId', 'settledDate', 'amountCents', 'status'], optional: [] },
  disputes: { required: ['id', 'transactionId', 'reportedDate', 'category', 'status'], optional: ['merchantId'] },
  fraudEvents: { required: ['id', 'transactionId', 'reportedDate', 'status'], optional: ['merchantId'] },
  refunds: { required: ['id', 'transactionId', 'reportedDate', 'amountCents'], optional: ['merchantId'] },
};

// ---------- Field checks ----------
function checkId(value, path, errors) {
  return checkPattern(value, ID_PATTERN, ERROR_CODE.INVALID_ID, 'identifier', path, errors);
}

function checkAmount(value, path, errors) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    errors.push(err(ERROR_CODE.INVALID_AMOUNT,
      'Amount must be a safe integer number of USD cents (no fractions, strings, exponents beyond integers or unsafe values).', path));
    return false;
  }
  if (value < 1 || value > MAX_AMOUNT_CENTS) {
    errors.push(err(ERROR_CODE.AMOUNT_OUT_OF_RANGE, `Amount must be between 1 and ${MAX_AMOUNT_CENTS} cents.`, path));
    return false;
  }
  return true;
}

function checkDate(value, path, errors, nullable = false) {
  if (value === null && nullable) return true;
  if (typeof value !== 'string') {
    errors.push(err(ERROR_CODE.INVALID_DATE, 'Expected a YYYY-MM-DD calendar date string.', path));
    return false;
  }
  if (!checkText(value, path, errors)) return false;
  if (!isValidDate(value)) {
    errors.push(err(ERROR_CODE.INVALID_DATE,
      'Expected a valid YYYY-MM-DD calendar date (no time, offset, whitespace or impossible day).', path));
    return false;
  }
  return true;
}

function checkEnum(value, allowed, path, errors) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push(err(ERROR_CODE.INVALID_ENUM, `Expected one of ${allowed.join(', ')}.`, path));
    return false;
  }
  return true;
}

const BUILDERS = {
  merchants(row, path, errors) {
    let ok = checkId(row.id, `${path}/id`, errors);
    ok = checkPattern(row.region, REGION_PATTERN, ERROR_CODE.INVALID_REGION, 'region', `${path}/region`, errors) && ok;
    if (checkText(row.currency, `${path}/currency`, errors)) {
      if (row.currency !== CURRENCY) {
        errors.push(err(ERROR_CODE.UNSUPPORTED_CURRENCY, 'Only USD is supported in v1; no automatic FX.', `${path}/currency`));
        ok = false;
      }
    } else ok = false;
    return ok ? { id: row.id, region: row.region, currency: row.currency } : null;
  },
  transactions(row, path, errors) {
    let ok = checkId(row.id, `${path}/id`, errors);
    ok = checkId(row.merchantId, `${path}/merchantId`, errors) && ok;
    ok = checkDate(row.settledDate, `${path}/settledDate`, errors, true) && ok;
    ok = checkAmount(row.amountCents, `${path}/amountCents`, errors) && ok;
    const statusOk = checkEnum(row.status, TRANSACTION_STATUS, `${path}/status`, errors);
    ok = statusOk && ok;
    if (statusOk && row.status === 'SETTLED' && row.settledDate === null) {
      errors.push(err(ERROR_CODE.SETTLED_DATE_REQUIRED,
        'SETTLED transactions require a valid settledDate; null is permitted only for PENDING/VOID.', `${path}/settledDate`));
      ok = false;
    }
    return ok ? {
      id: row.id, merchantId: row.merchantId, settledDate: row.settledDate, amountCents: row.amountCents, status: row.status,
    } : null;
  },
  disputes(row, path, errors) {
    let ok = eventCommon(row, path, errors);
    ok = checkPattern(row.category, CATEGORY_PATTERN, ERROR_CODE.INVALID_CATEGORY, 'category', `${path}/category`, errors) && ok;
    ok = checkEnum(row.status, DISPUTE_STATUS, `${path}/status`, errors) && ok;
    return ok ? {
      id: row.id, merchantId: ownMerchant(row), transactionId: row.transactionId,
      reportedDate: row.reportedDate, category: row.category, status: row.status,
    } : null;
  },
  fraudEvents(row, path, errors) {
    let ok = eventCommon(row, path, errors);
    ok = checkEnum(row.status, FRAUD_STATUS, `${path}/status`, errors) && ok;
    return ok ? {
      id: row.id, merchantId: ownMerchant(row), transactionId: row.transactionId, reportedDate: row.reportedDate, status: row.status,
    } : null;
  },
  refunds(row, path, errors) {
    let ok = eventCommon(row, path, errors);
    ok = checkAmount(row.amountCents, `${path}/amountCents`, errors) && ok;
    return ok ? {
      id: row.id, merchantId: ownMerchant(row), transactionId: row.transactionId,
      reportedDate: row.reportedDate, amountCents: row.amountCents,
    } : null;
  },
};

// Own-property read only: an inherited (polluted) merchantId must never be trusted.
function ownMerchant(row) {
  return has(row, 'merchantId') ? row.merchantId : undefined;
}

function eventCommon(row, path, errors) {
  let ok = checkId(row.id, `${path}/id`, errors);
  ok = checkId(row.transactionId, `${path}/transactionId`, errors) && ok;
  ok = checkDate(row.reportedDate, `${path}/reportedDate`, errors) && ok;
  if (has(row, 'merchantId')) ok = checkId(row.merchantId, `${path}/merchantId`, errors) && ok;
  return ok;
}

// ---------- Dataset validation ----------
/**
 * Validates an untrusted dataset object and returns a normalized, id-sorted, deep-frozen copy.
 * @returns {{ok:true,dataset:object}|{ok:false,errors:object[]}}
 */
export function validateDataset(input) {
  if (!isPlainObject(input)) return fail([err(ERROR_CODE.INVALID_TYPE, 'Dataset must be a JSON object.', '')]);
  const errors = [];
  checkKeys(input, ['schemaVersion', 'dataClassification', ...COLLECTIONS], [], '', errors);
  if (has(input, 'schemaVersion') && input.schemaVersion !== SCHEMA_VERSIONS.DATASET_JSON) {
    errors.push(err(ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION, `schemaVersion must be ${SCHEMA_VERSIONS.DATASET_JSON}.`, '/schemaVersion'));
  }
  if (has(input, 'dataClassification') && input.dataClassification !== DATA_CLASSIFICATION) {
    errors.push(err(ERROR_CODE.UNSUPPORTED_CLASSIFICATION, 'Only SYNTHETIC data is accepted.', '/dataClassification'));
  }
  let rowCount = 0;
  for (const c of COLLECTIONS) {
    if (!has(input, c)) continue;
    if (!Array.isArray(input[c])) errors.push(err(ERROR_CODE.INVALID_TYPE, 'Expected an array of records.', `/${c}`));
    else rowCount += input[c].length;
  }
  if (rowCount > IMPORT_LIMITS.MAX_ROWS) {
    return fail([err(ERROR_CODE.TOO_MANY_ROWS, `Dataset exceeds ${IMPORT_LIMITS.MAX_ROWS} records.`, '')]);
  }
  if (errors.length > 0) return fail(errors);

  const built = {};
  for (const c of COLLECTIONS) {
    built[c] = [];
    const rows = input[c];
    for (let i = 0; i < rows.length; i += 1) {
      const path = `/${c}/${i}`;
      const row = rows[i];
      if (!isPlainObject(row)) {
        errors.push(err(ERROR_CODE.INVALID_TYPE, 'Record must be a JSON object.', path));
        continue;
      }
      const before = errors.length;
      checkKeys(row, SHAPES[c].required, SHAPES[c].optional, path, errors);
      if (errors.length > before) continue;
      const rec = BUILDERS[c](row, path, errors);
      if (rec) built[c].push({ rec, path });
    }
  }
  // Record-level errors first: reference checks against partially valid data would only add noise.
  if (errors.length > 0) return fail(errors);

  // Event IDs are unique per source type; a dispute and a fraud event may share an id.
  const index = {};
  for (const c of COLLECTIONS) {
    index[c] = new Map();
    for (const { rec, path } of built[c]) {
      if (index[c].has(rec.id)) {
        errors.push(err(ERROR_CODE.DUPLICATE_ID, `Duplicate ${c} id within one import; records are never double counted.`, `${path}/id`));
      } else index[c].set(rec.id, rec);
    }
  }
  for (const { rec, path } of built.transactions) {
    if (!index.merchants.has(rec.merchantId)) {
      errors.push(err(ERROR_CODE.UNKNOWN_REFERENCE, 'Transaction references a merchant that is not imported.', `${path}/merchantId`));
    }
  }
  const refundTotals = new Map();
  for (const c of ['disputes', 'fraudEvents', 'refunds']) {
    for (const item of built[c]) {
      const { rec, path } = item;
      const txn = index.transactions.get(rec.transactionId);
      if (!txn) {
        errors.push(err(ERROR_CODE.UNKNOWN_REFERENCE,
          'Referenced transaction is not imported. The record is rejected, not dropped: import the historical transaction even when it is outside the denominator window.',
          `${path}/transactionId`));
        continue;
      }
      if (rec.merchantId !== undefined && rec.merchantId !== txn.merchantId) {
        errors.push(err(ERROR_CODE.CROSS_MERCHANT_REFERENCE,
          'Record merchantId does not match the merchant of the referenced transaction.', `${path}/merchantId`));
        continue;
      }
      if (txn.settledDate !== null && rec.reportedDate < txn.settledDate) {
        errors.push(err(ERROR_CODE.INVALID_DATE, 'reportedDate precedes the referenced transaction settledDate.', `${path}/reportedDate`));
        continue;
      }
      rec.merchantId = txn.merchantId;
      if (c === 'refunds') refundTotals.set(txn.id, (refundTotals.get(txn.id) ?? 0) + rec.amountCents);
    }
  }
  for (const [txnId, total] of refundTotals) {
    const txn = index.transactions.get(txnId);
    if (total > txn.amountCents) {
      const at = built.transactions.find((t) => t.rec.id === txnId).path;
      errors.push(err(ERROR_CODE.REFUND_EXCEEDS_TRANSACTION,
        'Cumulative refunds for this transaction exceed its amount; partial/multiple refunds must total <= amount.', at));
    }
  }
  if (errors.length > 0) return fail(errors);

  const dataset = { schemaVersion: SCHEMA_VERSIONS.DATASET_JSON, dataClassification: DATA_CLASSIFICATION };
  for (const c of COLLECTIONS) dataset[c] = built[c].map((b) => b.rec).sort((a, b) => cmp(a.id, b.id));
  return { ok: true, dataset: deepFreeze(dataset) };
}

// ---------- Byte handling and provenance ----------
function toText(input) {
  if (typeof input === 'string') {
    if (input.length > IMPORT_LIMITS.MAX_UPLOAD_BYTES) {
      return fail([err(ERROR_CODE.INPUT_TOO_LARGE, `Upload exceeds ${IMPORT_LIMITS.MAX_UPLOAD_BYTES} bytes (1 MiB).`)]);
    }
    return withBytes(new TextEncoder().encode(input));
  }
  return withBytes(input);
}

function withBytes(bytes) {
  const decoded = decodeUpload(bytes);
  return decoded.ok ? { ok: true, text: decoded.text, bytes } : decoded;
}

function provenance(format, bytes, dataset) {
  let rows = 0;
  for (const c of COLLECTIONS) rows += dataset[c].length;
  return deepFreeze({
    format,
    // Every import is user-supplied. The file's own classification is reported as a claim only.
    dataOrigin: DATA_ORIGIN.UNVERIFIED_USER_SUPPLIED,
    declaredDataClassification: DATA_CLASSIFICATION,
    inputSha256: sha256Hex(bytes),
    inputBytes: bytes.byteLength,
    datasetSha256: datasetSha256(dataset),
    recordCount: rows,
    note: 'Input hash identifies the exact upload; datasetSha256 identifies the normalized content (row-order independent). '
      + 'declaredDataClassification is self-asserted by the file and is not verified.',
  });
}

/** Fingerprint of the normalized dataset (independent of input row order). */
export function datasetSha256(dataset) {
  return sha256Hex(canonicalJson(dataset));
}

/**
 * Strict JSON import from a UTF-8 Uint8Array or string (<= 1 MiB, <= 5000 records).
 * Note: JSON.parse keeps the last value of a duplicated key; duplicate keys are not detected.
 */
export function importDatasetJson(input) {
  const decoded = toText(input);
  if (!decoded.ok) return decoded;
  let parsed;
  try {
    parsed = JSON.parse(decoded.text);
  } catch {
    return fail([err(ERROR_CODE.MALFORMED_JSON, 'Upload is not well-formed JSON.')]);
  }
  const result = validateDataset(parsed);
  if (!result.ok) return result;
  return { ok: true, dataset: result.dataset, provenance: provenance('JSON', decoded.bytes, result.dataset) };
}

// ---------- CSV ----------
const CSV_COLLECTION = {
  MERCHANT: 'merchants', TRANSACTION: 'transactions', DISPUTE: 'disputes', FRAUD: 'fraudEvents', REFUND: 'refunds',
};
const CSV_TYPE_OF = Object.fromEntries(Object.entries(CSV_COLLECTION).map(([k, v]) => [v, k]));
/** column -> [field, mode]; mode: required | optional (omit when empty) | nullable (null when empty) | amount */
const CSV_FIELDS = {
  MERCHANT: { id: ['id', 'required'], region: ['region', 'required'], currency: ['currency', 'required'] },
  TRANSACTION: {
    id: ['id', 'required'], merchant_id: ['merchantId', 'required'], settled_date: ['settledDate', 'nullable'],
    amount_cents: ['amountCents', 'amount'], status: ['status', 'required'],
  },
  DISPUTE: {
    id: ['id', 'required'], merchant_id: ['merchantId', 'optional'], transaction_id: ['transactionId', 'required'],
    reported_date: ['reportedDate', 'required'], category: ['category', 'required'], status: ['status', 'required'],
  },
  FRAUD: {
    id: ['id', 'required'], merchant_id: ['merchantId', 'optional'], transaction_id: ['transactionId', 'required'],
    reported_date: ['reportedDate', 'required'], status: ['status', 'required'],
  },
  REFUND: {
    id: ['id', 'required'], merchant_id: ['merchantId', 'optional'], transaction_id: ['transactionId', 'required'],
    reported_date: ['reportedDate', 'required'], amount_cents: ['amountCents', 'amount'],
  },
};
const META_COLUMNS = new Set(['schema_version', 'data_classification', 'record_type']);

/** Strict CSV import (RFC 4180 subset, exact known header, <= 1 MiB, <= 5000 data rows). */
export function importDatasetCsv(input) {
  const decoded = toText(input);
  if (!decoded.ok) return decoded;
  const parsed = parseCsv(decoded.text);
  if (!parsed.ok) return parsed;
  const [header, ...rows] = parsed.rows;
  if (rows.length > IMPORT_LIMITS.MAX_ROWS) {
    return fail([err(ERROR_CODE.TOO_MANY_ROWS, `CSV exceeds ${IMPORT_LIMITS.MAX_ROWS} data rows.`)]);
  }
  const errors = [];
  const seen = new Set();
  header.forEach((name, i) => {
    const path = `/csv/header/${i}`;
    if (seen.has(name)) errors.push(err(ERROR_CODE.DUPLICATE_COLUMN, `Duplicate column "${safeKey(name)}".`, path));
    else if (!CSV_IMPORT_COLUMNS.includes(name)) {
      errors.push(isSensitiveName(name)
        ? err(ERROR_CODE.SENSITIVE_FIELD_REJECTED, 'Cardholder-data style column is never accepted (no PAN/CVV/expiry).', path)
        : err(ERROR_CODE.UNKNOWN_COLUMN, `Unknown column "${safeKey(name)}".`, path));
    }
    seen.add(name);
  });
  for (const col of CSV_IMPORT_COLUMNS) {
    if (!seen.has(col)) errors.push(err(ERROR_CODE.MISSING_COLUMN, `Missing column "${col}".`, '/csv/header'));
  }
  if (errors.length > 0) return fail(errors);

  const object = { schemaVersion: SCHEMA_VERSIONS.DATASET_JSON, dataClassification: DATA_CLASSIFICATION };
  const rowNumbers = {};
  for (const c of COLLECTIONS) { object[c] = []; rowNumbers[c] = []; }
  rows.forEach((cells, r) => {
    const rowNo = r + 1;
    const path = `/csv/row/${rowNo}`;
    if (cells.length !== header.length) {
      errors.push(err(ERROR_CODE.MALFORMED_CSV, `Row has ${cells.length} cells; header has ${header.length}.`, path));
      return;
    }
    const cell = Object.create(null);
    header.forEach((name, i) => { cell[name] = cells[i]; });
    if (cell.schema_version !== SCHEMA_VERSIONS.DATASET_CSV) {
      errors.push(err(ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION, `schema_version must be ${SCHEMA_VERSIONS.DATASET_CSV}.`, `${path}/schema_version`));
    }
    if (cell.data_classification !== DATA_CLASSIFICATION) {
      errors.push(err(ERROR_CODE.UNSUPPORTED_CLASSIFICATION, 'Only SYNTHETIC data is accepted.', `${path}/data_classification`));
    }
    if (!CSV_RECORD_TYPES.includes(cell.record_type)) {
      errors.push(err(ERROR_CODE.INVALID_ENUM, `record_type must be one of ${CSV_RECORD_TYPES.join(', ')}.`, `${path}/record_type`));
      return;
    }
    const fields = CSV_FIELDS[cell.record_type];
    const rec = {};
    for (const name of header) {
      if (META_COLUMNS.has(name)) continue;
      const value = cell[name];
      const spec = fields[name];
      if (!spec) {
        if (value !== '') errors.push(err(ERROR_CODE.FIELD_NOT_APPLICABLE, `Column "${name}" must be empty for ${cell.record_type} rows.`, `${path}/${name}`));
        continue;
      }
      const [field, mode] = spec;
      if (value === '') {
        if (mode === 'nullable') rec[field] = null;
        else if (mode !== 'optional') errors.push(err(ERROR_CODE.MISSING_FIELD, `Column "${name}" is required for ${cell.record_type} rows.`, `${path}/${name}`));
      } else if (mode === 'amount') {
        rec[field] = /^(0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : value;
      } else rec[field] = value;
    }
    const c = CSV_COLLECTION[cell.record_type];
    object[c].push(rec);
    rowNumbers[c].push(rowNo);
  });
  if (errors.length > 0) return fail(errors);
  const result = validateDataset(object);
  if (!result.ok) {
    return fail(result.errors.map((e) => {
      const m = /^\/(merchants|transactions|disputes|fraudEvents|refunds)\/([0-9]+)(.*)$/.exec(e.path ?? '');
      return m ? { ...e, path: `/csv/row/${rowNumbers[m[1]][Number(m[2])]}${m[3]}` } : e;
    }));
  }
  return { ok: true, dataset: result.dataset, provenance: provenance('CSV', decoded.bytes, result.dataset) };
}

function requireValid(dataset) {
  const v = validateDataset(dataset);
  if (!v.ok) throw new TypeError(`Invalid dataset: ${v.errors.map((e) => e.code).join(', ')}`);
  return v.dataset;
}

/** Canonical (sorted keys, id-sorted rows) JSON export; re-importable byte-for-byte. */
export function datasetToJson(dataset) {
  return `${canonicalJson(requireValid(dataset))}\n`;
}

/** CSV export in the import schema (quote-all, CRLF); re-importable. */
export function datasetToCsv(dataset) {
  const ds = requireValid(dataset);
  const lines = [csvRow(CSV_IMPORT_COLUMNS)];
  for (const c of COLLECTIONS) {
    const type = CSV_TYPE_OF[c];
    const fields = CSV_FIELDS[type];
    for (const rec of ds[c]) {
      lines.push(csvRow(CSV_IMPORT_COLUMNS.map((col) => {
        if (col === 'schema_version') return SCHEMA_VERSIONS.DATASET_CSV;
        if (col === 'data_classification') return DATA_CLASSIFICATION;
        if (col === 'record_type') return type;
        const spec = fields[col];
        if (!spec) return '';
        const v = rec[spec[0]];
        return v === null || v === undefined ? '' : String(v);
      })));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Merges a validated addition into a validated base. Identical re-imported records are idempotent
 * no-ops; a differing record with an existing id is rejected (never overwritten, never double counted).
 */
export function mergeDatasets(base, addition) {
  const a = validateDataset(base);
  if (!a.ok) return a;
  const b = validateDataset(addition);
  if (!b.ok) return b;
  const errors = [];
  const merged = { schemaVersion: SCHEMA_VERSIONS.DATASET_JSON, dataClassification: DATA_CLASSIFICATION };
  const added = [];
  const unchanged = [];
  for (const c of COLLECTIONS) {
    const map = new Map(a.dataset[c].map((r) => [r.id, r]));
    b.dataset[c].forEach((r, i) => {
      const existing = map.get(r.id);
      if (!existing) {
        map.set(r.id, r);
        added.push({ collection: c, id: r.id });
      } else if (canonicalJson(existing) === canonicalJson(r)) {
        unchanged.push({ collection: c, id: r.id });
      } else {
        errors.push(err(ERROR_CODE.CONFLICTING_DUPLICATE_ID,
          `Re-imported ${c} record differs from the existing record with the same id; existing records are never overwritten.`,
          `/${c}/${i}/id`));
      }
    });
    merged[c] = [...map.values()];
  }
  if (errors.length > 0) return fail(errors);
  const v = validateDataset(merged);
  if (!v.ok) return v;
  return { ok: true, dataset: v.dataset, merge: deepFreeze({ added, unchanged }) };
}
