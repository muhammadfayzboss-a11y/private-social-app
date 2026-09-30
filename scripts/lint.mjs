// Zero-dependency lint/type contract for this dependency-free project.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'public', 'scripts', 'tests'];
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(js|mjs)$/.test(entry.name)) files.push(file);
  }
}
roots.forEach(walk);
const problems = [];

// Node's parser is the project's syntax/type boundary (native ESM, no transpilation).
for (const file of files) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  if (checked.status) problems.push(`${file}: ${checked.stderr.trim()}`);
}

function exported(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${escaped}\\b|export\\s*\\{[^}]*\\b${escaped}\\b`).test(text);
}

// Every relative static import must exist, and every named import must be exported by its module.
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/import\s*(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), match[1]);
    if (!fs.existsSync(target)) problems.push(`${file}: missing import ${match[1]}`);
  }
  for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!match[2].startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), match[2]);
    if (!fs.existsSync(target)) continue;
    const source = fs.readFileSync(target, 'utf8');
    for (const item of match[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/)[0];
      if (name && !exported(source, name)) problems.push(`${file}: ${name} is not exported by ${match[2]}`);
    }
  }
  if (file.startsWith('public/')) {
    if (/<(?:script|img|button|input|video|audio)[^>]+on(?:click|load|error|play)=/i.test(text)) problems.push(`${file}: inline event handler violates CSP`);
  }
}

if (problems.length) {
  console.error(problems.join('\n\n'));
  process.exit(1);
}
console.log(`Lint/type contract passed: ${files.length} JavaScript modules parse and all relative imports resolve.`);
