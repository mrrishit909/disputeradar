// Local browser journey over the BUILT dist/ with dist/_headers sent as real HTTP headers, so the
// host CSP (including form-action 'none') is enforced. Uses the globally installed Playwright and its
// cached Chromium; binds 127.0.0.1 only; no other network. Exits non-zero on any failed check.
// Usage: node scripts/build.mjs && node scripts/browser-journey.mjs   (PLAYWRIGHT_MODULE overrides the module path)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const { parseReportJson } = await import(pathToFileURL(join(ROOT, 'src', 'index.js')));
const { parseCsv } = await import(pathToFileURL(join(ROOT, 'src', 'primitives.js')));
const pw = process.env.PLAYWRIGHT_MODULE ?? join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'playwright');
const { chromium } = createRequire(import.meta.url)(pw);

const headers = {};
for (const line of readFileSync(join(DIST, '_headers'), 'utf8').split('\n')) {
  const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
  if (m) headers[m[1]] = m[2];
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const target = normalize(join(DIST, p));
    if (!target.startsWith(DIST + sep) || !(await stat(target)).isFile()) throw new Error('no');
    res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(target));
  } catch { res.writeHead(404, headers); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', `${name}: ${e.message.replace(/\s+/g, ' ').slice(0, 400)}`]); }
}

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
page.on('framenavigated', (f) => { if (f === page.mainFrame() && !f.url().endsWith('/app/')) problems.push(`navigated: ${f.url()}`); });
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});

const ids = () => page.$$eval('#findings button', (bs) => bs.map((b) => b.textContent.split(' ')[1]));
const card = (label) => page.$$eval('#cards li', (lis, l) => lis.find((li) => li.querySelector('.k').textContent === l)?.querySelector('strong').textContent, label);
const text = (sel) => page.$eval(sel, (el) => el.textContent);
const rows = (sel) => page.$$eval(`${sel} li`, (lis) => lis.map((li) => li.textContent));
async function download(button) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(button)]);
  assert.equal(await dl.failure(), null);
  return { name: dl.suggestedFilename(), body: readFileSync(await dl.path(), 'utf8') };
}
const csvSummary = (body, metric) => {
  const [h, ...r] = parseCsv(body).rows;
  const c = Object.fromEntries(h.map((x, i) => [x, i]));
  const row = r.find((x) => x[c.record_type] === 'SUMMARY' && x[c.metric] === metric);
  return metric === 'ratio_bps' ? row[c.text] : row[c.count];
};

const res = await page.goto(`${base}/app/`);
let baselineId;
let newId;

await check('host CSP header enforced (form-action none, connect-src none)', async () => {
  const csp = res.headers()['content-security-policy'];
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /connect-src 'none'/);
});

await check('origin banner: idle before any run; notice disclaims content inspection', async () => {
  assert.match(await text('#origin-label'), /^No data loaded yet\./);
  assert.match(await text('#origin-notice'), /do not inspect content and cannot detect or prevent real, personal or sensitive data/);
});

await check('golden run: 5/10 = 5000 bps vs 2500 threshold', async () => {
  await page.selectOption('#fixture-select', 'M1_BASELINE');
  await page.click('#run');
  assert.match(await text('#origin-label'), /^BUNDLED SYNTHETIC DEMO - built-in fixture DR-SYN-001/);
  assert.equal(await card('Numerator (events)'), '5');
  assert.equal(await card('Denominator (settled sales)'), '10');
  assert.equal(await card('Ratio (bps)'), '5000');
  assert.equal(await card('Threshold (bps)'), '2500');
  assert.deepEqual(await ids(), ['D3', 'D1', 'D2', 'F1', 'F2']);
});

const SORTS = [
  ['category', ['D2', 'F1', 'F2', 'D1', 'D3']],
  ['transactionId', ['D3', 'D1', 'F1', 'D2', 'F2']],
  ['eventId', ['D1', 'D2', 'D3', 'F1', 'F2']],
  ['eventType', ['D1', 'D2', 'D3', 'F1', 'F2']],
  ['reportedDate', ['D3', 'D1', 'D2', 'F1', 'F2']],
];
for (const [sortBy, expected] of SORTS) {
  await check(`sort ${sortBy} renders literal order ${expected.join(',')}`, async () => {
    await page.selectOption('#f-sort', sortBy);
    assert.deepEqual(await ids(), expected);
  });
}

await check('filters change rendered results (category, type, search)', async () => {
  await page.selectOption('#f-category', 'product-not-received');
  assert.deepEqual(await ids(), ['D3', 'D1']);
  await page.selectOption('#f-category', '');
  await page.selectOption('#f-type', 'FRAUD');
  assert.deepEqual(await ids(), ['F1', 'F2']);
  await page.selectOption('#f-type', '');
  await page.fill('#f-search', 't3');
  assert.deepEqual(await ids(), ['F2']);
  await page.fill('#f-search', '');
  assert.deepEqual(await ids(), ['D3', 'D1', 'D2', 'F1', 'F2']);
});

await check('JSON + CSV downloads under CSP match the shown snapshot', async () => {
  const j = await download('#export-json');
  const parsed = parseReportJson(j.body);
  assert.equal(parsed.ok, true);
  baselineId = parsed.snapshot.snapshotId;
  assert.equal(parsed.snapshot.evaluation.numerator, 5);
  assert.equal(JSON.parse(j.body).dataOrigin, 'BUNDLED_SYNTHETIC_DEMO');
  assert.equal(parsed.origin.effective, 'UNVERIFIED_USER_SUPPLIED', 'a re-read report file is never trusted');
  assert.equal(j.name, `disputeradar-M1-2026-10-${baselineId.slice(0, 12)}.json`);
  const c = await download('#export-csv');
  assert.equal(c.name, `disputeradar-M1-2026-10-${baselineId.slice(0, 12)}.csv`);
  assert.equal(csvSummary(c.body, 'numerator'), '5');
  assert.equal(csvSummary(c.body, 'ratio_bps'), '5000');
});

await check('valid late-event reimport (form submit) shows a diffSnapshots delta and a new snapshot', async () => {
  await page.click('#ex-valid');
  await page.click('#reimport-run');
  assert.match(await text('#reimport-status'), /^Reimported JSON \(3 record\(s\), input sha256 [0-9a-f]{12}\)\. New snapshot [0-9a-f]{12} is now shown and exported\. Data origin: UNVERIFIED_USER_SUPPLIED\.$/);
  assert.match(await text('#origin-label'), /^UNVERIFIED USER-SUPPLIED DATA - /);
  assert.equal(await page.getAttribute('#origin-label', 'data-origin'), 'UNVERIFIED_USER_SUPPLIED');
  const d = await rows('#delta');
  assert.ok(d[0].startsWith(`Baseline snapshot ${baselineId.slice(0, 12)} is retained unchanged`), d[0]);
  assert.ok(d[0].endsWith('merchant M1, period 2026-10, rule DEMO-EVENT-COUNT v1.'), d[0]);
  assert.equal(d[1], 'Numerator 5 → 6 (delta +1); denominator 10 → 10 (delta 0).');
  assert.ok(d[2].startsWith('Ratio 5000 bps → 6000 bps; exact difference 1/10 (+1000 bps)'), d[2]);
  assert.ok(d.includes('DISPUTE:D5 (transaction T5, reported 2026-10-31) is newly counted.'));
  assert.ok(d.includes('Merge: 1 new record(s): disputes D5; 2 identical record(s) ignored as idempotent re-imports.'));
  assert.equal(await card('Numerator (events)'), '6');
  assert.equal(await card('Ratio (bps)'), '6000');
  assert.deepEqual(await ids(), ['D3', 'D1', 'D2', 'F1', 'D5', 'F2']);
});

await check('export after reimport carries the new snapshot (6/10) with the baseline id unchanged elsewhere', async () => {
  const j = await download('#export-json');
  const parsed = parseReportJson(j.body);
  newId = parsed.snapshot.snapshotId;
  assert.notEqual(newId, baselineId);
  assert.equal(parsed.snapshot.evaluation.numerator, 6);
  assert.equal(JSON.parse(j.body).dataOrigin, 'UNVERIFIED_USER_SUPPLIED');
  const csv = (await download('#export-csv')).body;
  assert.equal(csvSummary(csv, 'ratio_bps'), '6000');
  const [h, ...r] = parseCsv(csv).rows;
  const label = r.find((x) => x[h.indexOf('record_type')] === 'LABEL' && x[h.indexOf('metric')] === 'data_origin');
  assert.equal(label[h.indexOf('text')], 'UNVERIFIED_USER_SUPPLIED');
});

await check('same file again is idempotent: delta 0, numerator stays 6', async () => {
  await page.click('#ex-valid');
  await page.click('#reimport-run');
  const d = await rows('#delta');
  assert.equal(d[1], 'Numerator 6 → 6 (delta 0); denominator 10 → 10 (delta 0).');
  assert.ok(d.some((r) => r.startsWith('No counted event or scoped data changed')));
  assert.equal(await card('Numerator (events)'), '6');
});

for (const [name, fill, code] of [
  ['conflicting duplicate D1', '#ex-conflict', 'CONFLICTING_DUPLICATE_ID'],
  ['other-merchant (M2) records', '#ex-other', 'OUT_OF_SCOPE'],
  ['malformed JSON', null, 'MALFORMED_JSON'],
]) {
  await check(`invalid reimport (${name}) rejected; prior snapshot and delta preserved`, async () => {
    const before = await rows('#delta');
    if (fill) await page.click(fill); else await page.fill('#reimport-text', '{not json');
    await page.click('#reimport-run');
    const s = await text('#reimport-status');
    assert.ok(s.startsWith(`Reimport rejected: ${code}`), s);
    assert.ok(s.endsWith(`Current snapshot ${newId.slice(0, 12)} kept; no data changed.`), s);
    assert.deepEqual(await rows('#delta'), before);
    assert.equal(await card('Numerator (events)'), '6');
    assert.deepEqual(await ids(), ['D3', 'D1', 'D2', 'F1', 'D5', 'F2']);
    if (code === 'OUT_OF_SCOPE') assert.ok(!(await page.content()).includes('U9 on') && !(await ids()).includes('D9'));
  });
}

await check('note form submit under form-action none stays in-page', async () => {
  await page.fill('#note-text', 'Follow up on T5 late dispute.');
  await page.press('#note-text', 'Tab');
  await page.click('#note-add');
  assert.match(await text('#note-status'), /^Recorded in new snapshot [0-9a-f]{12} \(parent [0-9a-f]{12}\)/);
  assert.ok(page.url().endsWith('/app/'));
});

await check('compare rule2 after reimport uses the reimported data (4 -> 5 unique transactions)', async () => {
  await page.selectOption('#cmp-select', 'SCENARIO_V2_UNIQUE_TRANSACTION');
  await page.click('#cmp-run');
  const c = await rows('#cmp');
  assert.ok(c[0].includes('6/10 = 60.00% (6000 bps)'), c[0]);
  assert.ok(c[1].includes('5/10 = 50.00% (5000 bps)'), c[1]);
  assert.ok(c[0].startsWith('Baseline DEMO-EVENT-COUNT v1 (numerator counts events): '), c[0]);
  assert.ok(c[1].startsWith('Scenario DEMO-EVENT-COUNT v2 (numerator counts unique transactions): '), c[1]);
  assert.ok(c[2].startsWith('Numerator delta -1 (scenario unique transactions minus baseline events); '), c[2]);
});

await check('new run resets to the seeded fixture (5/10) and clears the delta', async () => {
  await page.click('#run');
  assert.equal(await card('Numerator (events)'), '5');
  assert.match(await text('#origin-label'), /^BUNDLED SYNTHETIC DEMO - /, 'Run control restores the bundled fixture origin');
  assert.deepEqual(await rows('#delta'), []);
  assert.equal(await text('#reimport-status'), '');
  assert.equal(await text('#note-status'), '', 'no stale note status from the previous snapshot');
});

await check('v2 run labels its numerator as unique transactions (4/10); compare vs v1 labels both sides', async () => {
  await page.selectOption('#fixture-select', 'M1_V2');
  await page.click('#run');
  assert.equal(await card('Numerator (unique transactions)'), '4');
  assert.equal(await card('Numerator (events)'), undefined);
  await page.selectOption('#cmp-select', 'BASELINE_V1');
  await page.click('#cmp-run');
  const c = await rows('#cmp');
  assert.ok(c[0].startsWith('Baseline DEMO-EVENT-COUNT v2 (numerator counts unique transactions): 4/10 '), c[0]);
  assert.ok(c[1].startsWith('Scenario DEMO-EVENT-COUNT v1 (numerator counts events): 5/10 '), c[1]);
});

await check('M2 session: M1 file refused (no cross-merchant merge)', async () => {
  await page.selectOption('#fixture-select', 'M2_EMPTY');
  await page.click('#run');
  await page.click('#ex-valid');
  await page.click('#reimport-run');
  assert.ok((await text('#reimport-status')).startsWith('Reimport rejected: OUT_OF_SCOPE: session merchant is M2'));
  assert.equal(await card('Denominator (settled sales)'), '0');
  assert.equal(await card('Ratio (bps)'), 'undefined');
});

await check('mobile 390x844: no horizontal overflow', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
  await page.screenshot({ path: join(tmpdir(), 'disputeradar-journey-mobile.png'), fullPage: true });
});

await check('no CSP violations, console errors, failed requests, 4xx or navigations', async () => {
  const csp = await page.evaluate(() => window.__csp);
  assert.deepEqual([...csp, ...problems], []);
});

await browser.close();
server.close();
for (const [s, n] of results) console.log(`${s} ${n}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`browser journey: ${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
