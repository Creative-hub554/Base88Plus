#!/usr/bin/env node
/**
 * Create a generated-app regression pin (tests/generated/<name>/) from a
 * live project workspace, then validate the whole pin set before commit.
 *
 *   npm run new:pin -- <projectId-or-dir> <assertions.cjs> [--name <kebab-name>] [--force] [--keep]
 *
 * Steps:
 *   1. Resolve the project (projects-data/<id>, or any directory holding app.js)
 *      and the assertions file; load the assertions to fail fast on syntax/contract.
 *   2. Derive the pin name (--name wins; else the project.json name, slugged;
 *      else the directory name) and refuse to clobber an existing pin without
 *      --force.
 *   3. Copy app.js VERBATIM (regression snapshots must be byte-faithful) plus
 *      the assertions as assertions.cjs.
 *   4. Run the full pin set (node scripts/verify-generated-app.js --all). If
 *     anything fails, roll the new pin back unless --keep says otherwise —
 *     a broken pin must never be left behind for someone else to trip over.
 *
 * Exit: 0 = pin created and --all green; 1 = nothing created, or rolled back.
 */
'use strict';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// This file is ESM but assertions files are CommonJS — bridge the gap.
const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PINS_DIR = path.join(ROOT, 'tests', 'generated');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

function fail(msg, hint) {
  console.error(`✗ ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

const [projectArg, assertsArg] = argv.filter((a) => !a.startsWith('--') && a !== opt('--name'));
if (!projectArg || !assertsArg) {
  console.error('usage: npm run new:pin -- <projectId-or-dir> <assertions.cjs> [--name <name>] [--force] [--keep]');
  process.exit(1);
}

// ── 1. Resolve inputs ─────────────────────────────────────────────────────
const candidates = [
  projectArg,
  path.join(ROOT, 'projects-data', projectArg),
  path.join(ROOT, 'projects-data', projectArg, 'app.js'),
];
const projectDir = candidates.find((c) => {
  if (!fs.existsSync(c)) return false;
  const st = fs.statSync(c);
  return st.isDirectory() ? fs.existsSync(path.join(c, 'app.js')) : true;
});
if (!projectDir) {
  fail(`project not found: ${projectArg}`, 'pass a projects-data/<id> directory (or any dir holding app.js)');
}
const projectDirPath = fs.statSync(projectDir).isDirectory() ? projectDir : path.dirname(projectDir);
const appSrc = path.join(projectDirPath, 'app.js');

if (!fs.existsSync(assertsArg)) fail(`assertions file not found: ${assertsArg}`);
const assertsAbs = path.resolve(assertsArg);

// Fail fast on assertions syntax/contract before creating anything.
try {
  const mod = require(assertsAbs);
  const run = typeof mod === 'function' ? mod : mod.run;
  if (typeof run !== 'function') fail('assertions file must export run(h) (or be a function)');
} catch (e) {
  fail(`assertions file failed to load: ${e.message}`);
}

// ── 2. Pin name ───────────────────────────────────────────────────────────
let name = opt('--name');
if (!name) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(projectDirPath, 'project.json'), 'utf8'));
    name = meta.name || '';
  } catch {
    name = ''; // no metadata — fall through to the directory name
  }
}
if (!name) name = path.basename(projectDirPath);
const slug = name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail(`derived pin name "${slug}" is not kebab-case — pass --name <name>`);

const pinDir = path.join(PINS_DIR, slug);
if (fs.existsSync(pinDir) && !flag('--force')) {
  fail(`pin already exists: tests/generated/${slug}`, 'pass --force to overwrite (the old pin is replaced wholesale)');
}

// ── 3. Copy ───────────────────────────────────────────────────────────────
fs.mkdirSync(pinDir, { recursive: true });
fs.copyFileSync(appSrc, path.join(pinDir, 'app.js'));
fs.copyFileSync(assertsAbs, path.join(pinDir, 'assertions.cjs'));
console.log(`✓ created tests/generated/${slug}/ (app.js ${fs.statSync(appSrc).size}B + assertions.cjs)`);

// ── 4. Validate the whole pin set ─────────────────────────────────────────
const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-generated-app.js'), '--all'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (r.status === 0) {
  console.log(`\n✓ all pins green. Next: git add tests/generated/${slug} && commit.`);
  process.exit(0);
}

console.error(`\n✗ pin set FAILED with the new ${slug} pin${flag('--keep') ? ' (--keep: leaving it in place)' : ''}`);
if (!flag('--keep')) {
  fs.rmSync(pinDir, { recursive: true, force: true });
  console.error(`  rolled back: tests/generated/${slug} removed. Fix the assertions and retry.`);
} else {
  console.error('  inspect the failures above, fix tests/generated/' + slug + '/assertions.cjs, then re-run npm run verify:generated.');
}
process.exit(1);
