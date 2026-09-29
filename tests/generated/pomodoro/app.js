const WORK_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;
const LONG_BREAK_SECONDS = 15 * 60;

/* Operator fix: the 7B's first (degenerate) attempt referenced a
 * .long-break-indicator element that its retry's HTML doesn't contain;
 * the retry ships .progress-indicator dots instead. These selectors bind
 * the app to what the HTML actually has. */
const container = document.querySelector(".container");
const dots = Array.from(document.querySelectorAll(".progress-indicators .dot"));
const heading = document.querySelector(".timer-title");
const timeEl = document.querySelector(".time");
const completedEl = document.getElementById("completed");
const startBtn = document.querySelector(".start");
const pauseBtn = document.querySelector(".pause");
const resetBtn = document.querySelector(".reset");
const breakBtn = document.querySelector(".break-start");

let remaining = WORK_SECONDS;
let onBreak = false;
let longBreakNeeded = false;
let ticking = null;

function render() {
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  timeEl.textContent = `${m}:${String(s).padStart(2, "0")}`;
}

function stop() {
  if (ticking !== null) {
    clearInterval(ticking);
    ticking = null;
  }
}

function chime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.gain.value = 0.08;
    gain.connect(ctx.destination);
    [880, 1174.7].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.22);
      osc.stop(ctx.currentTime + i * 0.22 + 0.2);
    });
    setTimeout(() => ctx.close(), 900);
  } catch {
    /* audio unavailable — the timer still works */
  }
}

function setMode(isBreak, isLongBreak) {
  container.classList.toggle("break-mode", isBreak);
  container.classList.toggle("work-mode", !isBreak);
  container.classList.toggle("long-break-mode", isLongBreak);
  heading.textContent = isLongBreak ? "Long break" : isBreak ? "Break time" : "Pomodoro Timer";
  const cyclePos = Number(completedEl.textContent) % 4;
  dots.forEach((d, i) => d.classList.toggle("active", i < cyclePos));
  breakBtn.hidden = isBreak;
}

function tick() {
  remaining -= 1;
  if (remaining <= 0) {
    chime();
    if (!onBreak) {
      completedEl.textContent = String(Number(completedEl.textContent) + 1);
      longBreakNeeded = Number(completedEl.textContent) % 4 === 0;
      onBreak = true;
      remaining = longBreakNeeded ? LONG_BREAK_SECONDS : BREAK_SECONDS;
      setMode(true, longBreakNeeded);
    } else {
      onBreak = false;
      remaining = WORK_SECONDS;
      setMode(false, false);
    }
    render();
    return;
  }
  render();
}

startBtn.addEventListener("click", () => {
  if (ticking === null) {
    setMode(false, false);
    ticking = setInterval(tick, 1000);
  }
});

pauseBtn.addEventListener("click", stop);

resetBtn.addEventListener("click", () => {
  stop();
  onBreak = false;
  completedEl.textContent = "0";
  remaining = WORK_SECONDS;
  setMode(false, false);
  longBreakNeeded = false;
  render();
});

breakBtn.addEventListener("click", () => {
  stop();
  chime();
  onBreak = true;
  remaining = BREAK_SECONDS;
  setMode(true, false);
  render();
  if (ticking === null) {
    // Auto-start the break timer without touching mode visuals - the stray
    // setMode(false, false) that used to sit here flipped the UI back to
    // work-mode while counting 5:00, so the break never visibly happened
    // and a break expiry skipped the return-to-work transition.
    ticking = setInterval(tick, 1000);
  }
});

render();