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
 *   node scripts/verify-generated-app.js --all
 *   npm run verify:app -- --all
 *
 * The `--all` mode runs every pin under tests/generated/<app>/ (a pinned
 * app.js + an assertions.cjs). Pins are REGRESSION SNAPSHOTs: copy a
 * generated app's workspace app.js next to its assertions and commit both —
 * CI then re-verifies the pinned behavior on every push even though the
 * live projects-data/ workspaces are gitignored. See
 * tests/generated/README.md for the convention.
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
 *   h.fireDocument(type)    invoke document listeners the app registered
 *                           (e.g. DOMContentLoaded init or keydown handlers).
 *   h.fireWindow(type)      same for window listeners.
 *   h.pendingIntervals()    live interval count (leak checks).
 *   h.check(label, cond)    tally one assertion; prints PASS/FAIL.
 *
 * Sandbox: document (querySelector/querySelectorAll/getElementById/body/
 * createElement/addEventListener), window, in-memory
 * localStorage/sessionStorage, console pass-through, stubbed
 * setInterval/clearInterval/setTimeout/requestAnimationFrame. Elements stub
 * classList, listeners, attributes/dataset, appendChild and
 * get/setAttribute. Everything else is the vm realm's standard builtins.
 * Apps that touch unstubbed globals fail loudly — extend deliberately,
 * don't guess.
 *
 * Exit: 0 = every suite LOGIC_PASS, 1 = any failure, app throw, or
 * assertions-file error. With --all and zero pins: 0 (nothing to protect).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PINS_DIR = path.resolve(__dirname, '..', 'tests', 'generated');

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
    // innerHTML assignment models the clear-and-rebuild pattern: setting it
    // wipes children (and text), so suites can assert refresh-not-append.
    get innerHTML() { return this.textContent; },
    set innerHTML(v) {
      this.textContent = String(v);
      this.children.length = 0;
    },
    hidden: false,
    value: '',
    attributes: {},
    dataset: {}, // plain object; seed data-* values in setup() — not auto-linked to attributes
    children: [],
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
    click(event) {
      if (handlers.click) {
        handlers.click(event || { type: 'click', preventDefault() {}, stopPropagation() {} });
      }
    },
    getAttribute(n) {
      return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null;
    },
    setAttribute(n, v) { this.attributes[n] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    // Constraint-validation stub: generated forms commonly gate Next on
    // checkValidity(); default valid, suites can override per-element.
    checkValidity: () => true,
    reportValidity: () => true,
  };
}

function createHarness() {
  const bySelector = new Map();
  const lists = new Map();
  const intervals = new Map();
  const docListeners = {};
  const winListeners = {};
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
      addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
      createElement: (tag) => makeEl(tag),
    },
    window: { addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); } },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    // Constraint-validation era: generated forms commonly do
    // Object.fromEntries(new FormData(form)). Reads form.elements (seed the
    // array in setup) pairing each entry's id/name with its value.
    FormData: class {
      constructor(form) {
        this.pairs = (form && form.elements ? form.elements : []).map(
          (e) => [e.id || e.name || 'field', e.value]
        );
      }
      [Symbol.iterator]() { return this.pairs[Symbol.iterator](); }
    },
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
    // Fire document/window listeners (DOMContentLoaded, keydown, …) that the
    // app registered while loading — with a minimal synthetic event object
    // (preventDefault/stopPropagation no-ops, since generated handlers call
    // them freely).
    fireDocument(type, event) {
      const ev = event || { type, target: el('body'), preventDefault() {}, stopPropagation() {} };
      for (const fn of docListeners[type] || []) fn(ev);
    },
    fireWindow(type, event) {
      const ev = event || { type, preventDefault() {}, stopPropagation() {} };
      for (const fn of winListeners[type] || []) fn(ev);
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

/** Resolves the app entry: a directory pins its app.js; a file passes through. */
function resolveAppPath(appArg) {
  const stat = fs.existsSync(appArg) && fs.statSync(appArg);
  const appPath = stat && stat.isDirectory() ? path.join(appArg, 'app.js') : appArg;
  return fs.existsSync(appPath) ? appPath : null;
}

/**
 * Runs one suite. Returns { pass, fail, crashed } and prints the per-suite
 * RESULT line. Never exits — the caller decides, so --all can tally.
 */
function runSuite(label, appPath, assertsPath) {
  console.log(`\nsuite ${label}`);
  const h = createHarness();
  let mod;
  try {
    mod = require(path.resolve(assertsPath));
  } catch (e) {
    console.error(`ASSERTIONS_LOAD_FAILED ${e.message}`);
    return { pass: 0, fail: 1, crashed: true };
  }
  const setup = typeof mod === 'function' ? null : mod.setup;
  const run = typeof mod === 'function' ? mod : mod.run;
  if (typeof run !== 'function') {
    console.error('assertions file must export run(h) (or be a function)');
    return { pass: 0, fail: 1, crashed: true };
  }
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
    return { pass: h.pass, fail: h.fail + 1, crashed: true };
  }
  console.log(`RESULT ${h.fail === 0 ? 'LOGIC_PASS' : 'LOGIC_FAIL'} pass=${h.pass} fail=${h.fail}`);
  return { pass: h.pass, fail: h.fail, crashed: false };
}

function discoverPins() {
  if (!fs.existsSync(PINS_DIR)) return [];
  return fs
    .readdirSync(PINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      app: path.join(PINS_DIR, d.name, 'app.js'),
      asserts: path.join(PINS_DIR, d.name, 'assertions.cjs'),
    }))
    .filter((s) => fs.existsSync(s.app) && fs.existsSync(s.asserts));
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--all')) {
    const pins = discoverPins();
    if (pins.length === 0) {
      console.log(`no generated-app pins under ${path.relative(process.cwd(), PINS_DIR)} — nothing to verify (see tests/generated/README.md)`);
      process.exit(0);
    }
    let pass = 0;
    let fail = 0;
    let crashed = 0;
    for (const pin of pins) {
      const r = runSuite(pin.name, pin.app, pin.asserts);
      pass += r.pass;
      fail += r.fail;
      if (r.crashed) crashed++;
    }
    console.log(`\nRESULT --all ${fail === 0 ? 'LOGIC_PASS' : 'LOGIC_FAIL'} suites=${pins.length} pass=${pass} fail=${fail}${crashed ? ` crashed=${crashed}` : ''}`);
    process.exit(fail === 0 ? 0 : 1);
  }

  const [appArg, assertsArg] = argv;
  if (!appArg || !assertsArg) {
    console.error('usage: node scripts/verify-generated-app.js <app.js-or-project-dir> <assertions.cjs>');
    console.error('       node scripts/verify-generated-app.js --all');
    process.exit(1);
  }
  const appPath = resolveAppPath(appArg);
  if (!appPath) {
    console.error(`APP_NOT_FOUND ${appArg}`);
    process.exit(1);
  }
  const r = runSuite(path.basename(appPath), appPath, assertsArg);
  process.exit(r.fail === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { createHarness, makeEl, makeStorage, runSuite, discoverPins };
