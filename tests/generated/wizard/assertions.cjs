/**
 * CI pin for the regenerated "Wizard Guardrail Test 2" app
 * (mum61ixj-ae85qv) — generated AFTER the clear-before-refill rule joined
 * the builder prompt ("Interactive apps: state and timers").
 *
 * v2 mechanics (different from the v1 wizard): tab clicks single-writer
 * swap the `active` class; Next/Back move panels via the `hidden` class and
 * gate on form.checkValidity(); reaching Next on the last step calls
 * renderSummary(), which CLEARS the container (innerHTML = '') and rebuilds
 * one line per entered field — the X1 duplicate-append quirk fixed by the
 * prompt rule and pinned here so a regression fails CI.
 *
 * The app initializes inside DOMContentLoaded, so the suite fires it.
 */
'use strict';

module.exports = {
  setup(h) {
    const tabs = h.elAll('.tab', 3);
    tabs.forEach((t, i) => {
      t.setAttribute('data-step', String(i + 1));
      t.dataset.step = String(i + 1);
    });
    // Real DOM has exactly three .step panels; the summary is a separate
    // .summary element. The HTML marks panel 1 active from the start.
    const steps = h.elAll('.step', 3);
    steps[0].classList.add('active');
    h.el('#step1').elements = [{ id: 'name', name: 'name', value: 'Ada' }];
    h.el('#step2').elements = [{ id: 'email', name: 'email', value: 'ada@example.com' }];
    h.el('#step3').elements = [{ id: 'age', name: 'age', value: '36' }];
    h.el('#next');
    h.el('#back');
    h.el('.summary');
  },

  run(h) {
    const tabs = h.elAll('.tab', 3);
    const steps = h.elAll('.step', 3);
    const next = h.el('#next');
    const summary = h.el('.summary');
    const visible = (els) => els.filter((e) => !e.classList.contains('hidden')).length;

    h.fireDocument('DOMContentLoaded');

    // T1: initial state — no tab highlighted yet, panel 1 active+visible
    h.check('T1 no tab active before first interaction', tabs.every((t) => !t.classList.contains('active')));
    h.check('T1 panel 1 active', steps[0].classList.contains('active'));

    // T2: Next walks the panels via hidden (single writer per transition)
    next.click();
    h.check('T2 panel 1 hidden, panel 2 visible', steps[0].classList.contains('hidden') && !steps[1].classList.contains('hidden'));
    next.click();
    h.check('T2 panel 3 visible', steps[1].classList.contains('hidden') && !steps[2].classList.contains('hidden'));

    // T3: Next on the last step renders the summary — one line per field
    next.click();
    h.check('T3 summary has one line per field', summary.children.length === 3);
    h.check('T3 lines are label: value', summary.children[0].textContent === 'name: Ada' && summary.children[1].textContent === 'email: ada@example.com' && summary.children[2].textContent === 'age: 36');

    // T4: THE RULE — repeated Next refreshes, never duplicates
    next.click();
    h.check('T4 refresh not append (still 3 lines)', summary.children.length === 3);
    next.click();
    h.check('T4 still 3 lines after third render', summary.children.length === 3);

    // T5: a timer-free app stays timer-free
    h.check('T5 no intervals', h.pendingIntervals() === 0);
  },
};
