#!/usr/bin/env node
/**
 * Early-warning tripwire for the committed schedule snapshot
 * (scripts/node-schedule.json).
 *
 * The monthly cron refresh (ci.yml matrix job) is supposed to keep this
 * file at ~30 days old or less; its push step is continue-on-error, so a
 * failed or refused bot push would otherwise age silently. Past 60 days
 * loadSchedule() refuses the fallback outright during an outage
 * (MAX_FALLBACK_AGE_DAYS), which turns a quiet slide into a red run at
 * the worst possible time. This check surfaces the slide early:
 *
 *   exit 0  age <= 30 days (or 31..60 with a loud warning on stderr)
 *   exit 1  malformed wrapper, unreadable file, invalid NOW, or age > 60
 *
 * NOW env override (any parseable date, classified as a UTC day) for
 * tests and deterministic rehearsals, mirroring scripts/node-schedule.js.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const { MAX_FALLBACK_AGE_DAYS } = require("./node-schedule.js");

const WARN_AGE_DAYS = 30;

function isoToday() {
  const d = process.env.NOW ? new Date(process.env.NOW) : new Date();
  if (Number.isNaN(d.getTime())) {
    throw new Error(`NOW is not a valid date: ${process.env.NOW}`);
  }
  return d.toISOString().slice(0, 10);
}

function dayDiff(fromISO, toISO) {
  const t = (s) => new Date(`${s}T00:00:00Z`).getTime();
  return Math.round((t(toISO) - t(fromISO)) / 86_400_000);
}

function main() {
  const fp = path.join(process.cwd(), "scripts", "node-schedule.json");
  let wrapper;
  try {
    wrapper = JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (e) {
    console.error(`✗ cannot read fallback snapshot at ${fp}: ${e.message}`);
    console.error("  run `npm run update:schedule` to create it");
    process.exit(1);
  }
  const fetchedAt = wrapper && wrapper._fetchedAt;
  if (
    typeof fetchedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(fetchedAt) ||
    !wrapper.schedule ||
    typeof wrapper.schedule !== "object"
  ) {
    console.error(
      `✗ fallback snapshot ${fp} is malformed (expected { _fetchedAt, schedule })`,
    );
    console.error("  run `npm run update:schedule` to regenerate it");
    process.exit(1);
  }
  const age = dayDiff(fetchedAt, isoToday());
  if (age > MAX_FALLBACK_AGE_DAYS) {
    console.error(
      `✗ schedule snapshot is ${age} days old (fetched ${fetchedAt}) — past the ` +
        `${MAX_FALLBACK_AGE_DAYS}-day staleness backstop: the outage fallback now ` +
        `REFUSES to classify on it.`,
    );
    console.error(
      "  Refresh and commit via PR (`npm run update:schedule`), and check why the " +
        "monthly cron push stopped landing (see the ci.yml matrix job).",
    );
    process.exit(1);
  }
  if (age > WARN_AGE_DAYS) {
    console.warn(
      `⚠ schedule snapshot is ${age} days old (fetched ${fetchedAt}) — past the ` +
        `${WARN_AGE_DAYS}-day warning threshold.`,
    );
    console.warn(
      `  The monthly cron refresh has not landed for over a month; at ` +
        `${MAX_FALLBACK_AGE_DAYS} days the outage fallback refuses this snapshot.`,
    );
    console.warn(
      "  Refresh: `npm run update:schedule`, commit via PR, or investigate the " +
        "cron push (ruleset bypass / deploy key).",
    );
    process.exit(0);
  }
  console.log(
    `✓ schedule snapshot is ${age} days old (fetched ${fetchedAt}, ` +
      `warn >${WARN_AGE_DAYS}, fail >${MAX_FALLBACK_AGE_DAYS})`,
  );
}

try {
  main();
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
