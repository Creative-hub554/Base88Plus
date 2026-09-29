/**
 * GitHub OAuth device-flow token poller for CredMan rotation.
 *
 * Mints device codes (up to --gens, ~15 min each) and polls GitHub's OAuth
 * token endpoint until the operator approves one at github.com/login/device.
 * On success it shape-checks the token, verifies identity + scopes against
 * /user, then delegates the Windows Credential Manager swap to cred-swap.ps1
 * (NEW_TOKEN via env — the token is never an argv or a file).
 *
 * Hard-won rules baked in (see docs/rotation.md):
 *   - NEVER exit on a flow error (access_denied, incorrect_device_code, …):
 *     log it, cool down, mint the next code. Exiting turns any stray/wrong
 *     approval into a dead rotator that nobody notices for hours.
 *   - Default 150 generations ≈ 36 h of continuously fresh codes: the flow
 *     must survive turn boundaries, meetings, and overnight pauses.
 *   - Retry every HTTP request (network hiccups must not kill a generation).
 *
 * Exit codes: 0 = swap verified (SWAP_OK), 1 = any other outcome.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLIENT_ID = process.env.ROTATE_CLIENT_ID || '178c6fc778ccc68e1d6a'; // GitHub CLI
const LOGIN = process.env.ROTATE_LOGIN || 'Creative-hub554';
const SCOPES = process.env.ROTATE_SCOPES || 'gist read:org repo workflow';
const GENS = parseInt(process.env.ROTATE_GENS || '150', 10);
const FLOW_ERROR_COOLDOWN_MS = 10_000;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUN_DIR = process.env.ROTATE_RUN_DIR || path.join(REPO_ROOT, '.freebuff');
const STATUS = path.join(RUN_DIR, 'rotation-status.txt');
const LOG = path.join(RUN_DIR, 'rotator.log');
const DEVICE_CODE_FILE = path.join(RUN_DIR, 'device-code.json');
const SWAP_SCRIPT = path.join(__dirname, 'cred-swap.ps1');
const SWAP_TARGET = process.env.ROTATE_TARGET || 'gh:github.com:Creative-hub554';

fs.mkdirSync(RUN_DIR, { recursive: true });
const note = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG, line + '\n');
  try { fs.appendFileSync(STATUS, msg + '\n'); } catch { /* status file is best-effort */ }
  console.log(msg);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(host, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const H = Object.assign(
      { 'User-Agent': 'token-rotate', Accept: 'application/json' },
      headers || {}
    );
    if (body) H['Content-Type'] = 'application/x-www-form-urlencoded';
    const req = https.request(
      { host, path: urlPath, method: body ? 'POST' : 'GET', headers: H },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ code: res.statusCode, body: d, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function req(host, urlPath, body, headers) {
  let err;
  for (let a = 0; a < 6; a++) {
    try {
      return await once(host, urlPath, body, headers);
    } catch (e) {
      err = e;
      await sleep(2_000);
    }
  }
  throw err;
}

async function pollGeneration(dc) {
  const interval = Math.max((dc.interval || 5) * 1000, 5000);
  const deadline = dc.expires_at - 15_000; // stop before expiry to avoid dead-window polls
  while (Date.now() < deadline) {
    let j = null;
    try {
      const pr = await req(
        'github.com',
        '/login/oauth/access_token',
        'client_id=' + CLIENT_ID +
          '&device_code=' + encodeURIComponent(dc.device_code) +
          '&grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:device_code')
      );
      try { j = JSON.parse(pr.body); } catch { j = null; }
    } catch {
      await sleep(5_000);
      continue;
    }
    if (j && j.access_token) {
      note('TOKEN_SEEN fp=' + crypto.createHash('sha256').update(j.access_token).digest('hex').slice(0, 8));
      if (!/^gh[a-z]_[A-Za-z0-9]{30,60}$/.test(j.access_token)) {
        note('RESULT SHAPE_UNEXPECTED');
        process.exit(1);
      }
      const u = await req('api.github.com', '/user', null, { Authorization: 'Bearer ' + j.access_token });
      if (u.code !== 200) {
        note('RESULT NEW_TOKEN_HTTP_' + u.code);
        process.exit(1);
      }
      const scopes = (u.headers['x-oauth-scopes'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
      if (JSON.parse(u.body).login !== LOGIN || !scopes.includes('repo') || !scopes.includes('workflow')) {
        note('RESULT SCOPE_OR_LOGIN_MISMATCH');
        process.exit(1);
      }
      let out;
      try {
        out = execFileSync(
          'powershell',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SWAP_SCRIPT, '-Target', SWAP_TARGET],
          { env: Object.assign({}, process.env, { NEW_TOKEN: j.access_token }), encoding: 'utf8', timeout: 60_000 }
        );
      } catch (e) {
        out = (e.stdout || '') + (e.stderr || '');
      }
      const first = String(out).trim().split('\n')[0] || 'EMPTY_SWAP_OUTPUT';
      note('RESULT ' + first);
      process.exit(first.includes('SWAP_OK') ? 0 : 1);
    }
    if (!j) { await sleep(interval); continue; }
    if (j.error === 'authorization_pending') { await sleep(interval); continue; }
    if (j.error === 'slow_down') { await sleep(interval + 5_000); continue; }
    if (j.error === 'expired_token' || j.error === 'bad_verification_code') return false;
    // Unknown flow error: log and LIVE ON (mint the next code). Exiting here is
    // what silently killed attempts 1–11 whenever a stray approval landed.
    note('RESULT FLOW_ERROR ' + j.error);
    await sleep(FLOW_ERROR_COOLDOWN_MS);
    return false;
  }
  return false;
}

async function mintAndPoll(gen) {
  const dr = await req(
    'github.com',
    '/login/device/code',
    'client_id=' + CLIENT_ID + '&scope=' + encodeURIComponent(SCOPES)
  );
  if (dr.code !== 200) {
    note('RESULT DEVICE_CODE_HTTP_' + dr.code);
    process.exit(1);
  }
  const dj = JSON.parse(dr.body);
  const record = {
    device_code: dj.device_code,
    expires_at: Date.now() + dj.expires_in * 1000,
    user_code: dj.user_code,
    interval: dj.interval,
  };
  fs.writeFileSync(DEVICE_CODE_FILE, JSON.stringify(record));
  note(`CODE ${dj.user_code} gen${gen}`);
  console.log(`>>> OPEN https://github.com/login/device AND ENTER ${dj.user_code} (valid ~${Math.round(dj.expires_in / 60)} min)`);
  return pollGeneration(record);
}

(async () => {
  for (let gen = 1; gen <= GENS; gen++) {
    await mintAndPoll(gen);
    if (gen < GENS) await sleep(5_000);
  }
  note('RESULT EXHAUSTED');
  process.exit(1);
})().catch((e) => {
  note('RESULT ERR ' + e.message);
  process.exit(1);
});
