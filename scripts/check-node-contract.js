#!/usr/bin/env node
/**
 * Drift guard for the Node version contract.
 *
 * The supported Node set is described by sources that fail in different
 * ways when they disagree: npm only WARNS on engines mismatch (unless
 * engine-strict), nvm silently ignores .nvmrc without the shell hook, and
 * the CI matrix is COMPUTED from the release schedule at run time
 * (scripts/node-schedule.js → scripts/ci-compute-matrix.js). This script
 * re-runs the SAME classification and enforces:
 *
 *   1. The workflow's gates matrix is schedule-driven (fromJSON of the
 *      computed legs) — a hardcoded version list is drift by definition.
 *   2. Every COMPUTED blocking leg satisfies package.json engines — CI
 *      tests what npm allows; otherwise the matrix is red on a healthy
 *      tree. (When the schedule promotes a new LTS, this is what forces
 *      the engines bump instead of silently unblocking the new leg.)
 *   3. The engines floor is the oldest computed leg — a bumped floor can
 *      never silently orphan the oldest supported line, and an EOL leg
 *      dropping out of the schedule forces the floor bump in turn.
 *   4. .nvmrc satisfies engines and names a COMPUTED blocking leg — the
 *      recommended dev version is actually gated, not merely canaried.
 *   5. When the schedule has a canary candidate, the workflow's canary job
 *      exists, consumes the computed output, stays continue-on-error, and
 *      keeps its skip-when-empty guard. A canary without continue-on-error
 *      would block merges; without the guard it would fail on an empty set.
 *   6. The ci-ok aggregate job exists and depends on gates — the single
 *      stable required check that survives promotions/demotions.
 *
 * Exit 0 = contract holds; exit 1 = drift. Run via `npm run check:node`.
 * Checks the tree you run it FROM (npm scripts execute at the package
 * root); deps resolve module-relative, so tests can spawn it against
 * fixture trees. Env overrides: SCHEDULE_JSON (inline schedule — also
 * keeps this network-free in tests), NOW (classify as-of a date).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const semver = require("semver");
const YAML = require("yaml");
const { loadSchedule, classify } = require("./node-schedule");

const ROOT = process.cwd();
const WF_REL = path.join(".github", "workflows", "ci.yml");

const failures = [];
function check(cond, okMsg, failMsg) {
  if (cond) console.log(`  ✓ ${okMsg}`);
  else failures.push(failMsg);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${path.relative(ROOT, file)}: ${e.message}`);
  }
}

async function main() {
  console.log("Node version contract:");

  // --- engines -------------------------------------------------------------
  const pkg = readJson(path.join(ROOT, "package.json"));
  const engines = pkg.engines && pkg.engines.node;
  check(
    typeof engines === "string" && engines.trim() !== "",
    `package.json declares engines.node "${engines}"`,
    "package.json has no engines.node — the range contract is gone",
  );

  // --- .nvmrc ---------------------------------------------------------------
  let nvmrc = null;
  try {
    nvmrc = fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim();
  } catch {
    // reported below
  }

  // --- workflow ---------------------------------------------------------------
  let wf = null;
  try {
    wf = YAML.parse(fs.readFileSync(path.join(ROOT, WF_REL), "utf8"));
  } catch (e) {
    failures.push(`${WF_REL} is not valid YAML: ${e.message}`);
  }

  // --- the SAME classification CI uses --------------------------------------
  let legs = null;
  let canary = null;
  try {
    const schedule = await loadSchedule();
    const cls = classify(schedule, process.env.NOW || undefined);
    legs = cls.blocking;
    canary = cls.canary;
    console.log(
      `  schedule as of ${cls.today}: blocking [${legs.join(", ")}], canary ` +
        `${canary === null ? "none" : canary}`,
    );
  } catch (e) {
    failures.push(`cannot classify the release schedule: ${e.message}`);
  }

  // --- workflow structure ----------------------------------------------------
  if (wf) {
    const jobs = wf.jobs || {};
    const gates = jobs.gates;
    if (!gates) {
      failures.push(`${WF_REL} has no "gates" job — was the workflow renamed?`);
    } else {
      const mv = gates.strategy && gates.strategy.matrix && gates.strategy.matrix.node;
      check(
        typeof mv === "string" && mv.includes("needs.matrix.outputs.legs"),
        "gates matrix is computed from the release schedule (fromJSON of needs.matrix.outputs.legs)",
        `gates matrix is hardcoded (${JSON.stringify(mv)}) — it must consume ` +
          `\${{ fromJSON(needs.matrix.outputs.legs) }} so promotions/demotions apply without workflow edits`,
      );
    }

    const canaryJob = jobs.canary;
    if (canary !== null) {
      if (!canaryJob) {
        failures.push(
          `schedule has a canary candidate (node ${canary}) but ${WF_REL} has no canary job — the pre-LTS line would run nowhere`,
        );
      } else {
        const cm = canaryJob.strategy && canaryJob.strategy.matrix && canaryJob.strategy.matrix.node;
        check(
          typeof cm === "string" && cm.includes("needs.matrix.outputs.canary"),
          "canary job consumes the computed canary output",
          "canary job does not consume needs.matrix.outputs.canary — it would not follow promotions",
        );
        check(
          canaryJob["continue-on-error"] === true,
          "canary job is non-blocking (continue-on-error: true)",
          "canary job lost continue-on-error — a canary failure would block merges",
        );
        check(
          typeof canaryJob.if === "string" && canaryJob.if.includes("canary"),
          "canary job skips itself when the computed canary set is empty",
          "canary job lost its if: guard — it would fail whenever no canary exists (empty matrix)",
        );
      }
    }

    const ciok = jobs["ci-ok"];
    check(
      Boolean(ciok),
      "ci-ok aggregate job exists (the single stable required check)",
      "ci-ok aggregate job is missing — branch protection would have to track per-leg check names that change on every promotion",
    );
    if (ciok) {
      check(
        Array.isArray(ciok.needs) && ciok.needs.includes("gates"),
        "ci-ok depends on gates",
        "ci-ok does not depend on gates — the required check would not reflect the blocking legs",
      );
    }
  }

  // --- cross-source invariants ----------------------------------------------
  if (legs) {
    for (const leg of legs) {
      check(
        typeof engines === "string" && semver.satisfies(`${leg}.0.0`, engines),
        `blocking leg node ${leg} satisfies engines "${engines}"`,
        `blocking leg node ${leg} does NOT satisfy engines "${engines}" — CI runs red on a healthy tree; bump engines to cover it`,
      );
    }

    if (typeof engines === "string" && legs.length > 0) {
      const floor = semver.minVersion(engines);
      if (!floor) {
        failures.push(`cannot parse engines range "${engines}" with semver.minVersion`);
      } else {
        const oldest = Math.min(...legs);
        check(
          floor.major === oldest,
          `engines floor (node ${floor.major}) is the oldest blocking leg`,
          `engines floor is node ${floor.major} but the oldest blocking leg is node ${oldest} — support for node ${floor.major} is advertised but never tested (or an EOL leg was dropped without bumping the floor)`,
        );
      }
    }

    if (nvmrc !== null) {
      check(
        nvmrc !== "" &&
          typeof engines === "string" &&
          semver.satisfies(/^\d+$/.test(nvmrc) ? `${nvmrc}.0.0` : nvmrc, engines),
        `.nvmrc (${nvmrc}) satisfies engines "${engines}"`,
        `.nvmrc (${nvmrc}) does NOT satisfy engines "${engines}" — nvm users get an install npm rejects`,
      );
      const nvmMajor = parseInt(nvmrc, 10);
      check(
        Number.isFinite(nvmMajor) && legs.includes(nvmMajor),
        `.nvmrc (node ${nvmrc}) is one of the blocking CI legs [${legs.join(", ")}]`,
        `.nvmrc (node ${nvmrc}) is NOT a blocking CI leg [${legs.join(", ")}] — the recommended dev version would be ungated`,
      );
    } else {
      failures.push(".nvmrc is missing — version-manager users have no pinned default");
    }

    if (canary !== null) {
      check(
        typeof engines === "string" && semver.satisfies(`${canary}.0.0`, engines),
        `canary node ${canary} satisfies engines (the leg can at least install)`,
        `canary node ${canary} does NOT satisfy engines "${engines}" — the canary fails before tests even run`,
      );
    }
  }

  // --- verdict ---------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\n✗ Node version contract violated (${failures.length}):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(
    `\n✓ contract holds — engines "${engines}", .nvmrc ${nvmrc}, ` +
      `blocking [${legs ? legs.join(", ") : "?"}]` +
      (canary !== null ? `, canary ${canary} (experimental)` : ", canary none"),
  );
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
