// Static build for a plain static host (e.g. a Pages-style host that reads _headers). Copies the
// shipped directories into dist/ with the same relative layout the app's imports use, skips tests
// and dotfiles, and writes host security headers. Building deploys nothing; deployment is a
// separate, gated step. Usage: node scripts/build.mjs
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SHIP = ['app', 'src', 'fixtures', 'packages'].filter((d) => existsSync(join(ROOT, d)));
const skip = (p) => relative(ROOT, p).split(sep).some((seg) => seg.startsWith('.') || seg === 'test' || seg === 'tests' || seg === 'node_modules' || /\.test\.m?js$/.test(seg));

rmSync(DIST, { recursive: true, force: true });
for (const d of SHIP) cpSync(join(ROOT, d), join(DIST, d), { recursive: true, filter: (p) => !skip(p) });

const name = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name ?? 'synthetic demo';
if (existsSync(join(ROOT, 'index.html'))) cpSync(join(ROOT, 'index.html'), join(DIST, 'index.html'));
else writeFileSync(join(DIST, 'index.html'), `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0; url=app/"><title>${name}: synthetic demo</title></head>\n<body><main><h1>${name}</h1><p>Synthetic demo data only. <a href="app/">Open the workbench</a>.</p></main></body>\n</html>\n`);

// Policy source, in order: the page's meta CSP, the CSP the local preview server already sends
// (string literals, possibly concatenated across lines), else a same-origin default. The header
// then adds what a meta tag cannot carry.
const page = readFileSync(join(ROOT, 'app', 'index.html'), 'utf8');
const serve = existsSync(join(ROOT, 'scripts', 'serve.mjs')) ? readFileSync(join(ROOT, 'scripts', 'serve.mjs'), 'utf8') : '';
const fromServe = /content-security-policy['"]\s*:\s*((?:"[^"\n]*"\s*\+?\s*)+)/i.exec(serve)?.[1];
const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(page)?.[1]
  ?? (fromServe ? [...fromServe.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('') : null)
  ?? "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
if (!/(^|;)\s*default-src\s/.test(meta)) throw new Error(`refusing to write _headers: no default-src in "${meta}"`);
const have = new Set(meta.split(';').map((d) => d.trim().split(/\s+/)[0]).filter(Boolean));
const extra = [["frame-ancestors", "'none'"], ['base-uri', "'none'"], ['object-src', "'none'"], ['form-action', "'none'"]].filter(([d]) => !have.has(d));
const csp = [meta.trim().replace(/;$/, ''), ...extra.map(([d, v]) => `${d} ${v}`)].join('; ');
writeFileSync(join(DIST, '_headers'), [
  '/*',
  `  Content-Security-Policy: ${csp}`,
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  '  Cross-Origin-Opener-Policy: same-origin',
  '  X-Frame-Options: DENY',
  '',
].join('\n'));
console.log(`built dist/ from ${SHIP.join(', ')}`);
