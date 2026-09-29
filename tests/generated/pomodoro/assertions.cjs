/**
 * Per-app assertions for the generated Pomodoro timer (project
 * mubfjuag-rmkcjj), run headlessly through scripts/verify-generated-app.js.
 *
 * This suite pinned the "Break now" mode-clobber bug: the generated handler
 * used to re-enter setMode(false, false) inside its auto-start block,
 * flipping the UI back to work-mode while the break counted down. T2 guards
 * that fix specifically; the rest regress the full timer surface.
 *
 * Run:
 *   node scripts/verify-generated-app.js projects-data/mubfjuag-rmkcjj examples/pomodoro.assertions.cjs
 */
'use strict';

module.exports = {
  // Registered BEFORE the app loads: querySelectorAll lists are never auto-made.
  // Seeds exactly what app.js queries (the selectors strict mode expects):
  // .container/.timer-title/.time/.start/.pause/.reset/.break-start via
  // querySelector, #completed via getElementById, and the dot list.
  setup(h) {
    h.elAll('.progress-indicators .dot', 4);
    h.el('.container');
    h.el('.timer-title');
    h.el('.time');
    h.el('#completed');
    h.el('.start');
    h.el('.pause');
    h.el('.reset');
    h.el('.break-start');
  },

  run(h) {
    const container = h.el('.container');
    const dots = h.elAll('.progress-indicators .dot', 4);
    const heading = h.el('.timer-title');
    const timeEl = h.el('.time');
    const completedEl = h.el('#completed');
    const startBtn = h.el('.start');
    const pauseBtn = h.el('.pause');
    const resetBtn = h.el('.reset');
    const breakBtn = h.el('.break-start');
    const mode = () => (container.classList.contains('break-mode') ? 'break' : 'work');

    // T1: baseline start / pause / reset
    startBtn.click();
    h.ticks(2);
    h.check('T1 counting down', timeEl.textContent === '24:58');
    pauseBtn.click();
    h.check('T1 pause stops', h.pendingIntervals() === 0);
    resetBtn.click();
    h.check('T1 reset visuals', heading.textContent === 'Pomodoro Timer' && timeEl.textContent === '25:00' && mode() === 'work');

    // T2: THE FIX — "Break now" keeps break visuals while auto-running
    breakBtn.click();
    h.check('T2 break-mode class', mode() === 'break');
    h.check('T2 not work-mode', !container.classList.contains('work-mode'));
    h.check('T2 heading', heading.textContent === 'Break time');
    h.check('T2 time 5:00', timeEl.textContent === '5:00');
    h.check('T2 break btn hidden', breakBtn.hidden === true);
    h.check('T2 auto-started', h.pendingIntervals() === 1);
    h.ticks(2);
    h.check('T2 ticking in break', timeEl.textContent === '4:58');
    h.check('T2 visuals STILL break', mode() === 'break' && heading.textContent === 'Break time');

    // T3: break expiry returns to work visibly
    h.ticks(298);
    h.check('T3 expiry -> work heading', heading.textContent === 'Pomodoro Timer');
    h.check('T3 expiry -> work mode', mode() === 'work' && timeEl.textContent === '25:00');

    // T4: natural work expiry credits a session + auto-break + progress dot
    resetBtn.click();
    startBtn.click();
    h.ticks(1500);
    h.check('T4 session credit', completedEl.textContent === '1');
    h.check('T4 auto-break', heading.textContent === 'Break time' && mode() === 'break' && timeEl.textContent === '5:00');
    h.check('T4 first dot active', dots[0].classList.contains('active') && !dots[1].classList.contains('active'));

    // T5: four full cycles reach the long break; no interval leaks.
    // The interval runs continuously through auto-breaks: one start, then
    // tick through 1500 work + 300 short-break per cycle; the 4th break is
    // the 900-second long one.
    resetBtn.click();
    startBtn.click();
    h.ticks(1500);
    h.check('T5a after work 1: credit + short break', completedEl.textContent === '1' && timeEl.textContent === '5:00');
    h.ticks(300);
    h.check('T5b break 1 done: back to work', heading.textContent === 'Pomodoro Timer' && timeEl.textContent === '25:00');
    h.ticks(5100); // work 2 + break 2 + work 3 + break 3 + work 4 = long-break start
    h.check('T5c 4th credit', completedEl.textContent === '4');
    h.check('T5d long break visuals', heading.textContent === 'Long break' && timeEl.textContent === '15:00' && container.classList.contains('long-break-mode'));
    h.check('T5e exactly one interval (no leaks)', h.pendingIntervals() === 1);
    h.ticks(300);
    h.check('T5f still in long break after 300 ticks', heading.textContent === 'Long break' && container.classList.contains('long-break-mode'));
  },
};
