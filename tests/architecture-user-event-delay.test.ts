/**
 * Architecture guard: component-test interactions must not race the wall clock.
 *
 * user-event's DIRECT api — `userEvent.type(...)`, `userEvent.click(...)` and
 * friends — is built on a default of `delay: 0`, and that is NOT "no delay":
 * `wait()` in user-event/dist/cjs/utils/misc/wait.js awaits a real
 * `setTimeout(resolve, 0)` between every key and every pointer action. Wall
 * time therefore tracks scheduler contention instead of the code under test,
 * and the damage is invisible on an idle machine.
 *
 * Measured in this repo (same machine, same assertions, 12 cores):
 *
 *   deploy-section.test.tsx, first test   idle  10 hogs  24 hogs
 *     direct api (before)                1270ms   3095ms   5056ms → FAILED
 *                                        ("Test timed out in 5000ms")
 *     setup({ delay: null }) (after)      669ms   1064ms   1441ms → passed
 *
 * settings-form.test.tsx's two heaviest tests sat at 3635ms and 3784ms under
 * the same 24-hog load — same defect, one hop short of the same cliff, and it
 * did surface as timeouts once the whole suite ran in parallel.
 *
 * `userEvent.setup({ delay: null })` is the supported fix: `wait()` returns
 * immediately via its `typeof delay !== 'number'` branch, while the returned
 * instance still dispatches real per-key input events. Nothing asserted
 * changes. See the doc comment on renderSection() in
 * tests/deploy-section.test.tsx for the mechanism.
 *
 * Two rules, both enforced here:
 *   1. no test file calls the direct interaction api;
 *   2. every `userEvent.setup(...)` call passes `delay: null` (a bare
 *      `setup()` re-introduces the same default and the same bug).
 *
 * Comments are stripped before scanning — prose ABOUT the api is not a
 * violation — and the pattern self-tests, so a broken regex can never make
 * this guard pass silently.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The direct-api interaction surface. Every one of these drives
 * `keyboard/index.js`, `pointer/index.js` or `utility/selectOptions.js`, which
 * are the only modules that await `wait()` — i.e. the only ones that burn an
 * event-loop round trip per step. (`userEvent.setup` is deliberately absent:
 * it is the fix, not the defect.)
 */
const DIRECT_API =
  /(?<![\w.])userEvent\.(type|keyboard|tab|click|dblClick|tripleClick|hover|unhover|selectOptions|deselectOptions|paste|copy|cut|clear|pointer|move|dragAndDrop|upload|wheel)\s*\(/;

/** `setup({ … delay: null … })` — options object with the timer disabled. */
const TIMER_FREE_SETUP = /userEvent\.setup\(\{[^}]*delay:\s*null/;

/**
 * Blank out `/* … *\/` and `// …` spans without touching newlines, so reported
 * line numbers stay true to the original file.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("architecture: test interactions are timer-free", () => {
  it("the forbidden pattern actually matches a real call (self-test)", () => {
    // The guard is a regex over source text; if it were ever mistyped the
    // suite would go green while the hazard returned. Pin the shape.
    // Samples are assembled rather than written out so this file does not
    // itself contain the literal it forbids (otherwise the scan in the next
    // test flags the guard, and the temptation is to allowlist it away).
    const sample = (method: string) => `await userEvent.${method}(arg);`;
    for (const method of ["click", "type", "selectOptions", "keyboard", "hover", "clear"]) {
      expect(DIRECT_API.test(sample(method)), method).toBe(true);
    }

    // The fix itself must NOT be flagged, or the guard would be unsatisfiable.
    expect(DIRECT_API.test("const user = userEvent.setup({ delay: null });")).toBe(false);
    expect(DIRECT_API.test("await user.click(button);")).toBe(false);
    // A member access that merely *ends* like the api is not the api.
    expect(DIRECT_API.test("myuserEvent.click(x);")).toBe(false);
    expect(DIRECT_API.test("await thatuserEvent.click(x);")).toBe(false);

    expect(TIMER_FREE_SETUP.test("userEvent.setup({ delay: null })")).toBe(true);
    expect(
      TIMER_FREE_SETUP.test("userEvent.setup({ delay: null, pointerEventsCheck: 0 })"),
    ).toBe(true);
    // Bare setup() keeps the default of 0 — the bug.
    expect(TIMER_FREE_SETUP.test("userEvent.setup()")).toBe(false);
    expect(
      TIMER_FREE_SETUP.test("userEvent.setup({ advanceTimers: vi.advanceTimersByTime })"),
    ).toBe(false);
    // A file may legitimately re-enable the timer only via fake timers, but
    // this repo does not use them for component tests — require delay: null.
    expect(TIMER_FREE_SETUP.test("userEvent.setup({ delay: 0 })")).toBe(false);
    expect(TIMER_FREE_SETUP.test("userEvent.setup({ delay: 50 })")).toBe(false);
  });

  it("no test file calls the delayed direct api", () => {
    const testsDir = path.join(process.cwd(), "tests");
    const files = walk(testsDir);

    // Anti-vacuity: a scan that found nothing to scan proves nothing.
    expect(files.length).toBeGreaterThan(20);

    const violations: string[] = [];
    const timerFreeSetupFiles: string[] = [];

    for (const file of files) {
      const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
      const code = stripComments(fs.readFileSync(file, "utf8"));
      if (TIMER_FREE_SETUP.test(code)) timerFreeSetupFiles.push(rel);
      code.split("\n").forEach((line, i) => {
        if (DIRECT_API.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      violations,
      `user-event's direct api awaits a real setTimeout PER KEYSTROKE, which ` +
        `makes tests fail under CPU contention rather than on real defects. ` +
        `Use \`const user = userEvent.setup({ delay: null })\` and call ` +
        `user.type/user.click/... instead:\n${violations.join("\n")}`,
    ).toEqual([]);

    // And the timer-free instance must actually be in use — a guard that
    // passes because everyone stopped simulating input is worthless.
    expect(timerFreeSetupFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("the interaction-heavy suites configure the timer-free instance", () => {
    // These three are the ones that type or select enough to be measurable
    // under load; deleting their `delay: null` must fail here rather than
    // silently restore the flake.
    for (const rel of [
      "tests/deploy-section.test.tsx",
      "tests/settings-form.test.tsx",
      "tests/model-picker.test.tsx",
    ]) {
      const abs = path.join(process.cwd(), rel);
      expect(fs.existsSync(abs), `${rel} is missing — update this pin`).toBe(true);
      const code = stripComments(fs.readFileSync(abs, "utf8"));
      expect(
        TIMER_FREE_SETUP.test(code),
        `${rel} must build its interactions from userEvent.setup({ delay: null })`,
      ).toBe(true);
    }
  });
});
