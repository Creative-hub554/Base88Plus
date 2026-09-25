#!/usr/bin/env node
/**
 * CI matrix computation from the Node release schedule.
 *
 * Runs as the first workflow job; emits GITHUB_OUTPUT variables that the
 * gates/canary jobs consume via fromJSON:
 *
 *   legs=[22,24]    JSON array — blocking LTS majors (required checks)
 *   canary=[26]     JSON array with 0 or 1 entry — the newest released
 *                   major that is scheduled for LTS but not there yet
 *                   (non-blocking; the canary job skips itself when empty)
 *
 * Policy is implemented in scripts/node-schedule.js (classify()). This
 * wrapper only adds the CI plumbing and the safety guards: a schedule that
 * classifies to ZERO blocking legs is treated as an error — CI must fail
 * loudly instead of silently running no required checks at all.
 *
 * Env overrides (tests / debugging):
 *   SCHEDULE_JSON  inline schedule (skips the network)
 *   GITHUB_OUTPUT  output file (missing locally → prints instead)
 */
"use strict";

const fs = require("fs");
const { fetchSchedule, classify } = require("./node-schedule");

async function main() {
  const scheduleText = process.env.SCHEDULE_JSON;
  const schedule = scheduleText
    ? JSON.parse(scheduleText)
    : await fetchSchedule();

  const { today, blocking, canary } = classify(
    schedule,
    process.env.NOW || undefined,
  );

  if (blocking.length === 0) {
    console.error(
      `✗ ${today}: the release schedule classifies to ZERO blocking LTS legs — ` +
        `refusing to emit a matrix with no required checks. If this is real ` +
        `(between LTS lines), fix the policy in scripts/node-schedule.js ` +
        `deliberately, not silently.`,
    );
    process.exit(1);
  }

  const legs = JSON.stringify(blocking);
  const canaryJson = JSON.stringify(canary === null ? [] : [canary]);
  console.log(
    `${today}: blocking legs ${legs}, canary ${canaryJson} ` +
      `(canary auto-promotes on its lts date)`,
  );

  const out = process.env.GITHUB_OUTPUT;
  const payload = `legs=${legs}\ncanary=${canaryJson}\n`;
  if (out) {
    fs.appendFileSync(out, payload);
  } else {
    console.log(`(no GITHUB_OUTPUT — would emit)\n${payload.trim()}`);
  }
}

main().catch((e) => {
  console.error(`✗ matrix computation failed: ${e.message}`);
  process.exit(1);
});
