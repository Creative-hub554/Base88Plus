#!/usr/bin/env node
/**
 * Node.js release schedule: fetch, fallback, and classification.
 *
 * Single source of truth for which Node majors this repo gates and which
 * it canaries. The CI matrix is COMPUTED from this at run time (scripts/
 * ci-compute-matrix.js) and the drift guard (scripts/check-node-contract.js)
 * re-runs the same classification, so promotion/demotion happens on the
 * published dates without anyone editing the workflow:
 *
 *   blocking  — every major whose `lts` date has passed and whose `end`
 *               (EOL) has not. These run as required `gates` matrix legs.
 *   canary    — the NEWEST major that has been released but is not yet LTS
 *               AND is scheduled to become LTS (has an `lts` date). It runs
 *               as the non-blocking canary job and AUTO-PROMOTES to a
 *               blocking leg on its lts date (e.g. v26 on 2026-10-28).
 *               Odd-numbered majors never get an `lts` date, so they are
 *               skipped — they can never graduate.
 *
 * Sourcing policy (loadSchedule):
 *   1. SCHEDULE_JSON env (tests/determinism) — used verbatim, no network.
 *   2. Live fetch of nodejs/Release schedule.json.
 *   3. On upstream failure: the COMMITTED fallback snapshot
 *      (scripts/node-schedule.json, wrapper `{ _fetchedAt, schedule }`,
 *      refreshed via `npm run update:schedule`). The snapshot is trusted
 *      only while it cannot have gone stale in a classification-relevant
 *      way: it is REFUSED when it predates any transition date that has
 *      since passed (an outage on promotion day must not silently canarize
 *      what should gate) or when it exceeds 60 days of age. Otherwise it
 *      is used with a loud warning — CI keeps working through outages,
 *      but never on silently-stale data.
 *
 * Env overrides (tests / CI debugging):
 *   SCHEDULE_JSON  inline schedule (skips the network AND the fallback)
 *   SCHEDULE_URL   alternate schedule URL (tests point it at a dead port)
 *   NOW            ISO date to classify as-of (default: real now)
 *
 * The fallback path is ROOTED AT process.cwd() (like every other source
 * the drift guard checks), so fixture trees can carry their own snapshot.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const SCHEDULE_URL =
  "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";
const MAX_FALLBACK_AGE_DAYS = 60;

function fallbackPath() {
  return path.join(process.cwd(), "scripts", "node-schedule.json");
}

function httpGet(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    // Scheme-aware so tests can serve plain http locally; production uses https.
    const transport = url.startsWith("https:") ? https : http;
    const req = transport.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
  });
}

/** Fetch and parse a schedule from the given (or default) URL. */
async function fetchSchedule(url = process.env.SCHEDULE_URL || SCHEDULE_URL) {
  const body = await httpGet(url);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`schedule data is not valid JSON: ${e.message}`);
  }
}

/** Today (or NOW) as an ISO date string, UTC — matches schedule.json dates. */
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

/**
 * Load the schedule per the sourcing policy above. Returns the bare
 * schedule object ({ v22: { start, lts, end }, ... }); prints a warning
 * when the fallback is used; THROWS when the fallback is too stale to
 * classify responsibly (never silently stale).
 */
async function loadSchedule() {
  if (process.env.SCHEDULE_JSON) {
    return JSON.parse(process.env.SCHEDULE_JSON);
  }
  const today = isoToday();
  try {
    return await fetchSchedule();
  } catch (e) {
    const fp = fallbackPath();
    let wrapper;
    try {
      wrapper = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch (readErr) {
      throw new Error(
        `upstream unavailable (${e.message}) and no usable fallback snapshot at ` +
          `${fp}: ${readErr.message} — run \`npm run update:schedule\` to create it`,
      );
    }
    const fetchedAt = wrapper && wrapper._fetchedAt;
    if (
      typeof fetchedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fetchedAt) ||
      !wrapper.schedule ||
      typeof wrapper.schedule !== "object"
    ) {
      throw new Error(
        `fallback snapshot ${fp} is malformed (expected { _fetchedAt, schedule }) — ` +
          `run \`npm run update:schedule\` to regenerate it`,
      );
    }
    const age = dayDiff(fetchedAt, today);
    // Transitions the snapshot predates but that have since passed: the
    // live schedule may classify differently than this frozen copy, so
    // the classification would be a guess.
    const missed = [];
    for (const [key, entry] of Object.entries(wrapper.schedule)) {
      if (!/^v\d+$/.test(key) || !entry || typeof entry !== "object") continue;
      const major = Number(key.slice(1));
      for (const field of ["start", "lts", "maintenance", "end"]) {
        const d = entry[field];
        if (typeof d === "string" && d > fetchedAt && d <= today) {
          missed.push(`${key}.${field} ${d}`);
        }
      }
      // The date comparison above cannot see transitions whose field is
      // MISSING from the snapshot. An even-numbered released major always
      // gets an `lts` date in schedule.json eventually (odd ones never do,
      // legitimately), so its absence means the snapshot was taken before
      // that date was announced — and we cannot rule out that it has since
      // passed, silently flipping a canary into (or out of) the gate set.
      if (
        typeof entry.start === "string" &&
        entry.start <= today &&
        major % 2 === 0 &&
        typeof entry.lts !== "string"
      ) {
        missed.push(`node ${major} is released and even-numbered but its lts date is absent from this snapshot`);
      }
    }
    const reasons = [];
    if (missed.length) {
      reasons.push(`it predates transition(s) that have since passed: ${missed.join(", ")}`);
    }
    if (age > MAX_FALLBACK_AGE_DAYS) {
      reasons.push(`it is ${age} days old (limit ${MAX_FALLBACK_AGE_DAYS})`);
    }
    if (reasons.length) {
      throw new Error(
        `upstream unavailable (${e.message}) and the fallback snapshot is TOO STALE ` +
          `to classify responsibly — ${reasons.join("; ")}. Refresh it with ` +
          `\`npm run update:schedule\` and commit, or restore upstream connectivity. ` +
          `Refusing to classify on stale data.`,
      );
    }
    console.warn(
      `⚠ upstream unavailable (${e.message}) — using committed fallback snapshot ` +
        `(fetched ${fetchedAt}, ${age}d ago)`,
    );
    return wrapper.schedule;
  }
}

/**
 * @param {object} schedule parsed schedule.json ({ v22: {start, lts, end } })
 * @param {Date|string} [now] as-of moment (default: real now)
 * @returns {{today: string, blocking: number[], canary: number|null,
 *            details: Array<{major: number, status: string}>}}
 */
function classify(schedule, now = new Date()) {
  const d = typeof now === "string" ? new Date(now) : now;
  // ISO dates are lexically comparable; Date("YYYY-MM-DD") parses as UTC.
  const today = d.toISOString().slice(0, 10);

  const blocking = [];
  const canaryCandidates = [];
  const details = [];

  for (const [key, e] of Object.entries(schedule)) {
    if (!/^v\d+$/.test(key) || !e || typeof e.start !== "string") continue;
    const major = Number(key.slice(1));

    if (e.start > today) {
      details.push({ major, status: "pending" }); // not released yet
      continue;
    }
    if (typeof e.end === "string" && e.end <= today) {
      details.push({ major, status: "eol" }); // dropped everywhere
      continue;
    }
    if (typeof e.lts === "string" && e.lts <= today) {
      blocking.push(major); // released, LTS, in support window
      details.push({ major, status: "lts" });
      continue;
    }
    // Released but not yet LTS. Only versions SCHEDULED to become LTS are
    // canary candidates — odd majors (no `lts` field) never graduate.
    details.push({
      major,
      status: typeof e.lts === "string" ? "current" : "current-non-lts",
    });
    if (typeof e.lts === "string") canaryCandidates.push(major);
  }

  blocking.sort((a, b) => a - b);
  canaryCandidates.sort((a, b) => a - b);
  const canary = canaryCandidates.length
    ? canaryCandidates[canaryCandidates.length - 1]
    : null;

  return { today, blocking, canary, details };
}

module.exports = {
  fetchSchedule,
  loadSchedule,
  classify,
  fallbackPath,
  isoToday,
  MAX_FALLBACK_AGE_DAYS,
  SCHEDULE_URL,
};
