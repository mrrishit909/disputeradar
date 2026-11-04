// DisputeRadar synthetic workbench. Seeded fixture only; all numbers come from the engine snapshot.
import {
  generateDrSyn001, createSnapshot, compareScenarios, queryContributions, addRemediationNote,
  serializeReportJson, serializeReportCsv, SYNTHETIC_LABEL, IMPORT_LIMITS,
  importDatasetJson, importDatasetCsv, mergeDatasets, diffSnapshots,
} from '../src/index.js';
import {
  SCENARIOS, scenarioById, esc, summaryCards, findingLabel, findingDetail, resultState, errorSummary, looksLikePan,
  exportFilename, filterOptions, buildQuery, explanationRows, comparisonRows,
  REIMPORT_EXAMPLES, detectFormat, scopeViolations, deltaRows,
} from './ui.js';

const $ = (id) => document.getElementById(id);
const fixture = generateDrSyn001();
let result = null;
let session = null;
// Data behind the current snapshot: the seeded fixture plus any accepted same-merchant reimports.
let workingDataset = fixture.dataset;
let scenario = null;
let lastButton = null;

const safe = (text) => (looksLikePan(text) ? '[redacted]' : String(text));
function setText(id, text) { $(id).textContent = safe(text); }
function fillList(id, rows) {
  $(id).replaceChildren(...rows.map((r) => { const li = document.createElement('li'); li.textContent = safe(r); return li; }));
}
function fillSelect(id, values, allLabel) {
  const opts = [new Option(allLabel, ''), ...values.map((v) => new Option(v, v))];
  $(id).replaceChildren(...opts);
}

function render() {
  const state = resultState(result);
  const ok = state === 'findings' || state === 'zero';
  $('state').textContent = state;
  for (const id of ['export-json', 'export-csv', 'cmp-run', 'note-add', 'f-category', 'f-type', 'f-month', 'f-search', 'f-sort',
    'reimport-text', 'reimport-run', 'ex-valid', 'ex-conflict', 'ex-other']) $(id).disabled = !ok;
  $('cards').innerHTML = '';
  for (const id of ['findings', 'why', 'cmp', 'notes']) $(id).replaceChildren();
  setText('shown', '');
  closeDetail();
  if (state === 'empty') { setText('status', 'No run yet. Choose a seeded fixture scenario and press Run.'); return; }
  if (state === 'error') { setText('status', `Rejected: ${errorSummary(result).join(' | ')}`); return; }
  const snap = result.snapshot;
  for (const c of summaryCards(snap)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="k">${esc(c.label)}</span><strong>${esc(c.value)}</strong>`;
    $('cards').appendChild(li);
  }
  const opts = filterOptions(snap);
  fillSelect('f-category', opts.category, 'All categories');
  fillSelect('f-type', opts.eventType, 'All types');
  fillSelect('f-month', opts.month, 'All months');
  $('f-search').value = '';
  fillList('why', explanationRows(snap));
  const others = Object.keys(fixture.policySets).filter((k) => k !== scenario.policySet);
  $('cmp-select').replaceChildren(...others.map((k) => new Option(SCENARIOS.find((s) => s.policySet === k)?.label ?? k, k)));
  renderNotes();
  if (state === 'zero') { setText('status', `Run complete: zero counted findings for ${snap.scope.merchantId} in ${snap.scope.period} (state ${snap.evaluation.state}).`); return; }
  setText('status', `Run complete: ${snap.contributions.events.length} counted finding(s) for ${snap.scope.merchantId} in ${snap.scope.period}.`);
  renderFindings();
}

/** Findings come from the engine's queryContributions, so filters, search and sort change real results. */
function renderFindings() {
  closeDetail();
  const q = queryContributions(result.snapshot, buildQuery({
    category: $('f-category').value, eventType: $('f-type').value, month: $('f-month').value,
    search: $('f-search').value.trim(), sortBy: $('f-sort').value,
  }));
  $('findings').replaceChildren();
  if (!q.ok) { setText('shown', `Filter rejected: ${errorSummary(q).join(' | ')}`); return; }
  setText('shown', `Showing ${q.total} of ${result.snapshot.contributions.events.length} counted events.`);
  for (const e of q.results) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = safe(findingLabel(e));
    b.setAttribute('aria-controls', 'detail');
    b.addEventListener('click', () => openDetail(e, b));
    li.appendChild(b);
    $('findings').appendChild(li);
  }
}

function renderNotes() {
  fillList('notes', result.snapshot.notes.map((n) => `${n.recordedOn} ${n.author}: ${n.text}`));
  if (result.snapshot.notes.length === 0) fillList('notes', ['No remediation notes recorded on this snapshot.']);
}

function openDetail(e, button) {
  lastButton = button;
  const dl = $('detail-body');
  dl.innerHTML = '';
  for (const { key, value } of findingDetail(e)) {
    dl.insertAdjacentHTML('beforeend', `<dt>${esc(key)}</dt><dd>${esc(safe(value))}</dd>`);
  }
  $('detail').hidden = false;
  $('detail-close').focus();
}

function closeDetail() {
  if ($('detail').hidden) return;
  $('detail').hidden = true;
  if (lastButton && document.contains(lastButton)) lastButton.focus();
  lastButton = null;
}

function run() {
  scenario = scenarioById($('fixture-select').value);
  if (!scenario) return;
  session = { allowedMerchantIds: [scenario.sessionMerchantId] };
  workingDataset = fixture.dataset;
  $('delta').replaceChildren();
  setText('reimport-status', '');
  setText('note-status', '');
  result = createSnapshot({ dataset: workingDataset, policySet: fixture.policySets[scenario.policySet], merchantId: scenario.merchantId, period: fixture.period, session });
  render();
}

function compare() {
  const c = compareScenarios({
    dataset: workingDataset, merchantId: scenario.merchantId, period: fixture.period, session,
    baselinePolicySet: fixture.policySets[scenario.policySet], scenarioPolicySet: fixture.policySets[$('cmp-select').value],
  });
  fillList('cmp', c.ok ? comparisonRows(c.comparison) : [`Comparison rejected: ${errorSummary(c).join(' | ')}`]);
}

function addNote(ev) {
  ev.preventDefault();
  const n = addRemediationNote(result.snapshot, {
    author: $('note-author').value.trim(), text: $('note-text').value, recordedOn: new Date().toISOString().slice(0, 10),
  }, session);
  if (!n.ok) { setText('note-status', `Note rejected: ${errorSummary(n).join(' | ')}`); return; }
  const parent = result.snapshot.snapshotId;
  result = { ok: true, snapshot: n.snapshot };
  $('note-text').value = '';
  renderNotes();
  setText('note-status', `Recorded in new snapshot ${n.snapshot.snapshotId.slice(0, 12)} (parent ${parent.slice(0, 12)}); findings unchanged. Exports now include the note.`);
}

/**
 * Late-event reimport: validate the pasted synthetic file with the engine importer, refuse any record
 * outside the session merchant, merge (identical ids are idempotent, conflicting ids rejected), build a
 * NEW snapshot for the same merchant/period/policy set, and explain the delta with diffSnapshots.
 * Any rejection leaves the current snapshot, its data and the last delta exactly as they were.
 */
function reimport(ev) {
  ev.preventDefault();
  const prior = result.snapshot;
  const keep = `Current snapshot ${prior.snapshotId.slice(0, 12)} kept; no data changed.`;
  const reject = (msgs) => setText('reimport-status', `Reimport rejected: ${msgs.join(' | ')}. ${keep}`);
  const text = $('reimport-text').value;
  const format = detectFormat(text);
  const imported = format === 'JSON' ? importDatasetJson(text) : importDatasetCsv(text);
  if (!imported.ok) return reject(errorSummary(imported));
  const outside = scopeViolations(imported.dataset, prior.scope.merchantId);
  if (outside.length) return reject([`OUT_OF_SCOPE: session merchant is ${prior.scope.merchantId}; refused ${outside.join(', ')}`]);
  const merged = mergeDatasets(workingDataset, imported.dataset);
  if (!merged.ok) return reject(errorSummary(merged));
  const next = createSnapshot({ dataset: merged.dataset, policySet: fixture.policySets[scenario.policySet], merchantId: prior.scope.merchantId, period: prior.scope.period, session });
  if (!next.ok) return reject(errorSummary(next));
  const s = next.snapshot;
  if (s.requestedRuleId !== prior.requestedRuleId || s.provenance.policySetSha256 !== prior.provenance.policySetSha256) {
    return reject(['RULE_MISMATCH: reimport must use the same policy set and rule as the current snapshot']);
  }
  const d = diffSnapshots(prior, s);
  if (!d.ok) return reject(errorSummary(d));
  workingDataset = merged.dataset;
  result = next;
  render();
  fillList('delta', deltaRows(d.diff, prior, s, merged.merge));
  return setText('reimport-status', `Reimported ${format} (${imported.provenance.recordCount} record(s), input sha256 ${imported.provenance.inputSha256.slice(0, 12)}). New snapshot ${s.snapshotId.slice(0, 12)} is now shown and exported.`);
}

function download(ext) {
  const out = ext === 'json' ? serializeReportJson(result.snapshot, session) : serializeReportCsv(result.snapshot, session);
  if (!out.ok) { setText('status', `Export rejected: ${errorSummary(out).join(' | ')}`); return; }
  const blob = new Blob([out.text], { type: ext === 'json' ? 'application/json' : 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportFilename(result.snapshot, ext);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

for (const s of SCENARIOS) $('fixture-select').insertAdjacentHTML('beforeend', `<option value="${esc(s.id)}">${esc(s.label)}</option>`);
setText('synthetic-label', SYNTHETIC_LABEL);
$('note-text').maxLength = IMPORT_LIMITS.MAX_NOTE_CHARS;
$('run').addEventListener('click', run);
for (const id of ['f-category', 'f-type', 'f-month', 'f-sort']) $(id).addEventListener('change', renderFindings);
$('f-search').addEventListener('input', renderFindings);
$('cmp-run').addEventListener('click', compare);
$('note-form').addEventListener('submit', addNote);
$('reimport-form').addEventListener('submit', reimport);
for (const [id, key] of [['ex-valid', 'valid'], ['ex-conflict', 'conflict'], ['ex-other', 'otherMerchant']]) {
  $(id).addEventListener('click', () => { $('reimport-text').value = REIMPORT_EXAMPLES[key]; });
}
$('export-json').addEventListener('click', () => download('json'));
$('export-csv').addEventListener('click', () => download('csv'));
$('detail-close').addEventListener('click', closeDetail);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeDetail(); });
render();
