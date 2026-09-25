#!/usr/bin/env node
/**
 * Classifier for the Node.js release schedule (nodejs/Release schedule.json).
 *
 * Single source of truth for which Node majors this repo gates and which it
 * canaries. The CI matrix is COMPUTED from this at run time (scripts/
 * ci-compute-matrix.js) and the drift guard (scripts/check-node-contract.js)
 * re-runs the same classification, so promotion/demotion happens on the
 * published dates without anyone editing the workflow:
 *
 *   blocking  — every major whose `lts` date has passed and whose `end`
 *               (EOL) has not. These run as required `gates (node X)` jobs.
 *   canary    — the NEWEST major that has been released but is not yet LTS
 *               AND is scheduled to become LTS (has an `lts` date). It runs
 *               as the non-blocking `canary` job and AUTO-PROMOTES to a
 *               blocking leg on its lts date (e.g. v26 on 2026-10-28).
 *               Odd-numbered majors never get an `lts` date, so they are
 *               skipped — they can never graduate.
 *
 * Env overrides used by tests and CI debugging:
 *   SCHEDULE_JSON  inline schedule (skips the network)
 *   NOW            ISO date to classify as-of (default: real now)
 */
"use strict";

const https = require("https");

const SCHEDULE_URL =
  "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";

function fetchSchedule() {
  return new Promise((resolve, reject) => {
    const req = https.get(SCHEDULE_URL, { timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`schedule.json fetch failed: HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`schedule.json is not valid JSON: ${e.message}`));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("schedule.json fetch timed out after 10s"));
    });
    req.on("error", reject);
  });
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
    details.push({ major, status: typeof e.lts === "string" ? "current" : "current-non-lts" });
    if (typeof e.lts === "string") canaryCandidates.push(major);
  }

  blocking.sort((a, b) => a - b);
  canaryCandidates.sort((a, b) => a - b);
  const canary = canaryCandidates.length
    ? canaryCandidates[canaryCandidates.length - 1]
    : null;

  return { today, blocking, canary, details };
}

module.exports = { fetchSchedule, classify, SCHEDULE_URL };
