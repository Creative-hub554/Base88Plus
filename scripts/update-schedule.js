#!/usr/bin/env node
/**
 * One-shot refresher for the committed schedule snapshot
 * (scripts/node-schedule.json — the offline fallback used by CI and the
 * drift guard when nodejs/Release is unreachable; see scripts/
 * node-schedule.js `loadSchedule` for the freshness policy).
 *
 * Fetches the LIVE schedule and rewrites the snapshot wrapper:
 *   { "_fetchedAt": "<today ISO>", "schedule": { v22: {...}, ... } }
 *
 * Run via `npm run update:schedule`, then COMMIT the result.
 */
"use strict";

const fs = require("fs");
const { fetchSchedule, fallbackPath, isoToday } = require("./node-schedule");

async function main() {
  const schedule = await fetchSchedule();
  const wrapper = { _fetchedAt: isoToday(), schedule };
  const fp = fallbackPath();
  fs.writeFileSync(fp, JSON.stringify(wrapper, null, 2) + "\n");
  console.log(`✓ ${fp} refreshed (fetched ${wrapper._fetchedAt})`);
  console.log("  Commit it so CI's outage fallback stays current.");
}

main().catch((e) => {
  console.error(`✗ snapshot refresh failed: ${e.message}`);
  process.exit(1);
});
