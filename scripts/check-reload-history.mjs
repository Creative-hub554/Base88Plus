#!/usr/bin/env node
/**
 * check-reload-history - did the reload a deploy just asked for actually land?
 *
 * WHY THIS EXISTS
 * ---------------
 * `PROD_RELOAD_HISTORY` makes every reload `npm start` performs leave a record:
 * one JSON object per line, written from the same verdict the log was written
 * from. That record is what lets a deploy check what its deploy DID instead of
 * reading a log and hoping. This is the reader, and it is a GATE — it answers
 * with an exit code rather than with prose, so a pipeline acts on the answer
 * without parsing anything:
 *
 *   touch "$PROD_RELOAD_FILE" && node scripts/check-reload-history.mjs --wait 150000
 *
 * ...is a deploy: ask for the reload, wait for its record, and fail the step if
 * what came back is not a reload that landed.
 *
 * The wait has to cover the window the reload is allowed, because the record is
 * written when the reload CONCLUDES and not when the port changes hands: a
 * replacement nobody uses keeps the way back for the whole of `PROD_ROLLBACK_MS`
 * (90s by default) before its record exists, so `--wait 60000` would report a
 * reload that happened as one that never did.
 *
 * WHAT "IT LANDED" MEANS
 * ----------------------
 * The vocabulary is the supervisor's, and the verdict on each outcome is declared
 * ONCE, in `src/lib/deploy/reload-history.ts` — the same object the settings page
 * colours its rows with, so a page cannot show a rollback as fine while this
 * command fails a deploy over it. `replaced` landed. `stopped` landed too — a
 * shutdown ended the reload with the replacement already in place, and refusing
 * it would report a deploy that happened as one that did not, so it passes and is
 * printed in full rather than hidden. The three that do NOT land are the three a
 * pipeline has to hear about: `rolled-back` (the port went back to the run it
 * replaced), `kept` (nothing changed — the replacement never came up, or the
 * supervisor was already stopping), and `no-fallback` (the replacement failed AND
 * the run it replaced was gone, so it is serving anyway). The last one is not a
 * rollback and not a no-op: it is a deploy that landed broken, which is the worst
 * of the three to report as green. That module is imported here as `.ts` and run
 * through this Node's own type stripping (the same arrangement
 * `scripts/demo-link-audit.mjs` has with `src/lib/demo-link-audit.ts`), which is
 * what lets one declaration serve a script, a route and a component.
 *
 * WHY THERE IS A DEFAULT WINDOW, AND WHY IT IS SHORT
 * --------------------------------------------------
 * A record is written when a reload is PERFORMED, so a reload that never happened
 * writes nothing at all: with the supervisor not running, or the sentinel not
 * being watched, the newest line in the file belongs to some earlier deploy. A
 * reader that judged "the last line" unconditionally would therefore report the
 * PREVIOUS deploy's green reload as this one's, which is the false pass this gate
 * exists to refuse. So a record only counts if it landed recently enough to be
 * this deploy's — `--since`, five minutes by default, which is comfortably longer
 * than asking, waiting and checking, and far shorter than the gap between two
 * deploys. A record outside it is reported as an absence (`exit 2`), and
 * `--since` names the window explicitly for a script whose reload was a while
 * ago.
 *
 * `--wait` is the same idea from the other side. It insists on a record that
 * landed AFTER this command started, which is what makes "ask for the reload and
 * check it" one step: a wait that times out means no reload was recorded at all,
 * and that is `exit 2` — no record to judge — rather than a pass on the record
 * that was already there. It must be at least as long as the reload can take,
 * which is the reload's own window: that is up to `PROD_ROLLBACK_MS` (90s by
 * default) whenever the app is not using the replacement, and seconds when it is,
 * so the recipe above waits 150s rather than a minute.
 *
 * WHAT IT REFUSES TO PASS
 * -----------------------
 * A line that is not a JSON object, that carries a schema this reader does not
 * know (`base88.reload/1` is read from `supervise.mjs`, not restated here), that
 * has no outcome, or whose `at` cannot be read as a time, makes the whole file
 * unjudgeable (`exit 2`, naming the line): a gate that cannot read its evidence
 * does not pass. An outcome this command has never heard of is refused for the
 * same reason rather than guessed at, so a newer supervisor's vocabulary cannot
 * be read as a pass by an older reader. The schema is the argument that makes the
 * shared reader strict here and lenient on the settings page; this command is the
 * one that has to say no.
 *
 * Usage: node scripts/check-reload-history.mjs [history] [options]
 *
 *   history            the JSONL file `PROD_RELOAD_HISTORY` names, whose
 *                      records this command judges. Defaults to
 *                      $PROD_RELOAD_HISTORY.
 *
 *   --since <when>     only records that landed at or after <when> count: an
 *                      ISO timestamp, epoch milliseconds, or a duration back
 *                      from now (-30s, -5m, -2h, -1d). Default: -5m.
 *   --wait <ms>        wait up to <ms> for a reload that landed after this
 *                      command started, then judge that one.
 *   --all              judge every record in scope, not only the newest: any
 *                      one of them failing fails the command.
 *   --json             write the judged record(s) to stdout as JSONL — the
 *                      shape the history already carries — and the human lines
 *                      to stderr, so `--json | jq .` composes.
 *   -h, --help         this text.
 *
 * Exit codes (the interface; nothing here needs parsing):
 *   0  the reload landed (`replaced`, or `stopped`).
 *   1  it did not (`rolled-back`, `kept`, or `no-fallback`).
 *   2  it could not be judged: no path, no file, no record in scope, a line
 *      this command cannot read, or an outcome it does not know.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  OUTCOME_VERDICT,
  describeReload,
  parseReloadHistory,
} from "../src/lib/deploy/reload-history.ts";
import { RELOAD_HISTORY_SCHEMA } from "./supervise.mjs";

const DEFAULTS = {
  // How old a record may be and still count as THIS deploy's reload. The record
  // lands when the reload concludes, so a script that asks, waits and then checks
  // is always well inside this; a record older than it belongs to a different
  // deploy, and a deploy whose reload never happened writes nothing at all.
  recentMs: 5 * 60_000,
  // How often a `--wait` looks again. Three or four looks a second: fast enough
  // that a deploy step does not sit idle, slow enough to cost nothing.
  pollMs: 250,
};

export const USAGE = `Usage: node scripts/check-reload-history.mjs [history] [options]

  history            the JSONL file \`PROD_RELOAD_HISTORY\` names, whose records
                     this command judges. Defaults to $PROD_RELOAD_HISTORY.

  --since <when>     only records that landed at or after <when> count: an ISO
                     timestamp, epoch milliseconds, or a duration back from now
                     (-30s, -5m, -2h, -1d). Default: -5m.
  --wait <ms>        wait up to <ms> for a reload that landed after this command
                     started, then judge that one. Use it when the reload is asked
                     for and checked in the same breath:
                       touch "$PROD_RELOAD_FILE" && node scripts/check-reload-history.mjs --wait 150000
                     The wait has to cover the window the reload is allowed: a
                     reload nobody uses runs to PROD_ROLLBACK_MS (90s by default)
                     before its record is written.
  --all              judge every record in scope, not only the newest: any one of
                     them failing fails the command.
  --json             write the judged record(s) to stdout as JSONL (the shape the
                     history already carries) and the human lines to stderr.
  -h, --help         this text.

Exit codes:
  0  the reload landed: replaced, or stopped (a shutdown ended the reload with
     the replacement already in place).
  1  it did not: rolled-back (the port went back to the run it replaced), kept
     (nothing changed), or no-fallback (the replacement failed and there was no
     run left to go back to, so it is serving anyway).
  2  it could not be judged: no history named or no such file, no record in
     scope, a line this command cannot read, or an outcome it does not know.`;

/** `-90s`, `-5m`, `-2h`, `-1d`, `-750ms` — a duration back from `now`. */
const RELATIVE_WHEN = /^-(\d+)(ms|s|m|h|d)$/;
const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * When a `--since` value means, as epoch milliseconds, or null when it means
 * nothing. Relative durations are measured from `now` rather than from each
 * record, so the window is fixed by the moment the command ran — which is what
 * a caller who says "the last five minutes" is asking for.
 *
 * @param {string|null} [value]
 * @param {number} now epoch milliseconds
 * @returns {number|null} epoch milliseconds, or null when the value means nothing
 */
export function parseWhen(value, now) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const relative = RELATIVE_WHEN.exec(text);
  if (relative) return now - Number(relative[1]) * UNITS[relative[2]];
  if (/^\d+$/.test(text)) return Number(text);
  // Only a timestamp in the shape the usage promises, rather than whatever
  // `Date.parse` happens to tolerate: it reads "-5" as a year, which would turn a
  // mistyped duration into a window decades wide.
  if (!/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(text)) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The command line, as options — or a thrown Error naming what is wrong with it,
 * which the caller turns into usage plus `exit 2`: a pipeline that passed
 * something this command cannot read has to hear about it the same way it hears
 * about a failed deploy.
 *
 * @param {string[]} argv
 * @returns {{
 *   history: string|null, since: string|null, waitMs: number,
 *   all: boolean, json: boolean, help: boolean,
 * }}
 */
export function parseArgs(argv) {
  const options = { history: null, since: null, waitMs: 0, all: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const take = () => {
      if (inline !== null) return inline;
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      i += 1;
      return argv[i];
    };
    switch (flag) {
      case "--history":
        options.history = take();
        break;
      case "--since":
        options.since = take();
        break;
      case "--wait": {
        const raw = take();
        const ms = Number(raw);
        if (!Number.isFinite(ms) || ms < 0) {
          throw new Error(`--wait: not a number of milliseconds: ${JSON.stringify(raw)}`);
        }
        options.waitMs = ms;
        break;
      }
      case "--all":
        options.all = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        if (options.history !== null) throw new Error(`unexpected argument: ${arg}`);
        options.history = arg;
        break;
    }
  }
  return options;
}

/**
 * Judge the reloads a history file records, and say so with an exit code.
 *
 * Everything it touches outside itself is injectable — the clock, the reader,
 * the sleep, the two streams — so the whole gate is exercised as a unit as well
 * as through the real process, which is the interface a deploy uses.
 *
 * @param {string[]} [argv]
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   now?: () => number,
 *   readFile?: (path: string) => string,
 *   sleep?: (ms: number) => Promise<void>,
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 * }} [deps]
 * @returns {Promise<number>} the exit code: 0 landed, 1 did not, 2 could not judge
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    env = process.env,
    now = () => Date.now(),
    readFile = (path) => readFileSync(path, "utf8"),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    out = (text) => process.stdout.write(text),
    err = (text) => process.stderr.write(text),
  } = deps;

  // Before anything else: the moment this command started is the floor a
  // `--wait` insists on, and the anchor the default window is measured from.
  const startedAt = now();

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

  const historyPath = options.history ?? env.PROD_RELOAD_HISTORY ?? null;
  if (!historyPath) {
    err(
      "no reload history to read: name one as an argument, or set PROD_RELOAD_HISTORY to " +
        "the path `npm start` appends to (nothing is judged without one).\n",
    );
    return 2;
  }

  let sinceMs = startedAt - DEFAULTS.recentMs;
  if (options.since !== null) {
    const parsed = parseWhen(options.since, startedAt);
    if (parsed === null) {
      err(
        `--since: not a time this command can read: ${JSON.stringify(options.since)} ` +
          "(an ISO timestamp, epoch milliseconds, or -30s / -5m / -2h / -1d)\n",
      );
      return 2;
    }
    sinceMs = parsed;
  }
  // A reload that is waited for has to be newer than this command's own start, so
  // the floor is the later of the two: `--wait` cannot be satisfied by a record
  // that was already there when it began.
  const floor = options.waitMs > 0 ? Math.max(sinceMs, startedAt) : sinceMs;

  const deadline = startedAt + options.waitMs;
  let text = null;
  let readError = null;
  for (;;) {
    readError = null;
    try {
      text = readFile(historyPath);
    } catch (error) {
      text = null;
      readError = error;
    }
    // Nothing read is not a reason to stop early while waiting: the record is
    // appended when the reload concludes, which may be some seconds from now, and
    // so may the file itself (a history exists once a reload has been performed).
    // The wake-up test only: whether anything in the file has landed since this
    // command started. What the records MEAN is judged below, in one pass, with
    // the schema this gate insists on.
    const landed =
      text !== null && parseReloadHistory(text).records.some((entry) => entry.atMs >= floor);
    if (options.waitMs <= 0 || landed || now() >= deadline) break;
    await sleep(DEFAULTS.pollMs);
  }

  if (text === null) {
    if (readError?.code === "ENOENT" || !readError) {
      err(
        options.waitMs > 0
          ? `the reload history at ${historyPath} did not appear within the ${options.waitMs}ms this ` +
              "command waited — no reload was recorded, so there is nothing to judge.\n"
          : `there is no reload history at ${historyPath}: a history file exists once a reload has ` +
              "been performed, and nothing is judged without one.\n",
      );
    } else {
      err(`the reload history at ${historyPath} could not be read (${readError?.message ?? readError}).\n`);
    }
    return 2;
  }

  // The writer's own schema constant, so a record from a supervisor this gate
  // does not know is refused rather than read as though it were understood.
  const { records, unreadable } = parseReloadHistory(text, { schema: RELOAD_HISTORY_SCHEMA });
  if (unreadable.length > 0) {
    err(`${historyPath}: ${unreadable.length} line(s) this command cannot read as a ${RELOAD_HISTORY_SCHEMA} record:\n`);
    for (const bad of unreadable) err(`  line ${bad.line}: ${bad.reason}\n`);
    err("nothing is judged while the file carries a line this command cannot place.\n");
    return 2;
  }

  // Oldest first, so the newest record in scope is the last one — by `at` rather
  // than by position, because a file does not have to be strictly append-ordered
  // to be readable.
  const ordered = [...records].sort((left, right) => left.atMs - right.atMs);
  const inScope = ordered.filter((entry) => entry.atMs >= floor);
  if (inScope.length === 0) {
    const newest = ordered.length > 0 ? ordered[ordered.length - 1].record.at : null;
    if (options.waitMs > 0) {
      err(
        `no reload landed in the ${options.waitMs}ms this command waited (after ` +
          `${new Date(floor).toISOString()}) — the reload that was asked for did not happen, or ` +
          "PROD_RELOAD_HISTORY is not the file that supervisor appends to.\n",
      );
    } else {
      err(
        `no reload landed at or after ${new Date(sinceMs).toISOString()}` +
          (newest ? ` — the newest record in ${historyPath} is from ${newest}.\n` : " — the file has no records.\n") +
          "Pass --since <when> to judge an older reload, or --wait when you are asking for one now.\n",
      );
    }
    return 2;
  }

  const judged = options.all ? inScope : [inScope[inScope.length - 1]];
  const results = judged.map((entry) => ({
    entry,
    verdict: OUTCOME_VERDICT[entry.record.outcome ?? ""] ?? null,
  }));
  const unknown = results.find((result) => result.verdict === null);
  if (unknown) {
    err(
      `${historyPath}: line ${unknown.entry.line} carries the outcome ` +
        `${JSON.stringify(unknown.entry.record.outcome)}, which this command does not know — the history ` +
        `is newer than this reader (${RELOAD_HISTORY_SCHEMA}), so nothing is judged.\n`,
    );
    return 2;
  }

  // With `--json` the records are the output and the prose gets out of the way;
  // without it, a person reading a deploy log gets the prose.
  const human = options.json ? err : out;
  human(`${historyPath}: ${records.length} record(s), ${inScope.length} in scope, judging ${judged.length}\n`);
  for (const { entry, verdict } of results) human(`  ${describeReload(entry.record, verdict)}\n`);

  const failed = results.filter((result) => !result.verdict.landed);
  human(
    `RELOAD_VERDICT=${failed.length === 0 ? "LANDED" : "NOT_LANDED"} records=${results.length} ` +
      `landed=${results.length - failed.length} failed=${failed.length}\n`,
  );
  if (options.json) for (const { entry } of results) out(`${JSON.stringify(entry.record)}\n`);

  return failed.length === 0 ? 0 : 1;
}

// Run only when executed directly (the tests import the gate's parts).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
