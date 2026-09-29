#!/usr/bin/env node
/**
 * Deploy-key preflight — audits the cron-refresh push path on EVERY CI run.
 *
 * The 2026-09-29 test-fire (run 36532638008) proved the monthly snapshot push
 * can die silently: the grant-revocation pass had removed (1) the repo's
 * deploy key, (2) the main-protection ruleset's DeployKey bypass actor, and
 * the Oct 3 cron would have burned its monthly attempt on a dead credential
 * with nothing but a `Permission denied (publickey)` in a log nobody reads.
 * Rotating a deploy key invalidates ALL THREE legs, because the ruleset
 * bypass actor binds to the key id — so this check audits all three:
 *
 *   1. Repo has a WRITE-ENABLED deploy key        (GET /repos/{o}/{r}/keys)
 *   2. An active branch ruleset that governs the default branch still has a
 *      DeployKey bypass actor                     (GET /repos/{o}/{r}/rulesets)
 *   3. The DEPLOY_KEY_PEM Actions secret exists   (GET /repos/{o}/{r}/actions/secrets)
 *
 * Verdicts (matches the RESULT convention used by the verify harness):
 *   PASS — all three legs read and positive (exit 0)
 *   FAIL — any leg was readable and definitively negative (exit 1)
 *   SKIP — the token cannot audit (fork PRs run with a read-only token;
 *          administration endpoints 403). Skipping is honest, failing there
 *          would break every fork PR on a check it cannot influence.
 *
 * Usage:
 *   node scripts/check-deploy-key.js                       (in CI: GITHUB_TOKEN env)
 *   node scripts/check-deploy-key.js --repo o/r --token t  (local override)
 *   node scripts/check-deploy-key.js --self-test           (offline fixture suite)
 */
'use strict';

const SELF = 'DEPLOY_KEY_PEM';

/** GET one endpoint; returns { status, json } (json=null for non-JSON bodies). */
async function ghGet(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 204s and error bodies without JSON */
  }
  return { status: res.status, json };
}

/**
 * Does a ruleset's ref_name conditions govern `branch`? Handles the
 * ~DEFAULT_BRANCH token, full refs, and bare names; empty conditions apply
 * to everything. Excludes win over includes.
 */
function rulesetGovernsBranch(conditions, branch) {
  if (!conditions || !conditions.ref_name) return true; // null scope = all refs
  const { include = [], exclude = [] } = conditions.ref_name;
  const ref = `refs/heads/${branch}`;
  const matches = (pat) => pat === '~DEFAULT_BRANCH' || pat === ref || pat === branch;
  if (exclude.some(matches)) return false;
  if (include.length === 0) return true;
  return include.some(matches);
}

/**
 * Pure verdict logic — self-test fixtures run this offline.
 * inputs: defaultBranch, keys (array|null when unreadable), keysStatus,
 *         rulesets (array of full ruleset objects|null), rulesetsStatus,
 *         secretNames (array|null), secretsStatus
 * returns { verdict: 'PASS'|'FAIL'|'SKIP', lines: string[] }
 */
function classify(input) {
  const lines = [];
  let fail = null; // first definitive negative
  let blocked = false; // any leg we could not read

  const block = (msg) => {
    blocked = true;
    lines.push(`~ ${msg}`);
  };
  const reject = (msg) => {
    if (!fail) fail = msg;
    lines.push(`✗ ${msg}`);
  };

  // ---- Leg 1: write-enabled deploy key ------------------------------------
  if (input.keysStatus === 200 && Array.isArray(input.keys)) {
    const writers = input.keys.filter((k) => k && k.read_only === false);
    if (writers.length === 0) {
      reject(input.keys.length === 0
        ? 'no deploy keys registered on the repo (the push credential has nothing to authenticate against)'
        : 'every registered deploy key is read-only (write access was never enabled or was revoked)');
    } else {
      lines.push(`✓ deploy key leg: ${writers.length} write-enabled key(s) registered`);
    }
  } else {
    block(`deploy key leg unreadable (HTTP ${input.keysStatus}) — likely a fork-PR read-only token`);
  }

  // ---- Leg 2: active branch ruleset with a DeployKey bypass actor ---------
  if (input.rulesetsStatus === 200 && Array.isArray(input.rulesets)) {
    const active = input.rulesets.filter(
      (r) => r && r.enforcement === 'active' && (r.target ?? 'branch') === 'branch'
    );
    const governing = active.filter((r) => rulesetGovernsBranch(r.conditions, input.defaultBranch));
    const exempting = governing.filter((r) =>
      (r.bypass_actors || []).some((a) => a.actor_type === 'DeployKey')
    );
    if (governing.length === 0) {
      // No active branch ruleset reaches the default branch → nothing blocks
      // the push; the bypass leg is vacuously satisfied.
      lines.push('✓ ruleset leg: no active branch ruleset governs the default branch (nothing to bypass)');
    } else if (exempting.length === 0) {
      reject(`${governing.length} active branch ruleset(s) govern the default branch and NONE has a DeployKey bypass actor — the cron push would be rejected as a pull-request violation`);
    } else {
      lines.push(`✓ ruleset leg: ${exempting.length} governing ruleset(s) exempt DeployKey actors (always mode)`);
    }
  } else {
    block(`ruleset leg unreadable (HTTP ${input.rulesetsStatus}) — likely a fork-PR read-only token`);
  }

  // ---- Leg 3: the secret exists -------------------------------------------
  if (input.secretsStatus === 200 && Array.isArray(input.secretNames)) {
    if (input.secretNames.includes(SELF)) {
      lines.push(`✓ secret leg: ${SELF} exists`);
    } else {
      reject(`${SELF} is missing from repo Actions secrets — ssh-agent would load nothing`);
    }
  } else {
    block(`secret leg unreadable (HTTP ${input.secretsStatus}) — likely a fork-PR read-only token`);
  }

  if (fail) return { verdict: 'FAIL', lines };
  if (blocked) return { verdict: 'SKIP', lines };
  return { verdict: 'PASS', lines };
}

/** Fetch live data (repo meta + keys + rulesets-with-actors + secret names). */
async function gather(repo, token) {
  const meta = await ghGet(`/repos/${repo}`, token);
  if (meta.status !== 200 || !meta.json) {
    return { repoError: meta.status, defaultBranch: 'main' };
  }
  const defaultBranch = meta.json.default_branch || 'main';

  const keys = await ghGet(`/repos/${repo}/keys?per_page=100`, token);
  const secretNames = [];
  let secretsStatus = 200;
  let page = 1;
  for (;;) {
    const pageRes = await ghGet(`/repos/${repo}/actions/secrets?per_page=100&page=${page}`, token);
    secretsStatus = pageRes.status;
    if (pageRes.status !== 200 || !pageRes.json) break;
    const names = (pageRes.json.secrets || []).map((s) => s.name);
    secretNames.push(...names);
    const totalPages = pageRes.json.total_count > page * 100 ? page + 1 : page;
    if (page >= totalPages) break;
    page = totalPages;
  }

  // The ruleset LIST omits bypass_actors — fetch each active branch ruleset.
  const list = await ghGet(`/repos/${repo}/rulesets?per_page=100`, token);
  let rulesetsStatus = list.status;
  let rulesets = [];
  if (rulesetsStatus === 200 && Array.isArray(list.json)) {
    const candidates = list.json.filter(
      (r) => r && r.enforcement === 'active' && (r.target ?? 'branch') === 'branch'
    );
    rulesets = [];
    for (const r of candidates.slice(0, 10)) {
      const full = await ghGet(`/repos/${repo}/rulesets/${r.id}`, token);
      if (full.status === 200 && full.json) rulesets.push(full.json);
    }
  }

  return {
    defaultBranch,
    keys: keys.json,
    keysStatus: keys.status,
    rulesets,
    rulesetsStatus,
    secretNames,
    secretsStatus,
  };
}

function selfTest() {
  const mkRuleset = (over = {}) => ({
    enforcement: 'active',
    target: 'branch',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    ...over,
  });
  const base = {
    defaultBranch: 'main',
    keys: [{ id: 1, read_only: false }],
    keysStatus: 200,
    rulesets: [mkRuleset({ bypass_actors: [{ actor_type: 'DeployKey' }] })],
    rulesetsStatus: 200,
    secretNames: [SELF],
    secretsStatus: 200,
  };
  const cases = [
    ['all legs healthy → PASS', { ...base }, 'PASS'],
    ['zero deploy keys → FAIL', { ...base, keys: [] }, 'FAIL'],
    ['only read-only keys → FAIL', { ...base, keys: [{ id: 1, read_only: true }] }, 'FAIL'],
    ['governing ruleset without DeployKey actor → FAIL', { ...base, rulesets: [mkRuleset()] }, 'FAIL'],
    ['secret missing → FAIL', { ...base, secretNames: ['OTHER'] }, 'FAIL'],
    ['administration endpoints unreadable → SKIP', { ...base, keys: null, keysStatus: 403, rulesets: [], rulesetsStatus: 403 }, 'SKIP'],
    ['~DEFAULT_BRANCH conditions match', { ...base }, 'PASS'],
    ['ruleset scoped to another branch does not govern main → vacuous PASS', {
      ...base,
      rulesets: [mkRuleset({
        conditions: { ref_name: { include: ['refs/heads/dev'], exclude: [] } },
        bypass_actors: [{ actor_type: 'DeployKey' }],
      })],
    }, 'PASS'],
    ['excluded ref means the ruleset does not govern', {
      ...base,
      rulesets: [mkRuleset({ conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: ['refs/heads/main'] } } })],
    }, 'PASS'],
  ];
  let failures = 0;
  for (const [name, input, expected] of cases) {
    const got = classify(input).verdict;
    if (got !== expected) {
      console.error(`✗ self-test: ${name} — expected ${expected}, got ${got}`);
      failures++;
    } else {
      console.log(`✓ self-test: ${name}`);
    }
  }
  console.log(`RESULT self-test ${failures === 0 ? 'PASS' : 'FAIL'} cases=${cases.length} fail=${failures}`);
  return failures === 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  }
  const repoArgIdx = args.indexOf('--repo');
  const tokenArgIdx = args.indexOf('--token');
  const repo = repoArgIdx !== -1 ? args[repoArgIdx + 1] : process.env.GITHUB_REPOSITORY;
  const token = tokenArgIdx !== -1 ? args[tokenArgIdx + 1] : process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!repo || !token) {
    console.error('usage: check-deploy-key.js [--repo owner/repo] [--token TOKEN] | --self-test');
    process.exit(2);
  }

  const data = await gather(repo, token);
  if (data.repoError) {
    console.log(`RESULT deploy-key-preflight SKIP repo=${repo} (repo meta HTTP ${data.repoError})`);
    process.exit(0);
  }
  const { verdict, lines } = classify(data);
  console.log(`deploy-key preflight for ${repo} (default branch: ${data.defaultBranch})`);
  for (const line of lines) console.log(line);
  console.log(`RESULT deploy-key-preflight ${verdict}`);
  process.exit(verdict === 'FAIL' ? 1 : 0);
}

main().catch((err) => {
  console.error(`preflight crashed: ${err && err.message}`);
  process.exit(1);
});
