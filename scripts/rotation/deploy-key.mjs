/**
 * Cron deploy-key re-mint — the deploy-key leg of `npm run rotate`.
 *
 * A full credential rotation invalidates ALL THREE legs the monthly
 * snapshot push rides on: the deploy key itself, the DEPLOY_KEY_PEM
 * secret, and the ruleset bypass actor that binds to the key ID
 * (proved live on 2026-09-29, when a grant revocation silently killed
 * the cron path). This module re-mints everything in an order that
 * never leaves the push path dark:
 *
 *   discover → mint+verify pair → register new key (write) →
 *   rebind ruleset bypass ADDITIVELY (old actor untouched) →
 *   swap DEPLOY_KEY_PEM secret → local preflight must PASS →
 *   delete OLD key last → secure-delete key material
 *
 * Resume-safety: the new key title embeds a date+fp stamp; on 422
 * (duplicate) the existing key is adopted instead of failing, so an
 * interrupted run converges instead of orphaning keys.
 *
 * CLI (also used by rotate.mjs via runDeployKeyRotation):
 *   node scripts/rotation/deploy-key.mjs --repo o/r [--keep-old-keys] [--dry-run]
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seal } from './sealed-box.mjs';
import { mintEd25519, verifyPair } from './ssh-keygen.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECK_DEPLOY_KEY = path.join(__dirname, '..', 'check-deploy-key.js');
const KEY_DIR_NAME = '.freebuff/tmp'; // workspace-relative, gitignored, wiped after

export const SECRET_NAME = 'DEPLOY_KEY_PEM';
export const KEY_TITLE_PREFIX = 'cron-refresh deploy key';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fp8 = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 8);

export function apiFactory(token) {
  return async function api(urlPath, method = 'GET', body) {
    const res = await fetch('https://api.github.com' + urlPath, {
      method,
      headers: {
        'User-Agent': 'rotate-deploy-key',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 204s etc. */ }
    return { code: res.status, json, text };
  };
}

/** Everything knowable about the current deploy-key state, read-only. */
export async function discover(api, repoSlug) {
  const keys = await api(`/repos/${repoSlug}/keys?per_page=100`);
  if (keys.code !== 200) throw new Error(`GET /keys -> ${keys.code}`);
  const list = keys.json || [];
  const writers = list.filter((k) => k && k.read_only === false);
  const cronKeys = list.filter((k) => k && String(k.title || '').startsWith(KEY_TITLE_PREFIX));

  let ruleset = null; // first ACTIVE branch ruleset governing ~DEFAULT_BRANCH
  const rl = await api(`/repos/${repoSlug}/rulesets?per_page=100`);
  if (rl.code === 200 && Array.isArray(rl.json)) {
    for (const r of rl.json.filter((x) => x && x.enforcement === 'active' && (x.target ?? 'branch') === 'branch')) {
      const full = await api(`/repos/${repoSlug}/rulesets/${r.id}`);
      if (full.code !== 200 || !full.json) continue;
      const cond = full.json.conditions?.ref_name || {};
      const include = cond.include ?? [];
      const exclude = cond.exclude ?? [];
      const governs = exclude.length === 0 && (include.length === 0 || include.includes('~DEFAULT_BRANCH'));
      if (governs) { ruleset = full.json; break; }
    }
  }
  const bypass = ruleset
    ? (ruleset.bypass_actors || []).filter((a) => a.actor_type === 'DeployKey')
    : [];

  let secret = false;
  const sec = await api(`/repos/${repoSlug}/actions/secrets?per_page=100`);
  if (sec.code === 200 && sec.json) {
    secret = (sec.json.secrets || []).some((s) => s.name === SECRET_NAME);
  }

  return {
    keys: list,
    writers,
    cronKeys,
    writerWithoutCronTitle: writers.filter((k) => !String(k.title || '').startsWith(KEY_TITLE_PREFIX)),
    ruleset,
    rulesetBypassKeys: bypass,
    secret,
  };
}

/**
 * One full re-mint. Returns a summary; throws on any unrecoverable step
 * (failures leave the OLD key in place until the preflight has passed, so a
 * throw here never darkens the push path).
 */
export async function runDeployKeyRotation({ repoSlug, token, log = console.log, keepOldKeys = false, dryRun = false, now = new Date() }) {
  const api = apiFactory(token);
  const stamp = `${now.toISOString().slice(0, 10)}-${fp8(token)}`;
  const newTitle = `${KEY_TITLE_PREFIX} (v4, ${stamp})`;

  log(`── deploy-key re-mint (${repoSlug}) ───────────────────────`);
  const before = await discover(api, repoSlug);
  log(`discover: ${before.keys.length} key(s), ${before.writers.length} write-enabled, ${before.cronKeys.length} cron key(s), ruleset ${before.ruleset ? before.ruleset.id : 'none'}, ${before.rulesetBypassKeys.length} DeployKey actor(s), secret ${before.secret ? 'present' : 'MISSING'}`);

  // ---- 1. Mint + verify the pair locally (nothing remote yet) -------------
  const root = process.cwd();
  const outDir = path.join(root, KEY_DIR_NAME);
  const pair = mintEd25519({ repoSlug, outDir });
  verifyPair(pair.privateKeyPath, pair.fingerprint);
  log(`minted ${pair.fingerprint} (${pair.comment})`);
  const privPem = fs.readFileSync(pair.privateKeyPath, 'utf8');

  if (dryRun) {
    fs.rmSync(pair.privateKeyPath, { force: true });
    fs.rmSync(`${pair.privateKeyPath}.pub`, { force: true });
    log('dry-run: pair destroyed, nothing registered');
    return { dryRun: true, fingerprint: pair.fingerprint, title: newTitle };
  }

  const created = { keyId: null, oldKeyIds: [] };
  try {
    // ---- 2. Register the new key (write-enabled) --------------------------
    let reg = await api(`/repos/${repoSlug}/keys`, 'POST', {
      title: newTitle,
      key: pair.pubLine, // FULL OpenSSH line - the bare blob 422s
      read_only: false,
    });
    if (reg.code === 422 && Array.isArray(reg.json?.errors)) {
      // Already registered by an interrupted earlier run → adopt it.
      const dup = before.keys.concat(...(await api(`/repos/${repoSlug}/keys?per_page=100`).then((r) => r.json || [])))
        .find((k) => k && (k.key || '').includes(pair.pubB64));
      if (!dup) throw new Error(`422 duplicate but key not found: ${reg.text.slice(0, 200)}`);
      reg = { code: 200, json: dup };
      log(`422 duplicate → adopted existing key id ${dup.id}`);
    }
    if (reg.code !== 201 && reg.code !== 200) throw new Error(`POST /keys -> ${reg.code}: ${reg.text.slice(0, 200)}`);
    created.keyId = reg.json.id;
    log(`registered key id ${created.keyId} (read_only=${reg.json.read_only})`);
    if (reg.json.read_only !== false) throw new Error('GitHub registered the key as read-only — aborting before any rebinding');

    // ---- 3. Rebind the ruleset actor ADDITIVELY (old actor stays until 6) -
    if (before.ruleset) {
      const actors = (before.ruleset.bypass_actors || []).slice();
      if (!actors.some((a) => a.actor_type === 'DeployKey' && a.actor_id === created.keyId)) {
        actors.push({ actor_id: created.keyId, actor_type: 'DeployKey', bypass_mode: 'always' });
      }
      const put = await api(`/repos/${repoSlug}/rulesets/${before.ruleset.id}`, 'PUT', {
        name: before.ruleset.name,
        target: before.ruleset.target ?? 'branch',
        enforcement: before.ruleset.enforcement,
        conditions: before.ruleset.conditions,
        rules: before.ruleset.rules,
        bypass_actors: actors,
      });
      if (put.code !== 200) throw new Error(`PUT /rulesets/${before.ruleset.id} -> ${put.code}: ${put.text.slice(0, 200)}`);
      log(`ruleset ${before.ruleset.id}: DeployKey actor bound additively (${actors.length} actor(s) total)`);
    } else {
      log('ruleset leg: no governing ruleset — nothing to rebind');
    }

    // ---- 4. Swap the secret ----------------------------------------------
    const pk = await api(`/repos/${repoSlug}/actions/secrets/public-key`);
    if (pk.code !== 200 || !pk.json?.key) throw new Error(`secrets/public-key -> ${pk.code}`);
    const encrypted_value = seal(privPem, pk.json.key);
    const put = await api(`/repos/${repoSlug}/actions/secrets/${SECRET_NAME}`, 'PUT', {
      key_id: pk.json.key_id,
      encrypted_value,
    });
    if (put.code !== 201 && put.code !== 204) throw new Error(`PUT secrets/${SECRET_NAME} -> ${put.code}`);
    log(`${SECRET_NAME} sealed (key_id ${pk.json.key_id}, ${encrypted_value.length} b64 chars)`);

    // ---- 5. Local preflight MUST pass before the old key dies -------------
    await sleep(2000); // secret propagation slack
    const { execFileSync } = await import('node:child_process');
    let preflightOut = '';
    try {
      preflightOut = execFileSync(process.execPath, [CHECK_DEPLOY_KEY, '--repo', repoSlug, '--token', token], {
        encoding: 'utf8', timeout: 120_000,
      });
    } catch (e) {
      preflightOut = String(e.stdout || '') + String(e.stderr || '');
    }
    if (!preflightOut.includes('RESULT deploy-key-preflight PASS')) {
      throw new Error(`preflight did not PASS — keeping old key.\n${preflightOut.trim()}`);
    }
    log('preflight: PASS (all three legs read positive)');

    // ---- 6. Only now delete the old cron key(s) ---------------------------
    if (!keepOldKeys) {
      created.oldKeyIds = before.cronKeys.map((k) => k.id);
      for (const id of created.oldKeyIds) {
        const del = await api(`/repos/${repoSlug}/keys/${id}`, 'DELETE');
        log(`delete old cron key ${id}: HTTP ${del.code}`);
        if (del.code !== 204) log(`  (non-204 — inspect manually; new key ${created.keyId} remains authoritative)`);
      }
    } else {
      log('keep-old-keys: old cron keys left in place');
    }
  } finally {
    // ---- 7. Secure-delete the local key material either way ---------------
    for (const p of [pair.privateKeyPath, `${pair.privateKeyPath}.pub`]) {
      try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
    }
  }

  return {
    newKeyId: created.keyId,
    deletedOldKeyIds: created.oldKeyIds,
    fingerprint: pair.fingerprint,
    title: newTitle,
    oldRulesetActorCount: before.rulesetBypassKeys.length,
  };
}

/** CLI entry: `node scripts/rotation/deploy-key.mjs --repo o/r [--dry-run]` */
export async function cliMain(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, f) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : f; };
  const repoSlug = opt('--repo', process.env.ROTATE_REPO || 'Creative-hub554/Base88Plus');
  const dryRun = flag('--dry-run');
  const keepOldKeys = flag('--keep-old-keys');

  const { execFileSync } = await import('node:child_process');
  let token = '';
  try {
    token = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'cred-read.ps1')],
      { encoding: 'utf8', timeout: 60_000 },
    ).trim();
  } catch { /* fall through */ }
  if (!token) {
    console.error('FATAL: no usable token in CredMan.');
    process.exit(1);
  }
  const summary = await runDeployKeyRotation({ repoSlug, token, keepOldKeys, dryRun });
  console.log('SUMMARY ' + JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cliMain(process.argv.slice(2)).catch((e) => {
    console.error('FATAL:', e && e.message);
    process.exit(1);
  });
}
