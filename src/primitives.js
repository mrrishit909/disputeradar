// Pure helpers: plain-object checks, calendar dates, cents, exact rationals, SHA-256,
// canonical JSON, RFC 4180 CSV and sensitive-value scanning. No clock, locale, I/O or floats.
import {
  ERROR_CODE,
  IMPORT_LIMITS,
  MAX_YEAR,
  MIN_YEAR,
  PERIOD_PATTERN,
  SENSITIVE_FIELD_PATTERN,
  CSV_FORMULA_TRIGGER_PREFIXES,
} from './constants.js';

// ---------- Results and errors ----------
/** @param {string} code @param {string} message @param {string} [path] */
export function err(code, message, path) {
  return path === undefined ? { code, message } : { code, message, path };
}

/** Deterministic, bounded, sorted error list; never includes offending raw values. */
export function fail(errors) {
  const sorted = [...errors].sort((a, b) =>
    cmp(a.path ?? '', b.path ?? '') || cmp(a.code, b.code) || cmp(a.message, b.message));
  return { ok: false, errors: sorted.slice(0, IMPORT_LIMITS.MAX_ERRORS_REPORTED) };
}

/** Code-unit string comparison (never localeCompare). */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------- Plain objects ----------
export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Checks own keys against an allowlist. `__proto__`, `constructor` etc. as own keys are
 * unknown fields; inherited properties never satisfy required fields.
 */
export function checkKeys(obj, required, optional, path, errors) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string') {
      errors.push(err(ERROR_CODE.UNKNOWN_FIELD, 'Symbol keys are not accepted.', path));
    } else if (!allowed.has(key)) {
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        errors.push(err(ERROR_CODE.SENSITIVE_FIELD_REJECTED,
          'Cardholder-data style field is never accepted (no PAN/CVV/expiry).', `${path}/${safeKey(key)}`));
      } else {
        errors.push(err(ERROR_CODE.UNKNOWN_FIELD, `Unknown field "${safeKey(key)}".`, `${path}/${safeKey(key)}`));
      }
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      errors.push(err(ERROR_CODE.MISSING_FIELD, `Missing required field "${key}".`, `${path}/${key}`));
    }
  }
}

/** Field names echoed in errors are truncated and stripped of control characters. */
export function safeKey(key) {
  const cleaned = String(key).replace(/[^\x20-\x7e]/g, '?');
  if (looksSensitiveValue(cleaned)) return '[redacted]';
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}...` : cleaned;
}

export function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ---------- Sensitive values ----------
function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** True when the text contains a 13-19 digit run (spaces/dashes allowed) that passes Luhn. */
export function containsPanLike(text) {
  const runs = text.match(/[0-9](?:[ -]?[0-9]){12,22}/g) ?? [];
  for (const run of runs) {
    const digits = run.replace(/[ -]/g, '');
    for (let len = 13; len <= 19; len += 1) {
      for (let start = 0; start + len <= digits.length; start += 1) {
        if (luhnValid(digits.slice(start, start + len))) return true;
      }
    }
  }
  return false;
}

const SECRET_PATTERNS = [
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(api[_-]?key|secret|password|passwd|token|client[_-]?secret)\s*[:=]\s*\S{6,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

export function containsSecretLike(text) {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

function looksSensitiveValue(text) {
  return containsPanLike(text) || containsSecretLike(text);
}

/**
 * Validates an inert bounded text value. Errors never echo the value (redaction).
 * @returns {boolean} true when acceptable
 */
export function checkText(value, path, errors, maxChars = IMPORT_LIMITS.MAX_STRING_CHARS) {
  if (typeof value !== 'string') {
    errors.push(err(ERROR_CODE.INVALID_TYPE, 'Expected a string.', path));
    return false;
  }
  if (value.length > maxChars) {
    errors.push(err(ERROR_CODE.STRING_TOO_LONG, `String exceeds ${maxChars} characters.`, path));
    return false;
  }
  if (containsPanLike(value)) {
    errors.push(err(ERROR_CODE.PAN_LIKE_VALUE_REJECTED,
      'Value resembles a card number (PAN); cardholder data is never accepted. Value redacted.', path));
    return false;
  }
  if (containsSecretLike(value)) {
    errors.push(err(ERROR_CODE.SECRET_LIKE_VALUE_REJECTED,
      'Value resembles a credential or secret; rejected and redacted.', path));
    return false;
  }
  return true;
}

/** Checks a value against a grammar after the generic text checks. */
export function checkPattern(value, pattern, code, label, path, errors) {
  if (!checkText(value, path, errors)) return false;
  if (!pattern.test(value)) {
    errors.push(err(code, `Invalid ${label}.`, path));
    return false;
  }
  return true;
}

// ---------- Dates (strings only; no Date object, so host timezone is irrelevant) ----------
function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Strict `YYYY-MM-DD` calendar date. Times, offsets, whitespace and 2026-02-30 are invalid. */
export function isValidDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/** `YYYY-MM` monthly period -> inclusive date window. */
export function periodWindow(period) {
  const m = typeof period === 'string' ? PERIOD_PATTERN.exec(period) : null;
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) return null;
  const end = `${period}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
  return { start: `${period}-01`, end };
}

/** Inclusive window membership by lexicographic comparison of validated dates. */
export function inWindow(date, window) {
  return date !== null && date >= window.start && date <= window.end;
}

// ---------- Money ----------
/** Integer cents -> `-?D.DD` string, by integer arithmetic only. */
export function formatCents(cents) {
  if (!Number.isSafeInteger(cents)) throw new TypeError('formatCents requires a safe integer');
  const neg = cents < 0;
  const abs = neg ? -cents : cents;
  const units = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${neg ? '-' : ''}${units}.${String(rem).padStart(2, '0')}`;
}

export function checkedAdd(a, b) {
  const s = a + b;
  if (!Number.isSafeInteger(s)) throw new RangeError('ARITHMETIC_OVERFLOW');
  return s;
}

// ---------- Exact rationals ----------
/**
 * Compares n1/d1 with n2/d2 exactly via BigInt cross-multiplication (d > 0).
 * @returns {-1|0|1}
 */
export function compareRationals(n1, d1, n2, d2) {
  for (const v of [n1, d1, n2, d2]) {
    if (!Number.isSafeInteger(v)) throw new TypeError('compareRationals requires safe integers');
  }
  if (d1 <= 0 || d2 <= 0) throw new RangeError('compareRationals requires positive denominators');
  const left = BigInt(n1) * BigInt(d2);
  const right = BigInt(n2) * BigInt(d1);
  return left < right ? -1 : left > right ? 1 : 0;
}

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Half-up (away from zero) division of BigInts, b > 0. */
function divHalfUp(a, b) {
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const q = (abs * 2n + b) / (2n * b);
  return neg ? -q : q;
}

function fixed2(hundredths) {
  const neg = hundredths < 0n;
  const abs = neg ? -hundredths : hundredths;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/**
 * Display-only rendering of n/d. Comparisons never use these strings.
 * @returns {{fraction:string, reduced:string, bps:string, percent:string, exactBps:boolean}|null}
 */
export function ratioDisplay(n, d) {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d)) throw new TypeError('ratioDisplay requires safe integers');
  if (d === 0) return null;
  if (d < 0) throw new RangeError('ratioDisplay requires a non-negative denominator');
  const N = BigInt(n);
  const D = BigInt(d);
  const g = gcd(N, D) || 1n;
  const scaledBps = N * 10000n;
  const exactBps = scaledBps % D === 0n;
  return {
    fraction: `${n}/${d}`,
    reduced: `${N / g}/${D / g}`,
    bps: exactBps ? `${scaledBps / D}` : fixed2(divHalfUp(N * 1000000n, D)),
    percent: `${fixed2(divHalfUp(N * 10000n, D))}%`,
    exactBps,
  };
}

/** Exact a/b - c/d expressed in bps for display, plus the exact rational. */
export function rationalDifferenceBps(a, b, c, d) {
  const num = BigInt(a) * BigInt(d) - BigInt(c) * BigInt(b);
  const den = BigInt(b) * BigInt(d);
  const scaled = num * 10000n;
  const exact = scaled % den === 0n;
  const g = gcd(num, den) || 1n;
  return {
    differenceFraction: `${num / g}/${den / g}`,
    bps: exact ? `${scaled / den}` : fixed2(divHalfUp(num * 1000000n, den)),
    exactBps: exact,
  };
}

// ---------- Canonical JSON and SHA-256 ----------
/** Sorted-key JSON with no whitespace; arrays keep their (already canonical) order. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('non-finite number');
    if (value === undefined) throw new TypeError('undefined is not canonical JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort(cmp);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** Synchronous pure SHA-256 of a UTF-8 string (or bytes), lowercase hex. */
export function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const bitLen = bytes.length * 8;
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

// ---------- Bytes ----------
/**
 * Size check before decoding, then fatal UTF-8 decode with one leading BOM stripped.
 * @returns {{ok:true,text:string}|{ok:false,errors:any[]}}
 */
export function decodeUpload(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return fail([err(ERROR_CODE.INVALID_TYPE, 'Upload must be a Uint8Array of bytes.')]);
  }
  if (bytes.byteLength > IMPORT_LIMITS.MAX_UPLOAD_BYTES) {
    return fail([err(ERROR_CODE.INPUT_TOO_LARGE, `Upload exceeds ${IMPORT_LIMITS.MAX_UPLOAD_BYTES} bytes (1 MiB).`)]);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail([err(ERROR_CODE.INVALID_UTF8, 'Upload is not valid UTF-8.')]);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { ok: true, text };
}

// ---------- CSV (RFC 4180 subset) ----------
/**
 * Parses CSV text: comma delimiter, `"` quoting with `""` escape, CRLF or LF, header required,
 * no blank data rows (one trailing newline allowed). Bare quotes inside unquoted cells fail.
 * @returns {{ok:true,rows:string[][]}|{ok:false,errors:any[]}}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let line = 1;
  const malformed = (msg) => fail([err(ERROR_CODE.MALFORMED_CSV, `${msg} (line ${line}).`)]);
  while (i <= text.length) {
    const atEnd = i === text.length;
    const ch = text[i];
    if (!atEnd && ch === '"' && cell === '') {
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          closed = true; i += 1; break;
        }
        if (text[i] === '\n') line += 1;
        cell += text[i];
        i += 1;
      }
      if (!closed) return malformed('Unterminated quoted cell');
      const next = text[i];
      if (i < text.length && next !== ',' && next !== '\n' && next !== '\r') {
        return malformed('Characters after closing quote');
      }
      continue;
    }
    if (atEnd || ch === ',' || ch === '\n' || ch === '\r') {
      row.push(cell);
      cell = '';
      if (atEnd || ch !== ',') {
        if (ch === '\r') {
          if (text[i + 1] !== '\n') return malformed('Bare carriage return');
          i += 1;
        }
        rows.push(row);
        row = [];
        if (!atEnd) line += 1;
        if (atEnd) break;
        if (i + 1 === text.length) break; // single trailing newline
      }
      i += 1;
      continue;
    }
    if (ch === '"') return malformed('Quote inside unquoted cell');
    cell += ch;
    i += 1;
  }
  if (rows.length === 0 || (rows.length === 1 && rows[0].length === 1 && rows[0][0] === '')) {
    return malformed('Empty CSV');
  }
  for (let r = 0; r < rows.length; r += 1) {
    if (rows[r].length === 1 && rows[r][0] === '') {
      return fail([err(ERROR_CODE.MALFORMED_CSV, `Blank row ${r + 1} is not allowed.`)]);
    }
  }
  return { ok: true, rows };
}

/** Neutralises spreadsheet formula triggers in a text cell (one-way, CSV export only). */
export function escapeFormula(text) {
  return CSV_FORMULA_TRIGGER_PREFIXES.some((p) => text.startsWith(p)) ? `'${text}` : text;
}

/** Quote-all CSV row with doubled quotes; CRLF line endings are added by the caller. */
export function csvRow(cells) {
  return cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',');
}
