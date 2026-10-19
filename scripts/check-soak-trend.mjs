#!/usr/bin/env node
/**
 * check-soak-trend - is the soak getting slower, and did any of its numbers move?
 *
 * WHY THIS EXISTS
 * ---------------
 * `npm run soak:supervisor` leaves one trend line per run (`--trend`, by default
 * `<dir>/soak-trend.jsonl`): what the run cost per reload, the descriptor floor each
 * phase read, and how its reloads ended. The soak's own verdict is about ONE run —
 * a leak it can see, a reload that did not land, a door that cost a client its
 * answer — and numbers that drift are the thing no single run can see. This is the
 * reader, and it is a gate: it answers with an exit code rather than with prose.
 *
 * WHAT IT JUDGES, AND WHY A SLOW REGRESSION COMES FIRST
 * ----------------------------------------------------
 * A leak announces itself as cost before it announces itself as a count: the retired
 * run's sockets, its pipes and its descendants are not the leak, the SLOWING is what
 * the leak does on the way there, and a descriptor floor is a noisy instrument by
 * design (see `handleTrendProblems` in scripts/soak-supervisor.mjs). So the first
 * thing this reads is the run against ITSELF:
 *
 *   in-run     the median of each phase's reload durations (asked → landed, which is
 *              the replacement's boot, the window and the stop of the run it replaced
 *              — the whole cell, not one leg of it) in the second half of a phase's
 *              reloads against the first half. Four readings minimum, the same
 *              halves rule the descriptor check uses, so the two instruments read
 *              alike.
 *
 * And the second thing it reads is the run against the RUNS BEFORE IT, when the file
 * has any: the same per-phase medians, and the floor each phase read. Both halves
 * compare like with like — same platform, same architecture, same engine major —
 * because timings from a laptop and a shared runner are not two measurements of one
 * thing. A record whose `profile` is missing is not compared at all, and says so.
 *
 * WHAT IT REFUSES
 * ---------------
 * It refuses to judge a trend it does not have: with fewer than `minBaseline` earlier
 * passing runs of the same profile, the across-runs half says so and names the count,
 * and a run whose own verdict was FAIL is RECORDED and judged by nothing at all — not
 * as a baseline, and not as the run being judged. A trend of the runs that leaked
 * would make leaking normal, and the numbers of a run that failed are usually the
 * numbers of a run that STOPPED, which read as the numbers of a fast one (see the note
 * at that check for the run that measured it). It refuses to compare the
 * descriptor floor across runs on a platform whose reading is SAMPLED rather than
 * live: on Windows the count comes from a 400ms watcher whose noise was measured at
 * up to 15 handles under load, which is most of a floor's signal, so the floor half
 * is skipped there by name rather than judged on noise. And a line it cannot read, or
 * an outcome it does not know, is reported rather than skipped quietly.
 *
 * WHAT A RED RUN'S LINE STILL CARRIES
 * -----------------------------------
 * A record that did not pass is judged by nothing, which leaves the reader of it with
 * the problems the soak wrote — and a door claim names one reload ("the door reported
 * 0 connection(s) still on the run it retired") without naming the facts behind it.
 * The run's summary has them, but a summary is uploaded for the run that produced it
 * while this file accumulates one line per run, so a line downloaded on its own has to
 * be enough. It is: every reload's held connection is carried in the record (`held`,
 * written by `trendRecord` in scripts/soak-supervisor.mjs) with when the door accepted
 * it, what the door said to it and when, when it ended and why, whether that ending came
 * before the door's count, and the count itself — and a failing run's NOT-JUDGED lines
 * name the reloads whose hold is not the ordinary shape, so the claim can be read here
 * instead of re-run (see `heldNotes`).
 *
 * The answers are PLACED here by the record's own aggregate fact (`answeredBeforeSwap`)
 * and not by the instant each one carries on it, because this file names a reload by its
 * held connection and carries no instant the port changed hands at to compare one
 * against. Nothing is guessed by either reading: the flag is the writer's answer to the
 * same question, and `scripts/soak-diagnose.mjs` — which reads the summary, and with it
 * the swap — is where an answer is placed at its own instant.
 *
 * Usage: node scripts/check-soak-trend.mjs <trend.jsonl...> [options]
 *
 *   trend.jsonl        one or more files of soak-trend records (JSONL). The NEWEST
 *                      record by its own `at` is the one judged; every other record
 *                      in the files given is its baseline. Name several and a series
 *                      downloaded from a run's artifacts is judged as one file.
 *   --profile p/a/n    compare against records from this platform/architecture/engine
 *                      major (e.g. linux/x64/22). Default: the newest record's own
 *                      profile, which is the comparison the run is asking for.
 *   --json             write the judgment to stdout as one JSON object and the human
 *                      lines to stderr, so `--json | jq .` composes.
 *   -h, --help         this text.
 *
 * Whatever it decides, it ends with one machine-readable line for a log reader:
 *
 *   SOAK_TREND=PASS|REGRESSED|NOT_JUDGED records=N compared=N judged=N problems=N
 *
 * Exit codes:
 *   0  the newest run's numbers moved within what its own reloads and the runs before
 *      it said they should.
 *   1  they moved out of it: a phase that got slower as the soak went on, a phase
 *      slower than the runs before it, a floor that rose across runs, or a reload
 *      that did not land.
 *   2  it could not be judged: no path or no such file, no record in this schema, a
 *      line this command cannot read, the newest run did not pass, or nothing to
 *      compare and nothing to read the run's own slow-down from.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { OUTCOME_VERDICT } from "../src/lib/deploy/reload-history.ts";
import { HELD_SHAPE, SOAK_TREND_SCHEMA } from "./soak-supervisor.mjs";

export const USAGE = `Usage: node scripts/check-soak-trend.mjs <trend.jsonl...> [options]

  trend.jsonl        one or more files of soak-trend records (JSONL), one record per
                     soak run. The newest record by its own \`at\` is judged and every
                     other record is its baseline.
  --profile p/a/n    compare against records from this platform/architecture/engine
                     major (e.g. linux/x64/22). Default: the newest record's own.
  --json             write the judgment to stdout as one JSON object (the human lines
                     go to stderr).
  -h, --help         this text.

It ends with one machine-readable line for a log reader:

  SOAK_TREND=PASS|REGRESSED|NOT_JUDGED records=N compared=N judged=N problems=N

Exit codes:
  0  the newest run moved within what its own reloads and the runs before it allowed.
  1  it did not: a phase got slower as the soak went on, a phase is slower than the
     runs before it, a floor rose across runs, or a reload did not land.
  2  it could not be judged: no path, no such file, no record in this schema, a line
     this command cannot read, a newest run that did not pass, or nothing left to read
     a trend from.`;

/**
 * What a movement has to clear before it is called one, and why those numbers.
 *
 * MEASURED, and the measurements are the reason they are not guesses. Twelve-reload
 * soaks of this repository's own build on one machine, from the three that passed: the
 * run's cost (the sum of its reloads' cells) came in at 70881ms, 73558ms and 75223ms —
 * a spread of 4342ms, 6% — and per phase the medians of the reloads differed by
 * 304-462ms across runs (busy 2938/3109/3400, trickle 7388/7578/7692, quiet 7370/
 * 7607/7697). So 20% with a 10s allowance on the run's cost is 3.3x
 * the measured spread and the 14.7s it works out to is +1.2s on every reload; a 25%
 * rise with a 2s allowance on a phase's median is 4-6x the 304-462ms that was
 * measured, and a reload's own cell is 2.9-3.4s in the busy phase and 7.4-7.7s in
 * trickle and quiet (the window it keeps open is 6s of that, by design).
 * The window a reload keeps open is RECORDED and not judged: it is set by the clock
 * (6s) or by the traffic (1.5s busy) rather than by how long the app took, so a rise
 * in it means the phase's own schedule changed, and the reload's cell already carries
 * whatever the app's part of it was. `minBaseline` is 3 because a median of two runs
 * is a coin toss, and `minReadings` is 4 because that is what a FLOOR needs — the
 * same rule the soak's descriptor check uses, so the two cannot disagree about what
 * is judgeable.
 */
export const DEFAULTS = {
  durationRatio: 0.25,
  durationAllowanceMs: 2_000,
  totalRatio: 0.2,
  totalAllowanceMs: 10_000,
  floorSlack: 8,
  minReadings: 4,
  minBaseline: 3,
};

/** The median of a list of numbers, or null when there is nothing to average. */
export function median(values) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[middle] : Math.round((numbers[middle - 1] + numbers[middle]) / 2);
}

/**
 * A platform's descriptor reading: live, or sampled.
 *
 * Linux answers the count by reading `/proc/<pid>/fd` at the instant of the check, so
 * two readings of the same supervisor differ only when the process does. Windows has
 * no such table and the soak watches its handle count from a polling PowerShell
 * instead — the instrument the soak's own header documents as noisy by up to 13
 * handles, and 15 under load. A floor compared across runs on that reading would be
 * comparing noise, so the floor half of this gate is skipped there by name.
 *
 * @param {{ platform?: string } | null} profile
 */
export function liveReading(profile) {
  return profile !== null && profile !== undefined && profile.platform !== "win32";
}

/** `platform/arch/node`, the three things two runs have to agree about. */
export function profileKey(profile) {
  if (!profile) return null;
  return [profile.platform ?? "?", profile.arch ?? "?", profile.node ?? "?"].join("/");
}

/**
 * The answers an entry carries as objects — an object per answer, its status and its instant
 * together — or null when the entry is not in the shape this reader reads answers from.
 *
 * The block STATES its shape (`shape`, see `HELD_SHAPE` in scripts/soak-supervisor.mjs), so
 * this reads that marker rather than inferring a shape from which fields happen to be there.
 * An entry that does not name this shape — an older hold with plenty of facts and no marker,
 * or anything written after this reader — carries no answers HERE, and `null` says that
 * rather than an empty list, which would be the different claim that it was answered nothing.
 *
 * @param {Record<string, any>} entry
 * @returns {{ status?: number | string, at?: string }[] | null} the answers, or null
 */
export function answersOf(entry) {
  if (entry?.shape !== HELD_SHAPE) return null;
  return Array.isArray(entry.answered) ? entry.answered : null;
}

/**
 * The statuses of those answers, one per answer, in order.
 *
 * @param {Record<string, any>} entry
 * @returns {(number | string)[]}
 */
export function answerStatuses(entry) {
  return (answersOf(entry) ?? []).map((answer) => answer?.status ?? "?");
}

/**
 * The connections a run held across its swaps, as lines for whoever is reading a red
 * one.
 *
 * A door claim is about ONE reload — "the door reported 0 connection(s) still on the
 * run it retired" is a statement about the run reload 3 retired, and the count was
 * taken at an instant inside its window — so what a reader needs is that reload with
 * the facts the claim was judged on, and not twelve lines of the ordinary shape. The
 * reloads whose hold is NOT ordinary are therefore the ones named: no connection held
 * at all, one that was never accepted (with the reason it gives), one that was said
 * something the verdict does not let through — anything at all written before the port
 * changed hands, or a status that is neither the run's own 408 nor the door's retry-503
 * for a connection whose run has gone — one that ended before the door took its count,
 * and one whose count came back below the connection that was still open on it, which
 * is the count claim itself, read the way
 * `heldConnectionProblems` reads it, on the instant that decides whether the count
 * could be evidence at all. A run whose holds are all ordinary says so in one line,
 * and that is a diagnosis too: the problem then is not the connection the soak held.
 *
 * A record written before the field existed has no facts to name, and says that
 * rather than nothing, because "no held facts" and "nothing odd in the held facts" are
 * different answers to the same question.
 *
 * @param {Record<string, any>[] | null | undefined} held the record's own `held` field
 * @returns {string[]} the lines, in reload order, with the count over them
 */
export function heldNotes(held) {
  // No list, or one nothing contributed to: a record written before the field existed
  // carries none, and so does a run that performed no reloads. Both are the same
  // answer to the question, and it is said rather than left as silence — "no held
  // facts" and "nothing odd in the held facts" are not the same thing.
  if (!Array.isArray(held) || held.length === 0) {
    return [
      "the newest record carries no per-reload held-connection facts (a record written before the field existed does not), " +
        "so what the door did to the connection the soak held can only be read from that run's own summary",
    ];
  }
  /**
   * The statuses the verdict does NOT let through, i.e. what a claim is about.
   *
   * Two answers are ordinary and are said to a held connection all the time: the run
   * giving up on a request head it never received the end of (a 408), and the door's own
   * retry-503 for a connection whose run has gone, which comes at or after the swap.
   * Everything else is what the claim is about — including ANY answer written before the
   * port changed hands, when the run behind the door was still serving.
   *
   * WHERE an answer belongs is read from the record's aggregate flag rather than from the
   * instant each answer carries on it: a record carries those instants so that an incident
   * can be placed on one clock (scripts/soak-diagnose.mjs), but a trend line names no
   * per-reload instant the port changed hands at, so there is nothing here to compare an
   * instant WITH. The flag is the writer's own answer to that question, which is why the
   * two can never disagree.
   *
   * Only a block in `HELD_SHAPE` has answers to read here at all (`answersOf`): one in an
   * older shape, or in a shape this reader has never seen, is not read as a hold that was
   * answered nothing, which its own list would have to say.
   */
  const saidTo = (entry) => answerStatuses(entry).filter((status) => status !== 408 && (status !== 503 || entry.answeredBeforeSwap === true));
  const count = (test) => held.filter(test).length;
  const attached = (entry) =>
    entry.retiredPort === null || entry.retiredPort === undefined ? "" : `, on the run it had in port ${entry.retiredPort}`;
  const lines = [];
  for (const entry of held) {
    const at = `held reload ${entry.index ?? "?"} (${entry.phase ?? "?"})${attached(entry)}`;
    if (entry.accepted !== true) {
      lines.push(`${at}: no connection could be held through the door across the swap (${entry.endedReason ?? "it was never accepted"})`);
      continue;
    }
    const odd = [];
    const said = saidTo(entry);
    if (said.length > 0) {
      odd.push(
        entry.answeredBeforeSwap === true
          ? `was answered ${said.join("/")} while the run it was piped to was serving`
          : `was answered ${said.join("/")} after the port had changed hands`,
      );
    }
    if (entry.runGaveUp === true) {
      odd.push("was ended by the run it was piped to, which answered 408 for a request this connection never finished");
    }
    if (entry.endedBeforeSwap === true) odd.push("ended before the port changed hands");
    else if (entry.endedBeforeCount === true) odd.push("ended before the door took its count");
    if (entry.endedBeforeCount === false) {
      // The connection was still open when the count was taken, so the count IS
      // evidence about the run it was piped to: a count below one, or a count that is
      // not a count, is the finding this line exists for.
      if (!(Number.isInteger(entry.leftoverConnections) && entry.leftoverConnections >= 1)) {
        odd.push(
          `was still open when the door took its count, which reported ${JSON.stringify(entry.leftoverConnections)} connection(s) on the run it retired`,
        );
      }
    }
    if (typeof entry.afterStop === "string" && /^2\d\d$/.test(entry.afterStop)) {
      odd.push(`was answered ${entry.afterStop} after the run it was piped to had been stopped`);
    }
    if (odd.length > 0) lines.push(`${at}: ${odd.join("; ")}`);
  }
  lines.unshift(
    `held connections: ${held.length} reload(s), ${count((entry) => entry.accepted === true)} accepted, ` +
      `${count((entry) => saidTo(entry).length > 0)} answered where nothing may answer, ${count((entry) => entry.runGaveUp === true)} given up on by the run, ` +
      `${count((entry) => entry.endedBeforeCount === true)} ended before the door's count, ` +
      `${count((entry) => entry.endedBeforeCount === false && !(Number.isInteger(entry.leftoverConnections) && entry.leftoverConnections >= 1))} with the door's count below the connection on it`,
  );
  return lines;
}

/**
 * Judge the newest record in a series against the runs before it and against itself.
 *
 * Everything it needs is in the records, so the whole gate is exercised as a unit as
 * well as through the real process, which is the interface a CI step uses.
 *
 * @param {Record<string, any>[]} records the trend's records, in file order
 * @param {{ profile?: string | null, budgets?: typeof DEFAULTS }} [options]
 * @returns {{
 *   problems: string[],
 *   notes: string[],
 *   judged: string[],
 *   skipped: string[],
 *   latest: Record<string, any> | null,
 *   compared: number,
 * }}
 */
export function judgeSoakTrend(records, { profile = null, budgets = DEFAULTS } = {}) {
  const problems = [];
  const notes = [];
  const judged = [];
  const skipped = [];

  const usable = records.filter(
    (record) => record && record.schema === SOAK_TREND_SCHEMA && Number.isFinite(Date.parse(record.at ?? "")),
  );
  const unreadable = records.length - usable.length;
  if (unreadable > 0) {
    notes.push(
      `${unreadable} line(s) are not records in ${SOAK_TREND_SCHEMA} with a timestamp this reader can read, ` +
        "and are not judged",
    );
  }
  if (usable.length === 0) {
    return { problems, notes, judged, skipped: [`no record in ${SOAK_TREND_SCHEMA} to judge`], latest: null, compared: 0 };
  }
  const ordered = [...usable].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latest = ordered[ordered.length - 1];
  const key = profile ?? profileKey(latest.profile);
  const { totalRatio, totalAllowanceMs, durationRatio, durationAllowanceMs, floorSlack, minReadings, minBaseline } = budgets;

  // A run that did not pass is RECORDED — a trend of the runs that passed cannot show
  // a regression — and it is judged by nothing here, including itself. The reason is
  // not tidiness: a run that failed is usually a run that STOPPED, and the numbers of
  // a stopped run read as the numbers of a fast one. Measured, on the run that found
  // this: a soak disturbed by a second soak in its own `--dir` performed 12 reloads,
  // four of them with no usable clock, and its cost came out 48080ms against the three
  // passing runs' 73558ms — a 35% "speed-up" a total-cost check would have called fine.
  // The verdict on such a run is the soak's own, and the place to read it is its
  // problems, not a comparison of a truncated run with whole ones.
  if (latest.verdict !== "PASS") {
    const detail = Array.isArray(latest.problems) && latest.problems.length > 0 ? `: ${latest.problems[0]}` : "";
    notes.push(`the newest record is a ${latest.verdict} run${detail}`);
    // ...and the held connections behind it: a door claim names one reload, and these
    // are the facts it was judged on, so the account can be diagnosed here rather than
    // by re-running the soak (see `heldNotes`).
    notes.push(...heldNotes(latest.held));
    skipped.push(
      "the newest run did not pass, so there is no trend to read from it — a base has to be made of runs whose " +
        `numbers are the numbers of a working deploy (the verdict on this one is the soak's own, in its problems)${detail}`,
    );
    return { problems, notes, judged, skipped, latest, compared: 0 };
  }

  // ---------------------------------------------------------------- the run itself
  const durations = latest.durations ?? {};
  const phases = Object.keys(durations).sort();
  if (phases.length === 0) {
    skipped.push("the newest record carries no reload durations, so there is no slow-down to read from it");
  }
  for (const phase of phases) {
    const values = (durations[phase] ?? []).filter((value) => Number.isFinite(value));
    if (values.length < minReadings) {
      skipped.push(
        `${phase} in-run (${values.length} reading(s)): ${minReadings} readings is what the halves rule needs, the ` +
          "same rule a descriptor floor is read by",
      );
      continue;
    }
    const half = Math.floor(values.length / 2);
    const first = median(values.slice(0, half));
    const second = median(values.slice(half));
    const allowed = Math.max(durationAllowanceMs, Math.round((first ?? 0) * durationRatio));
    judged.push(`in-run ${phase} ${first}ms→${second}ms`);
    if (second - first > allowed) {
      problems.push(
        `the ${phase} phase's reloads cost more as the soak went on: the median reload in the first half took ` +
          `${first}ms and in the second ${second}ms (+${second - first}ms, more than the ${allowed}ms allowed, ` +
          `series: ${values.join(", ")}) — a leak's first symptom is reloads that cost more, and the descriptor ` +
          "floor does not have to have moved yet",
      );
    }
  }

  // ------------------------------------------------------------ the runs before it
  const baseline = ordered.filter(
    (record) => record !== latest && profileKey(record.profile) === key && record.verdict === "PASS",
  );
  const leftOut = ordered.filter((record) => record !== latest).length - baseline.length;
  if (leftOut > 0) {
    notes.push(
      `${leftOut} earlier record(s) are not a baseline: either they ran somewhere else (${key} is the profile ` +
        "being compared) or they did not pass, and a run that leaked must not become what normal looks like",
    );
  }
  if (baseline.length < minBaseline) {
    skipped.push(
      `across runs (${baseline.length} earlier ${key} run(s)): ${minBaseline} are needed, because a median of ` +
        "two runs is a coin toss",
    );
  } else {
    for (const phase of phases) {
      const earlier = median(baseline.map((record) => median(record.durations?.[phase] ?? [])).filter(Number.isFinite));
      const now = median(durations[phase] ?? []);
      if (earlier === null || now === null) {
        skipped.push(`${phase} across runs (no median to compare in one of the records)`);
        continue;
      }
      const allowed = Math.max(durationAllowanceMs, Math.round(earlier * durationRatio));
      judged.push(`across-runs ${phase} ${earlier}ms→${now}ms`);
      if (now - earlier > allowed) {
        problems.push(
          `the ${phase} phase is slower than the ${baseline.length} passing run(s) before it: a median reload of ` +
            `${earlier}ms there against ${now}ms now (+${now - earlier}ms, more than the ${allowed}ms allowed) — ` +
            "the same work taking longer is a regression whether or not anything leaked this time",
        );
      }
    }
    // The run's cost as one number, over every reload it performed.
    const costOf = (record) => Object.values(record.durations ?? {}).flat().reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
    const earlierCost = median(baseline.map(costOf).filter((value) => value > 0));
    const nowCost = costOf(latest);
    if (earlierCost !== null && nowCost > 0) {
      const allowed = Math.max(totalAllowanceMs, Math.round(earlierCost * totalRatio));
      judged.push(`across-runs total ${earlierCost}ms→${nowCost}ms`);
      if (nowCost - earlierCost > allowed) {
        problems.push(
          `the run cost more than the ${baseline.length} passing run(s) before it: ${nowCost}ms of reloads against ` +
            `${earlierCost}ms (+${nowCost - earlierCost}ms, more than the ${allowed}ms allowed)`,
        );
      }
    }

    // The floor, and only where the instrument is a measurement rather than a sample.
    const live = liveReading(latest.profile) && baseline.every((record) => liveReading(record.profile));
    if (!live) {
      skipped.push(
        "across-runs descriptor floors (this profile's reading is sampled, not live): its noise was measured at " +
          "15 handles under load, which is most of a floor's signal",
      );
    } else {
      for (const phase of phases) {
        const earlier = median(baseline.map((record) => record.floors?.[phase]?.second).filter(Number.isFinite));
        const now = latest.floors?.[phase]?.second;
        if (earlier === null || !Number.isFinite(now)) {
          skipped.push(`${phase} across-runs floor (no floor read in one of the records)`);
          continue;
        }
        judged.push(`across-runs floor ${phase} ${earlier}→${now}`);
        if (now - earlier > floorSlack) {
          problems.push(
            `the ${phase} phase's descriptor floor rose across runs, from ${earlier} to ${now} (+${now - earlier}, ` +
              `more than the ${floorSlack} allowed) — something is being kept between runs, not just within one`,
          );
        }
      }
    }
  }

  // ------------------------------------------------------------- how reloads ended
  const outcomes = latest.outcomes ?? {};
  const names = Object.keys(outcomes);
  const unknown = names.filter((name) => !OUTCOME_VERDICT[name]);
  if (unknown.length > 0) {
    notes.push(
      `the newest record carries outcome(s) this reader does not know (${unknown.join(", ")}): the outcome half is ` +
        "not judged — the vocabulary is declared in src/lib/deploy/reload-history.ts, and a newer record means this " +
        "reader is behind it",
    );
  }
  const unlanded = names.filter((name) => OUTCOME_VERDICT[name] && !OUTCOME_VERDICT[name].landed);
  if (unlanded.length > 0) {
    problems.push(
      `the newest run's reloads did not all land: ${unlanded.map((name) => `${name} ×${outcomes[name]}`).join(", ")} — ` +
        "a base has to be made of reloads that landed, or the numbers above are the numbers of a broken deploy",
    );
  }
  const known = names.filter((name) => OUTCOME_VERDICT[name]);
  if (known.length > 0 && baseline.length >= minBaseline) {
    const earlierNames = new Set(baseline.flatMap((record) => Object.keys(record.outcomes ?? {})));
    const appeared = known.filter((name) => !earlierNames.has(name));
    if (appeared.length > 0) {
      notes.push(
        `reloads now end as ${appeared.join(", ")} where the runs before it did not: ${known
          .map((name) => `${name} ×${outcomes[name]}`)
          .join(", ")}`,
      );
    }
  }

  return { problems, notes, judged, skipped, latest, compared: baseline.length };
}

/**
 * The arguments, as options, or a thrown error naming what is wrong with them.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = { paths: [], profile: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--profile") {
      if (i + 1 >= argv.length) throw new Error("--profile needs a value");
      options.profile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    options.paths.push(arg);
  }
  return options;
}

/**
 * Judge a trend file, or several, and say so with an exit code.
 *
 * The reader is injectable so the gate can be exercised against records a test
 * wrote, as well as through the real process against a real file.
 *
 * @param {string[]} [argv]
 * @param {{
 *   readFile?: (path: string) => string,
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 *   budgets?: typeof DEFAULTS,
 * }} [deps]
 * @returns {number} the exit code: 0 within, 1 outside, 2 could not judge
 */
export function main(argv = process.argv.slice(2), deps = {}) {
  const {
    readFile = (path) => readFileSync(path, "utf8"),
    out = (text) => process.stdout.write(text),
    err = (text) => process.stderr.write(text),
    budgets = DEFAULTS,
  } = deps;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    out(`${USAGE}\n`);
    return 0;
  }
  if (options.paths.length === 0) {
    err(`no trend file named\n\n${USAGE}\n`);
    return 2;
  }

  const records = [];
  for (const path of options.paths) {
    let text;
    try {
      text = readFile(path);
    } catch (error) {
      err(`${path}: ${error.message}\n`);
      return 2;
    }
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === "") continue;
      try {
        records.push(JSON.parse(line));
      } catch (error) {
        err(
          `${path}: line ${index + 1} is not JSON (${error.message}) — the trend is written one record per line, ` +
            "and a file this reader cannot read in full is not a trend it will judge\n",
        );
        return 2;
      }
    }
  }

  const judgment = judgeSoakTrend(records, { profile: options.profile, budgets });
  const human = options.json ? err : out;
  human(`${options.paths.join(", ")}: ${records.length} record(s)\n`);
  for (const line of judgment.judged) human(`  judged   ${line}\n`);
  for (const line of judgment.skipped) human(`  skipped  ${line}\n`);
  for (const line of judgment.notes) human(`  note     ${line}\n`);
  for (const line of judgment.problems) human(`  problem  ${line}\n`);
  const verdict = judgment.problems.length > 0 ? "REGRESSED" : judgment.judged.length > 0 ? "PASS" : "NOT_JUDGED";
  human(
    `SOAK_TREND=${verdict} records=${records.length} compared=${judgment.compared} ` +
      `judged=${judgment.judged.length} problems=${judgment.problems.length}\n`,
  );
  if (options.json) out(`${JSON.stringify({ verdict, ...judgment, records: records.length })}\n`);
  return judgment.problems.length > 0 ? 1 : judgment.judged.length > 0 ? 0 : 2;
}

// Run only when executed directly (the tests import the gate's parts).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
