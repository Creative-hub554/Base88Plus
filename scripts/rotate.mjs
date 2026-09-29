#!/usr/bin/env node
/**
 * One-command GitHub token rotation for the Windows CredMan credential.
 *
 *   npm run rotate          # full flow: preflight → poller → approval → battery → deploy-key re-mint
 *   npm run rotate -- --status
 *   npm run rotate -- --battery-only
 *   npm run rotate -- --deploy-key-only   # re-mint the cron deploy key without a token rotation
 *   npm run rotate -- --skip-deploy-key   # full flow without touching the cron deploy key
 *   npm run rotate -- --keep-old-keys     # debugging: leave old cron keys registered
 *   npm run rotate -- --gens 12 --no-battery
 *
 * Orchestration only: every secret-touching step is delegated.
 *   - scripts/rotation/rotate-hard.cjs  mints/polls device codes, swaps via
 *     scripts/rotation/cred-swap.ps1 (NEW_TOKEN through env, never argv/file)
 *   - scripts/rotation/cred-read.ps1    reads the current token for the battery
 *
 * Everything lands in .freebuff/rotation-* / rotator.log / device-code.json
 * (gitignored); this driver holds no secrets itself.
 *
 * Runbook with the full why-behind-every-step: docs/rotation.md.
 */
'use strict';

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runDeployKeyRotation } from './rotation/deploy-key.mjs';
import { seal } from './rotation/sealed-box.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUN_DIR = path.join(ROOT, '.freebuff');
const STATUS = path.join(RUN_DIR, 'rotation-status.txt');
const LOG = path.join(RUN_DIR, 'rotator.log');
const DEVICE_CODE = path.join(RUN_DIR, 'device-code.json');
const POLLER = path.join(__dirname, 'rotation', 'rotate-hard.cjs');
const CRED_READ = path.join(__dirname, 'rotation', 'cred-read.ps1');
const CHECK_DEPLOY_KEY = path.join(__dirname, 'check-deploy-key.js');
const REPO_SLUG = process.env.ROTATE_REPO || 'Creative-hub554/Base88Plus';
const LOGIN = process.env.ROTATE_LOGIN || 'Creative-hub554';
const BATTERY_MARKER = 'cm-path-check-' + new Date().toISOString().slice(0, 10);
const ISSUE = process.env.ROTATE_BATTERY_ISSUE || '18';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const GEN_LIMIT = parseInt(opt('--gens', process.env.ROTATE_GENS || '150'), 10);
const DO_BATTERY = !flag('--no-battery');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readToken() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CRED_READ],
      { encoding: 'utf8', timeout: 60_000 }
    );
    return String(out).trim();
  } catch {
    return '';
  }
}

const fp = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 8);
const api = async (urlPath, method, token, body) => {
  const res = await fetch('https://api.github.com' + urlPath, {
    method: method || 'GET',
    headers: {
      'User-Agent': 'rotate-battery',
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (e.g. empty) */ }
  return { code: res.status, json, text, scopes: res.headers.get('x-oauth-scopes') || '' };
};

function preflight() {
  console.log('── preflight ─────────────────────────────────────────────');
  if (process.platform !== 'win32') {
    console.error('FATAL: rotation targets Windows Credential Manager (win32 only).');
    process.exit(1);
  }
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const t = readToken();
  if (!/^gh[a-z]_[A-Za-z0-9]{30,60}$/.test(t)) {
    console.error('FATAL: no usable token in CredMan (target gh:github.com:' + LOGIN + ').');
    console.error('First mint: run this same command after seeding the credential once by hand.');
    process.exit(1);
  }
  console.log(`current token fp=${fp(t)} (must change after the swap)`);
  return { before: fp(t) };
}

function launchPoller() {
  console.log('── device flow ───────────────────────────────────────────');
  fs.writeFileSync(STATUS, '');
  try { fs.unlinkSync(LOG); } catch { /* first run */ }
  try { fs.unlinkSync(DEVICE_CODE); } catch { /* no stale grant */ }

  const child = spawn(
    process.execPath,
    [POLLER],
    {
      cwd: ROOT,
      env: Object.assign({}, process.env, { ROTATE_GENS: String(GEN_LIMIT) }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    }
  );
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  console.log(`poller pid=${child.pid} (up to ${GEN_LIMIT} codes ≈ ${Math.max(1, Math.round((GEN_LIMIT * 15) / 60))} h runway)`);
  return child;
}

function lastCode() {
  try {
    const s = fs.readFileSync(STATUS, 'utf8');
    const lines = s.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^CODE (\S{4}-\S{4}) gen\d+$/);
      if (m) return m[1];
    }
  } catch { /* no status yet */ }
  return null;
}

function expiresAtMs() {
  try { return JSON.parse(fs.readFileSync(DEVICE_CODE, 'utf8')).expires_at; }
  catch { return 0; }
}

async function waitForResult(child, startFp) {
  const t0 = Date.now();
  let shown = '';
  while (child.exitCode === null) {
    await sleep(3_000);
    const code = lastCode();
    if (code && code !== shown) {
      shown = code;
      const left = Math.max(0, Math.round((expiresAtMs() - Date.now()) / 60_000));
      console.log(`  ▶ APPROVE: https://github.com/login/device → ${code}  (~${left} min left)`);
    }
    const s = fs.existsSync(STATUS) ? fs.readFileSync(STATUS, 'utf8') : '';
    if (s.includes('RESULT ')) {
      const lines = s.split('\n').filter((l) => l.startsWith('RESULT ') || l.startsWith('TOKEN_SEEN '));
      const seen = lines.find((l) => l.startsWith('TOKEN_SEEN fp='));
      const result = lines.reverse().find((l) => l.startsWith('RESULT ')) || '';
      if (result.includes('SWAP_OK')) {
        const t = readToken();
        const ok = t && fp(t) !== startFp && seen && seen.endsWith(fp(t));
        console.log(`  swap: SWAP_OK, new fp=${fp(t)}${ok ? ' (matches TOKEN_SEEN)' : ' (MISMATCH — inspect ' + STATUS + ')'}`);
        return { ok: !!ok, fp: fp(t), seen: seen || '', result };
      }
      console.log(`  swap not completed: ${result.trim()}${seen ? ` (${seen.trim()})` : ''}`);
      return { ok: false, result, seen: seen || '' };
    }
    if (Date.now() - t0 > 1000 * 60 * 60 * 40) {
      console.error('  giving up after 40h of watching (poller should have exhausted by now).');
      return { ok: false, result: 'RESULT DRIVER_TIMEOUT' };
    }
  }
  return { ok: false, result: `RESULT POLLER_EXIT_${child.exitCode}` };
}

async function battery(token) {
  console.log('── battery ───────────────────────────────────────────────');
  let failures = 0;

  console.log(`B1 CredMan read: len=${token.length} prefix=${token.slice(0, 4)} fp=${fp(token)}`);
  if (!/^gh[a-z]_/.test(token) || token.length < 34) failures++;

  const me = await api('/user', 'GET', token);
  console.log(`B2 GET /user: ${me.code} login=${me.json && me.json.login} scopes=${me.scopes}`);
  if (me.code !== 200 || me.json?.login !== LOGIN) failures++;
  if (!me.scopes.includes('repo') || !me.scopes.includes('workflow')) failures++;

  const comments = await api(`/repos/${REPO_SLUG}/issues/${ISSUE}/comments?per_page=100`, 'GET', token);
  if (comments.code === 200 && comments.text.includes(BATTERY_MARKER)) {
    console.log(`B3 write: marker ${BATTERY_MARKER} already present — skipped`);
  } else {
    const c = await api(`/repos/${REPO_SLUG}/issues/${ISSUE}/comments`, 'POST', token, {
      body: `Credential battery ${BATTERY_MARKER}: authenticated write via rotated CredMan token (fp ${fp(token)}).`,
    });
    console.log(`B3 write: ${c.code} ${(c.json && c.json.html_url) || c.text.slice(0, 80)}`);
    if (c.code !== 201) failures++;
  }

  const ls = execFileSync('git', ['ls-remote', `https://github.com/${REPO_SLUG}.git`, 'refs/heads/main'], {
    encoding: 'utf8',
    env: gitAuthEnv(token),
    timeout: 60_000,
  });
  console.log(`B4 ls-remote: ${ls.trim().split('\t')[0].slice(0, 12)} (git-auth via env only)`);
  const push = spawn('git', ['push', 'origin', 'HEAD:refs/heads/main'], {
    env: gitAuthEnv(token),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pushCode = await new Promise((res) => push.on('exit', res));
  console.log(`B4 push round trip: exit=${pushCode}`);
  if (pushCode !== 0) failures++;

  const runs = await api(`/repos/${REPO_SLUG}/actions/workflows/ci.yml/runs?per_page=1`, 'GET', token);
  const rid = runs.json?.workflow_runs?.[0]?.id || 'NONE';
  console.log(`B5 verifier smoke: run ${rid}`);
  const v = spawn(
    'powershell',
    [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join('scripts', 'verify-oct28.ps1'),
    ],
    {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        VERIFY_FORCE: '1', DRY_RUN: '1', VERIFY_TOKEN: token, SMOKE_RUN_ID: String(rid),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let verdict = '';
  v.stdout.on('data', (d) => {
    const m = String(d).match(/VERDICT=([A-Z_]+)/);
    if (m) verdict = m[1];
  });
  v.stderr.pipe(process.stderr);
  const vCode = await new Promise((res) => v.on('exit', res));
  const now = new Date();
  const promoDay = new Date(`${now.getUTCFullYear()}-10-28T00:00:00Z`);
  const prePromo = now < promoDay;
  const okVerdicts = prePromo
    ? (verdict === 'SMOKE_FAIL_NOT_PROMOTED' && vCode === 1)
    : (verdict.startsWith('SMOKE_PASS') && vCode === 0);
  console.log(`B5 verdict=${verdict || 'NONE'} exit=${vCode} expected(${prePromo ? 'pre' : 'post'}-promo)=${okVerdicts ? 'match' : 'MISMATCH'}`);
  if (!okVerdicts) failures++;

  return failures;
}

/**
 * PREFLIGHT_TOKEN is a sealed COPY of the CredMan token, so it rotated under
 * us — re-seal it to the new token or the deploy-key preflight (which requires
 * administration:read, impossible for GITHUB_TOKEN) goes red by design.
 */
async function sealPreflightToken(token) {
  try {
    const pk = await api(`/repos/${REPO_SLUG}/actions/secrets/public-key`, 'GET', token);
    if (pk.code !== 200 || !pk.json?.key) {
      console.error(`  seal: public-key -> ${pk.code}`);
      return false;
    }
    const encrypted_value = seal(token, pk.json.key);
    const put = await api(`/repos/${REPO_SLUG}/actions/secrets/PREFLIGHT_TOKEN`, 'PUT', token, {
      key_id: pk.json.key_id,
      encrypted_value,
    });
    if (put.code !== 201 && put.code !== 204) {
      console.error(`  seal: PUT secrets/PREFLIGHT_TOKEN -> ${put.code}: ${put.text.slice(0, 140)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`  seal: ${e && e.message}`);
    return false;
  }
}

/**
 * The deploy-key leg of a full rotation: the cron snapshot push rides on a
 * write-enabled deploy key + a ruleset bypass actor bound to its ID + the
 * DEPLOY_KEY_PEM secret — ALL THREE die with a credential rotation, so they
 * are re-minted here (order-safe: the old key is deleted only after the
 * preflight reads green). Then PREFLIGHT_TOKEN is re-sealed and the strict
 * preflight must PASS, or the leg — and the run — fails.
 */
async function deployKeyLeg(token) {
  console.log('── deploy-key leg ────────────────────────────────────────');
  let failures = 0;
  if (!token) { console.error('  no token for the deploy-key leg'); return 1; }
  try {
    const dk = await runDeployKeyRotation({
      repoSlug: REPO_SLUG,
      token,
      keepOldKeys: flag('--keep-old-keys'),
      log: (m) => console.log('  ' + m),
    });
    console.log(`  new key id=${dk.newKeyId} deletedOld=[${(dk.deletedOldKeyIds || []).join(',') || 'none'}]`);
  } catch (e) {
    console.error(`  deploy-key re-mint FAILED: ${e && e.message}`);
    failures++;
  }
  const sealed = await sealPreflightToken(token);
  console.log(sealed
    ? '  PREFLIGHT_TOKEN re-sealed to the new token'
    : '  PREFLIGHT_TOKEN re-seal FAILED — preflight stays red until re-sealed');
  if (!sealed) failures++;
  try {
    const out = execFileSync(
      process.execPath,
      [CHECK_DEPLOY_KEY, '--repo', REPO_SLUG, '--token', token, '--require-audit'],
      { encoding: 'utf8', timeout: 120_000 }
    );
    console.log('  ' + out.trim().split('\n').pop());
    if (!out.includes('RESULT deploy-key-preflight PASS')) failures++;
  } catch (e) {
    console.error(`  strict preflight FAILED: ${String(e.stdout || e.message).trim().split('\n').slice(-2).join(' | ')}`);
    failures++;
  }
  return failures;
}

async function deployKeyOnlyMode() {
  const t = readToken();
  if (!t) { console.error('FATAL: no token in CredMan.'); process.exit(1); }
  const failures = await deployKeyLeg(t);
  console.log(failures === 0 ? '\nDEPLOY_KEY_LEG_GREEN' : `\nDEPLOY_KEY_LEG_FAILED failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

function gitAuthEnv(token) {
  const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
  return Object.assign({}, process.env, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${b64}`,
  });
}

async function statusMode() {
  const s = fs.existsSync(STATUS) ? fs.readFileSync(STATUS, 'utf8') : '(no status file — no rotation run yet)';
  console.log(s.trim() || '(status file empty)');
  const t = readToken();
  if (t) console.log(`\nCredMan token: fp=${fp(t)} len=${t.length}`);
}

async function batteryOnlyMode() {
  const t = readToken();
  if (!t) { console.error('FATAL: no token in CredMan.'); process.exit(1); }
  const failures = await battery(t);
  console.log(failures === 0 ? '\nBATTERY_GREEN' : `\nBATTERY_FAILED failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  if (flag('--status')) return statusMode();
  if (flag('--battery-only')) return batteryOnlyMode();
  if (flag('--deploy-key-only')) return deployKeyOnlyMode();

  const { before } = preflight();
  const child = launchPoller();

  console.log('\nWhat happens next (details: docs/rotation.md):');
  console.log('  1. A CODE line appears below — open github.com/login/device, enter it.');
  console.log('  2. If GitHub shows a sudo/re-auth challenge (passkey / emailed 8-char');
  console.log('     NO-dash code), clear it in the same sitting — sudo is per-flow.');
  console.log('  3. On success the poller swaps CredMan and verifies read-back.');
  console.log('  Codes keep re-minting every ~15 min; nothing expires the campaign.\n');

  const r = await waitForResult(child, before);
  if (!r.ok) {
    console.error('\nROTATION_INCOMPLETE — ' + r.result);
    console.error(`Inspect: ${STATUS}, ${LOG}. Codes keep minting while the poller lives;`);
    console.error('re-run `npm run rotate` any time (it restarts cleanly).');
    process.exitCode = 1;
    return;
  }

  if (DO_BATTERY) {
    const t = readToken();
    const failures = await battery(t);
    console.log(failures === 0 ? '\nROTATION_OK BATTERY_GREEN' : `\nROTATION_SWAPPED_BATTERY_FAILED failures=${failures}`);
    if (failures !== 0) process.exitCode = 1;
  } else {
    console.log('\nROTATION_OK (battery skipped by --no-battery; run `npm run rotate -- --battery-only` later)');
  }

  // The cron deploy key + PREFLIGHT_TOKEN die with every credential rotation —
  // re-mint them here (skippable with --skip-deploy-key).
  if (flag('--skip-deploy-key')) {
    console.log('\nDEPLOY_KEY_LEG_SKIPPED (--skip-deploy-key; cron push path NOT re-minted)');
  } else {
    const dkFailures = await deployKeyLeg(readToken());
    if (dkFailures !== 0) {
      process.exitCode = 1;
      console.log(`DEPLOY_KEY_LEG_FAILED failures=${dkFailures} (token swap survived; fix the leg with \`npm run rotate -- --deploy-key-only\`)`);
    } else {
      console.log('DEPLOY_KEY_LEG_GREEN');
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e && e.message);
  process.exit(1);
});
