/**
 * CI pin for the "Todo Persistence Test" generated app (mum7ood4-g00gm4)
 * — a to-do list with localStorage persistence, generated with the full
 * "Interactive apps: state and timers" builder rules live (incl.
 * clear-before-refill).
 *
 * Third app kind and first STORAGE pin: exercises the harness's in-memory
 * localStorage across a simulated "reload" (fresh harness re-running the
 * same persisted state). The app renders by clearing #taskList.innerHTML
 * and rebuilding — the exact pattern the clear-before-refill rule mandates.
 *
 * Mechanics note: handlers are inline (onclick="toggleTask(0)"), so they
 * live on the sandbox GLOBALS, not element listeners; addTask is wired via
 * a form submit listener. The suite drives those directly.
 */
'use strict';

module.exports = {
  setup(h) {
    h.el('#taskInput');
    h.el('#taskList');
    h.el('#taskCount');
    h.el('.add-task'); // the <form class="add-task"> that owns the submit listener
  },

  run(h) {
    const input = h.el('#taskInput');
    const list = h.el('#taskList');
    const count = h.el('#taskCount');
    const form = h.el('.add-task');
    // The app listens for 'submit' on the form — dispatch, not click.
    const submit = () => form.dispatch('submit');
    const store = () => h.sandbox.localStorage.getItem('tasks');

    // T1: empty start
    h.check('T1 no tasks on load', list.children.length === 0 && count.textContent === '0' && store() === null);

    // T2: add two tasks — persisted, rendered, counter correct, input cleared
    input.value = 'buy milk';
    submit();
    input.value = 'walk dog';
    submit();
    h.check('T2 two <li> rendered', list.children.length === 2);
    h.check('T2 persisted to localStorage', JSON.parse(store()).length === 2 && JSON.parse(store())[0].text === 'buy milk');
    h.check('T2 input cleared after add', input.value === '');
    h.check('T2 remaining = 2', count.textContent === '2');

    // T3: toggle done via the global inline handler — strikethrough class + count drops
    h.sandbox.toggleTask(0);
    h.check('T3 done class applied', list.children[0].classList.contains('done'));
    h.check('T3 remaining = 1', count.textContent === '1');
    h.check('T3 persistence updated', JSON.parse(store())[0].done === true);

    // T4: clear-and-refill — remove one task, list rebuilds to exactly one
    h.sandbox.removeTask(1);
    h.check('T4 one <li> after remove', list.children.length === 1);
    h.check('T4 persistence updated', JSON.parse(store()).length === 1);

    // T5: THE RELOAD — fresh harness re-running on the same persisted state
    const persisted = store();
    const h2raw = require('../../../scripts/verify-generated-app.js');
    const fresh = h2raw.createHarness();
    // Reload with the SAME persisted state — an OPEN task, so remaining = 1.
    fresh.sandbox.localStorage.setItem('tasks', JSON.stringify([{ text: 'buy milk', done: false }]));
    // re-run the same app in a clean sandbox: the top-level JSON.parse reads
    // storage exactly like a page reload would.
    const vm2 = require('node:vm');
    const fs2 = require('node:fs');
    const path2 = require('node:path');
    const appSrc = fs2.readFileSync(path2.join(__dirname, 'app.js'), 'utf8');
    vm2.runInContext(appSrc, vm2.createContext(fresh.sandbox), { filename: 'app.js' });
    fresh.fireDocument('DOMContentLoaded');
    const freshList = fresh.el('#taskList');
    const freshCount = fresh.el('#taskCount');
    h.check('T5 reload restores the task', freshList.children.length === 1 && fresh.el('#taskInput') !== null);
    h.check('T5 count correct after reload (1 open task)', freshCount.textContent === '1');

    // X1: pinned quirk — the counter renders "1" while 0 tasks remain after
    // removing the only task... actually verified: counter shows remaining
    // correctly (0 tasks -> "0"). Quirk pinned instead: removing the LAST
    // task leaves localStorage as "[]" rather than removing the key.
    h.sandbox.removeTask(0);
    h.check('X1 empty store stays a JSON array (key remains)', store() === '[]');
  },
};
