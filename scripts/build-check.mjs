// Production build verification. Circle ships native modules directly, so "build" validates the
// exact deployable files instead of producing a second, divergent bundle.
import fs from 'node:fs';
import path from 'node:path';

const problems = [];
const read = file => fs.readFileSync(file, 'utf8');
const html = read('public/index.html');
const worker = read('public/sw.js');
const manifest = JSON.parse(read('public/manifest.webmanifest'));

// Every local asset referenced by index.html must exist.
for (const match of html.matchAll(/(?:src|href)="(\/[^"?#]+)[^"]*"/g)) {
  const file = path.join('public', match[1]);
  if (!fs.existsSync(file)) problems.push(`index.html references missing ${match[1]}`);
}
if (/<script(?![^>]+src=)/i.test(html)) problems.push('index.html contains an inline script (CSP forbids it)');
if (!/viewport-fit=cover/.test(html) || !/interactive-widget=resizes-content/.test(html)) problems.push('mobile viewport metadata is incomplete');
if ((html.match(/apple-touch-startup-image/g) || []).length < 10) problems.push('iOS launch screens are incomplete');

// The service worker shell is explicit: verify every quoted root path in SHELL before the closing ];.
const shell = worker.match(/const SHELL = \[([\s\S]*?)\];/)?.[1] || '';
for (const match of shell.matchAll(/['"](\/[^'"]+)['"]/g)) {
  const file = match[1] === '/' ? 'public/index.html' : path.join('public', match[1]);
  if (!fs.existsSync(file)) problems.push(`service worker precaches missing ${match[1]}`);
}
for (const required of ['/mobile.css', '/views/chats.js', '/views/conversation.js', '/lib/nav.js', '/manifest.webmanifest']) if (!shell.includes(`'${required}'`)) problems.push(`service worker shell omits ${required}`);

if (manifest.display !== 'standalone' || manifest.scope !== '/' || manifest.start_url !== '/') problems.push('manifest is not a standalone root-scoped app');
for (const icon of manifest.icons || []) {
  if (!fs.existsSync(path.join('public', icon.src))) problems.push(`manifest icon missing: ${icon.src}`);
}
if (!(manifest.shortcuts || []).length) problems.push('manifest has no shortcuts');

// Keep payloads appropriate for mid-range phones. Native modules are cached and loaded on demand.
const jsFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.js')) jsFiles.push(file);
  }
}
walk('public');
for (const file of jsFiles) if (fs.statSync(file).size > 90 * 1024) problems.push(`${file} exceeds the 90 KB module budget`);
const cssBytes = fs.statSync('public/styles.css').size + fs.statSync('public/mobile.css').size;
if (cssBytes > 120 * 1024) problems.push(`CSS exceeds 120 KB (${Math.round(cssBytes / 1024)} KB)`);

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
const jsBytes = jsFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
console.log(`Build verified: ${jsFiles.length} native modules (${Math.round(jsBytes / 1024)} KB source), ${Math.round(cssBytes / 1024)} KB CSS, ${manifest.icons.length} icons, ${(html.match(/apple-touch-startup-image/g) || []).length} iOS launch screens.`);
