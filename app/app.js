// DisputeRadar synthetic workbench. Seeded fixture only; all numbers come from the engine snapshot.
import { generateDrSyn001, createSnapshot, serializeReportJson, serializeReportCsv, SYNTHETIC_LABEL } from '../src/index.js';
import { SCENARIOS, scenarioById, esc, summaryCards, findingLabel, findingDetail, resultState, errorSummary, looksLikePan, exportFilename } from './ui.js';

const $ = (id) => document.getElementById(id);
const fixture = generateDrSyn001();
let result = null;
let session = null;
let lastButton = null;

function setText(id, text) { $(id).textContent = looksLikePan(text) ? '[redacted]' : text; }

function render() {
  const state = resultState(result);
  $('state').textContent = state;
  $('export-json').disabled = $('export-csv').disabled = state !== 'findings' && state !== 'zero';
  $('cards').innerHTML = '';
  $('findings').innerHTML = '';
  closeDetail();
  if (state === 'empty') { setText('status', 'No run yet. Choose a seeded fixture scenario and press Run.'); return; }
  if (state === 'error') { setText('status', `Rejected: ${errorSummary(result).join(' | ')}`); return; }
  const snap = result.snapshot;
  for (const c of summaryCards(snap)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="k">${esc(c.label)}</span><strong>${esc(c.value)}</strong>`;
    $('cards').appendChild(li);
  }
  if (state === 'zero') { setText('status', `Run complete: zero counted findings for ${snap.scope.merchantId} in ${snap.scope.period} (state ${snap.evaluation.state}).`); return; }
  setText('status', `Run complete: ${snap.contributions.events.length} counted finding(s) for ${snap.scope.merchantId} in ${snap.scope.period}.`);
  snap.contributions.events.forEach((e, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = looksLikePan(findingLabel(e)) ? '[redacted]' : findingLabel(e);
    b.setAttribute('aria-controls', 'detail');
    b.addEventListener('click', () => openDetail(e, b));
    li.appendChild(b);
    $('findings').appendChild(li);
  });
}

function openDetail(e, button) {
  lastButton = button;
  const dl = $('detail-body');
  dl.innerHTML = '';
  for (const { key, value } of findingDetail(e)) {
    dl.insertAdjacentHTML('beforeend', `<dt>${esc(key)}</dt><dd>${esc(looksLikePan(value) ? '[redacted]' : value)}</dd>`);
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
  const sc = scenarioById($('scenario').value);
  if (!sc) return;
  session = { allowedMerchantIds: [sc.sessionMerchantId] };
  result = createSnapshot({ dataset: fixture.dataset, policySet: fixture.policySets[sc.policySet], merchantId: sc.merchantId, period: fixture.period, session });
  render();
}

function download(ext) {
  const out = ext === 'json' ? serializeReportJson(result.snapshot, session) : serializeReportCsv(result.snapshot, session);
  if (!out.ok) { setText('status', `Export rejected: ${errorSummary(out).join(' | ')}`); return; }
  const blob = new Blob([out.text], { type: ext === 'json' ? 'application/json' : 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportFilename(result.snapshot, ext);
  a.click();
  URL.revokeObjectURL(a.href);
}

for (const s of SCENARIOS) $('scenario').insertAdjacentHTML('beforeend', `<option value="${esc(s.id)}">${esc(s.label)}</option>`);
setText('synthetic-label', SYNTHETIC_LABEL);
$('run').addEventListener('click', run);
$('export-json').addEventListener('click', () => download('json'));
$('export-csv').addEventListener('click', () => download('csv'));
$('detail-close').addEventListener('click', closeDetail);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeDetail(); });
render();
