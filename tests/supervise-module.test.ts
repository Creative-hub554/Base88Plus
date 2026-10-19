/**
 * The split the loop lives in: one mechanism, two policies, and no entry
 * importing the other.
 *
 * `scripts/supervise.mjs` is the loop both servers run under — the probe, the
 * tree kill, the audit, the backoff, the budget, the replay pass. `scripts/dev.mjs`
 * and `scripts/start.mjs` hold the policy: what a line MEANS, the banner, the
 * give-up hint, the log prefix, whether pages are replayed, and the knobs from
 * their own environment. Each passes its own; neither needs the other.
 *
 * The failure this pins is not hypothetical. The production entry used to take
 * the loop out of the dev entry's file, so production's supervision could only
 * be read (and fixed) through development's, and a dev-only default — a
 * classifier that restarts on a Turbopack pool-death line, a warm pass, a
 * `[dev]` log prefix, `DEV_PORT` — was one forgotten argument away from running
 * in production.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { supervise } from "../scripts/supervise.mjs";

const source = (name: string) => readFileSync(join(process.cwd(), "scripts", name), "utf8");
const DEV = source("dev.mjs");
const START = source("start.mjs");
const SHARED = source("supervise.mjs");

/** Does `text` import the given module path? */
const imports = (text: string, specifier: string) =>
  new RegExp(`from\\s+["']${specifier.replace(/[.\\/]/g, "\\$&")}["']`).test(text);

describe("supervision — one mechanism, two policies", () => {
  it("both entries take the loop from the shared module", () => {
    expect(imports(DEV, "./supervise.mjs")).toBe(true);
    expect(imports(START, "./supervise.mjs")).toBe(true);
  });

  it("neither entry imports the other", () => {
    expect(imports(DEV, "./start.mjs")).toBe(false);
    expect(imports(START, "./dev.mjs")).toBe(false);
  });

  it("the shared module imports neither entry", () => {
    expect(imports(SHARED, "./dev.mjs")).toBe(false);
    expect(imports(SHARED, "./start.mjs")).toBe(false);
  });

  it("keeps what a line MEANS out of the mechanism", () => {
    // The pool-death signature, the fatal startup errors, the banner, the log
    // prefix: all of them are policy, and a mechanism that carried any of them
    // would be one server's judgement wearing a shared name.
    expect(SHARED).not.toMatch(/jest worker encountered/i);
    expect(SHARED).not.toMatch(/another next dev server is already running/i);
    expect(SHARED).not.toMatch(/production build/i);
    expect(SHARED).not.toMatch(/`\[dev\]/);
    expect(SHARED).not.toMatch(/`\[start\]/);
    // …and the two signatures really are in the entries, not only removed here.
    expect(DEV).toMatch(/jest worker encountered/i);
    expect(START).toMatch(/could not find a production build/i);
  });

  it("runs no server of its own", () => {
    // The loop runs the argv its entry hands it. A default server in the
    // mechanism is how the production entry would end up running `next dev`.
    expect(SHARED).not.toMatch(/process\.execPath/);
    expect(SHARED).not.toMatch(/"dev"\s*,\s*\.\.\.forward/);
  });

  it("lets each entry name its own port variable", () => {
    expect(DEV).toMatch(/portEnv: "DEV_PORT"/);
    expect(START).toMatch(/portEnv: "PROD_PORT"/);
  });

  it("keeps the front door, and which port it takes, in the entry that asks for it", () => {
    // Whether there is a public port of the supervisor's own — and which one —
    // is a promise that entry makes to whoever runs it, so the mechanism names
    // no port of its own and development never takes one: a front door in front
    // of the dev server would be a second thing to debug while compiling.
    expect(SHARED).not.toMatch(/3000/);
    expect(DEV).not.toMatch(/frontPort|frontHost|reloadFile/);
    expect(START).toMatch(/frontPort: frontEnabled/);
    expect(START).toMatch(/PROD_FRONT !== "0"/);
    expect(START).toMatch(/reloadFile: process\.env\.PROD_RELOAD_FILE/);
    // How long a replaced server is kept warm as the way back is the same kind of
    // promise — it is what an operator counts on when a deploy goes wrong — so it
    // belongs to the entry that reloads, and development never asks for one.
    expect(START).toMatch(/rollbackWindowMs: envInt\("PROD_ROLLBACK_MS"/);
    // …and both ends of it: the floor under the window is as much an operator's
    // promise as the ceiling is, since a window nobody has put traffic through runs
    // to the ceiling and one the app is hammering is closed by traffic at the floor.
    expect(START).toMatch(/rollbackWindowMinMs: envInt\("PROD_ROLLBACK_MIN_MS"/);
    expect(SHARED).not.toMatch(/PROD_ROLLBACK_MS|PROD_ROLLBACK_MIN_MS|PROD_ROLLBACK_CONNECTIONS/);
    expect(DEV).not.toMatch(/rollbackWindowMs|rollbackWindowMinMs|PROD_ROLLBACK_MS|healthCheck/);
    // …and what counts as proof, which is the same kind of promise: an operator
    // decides it, the mechanism only reads it.
    expect(START).toMatch(/rollbackProofConnections: envInt\("PROD_ROLLBACK_CONNECTIONS"/);
    expect(SHARED).not.toMatch(/rollbackProofConnections *[:=] *envInt/);
    // Where the account of a reload is written is the same kind of promise, and
    // the same kind of environment variable: a production operator names the
    // file a deploy pipeline reads, and development — which never reloads, having
    // no front door — has nothing to record.
    expect(START).toMatch(/reloadHistory: process\.env\.PROD_RELOAD_HISTORY/);
    expect(SHARED).not.toMatch(/PROD_RELOAD_HISTORY/);
    expect(SHARED).toMatch(/export function reloadRecord\(/);
    expect(DEV).not.toMatch(/reloadHistory|PROD_RELOAD_HISTORY/);
  });
});

describe("supervise() needs the entry's policy", () => {
  // The calls below are deliberately malformed — that IS the case under test —
  // so they are cast past the types that would otherwise stop them at compile
  // time, the same way a JavaScript entry with a typo would reach them.
  const malformed = (options: object) => options as Parameters<typeof supervise>[0];

  it("names every missing input instead of inheriting one", async () => {
    await expect(supervise(malformed({}))).rejects.toThrow(
      /missing serverCmd, classify, banner, plainHint, log, warmEnabled/,
    );
  });

  it("rejects a policy that is half there", async () => {
    // A production supervisor that forgot its classifier is exactly the bug
    // this guard exists for, so the rest of the policy does not carry it.
    await expect(
      supervise(malformed({ serverCmd: [process.execPath, "-e", "1"], log: () => {} })),
    ).rejects.toThrow(/missing classify, banner, plainHint, warmEnabled/);
  });
});
