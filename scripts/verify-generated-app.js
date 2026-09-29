#!/usr/bin/env node
/**
 * Headless logic verifier for generated apps.
 *
 * Runs an app's JavaScript in a `vm` sandbox with stubbed DOM elements and a
 * manually-driven interval clock, then applies a small per-app assertions
 * file. This is the tool that caught (and now regresses) the Pomodoro
 * "Break now" mode-clobber bug — the pattern generalizes to any generated
 * app: drive the app's own tick()/handlers synchronously and assert on
 * textContent/classList/hidden.
 *
 * Usage:
 *   node scripts/verify-generated-app.js <app.js-or-project-dir> <assertions.cjs>
 *   npm run verify:app -- projects-data/<id>/app.js .freebuff/assert-mine.cjs
 *
 * Assertions file contract (CommonJS):
 *   module.exports = {
 *     setup(h) { h.elAll('.progress-indicators .dot', 4); }, // optional, BEFORE load
 *     run(h)   { h.check('label', cond); },                  // required
 *   };
 *   // or simply: module.exports = (h) => { h.check(...); };
 *
 * Harness API:
 *   h.el(sel)               stub element for querySelector(sel); '#id' shares
 *                           the object with getElementById(id). Auto-created.
 *   h.elAll(sel, n)         register n elements for querySelectorAll(sel);
 *                           REQUIRED before load — lists are never auto-made.
 *   h.ticks(n)              fire every pending interval n times (drives the
 *                           app's own tick — immune to tab throttling).
 *   h.pendingIntervals()    live interval count (leak checks).
 *   h.check(label, cond)    tally one assertion; prints PASS/FAIL.
 *
 * Sandbox: document (querySelector/querySelectorAll/getElementById/body),
 * window, in-memory localStorage/sessionStorage, console pass-through,
 * stubbed setInterval/clearInterval/setTimeout/requestAnimationFrame.
 * Everything else is the vm realm's standard builtins. Apps that touch
 * unstubbed globals fail loudly — extend deliberately, don't guess.
 *
 * Exit: 0 = RESULT LOGIC_PASS (all assertions green), 1 = any failure,
 * app throw, or assertions-file error.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(String(k), String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

function makeEl(name) {
  const classes = new Set();
  const handlers = {};
  return {
    name,
    textContent: '',
    hidden: false,
    value: '',
    classList: {
      toggle(c, on) {
        if (on === undefined) on = !classes.has(c);
        if (on) classes.add(c); else classes.delete(c);
      },
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    addEventListener: (t, fn) => { handlers[t] = fn; },
    removeEventListener: (t) => { delete handlers[t]; },
    click: () => { if (handlers.click) handlers.click(); },
  };
}

function createHarness() {
  const bySelector = new Map();
  const lists = new Map();
  const intervals = new Map();
  let nextId = 1;
  let passCount = 0;
  let failCount = 0;

  // '#x' selectors and getElementById('x') share one element instance.
  const el = (sel) => {
    const key = sel.startsWith('#') ? 'id:' + sel.slice(1) : sel;
    if (!bySelector.has(key)) bySelector.set(key, makeEl(sel));
    return bySelector.get(key);
  };

  const sandbox = {
    document: {
      querySelector: (s) => el(s),
      querySelectorAll: (s) => {
        if (!lists.has(s)) {
          throw new Error(
            `querySelectorAll("${s}") was not registered — call h.elAll("${s}", n) in setup(h) before the app loads`
          );
        }
        return lists.get(s);
      },
      getElementById: (id) => el('#' + id),
      get body() { return el('body'); },
      addEventListener: () => {},
    },
    window: { addEventListener: () => {} },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    console,
    setInterval: (fn) => {
      const id = nextId++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id) => { intervals.delete(id); },
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
  };

  return {
    sandbox,
    el,
    elAll: (sel, n) => {
      if (!lists.has(sel)) {
        lists.set(sel, Array.from({ length: n }, (_, i) => makeEl(`${sel}[${i}]`)));
      }
      return lists.get(sel);
    },
    ticks(n) {
      for (let i = 0; i < n; i++) {
        for (const fn of [...intervals.values()]) fn();
      }
    },
    pendingIntervals: () => intervals.size,
    check(label, cond) {
      if (cond) { passCount++; console.log('  PASS', label); }
      else { failCount++; console.log('  FAIL', label); }
    },
    get pass() { return passCount; },
    get fail() { return failCount; },
  };
}

function main() {
  const [appArg, assertsArg] = process.argv.slice(2);
  if (!appArg || !assertsArg) {
    console.error('usage: node scripts/verify-generated-app.js <app.js-or-project-dir> <assertions.cjs>');
    process.exit(1);
  }

  const appStat = fs.existsSync(appArg) && fs.statSync(appArg);
  const appPath = appStat && appStat.isDirectory() ? path.join(appArg, 'app.js') : appArg;
  if (!fs.existsSync(appPath)) {
    console.error(`APP_NOT_FOUND ${appPath}`);
    process.exit(1);
  }

  const assertsPath = path.resolve(assertsArg);
  let mod;
  try {
    mod = require(assertsPath);
  } catch (e) {
    console.error(`ASSERTIONS_LOAD_FAILED ${e.message}`);
    process.exit(1);
  }
  const setup = typeof mod === 'function' ? null : mod.setup;
  const run = typeof mod === 'function' ? mod : mod.run;
  if (typeof run !== 'function') {
    console.error('assertions file must export run(h) (or be a function)');
    process.exit(1);
  }

  const h = createHarness();
  try {
    if (setup) setup(h);
    vm.runInContext(fs.readFileSync(appPath, 'utf8'), vm.createContext(h.sandbox), {
      filename: appPath,
    });
    run(h);
  } catch (e) {
    // e.stack's first frame is the vm.runInContext call site in THIS file;
    // the actionable part is the message (e.g. an unregistered list).
    console.error(`APP_ERROR ${e && e.message ? e.message : e}`);
    console.log(`\nRESULT LOGIC_FAIL pass=${h.pass} fail=${h.fail + 1}`);
    process.exit(1);
  }

  console.log(`\nRESULT ${h.fail === 0 ? 'LOGIC_PASS' : 'LOGIC_FAIL'} pass=${h.pass} fail=${h.fail}`);
  process.exit(h.fail === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { createHarness, makeEl, makeStorage };
