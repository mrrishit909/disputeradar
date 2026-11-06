# DisputeRadar landing page: design decision

Status: **draft, not visually verified.** Files: `index.html` (root), `app/landing.css`. The page has
no script; it is a static, labelled print of the bundled fixture. The CTA goes to the existing
workbench at `app/`. All links and the stylesheet path are relative, so the page works under a
Pages subpath such as `/disputeradar/`.

## Brief

A public front door for the synthetic DisputeRadar slice. The page should look like a merchant
signal desk without being a generic dark SaaS dashboard. Its main composition is one scenario-delta
exhibit: a numerator ledger, a denominator strip, two fictional counting rules and the delta
between them, with exact annotations. Every figure comes from fixture DR-SYN-001. The page must not
imply live processing, a real network rule or any determination.

## Three directions considered

### A. Broadsheet market-analysis page (chosen)

An obsidian-to-deep-green field holding a single cream "paper" exhibit sheet with a faint 24px
chart grid, like an analyst's printed exhibit pinned to a dark desk. The headline is set in a
serif, the data in tabular monospace figures. Ochre appears only on the illustrative 2500 bps line,
the -1000 bps bracket and annotation rules. The page is one exhibit: a delta scale (rule 1 bar to
5000, rule 2 bar to 4000, threshold line at 2500, bracket for the gap), a four-cell readout, then the
ledger (A) and the denominator strip (B) side by side.

### B. Terminal tape / trading blotter

All-dark, monospace throughout, events scroll as a ticker tape, green/red deltas, blinking cursor.
Rejected: it implies live feeds and real-time processing, which the product must never suggest.
Red/green alarm colour also reads as a risk rating. It is the closest to the "generic dark
dashboard" the brief rules out.

### C. Audit-workpaper ledger

Light ruled ledger paper, tick marks, auditor-style annotations and stamps across the whole page,
with no dark field. Rejected: stamps and tick-and-tie language read as an audit or compliance
sign-off, which this tool explicitly does not give. It also loses the "signal desk" mood the brief
asks for, and a full-page light ledger is hard to distinguish from the workbench itself.

### Why A

- It makes the single idea (the same records give two numbers under two rules) the hero, in one
  view, instead of a feature tour.
- The paper sheet on a dark field separates "exhibit of a fixture" from "live system": it reads as
  a printed figure, not a running dashboard.
- Ochre has one job (the illustrative line and the delta), so it never turns into an alert colour.
  No red is used anywhere.
- Static HTML and CSS can carry it fully, so no script is needed and the CSP can forbid scripts.

## Facts shown and their source

Source: `src/fixture.js` (`generateDrSyn001`, literal records) and the semantics in `README.md`
("Evaluation semantics", "Usage"). The Atlas spec `atlas/docs/specs/DISPUTERADAR-VERTICAL-SLICE.md`
and the Atlas design docs were **not readable from this session (permission denied)**, so they
were not cross-checked; see Unknowns.

| Shown on page | Value | Source |
| --- | --- | --- |
| Denominator | T1-T10, SETTLED 2026-10-01, $100.00 each; 10 sales, $1,000.00 gross | fixture `transactions` |
| Outside denominator | T0 SETTLED 2026-09-30 $50.00; T11 PENDING, settledDate null, $100.00 | fixture |
| Counted events (rule 1) | D3 (T0, 10-01, WITHDRAWN), D1 (T1, 10-03, OPEN), D2 (T2, 10-10, WON), F1 (T1, 10-15, REPORTED), F2 (T3, 10-31, RETRACTED) = 5 | fixture `disputes`, `fraudEvents`; v1 status lists include all statuses (`src/constants.js`) |
| Unique transactions (rule 2) | T0, T1, T2, T3 = 4 | README v2 semantics |
| Excluded event | D4 (T4, reported 2026-11-01, REVERSED) | fixture |
| Ratios | 5/10 = 5000 bps (50.00%); 4/10 = 4000 bps (40.00%); difference -1000 bps | README "Usage" comments |
| Threshold | Illustrative 2500 bps for both fictional rules | README "Fixture policy sets" |
| Refund | Q1, T2, 2026-10-20, $100.00; context, not subtracted | fixture `refunds`; README |
| Zero denominator | Undefined, not zero or all-clear (merchant M2) | README; fixture `emptyMerchantId` |
| Policy set ids | DEMO-BASELINE-V1, DEMO-SCENARIO-V2 | fixture `policySets` |

The page says "Both ratios sit above it" for the 2500 bps line. That follows from README's alert
test (`numerator x 10000` vs `threshold x denominator`) and is described as a demo label for human
review, not a finding. The engine state name ILLUSTRATIVE_ALERT is not shown.

## Safety copy present on the page

- Banner and limits: fictional data; DEMO-EVENT-COUNT is not Visa VAMP, Mastercard, acquirer or
  processor policy (card networks named only in negation).
- Illustrative threshold; human review; no fine, monitoring-programme or recovery prediction; no
  risk rating or compliance determination.
- Zero denominator is undefined, not all-clear.
- No network connection; no paid service.
- Imported data is UNVERIFIED USER-SUPPLIED; the app cannot detect or prevent real or sensitive data.
- Figures are printed from the fixture, not computed live on the page.

## System

- Colour: obsidian `#0b100e`, greens `#10241c` / `#173328`, paper `#f1ece0`, ink `#16201b`,
  ochre `#c8962e` (field) and `#8a5a0b` (text on paper), bars `#1d4a39` / `#3f7a62`.
  Contrast ratios were chosen to clear 4.5:1 but have **not been measured**.
- Type: system serif stack (Iowan Old Style, Charter, Palatino, Georgia) for display; system sans
  for body; system monospace with tabular figures for data. No web fonts, no external assets.
- Layout: 12-column feel at 1440 (lede 7/5, ledger 1.55fr / strip 1fr); at <=1023px (768
  composition) the ledger and strip stack and the readout becomes 2x2, with the strip full width
  and the outside list and refund note side by side; at <=599px (390 composition) the sheet bleeds
  edge to edge, odd scale ticks are hidden, nav reduces to the Workbench CTA, and the ledger uses
  five compact columns inside a keyboard-focusable scroll region.
- Motion (CSS only, inside `prefers-reduced-motion: no-preference`): staggered lede rise, sheet
  rise, bars grow from 0 to their value, labels and bracket fade in after, strip cells fade in
  sequence, CTA arrow nudge, ledger row hover highlights its sale cell (via `:has`). Reduced
  motion shows the same final composition with no movement. Animations use `backwards` fill, so
  content is in its final state if animation does not run.
- Accessibility: skip link, landmarks, one `h1`, real table with caption, `scope` and `tfoot`;
  the visual scale is `aria-hidden` and its values are repeated in a `dl` readout; visible
  `:focus-visible` outline in ochre.
- CSP (meta): `default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:;
  connect-src 'none'`. The built `_headers` CSP still comes from `app/index.html` (builder unchanged).

## Quality rubric (8 categories)

The website-playbook and its quality/motion references were read and applied by Codex. Criteria are graded only
from inspected browser evidence; no test suite was run.

| # | Criterion | Intended outcome / implementation | Evidence inspected | Status | Remaining correction |
| --- | --- | --- | --- | --- | --- |
| 1 | Point of view | Printed analyst exhibit on a dark desk; one idea (same records, two rules, two numbers) | Desktop and phone show this through the chart-led layout | Strong | User review remains primary |
| 2 | Typography | System serif display, tabular mono data, sans body; no web fonts | Rendered at desktop, tablet and phone; phone headline and ledger are legible | Mixed | Check serif fallback on other OSes and dense ledger labels |
| 3 | Colour | Obsidian/green field, paper sheet, ochre only for threshold and delta, no red | Roles rendered consistently; contrast ratios not measured instrumentally | Mixed | Measure interactive/text contrast |
| 4 | Hierarchy | Headline, CTA, then exhibit: scale, readout, ledger A, strip B, limits | Desktop hero and chart plus phone hero/chart inspected | Strong | Confirm longer content pages as part of final pass |
| 5 | Imagery | The chart is the image; original chart, no stock or generated assets | Desktop and mobile chart inspected; all bars and threshold render | Strong | None identified in rendered views |
| 6 | Motion | CSS reveal, bars grow, labels fade, strip stagger, CTA nudge, row-to-sale hover; static under reduced motion | Still images only; motion/reduced-motion states not recorded | Unverified | Record motion and test reduced-motion |
| 7 | Mobile | Distinct 390 composition with CTA-led navigation and stacked hierarchy | 390px hero/chart/ledger views; document/body widths both 390px | Mixed | Inspect full phone page, table interaction and touch spacing |
| 8 | Invisible quality | Semantic landmarks/table, skip link, focus ring, text equivalent, relative paths | Build passes; local CTA paths resolve; no overflow at three widths | Mixed | Keyboard, axe, Lighthouse, console and live Pages remain unchecked |

## Remaining checks
- At 390px the five-column ledger may scroll sideways inside its focusable region. That is
  expected; judge it on purpose rather than as a bug, and tighten columns if it reads badly.
- The built `_headers` CSP (taken from `app/index.html`, which allows inline styles) also applies
  to this page. Browsers enforce both policies, so the stricter meta CSP here still applies.
- Motion, reduced-motion behavior, keyboard navigation, axe, Lighthouse and live Pages still need checks.
- The workbench `app/index.html` uses a light theme, so the landing-to-workbench jump changes
  palette. That is a known mismatch, left alone because app files were out of scope.
- `scripts/serve.mjs` maps `/` to `/app/index.html`, only serves allow-listed top-level folders and
  does not resolve directory URLs. So it cannot show this landing page, and its `app/` CTA would
  fail there. View the page from the built `dist/` with any static server that maps `app/` to
  `app/index.html` (as Pages does). The serve script was left unchanged.
