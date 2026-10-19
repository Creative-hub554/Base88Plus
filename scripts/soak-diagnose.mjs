#!/usr/bin/env node
/**
 * soak-diagnose - read a downloaded `soak-account` and print one incident timeline.
 *
 * WHY THIS EXISTS
 * ---------------
 * The soak's account is three files, and each answers a different question: the summary
 * (`soak-summary.json`, the object `--json` writes) is what the run FOUND, the history
 * (`reloads.jsonl`) is what each reload DID, and the trend line (`soak-trend.jsonl`) is
 * what the run COST. A fourth — the app's own output, `server.log` — is saved beside them
 * by the soak, and says what the app did with a client a swap cost. They are uploaded together for one reason — a red run has to be
 * diagnosable from the artifact — and diagnosing one used to mean reading three files
 * side by side, with the clocks in three shapes (an ISO instant in one, a duration in
 * another, a `T+` relation worked out by hand) and reload N in one matched against
 * reload N in the next. Anything read that way gets read wrongly, and the reader is
 * usually somebody who did not write the soak.
 *
 * So this reads the ACCOUNT rather than one file: all three, every fact on the run's own
 * clock (whose zero is the earliest instant the account names), in the order it happened,
 * with the problems the account names sitting at the reload they are about instead of in a
 * list at the end.
 *
 * …and the app's OWN OUTPUT when the account carries it (`server.log`, written by the soak
 * beside the history): a loss names the client by the ordinal it was handed to the door at, and
 * that ordinal is on the request the client asked with — so the app's line for that client is in
 * this file, and the report prints it under the loss instead of sending a reader to grep an
 * artifact they may not have downloaded beside this one — and then CLASSIFIES it, because that
 * line is the only place the app's side of the request is written down: whether it was
 * answered (and with what), named without an answer, or never named at all is what separates a
 * loss the door caused on the way back from one the app never finished from one that never
 * reached the app, and a report that only quoted the line left the reader to draw that line
 * themselves. An account from before the soak saved it is read exactly as it was, and says
 * that the loss was not followed.
 *
 * WHAT IT READS, AND WHAT IT DOES NOT DECIDE AGAIN
 * -----------------------------------------------
 * Nothing here is measured twice and no vocabulary is restated:
 *
 *   - the history goes through `parseReloadHistory` and the outcome words come from
 *     `verdictFor` (src/lib/deploy/reload-history.ts, the same declaration the deploy
 *     gate and the settings page read), so "LANDED BROKEN" here is those words there;
 *   - the run's trend line is judged by `judgeSoakTrend` — including the lines it writes
 *     about a red run's held connections (`heldNotes`) — so this command cannot disagree
 *     with `npm run check:soak-trend` about what the line says;
 *   - the held connection's facts are the ones the soak already wrote per reload
 *     (`reloadsDetail[].held`, projected into the trend line as `held`), read against
 *     the instant the port changed hands rather than re-derived from anything: when the
 *     door ACCEPTED it, what the door or the run said to it — each answer with its own
 *     status and instant — when it ended, whether that came before the count, and the
 *     count;
 *   - each reload's swap is the soak's own per-swap evidence (`swapsAtTheDoor`), matched
 *     to its reload by the instant the port changed hands, and every client it cost is
 *     named by `describeSpent` (scripts/soak-supervisor.mjs) — the same reading the soak
 *     writes its own account with, so which client a swap spent is never re-derived here —
 *     and named BY THE HANDLE that client carried: the ordinal it was handed to the door at
 *     (`spent[].client`), which is the number the client asked with (`_client=` on the path,
 *     see `asked` in scripts/soak-supervisor.mjs) and therefore the one the app's own request
 *     log keys the same client by. The account carries that ordinal; this reader only says it
 *     (see `clientHandle` in scripts/soak-supervisor.mjs), which is what lets a downloaded account
 *     be correlated with a log without opening the JSON to find the number first — and the watch's
 *     live line names it through the same `nameSpent`, so the incident read during the deploy and
 *     the one read from the account afterwards say the same words about the same client.
 *
 * The one thing it adds is the SPINE: which reload each fact belongs to, and when. The
 * only instant it computes rather than reads is the door's count, which the record's own
 * arithmetic names (the swap plus the window the reload used) and which
 * `leftoverCountInstant` in scripts/soak-supervisor.mjs reads the same way.
 *
 * Because the hold is opened before the reload is asked for, `T+0` is usually that
 * connection being accepted rather than the first ask — the account's zero is simply the
 * earliest instant it names, so nothing on the timeline is ever before its own start.
 *
 * AN ACCOUNT WITH A FILE MISSING IS STILL AN ACCOUNT
 * --------------------------------------------------
 * The files are not equally necessary, and a soak that could not be run at all
 * leaves none of them (the summary is written by the same function that appends the trend
 * line, at the end of a run that happened). So an absent file is reported and the account
 * is read from what is there — the trend line carries the run's verdict, its problems and
 * every reload's held facts, and the history carries the clocks — and only an account
 * with nothing readable in it is `exit 2`.
 *
 * WHAT IT REFUSES
 * ---------------
 * Two files, two readers, and each keeps its own reader's strictness rather than a third
 * one being invented: a trend line that is not JSON makes the account unreadable
 * (`exit 2`, exactly as `check:soak-trend` refuses it), while a history line that is JSON
 * but not a record this reader can use is REPORTED as a problem — which is what the
 * lenient `parseReloadHistory` is for — and does not hide the rest of the file. A file
 * that is there and cannot be parsed at all is `exit 2`, because half an incident read as
 * a whole one is how a wrong diagnosis gets made; the report still shows the readable
 * half and says which half it could not read.
 *
 * TWO ACCOUNTS: WHAT CHANGED BETWEEN THEM
 * ---------------------------------------
 * Naming a SECOND account compares the two and prints only the facts that are not the same
 * in both: `soak:diagnose <green> <red>` is how a regression gets read, because the
 * question after a red run is almost never "what did it say" but "what is different from
 * the run that passed".
 *
 * The comparison is by FACT, not by text: the two accounts sit on two clocks and two ports,
 * so a text diff of two timelines would be nothing but the ports. What is compared is
 * therefore what MEANS THE SAME THING in both runs — the run's verdict, its profile, which
 * of the files it left, its problems and its notes, and every reload's phase, outcome,
 * how its window ended and the connection it held across the swap — while the facts that are
 * the identity of ONE run (its instants, its ports, its window durations, its descriptor
 * readings) are excluded BY NAME and said so at the foot of the report. A leak is still
 * compared: the leak VERDICT is the run's `problems`, which is one of the compared facts,
 * not the raw counts behind it.
 *
 * TIME is the one measurement a text comparison of two accounts could not name, so the run's
 * COST is compared too: each phase's median reload and the run's total, read off the trend
 * line — the file whose job is to carry what a run cost, and where `check:soak-trend` reads
 * the same two numbers from. A duration is not the identity of ONE run the way a port is (a
 * regression shows up in it, which is why it is worth comparing), but two readings of one are
 * not equal either, so only a movement PAST the allowance that gate already carries for the
 * same comparison is a fact here (a quarter of a phase's median or 2s, a fifth of the run's
 * total or 10s), and the two runs have to have run on one profile — two machines are not two
 * measurements of one thing. Without this, a regression whose two accounts carried the same
 * problems could only ever read as `SAME`: a run that got slower would be indistinguishable
 * from one that did not.
 *
 * THE DOOR is compared too, and as RATES rather than as counts. How many requests arrived is a
 * fact of the traffic, not of the door: three soaks of one build through the same fixture counted
 * 61, 59 and 62 requests and served exactly 61, 59 and 62 of them 200 — a raw count that moved by
 * three between runs of the SAME build while the mix did not move at all. So what two runs can be
 * compared on is each status's share of what the door was offered, its timeouts and connection
 * errors as shares of the same, the clients it had in flight per swap that had one, and the clients
 * its swaps LOST as a share of the clients those swaps had at the door — that last one held to half
 * a client of the sample it was counted among rather than to the points of mix, so a single client
 * lost is a movement however large the sample (see `DOOR`). The counters come off the
 * trend line's `door` block — a projection of the summary, so the two cannot disagree — and a run
 * whose record names no traffic is REPORTED as not compared rather than read as a door with nothing
 * behind it. A loss is still a problem rather than an answer: a run whose door cost a client its
 * answer did not pass, and the run group names the reload it happened at. The rate is the magnitude
 * of that finding, which is the half of it two problem sentences cannot be compared on.
 *
 * Its exit code is about the READ rather than about the answer: 0 when every account was
 * compared, 2 when one of them could not be read at all. `DIFFERENT` is not a failure — a
 * diff command that failed whenever its two inputs differed would be one no pipeline could
 * use — and only `SAME` says the runs agreed about everything comparable.
 *
 * MANY ACCOUNTS: THE SAME COMPARISON, AS A REGRESSION SERIES
 * ----------------------------------------------------------
 * Naming THREE or more compares them the same way, one STEP at a time: the comparison is the
 * consecutive pairs (run 1 against 2, 2 against 3, ...), and every fact that moved is
 * reported with the run where it FIRST moved — which is the question a regression actually
 * asks, not which runs differ but which run introduced the difference. A fact that moves
 * twice is two differences, because each step is judged against the run before it, exactly
 * as `check:soak-trend` judges a run against the runs before it.
 *
 * The runs are the order they are named, oldest first, and the header names every one of
 * them: two accounts are still `first`/`second` and the series numbers them, so a series
 * given out of order is visible rather than silently reordered. The accounts are not sorted
 * by their own `at`, because a download names its directory, an account's instants may be
 * missing (a run that died early leaves no summary and no trend line), and the command line
 * is always there. The exit code stays about the READ.
 *
 * `--summary`/`--history`/`--trend` name a file of ONE account, so they are refused when
 * accounts are compared rather than silently applied to one of them.
 *
 * ONE ACCOUNT AGAINST A STORED BASELINE
 * -------------------------------------
 * An account on its own has nothing to be compared with, and a person with ONE artifact —
 * the one they just downloaded — still has the question this command was extended for: how
 * far did this run drift? `--baseline <trend.jsonl>` names a STORED trend line (the file a
 * soak appends one line per run to, kept across runs) and reads the run against the runs
 * BEFORE it, which is the comparison no single run can make and the one `check:soak-trend`
 * makes across runs.
 *
 * The numbers are that gate's numbers rather than a second reading of them: each phase's
 * median reload and the run's total, against the MEDIAN of the baseline records' own
 * per-phase medians and totals, held to the allowances the across-runs half uses (a quarter
 * of the baseline's median or 2s on a phase, a fifth of the total or 10s) — so a reader of
 * this report and a reader of the gate cannot disagree about what `slower` is. What is a
 * baseline is not invented here either: an earlier run on ANOTHER profile is not one (two
 * machines are not two measurements of one thing), a run that did not PASS is not one (a run
 * that leaked must not become what normal looks like, and the numbers of a run that stopped
 * read as the numbers of a fast one), and THIS RUN'S OWN LINE is not one — a trend file kept
 * across runs has the run's own line in it, and a run is not a baseline for itself. Every
 * record left out is counted and the reason for it is said.
 *
 * A baseline thinner than the gate's three runs is still READ, because a lone artifact is
 * exactly when a person wants the number, and the report says the gate would not judge a
 * trend on it — the same honesty as its `minBaseline` refusal, in the direction that helps.
 * A run that did NOT pass is measured too, and says so: the gate judges only a run that
 * passed, and a red run that got slower is precisely the finding a person is looking for, so
 * the caveat is named instead of the reading being refused.
 *
 * The exit code stays about the READ, with one thing added by the baseline: a file named
 * with `--baseline` that cannot be read at all is `exit 2`, exactly as a named file of the
 * account is, because the comparison that was asked for could not be made — while a baseline
 * that reads and simply has nothing of this profile to compare is `NOT_COMPARED` and the
 * account's own exit code stands, which is the rule the cost half of a pair already follows.
 *
 * Usage: node scripts/soak-diagnose.mjs [account] [other...] [options]
 *
 *   account            the directory a downloaded `soak-account` artifact unpacks
 *                      into, i.e. where the account's files sit (default: .).
 *   other...           a SECOND account to compare it with, and any further ones: only the
 *                      facts that are not the same are printed, and with three or more every
 *                      fact that moved is named at the run it FIRST changed in.
 *   --summary <path>   read the summary from here instead of <account>/soak-summary.json
 *   --history <path>   ... the reload history instead of <account>/reloads.jsonl
 *   --trend <path>     ... the trend file instead of <account>/soak-trend.jsonl
 *   --log <path>       ... the app's own output instead of <account>/server.log — the
 *                      lines a lost client's request was answered or cut off on
 *                      (all four name a file of ONE account, so they cannot be used with
 *                      accounts compared)
 *   --json             write the account to stdout as one JSON object and the human
 *                      timeline to stderr, so `--json | jq .` composes.
 *   -h, --help         this text.
 *
 * Whatever it decides, it ends with one machine-readable line for a log reader:
 *
 *   SOAK_DIAGNOSIS=PASS|RED|UNREADABLE files=N reloads=N events=N problems=N
 *   SOAK_DIFF=SAME|DIFFERENT|UNREADABLE accounts=N differences=N reloads=N/... cost=<+Nms|-Nms|?>
 *
 * Exit codes:
 *   0  the account was read and carries no problem: the run passed.
 *   1  it was read and carries at least one: the soak's own problem, the trend reader's,
 *      or a line of the account this reader cannot use.
 *   2  it could not be read: nothing of the account is there, or a file that is there
 *      cannot be parsed.
 *
 * With two accounts it is 0 or 2 only: whether the comparison could be made, not whether
 * the two runs agreed (see the section above).
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReloadHistory, reloadEvidence, verdictFor } from "../src/lib/deploy/reload-history.ts";
import { DEFAULTS as TREND_BUDGETS, answersOf, judgeSoakTrend, median, profileKey } from "./check-soak-trend.mjs";
import { HELD_SHAPE, SERVER_LOG, SOAK_TREND_SCHEMA, clientLogLines, describeAppLines, nameSpent } from "./soak-supervisor.mjs";
import { RELOAD_HISTORY_SCHEMA } from "./supervise.mjs";

/**
 * Where each file of a downloaded account sits.
 *
 * The first three are the account proper — what the run FOUND, what each reload DID, what it
 * COST — and the fourth is the app's own output, which is where a lost client's request line
 * is (`SERVER_LOG` in scripts/soak-supervisor.mjs, the name this reader and the soak share).
 * It is read rather than required: an account downloaded before the soak saved it has three
 * files, and a loss in one of those is still named and placed, just not followed into prose
 * the account does not carry.
 */
export const DEFAULTS = {
  summary: "soak-summary.json",
  history: "reloads.jsonl",
  trend: "soak-trend.jsonl",
  log: SERVER_LOG,
};

/** The account's files, in the order the report names them. */
const KINDS = ["summary", "history", "trend", "log"];

// The app's own output, read by the same functions the watch uses as a loss lands: the
// vocabulary, the match on the client's ordinal and the sentence are defined in
// scripts/soak-supervisor.mjs, because a live line and this timeline must not be able to
// disagree about why a loss looks the way it does. They are re-exported here so every reader
// of an account keeps one name for them.
export { LOG_SHAPES, classifyLogLine, classifyLogLines, clientLogLines, describeAppLines } from "./soak-supervisor.mjs";

export const USAGE = `Usage: node scripts/soak-diagnose.mjs [account] [other...] [options]

  account            the directory a downloaded \`soak-account\` artifact unpacks
                     into: ${DEFAULTS.summary}, ${DEFAULTS.history} and ${DEFAULTS.trend},
                     plus ${DEFAULTS.log} — the app's own output — when the artifact carries it
                     (default: .).
  other...           a SECOND account to compare it with, and any further ones: only the
                     facts that are not the same are printed, so a green run and a red one are
                     read against each other instead of as two timelines. TWO accounts are a
                     diff; THREE or more are a SERIES, compared in the order they are named
                     (oldest first), with every fact that moved reported at the run it FIRST
                     changed in. Facts that are the identity of one run (instants, ports,
                     window durations, descriptor readings, and how many connections it
                     happened to serve) are not compared, and the report says so — while what
                     a run COST is, as each phase's median reload and the run's total, measured
                     against the allowances check:soak-trend judges those same numbers with,
                     and what its DOOR did, as RATES rather than as counts: each status's share
                     of the requests the door was offered, its timeouts and its connection
                     errors as shares of the same, the clients in flight per swap that had one,
                     and the clients its swaps lost as a share of the clients those swaps had at
                     the door — that one held to half a client of its sample rather than to the
                     points of mix, so one client lost is a movement at any sample size. The raw
                     request count is the traffic rather than the door (it
                     moved 3 in 60 across three runs of one build while the mix did not move at
                     all), so it is not compared and the report says that too.
                     The exit code is about whether the accounts could be READ, not about
                     whether they agreed.
  --summary <path>   read the summary from here instead of <account>/${DEFAULTS.summary}
  --history <path>   ... the reload history instead of <account>/${DEFAULTS.history}
  --trend <path>     ... the trend file instead of <account>/${DEFAULTS.trend}
  --log <path>       ... the app's own output instead of <account>/${DEFAULTS.log} — where a
                     lost client's own request line is, and the shape that line has is what
                     the report classifies it by
                     (all four name a file of ONE account, so they cannot be used with
                     accounts compared)
  --baseline <path>  compare ONE account's cost against a STORED trend line: the file a
                     soak appends one line per run to, kept across runs. The run is then
                     read against the runs BEFORE it — every phase's median reload and the
                     run's total, against the median of those same numbers in the baseline,
                     under the allowances check:soak-trend judges across runs with — so a
                     single artifact can say how far it drifted. The baseline is the earlier
                     PASSING runs of this run's own profile; this run's own line is not a
                     baseline for itself, and neither is a run that ran elsewhere or did not
                     pass, and each record left out is counted and the reason said. It names
                     a comparison to a file that is not an account, so it needs ONE account
                     and cannot be used with accounts compared.
  --json             write the account (or the comparison) to stdout as one JSON object
                     (the human report goes to stderr).
  -h, --help         this text.

Every reload of the run is printed on the run's own clock, oldest first, with the
problems of the account sitting at the reload they are about — and a swap that cost a
client an answer says WHICH client it was: the ordinal it was handed to the door at, its
place among the clients the swap had at the door, and its place among the clients of the
run it went to. When the account carries the app's own output (${DEFAULTS.log}), that
client's own lines are printed under the loss, found by the same ordinal, and CLASSIFIED —
ANSWERED, NO ANSWER, MIXED or NO LINE AT ALL — because the shape of the log is what says WHY
the loss looks the way it does: an answer that did not come back through the door, a status
the door would not pass, a request the app was handed and never finished, or one that was cut
off before it reached the app at all. Where the app wrote none for it, the report says so
rather than leaving the reader to guess.

It ends with one machine-readable line for a log reader:

  SOAK_DIAGNOSIS=PASS|RED|UNREADABLE files=N reloads=N events=N problems=N

With --baseline it prints a second one, how far the run drifted from the runs before it:

  SOAK_DRIFT=DRIFTED|WITHIN|NOT_COMPARED records=N compared=N differences=N cost=<+Nms|-Nms|?>

...where \`records\` is what the baseline file held, \`compared\` how many of those were a
baseline for this run, and \`cost\` how much more (or less) the run cost in total than that
baseline — or \`?\` when the two could not be compared at all.

With a SECOND account it prints only the facts that are not the same in both — or, with
three or more, every fact that moved, at the run it first moved in — and ends with:

  SOAK_DIFF=SAME|DIFFERENT|UNREADABLE accounts=N differences=N reloads=N/... cost=<+Nms|-Nms|?>

...where \`cost\` is how much MORE (or less) the LAST run's reloads cost in total than the
first's, or \`?\` when the runs could not be compared on cost at all (a trend line missing,
or two different profiles).

Exit codes:
  0  the account was read and carries no problem.
  1  it carries at least one: the soak's own problem, the trend reader's, or a line of
     the account this reader cannot use.
  2  it could not be read: nothing of the account is there, or a file that is there
     cannot be parsed.

With accounts compared it is 0 or 2 only: whether every account could be read, rather
than whether they agreed. With --baseline it is 2 when the file that flag names could not
be read at all, because the comparison asked for could not be made — a baseline that reads
and has nothing of this run's profile to compare is NOT_COMPARED, and the account's own
code stands.`;

/**
 * The command line, as options — or a thrown Error naming what is wrong with it, which
 * the caller turns into usage plus `exit 2`.
 *
 * The positional directories ARE the series, in the order they are given: the first is the
 * one everything is read against (`account`), the second is `against` for the two-account
 * case, and every one of them is in `accounts`. The order is the caller's and never
 * recomputed — see the MANY ACCOUNTS section above for why.
 *
 * @param {string[]} argv
 * @returns {{ account: string, against: string | null, accounts: string[], summary: string | null, history: string | null, trend: string | null, baseline: string | null, json: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const options = { account: ".", against: null, accounts: [], summary: null, history: null, trend: null, log: null, baseline: null, json: false, help: false };
  const named = [];
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
    if (arg === "--summary" || arg === "--history" || arg === "--trend" || arg === "--log" || arg === "--baseline") {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    named.push(arg);
  }
  // One account, or the series of them: a download names its directory, so the order on the
  // command line is the order they are read in.
  options.accounts = named.length > 0 ? named : ["."];
  options.account = options.accounts[0];
  options.against = options.accounts.length > 1 ? options.accounts[1] : null;
  // A file flag names a file of ONE account, and with accounts compared there is no answer
  // to which one it belongs to — refused rather than applied to whichever came first.
  if (
    options.accounts.length > 1 &&
    (options.summary !== null || options.history !== null || options.trend !== null || options.log !== null)
  ) {
    throw new Error("--summary/--history/--trend/--log name a file of ONE account, so they cannot be used when accounts are compared");
  }
  // `--baseline` names a comparison to a stored trend line rather than a file of one account,
  // so with accounts named the comparison IS those accounts, and there is no second answer for
  // a baseline to give — refused rather than applied to whichever run came first.
  if (options.accounts.length > 1 && options.baseline !== null) {
    throw new Error(
      "--baseline compares ONE account's cost against a stored trend line, so it cannot be used when accounts are compared " +
        "(there the accounts are the comparison, one step at a time)",
    );
  }
  return options;
}

/**
 * The three paths to read: the account directory, and any file named over it.
 *
 * A file named with a flag is resolved against the working directory (how a path on a
 * command line reads everywhere else) and the rest against the account.
 *
 * @param {{ account: string, summary: string | null, history: string | null, trend: string | null, log?: string | null }} options
 */
export function accountFiles(options) {
  const dir = resolve(options.account ?? ".");
  return {
    dir,
    summary: options.summary ? resolve(options.summary) : join(dir, DEFAULTS.summary),
    history: options.history ? resolve(options.history) : join(dir, DEFAULTS.history),
    trend: options.trend ? resolve(options.trend) : join(dir, DEFAULTS.trend),
    log: options.log ? resolve(options.log) : join(dir, DEFAULTS.log),
  };
}

/**
 * The account's files as they were found: the text, or why there is none.
 *
 * `not there` and anything else are different answers, and that difference is the whole of
 * the missing-file policy above: a soak that could not be run leaves no summary, so an
 * absent file is reported and the account is read from the rest, while a file that is there
 * and cannot be read at all is one of the ways the account is unreadable.
 *
 * @param {{ dir: string }} files
 * @param {(path: string) => string} readFile
 */
export function readAccount(files, readFile) {
  return KINDS.map((key) => {
    try {
      return { key, path: files[key], text: readFile(files[key]), error: null };
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      return { key, path: files[key], text: null, error: code === "ENOENT" ? "not there" : String(error?.message ?? error) };
    }
  });
}

/**
 * One line of the incident: an instant, the reload it belongs to, and what it says.
 *
 * @typedef {{
 *   atMs: number | null,
 *   when: string | null,
 *   offsetMs: number | null,
 *   who: string,
 *   reload: number | null,
 *   kind: "event" | "problem" | "note",
 *   text: string,
 * }} TimelineEvent
 */

/** An instant as its ISO string, or null when the value names none. */
const instant = (value) => {
  const at = Date.parse(String(value ?? ""));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

/**
 * An instant the account writes as a NUMBER of milliseconds (`swapsAtTheDoor[].at`, a clock the
 * soak read off a record) or as an ISO string (`swappedAt`, the same instant as the record
 * writes it), as the milliseconds both name — or null when the value names neither.
 *
 * The two spellings have to be reconciled for the swap and the reload that has it to be matched
 * at all, and a comparison of the number against its own ISO string would silently find nothing
 * and leave every account reading as one whose losses are unplaced.
 */
const swapInstant = (value) => {
  const ms = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : null;
};

/** The JSONL records of a file, or a thrown Error naming the line that is not JSON. */
function parseJsonLines(text, path) {
  const records = [];
  const lines = String(text).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${path}: line ${index + 1} is not JSON (${error.message})`);
    }
  }
  return records;
}

/**
 * One reload of the run, from whichever of the three files names it.
 *
 * The summary is the spine when it is there: it carries every reload with its clocks and
 * its held connection. Without it, the trend line's `held` entries are (one per reload,
 * with the `index` a claim is read by), and failing that the history's records (one per
 * reload, in the order the soak asked for them, with no phase and no held facts — the
 * account simply does not carry them). Each row is then matched to its history record by
 * the instant the reload was asked (`startedAt`, which both files take from the same
 * record, so the match is exact), and by order only for a row that does not carry one.
 *
 * @param {{ summary?: any, trend?: any, history?: { records: any[], unreadable: any[] } | null }} account
 */
export function reloadRows({ summary, trend, history }) {
  const records = history?.records ?? [];
  const rows = [];
  const detail = Array.isArray(summary?.reloadsDetail) ? summary.reloadsDetail : [];
  if (detail.length > 0) {
    for (const reload of detail) {
      rows.push({
        from: "summary",
        index: reload.index ?? rows.length + 1,
        phase: reload.phase ?? "?",
        outcome: reload.outcome ?? null,
        startedAt: reload.startedAt ?? null,
        landedAt: reload.landedAt ?? null,
        swappedAt: reload.swappedAt ?? null,
        closedBy: reload.closedBy ?? null,
        served: reload.served ?? null,
        checks: reload.checks ?? null,
        windowUsedMs: reload.windowUsedMs ?? null,
        replacementPort: reload.replacementPort ?? null,
        retiredPort: reload.retiredPort ?? null,
        retiredPortFree: reload.retiredPortFree ?? null,
        descendants: reload.descendants ?? null,
        handles: reload.handles ?? null,
        // ALWAYS an object on a run of this soak's own build, and absent on a record
        // written before the field existed — which the timeline says rather than
        // rendering as a hold with no facts.
        held: reload.held === undefined ? null : reload.held,
      });
    }
  } else {
    for (const [position, entry] of (Array.isArray(trend?.held) ? trend.held : []).entries()) {
      rows.push({
        from: "trend",
        index: entry.index ?? position + 1,
        phase: entry.phase ?? "?",
        outcome: null,
        held: { ...entry },
        retiredPort: entry.retiredPort ?? null,
        startedAt: null,
        landedAt: null,
        swappedAt: null,
        closedBy: null,
        served: null,
        checks: null,
        windowUsedMs: null,
        replacementPort: null,
        retiredPortFree: null,
        descendants: null,
        handles: null,
      });
    }
  }
  if (rows.length === 0) {
    for (const [position, entry] of records.entries()) {
      rows.push({
        from: "history",
        index: position + 1,
        phase: "?",
        outcome: entry.record.outcome ?? null,
        startedAt: entry.record.startedAt ?? null,
        landedAt: entry.record.at ?? null,
        swappedAt: entry.record.swappedAt ?? null,
        closedBy: entry.record.closedBy ?? null,
        served: entry.record.served ?? null,
        checks: entry.record.checks ?? null,
        windowUsedMs: entry.record.windowUsedMs ?? null,
        replacementPort: entry.record.replacementPort ?? null,
        retiredPort: entry.record.previousPort ?? null,
        retiredPortFree: null,
        descendants: null,
        handles: null,
        held: null,
      });
    }
  }

  // The record each row is the summary OF, whose evidence sentence and `detail` the
  // timeline prints. Matched by the instant the reload was asked, and by order only for
  // rows and records that name NO instant — a *missing* record is left missing rather
  // than filled in from the next one along, because a record pinned on the wrong reload
  // prints another reload's window, evidence and detail against it, and that is the one
  // kind of mistake a diagnosis command must not make.
  const used = new Set();
  const byStarted = new Map();
  for (const entry of records) {
    const started = instant(entry.record.startedAt);
    if (started !== null && !byStarted.has(started)) byStarted.set(started, entry);
  }
  for (const row of rows) {
    const started = instant(row.startedAt);
    const entry = started === null ? undefined : byStarted.get(started);
    if (entry === undefined || used.has(entry)) continue;
    used.add(entry);
    row.record = entry.record;
    // The clocks the summary does not carry per reload are the record's own.
    row.startedAt ??= entry.record.startedAt ?? null;
    row.landedAt ??= entry.record.at ?? null;
    row.swappedAt ??= entry.record.swappedAt ?? null;
    row.closedBy ??= entry.record.closedBy ?? null;
    row.served ??= entry.record.served ?? null;
    row.checks ??= entry.record.checks ?? null;
    row.windowUsedMs ??= entry.record.windowUsedMs ?? null;
    row.replacementPort ??= entry.record.replacementPort ?? null;
    row.retiredPort ??= entry.record.previousPort ?? null;
    row.outcome ??= entry.record.outcome ?? null;
  }
  // Then the rows that name no instant at all, against the records that name none
  // either, in the order both were written — the only pairing order can be trusted for.
  const instants = records.filter((entry) => instant(entry.record.startedAt) === null && !used.has(entry));
  for (const row of rows) {
    if (row.record !== undefined || instant(row.startedAt) !== null) continue;
    const entry = instants.shift();
    if (entry === undefined) continue;
    used.add(entry);
    row.record = entry.record;
    row.landedAt ??= entry.record.at ?? null;
    row.swappedAt ??= entry.record.swappedAt ?? null;
    row.closedBy ??= entry.record.closedBy ?? null;
    row.outcome ??= entry.record.outcome ?? null;
  }

  // Each reload's own swap, as the summary's per-swap evidence block: what the door did to the
  // clients that had the port in their hands while it changed hands, and — for each one it cost
  // — WHICH client of them it was, which is the one thing a count cannot say (`spent`, whose
  // `client` is the handle the client was handed to the door at, and `describeSpent` for the two
  // places that loss can be named by). A block is matched by the
  // instant the port changed hands, which the summary and the record both take from the same
  // record, so the match is exact and two reloads cannot swap each other's losses; a row whose
  // instant the account does not name is matched by index, the way the records above are, and
  // only where the two agree on it. A summary written before this evidence existed carries no
  // blocks at all — so a row left with none is left with NONE rather than an empty swap that
  // would read as a swap that cost nothing (see `reloadEvents`).
  const blocks = Array.isArray(summary?.swapsAtTheDoor) ? summary.swapsAtTheDoor : [];
  const bySwapAt = new Map();
  for (const [position, block] of blocks.entries()) {
    const at = swapInstant(block?.at);
    if (at !== null && !bySwapAt.has(at)) bySwapAt.set(at, position);
  }
  const claimed = new Set();
  for (const row of rows) {
    const at = swapInstant(row.swappedAt);
    if (at === null) continue;
    const position = bySwapAt.get(at);
    if (position === undefined || claimed.has(position)) continue;
    claimed.add(position);
    row.swap = blocks[position];
  }
  for (const row of rows) {
    if (row.swap !== undefined) continue;
    const position = blocks.findIndex((block, index) => !claimed.has(index) && block?.index === row.index);
    if (position === -1) continue;
    claimed.add(position);
    row.swap = blocks[position];
  }
  return rows;
}

/**
 * What the account says about the connection the soak held through this reload's swap, as the
 * clause the swap's own line carries when the account names no instant for it.
 *
 * A record written before the instants existed (`acceptedAt`, `answered`) has the facts and no
 * clock for them, and its own lines would put them somewhere they did not happen; the swap is
 * where the hold belongs then, so this is what `holdEvents` falls back to.
 */
function holdClauses(row) {
  const held = row.held;
  if (held === null) {
    return ", with no held-connection facts in the account (a record written before the field existed carries none)";
  }
  if (held.accepted !== true) {
    return `, and NO connection could be held through the door across it (${held.endedReason ?? "it was never accepted"})`;
  }
  const on = row.retiredPort === null || row.retiredPort === undefined ? "the run it piped it to" : `the run it piped it to, port ${row.retiredPort}`;
  // A hold that carries no answers THIS READER reads is not a hold that says it was answered
  // nothing: the two are different answers to the same question, and only one of them is a
  // fact. Which it is comes from the block's own shape marker (`answersOf`), and it is named
  // here so an older account is read as an older account rather than silently as a quiet one.
  const answers = answersOf(held);
  if (answers === null) {
    const shape =
      held.shape === undefined || held.shape === null
        ? "it carries no shape marker, which is the hold written before the marker existed"
        : `it is in ${JSON.stringify(held.shape)}, a shape this reader does not know`;
    return `, with a client's connection held through the door on ${on}, and no per-answer facts in the account (${shape}; this reader reads answers from ${HELD_SHAPE})`;
  }
  if (answers.length === 0) {
    return `, with a client's connection held through the door on ${on}, and nothing was ever said to it while it was held`;
  }
  const statuses = answers.map((answer) => answer?.status ?? "?");
  return (
    `, with a client's connection held through the door on ${on}, and ${statuses.length} answer(s) (${statuses.join("/")}) ` +
    `arriving ${held.answeredBeforeSwap === true ? "BEFORE the port changed hands, while that run was still serving" : "after the port had changed hands"}`
  );
}

/**
 * The held connection's own lines, at the instants the account names for them.
 *
 * The instants are facts of the connection rather than of the reload, and the account carries
 * them per reload: when the door ACCEPTED it (the soak opens the hold before it even asks for
 * the reload, so this is usually the first thing a reload's stretch of the timeline shows) and
 * when each answer arrived, each answer carrying its own status and instant. So an answer is
 * placed where it happened and read against the instant the port changed hands, rather than
 * being folded into a clause that can only say "before" or "after" in aggregate.
 *
 * `placed` says whether that was possible: a record written before the instants existed has
 * the same facts and no clock for them, and the swap's line carries them instead (see
 * `holdClauses`). The record's own aggregate flag is still what qualifies an answer when the
 * account does not carry the swap instant — a trend line names a reload by its held connection
 * and no clocks at all — so the relation is never guessed.
 *
 * Which answers these are comes from the block's own shape marker (`answersOf`): a hold in
 * another shape is not placed at all, rather than being read as a hold that was answered
 * nothing.
 *
 * @param {ReturnType<typeof reloadRows>[number]} row
 * @returns {{ events: { atMs: number, text: string }[], placed: boolean }}
 */
export function holdEvents(row) {
  const events = [];
  const held = row.held;
  if (held === null) return { events, placed: false };
  const answered = answersOf(held);
  const acceptedAt = Date.parse(String(held.acceptedAt ?? ""));
  const refusedAt = Date.parse(String(held.endedAt ?? ""));
  const placed = answered !== null && (held.accepted === true ? Number.isFinite(acceptedAt) : Number.isFinite(refusedAt));
  if (!placed) return { events, placed: false };
  const swapped = Date.parse(String(row.swappedAt ?? ""));
  const on = row.retiredPort === null || row.retiredPort === undefined ? "the run it piped it to" : `the run it piped it to, port ${row.retiredPort}`;
  if (held.accepted !== true) {
    events.push({
      atMs: refusedAt,
      text: `the connection the soak opened to the door for this reload was never accepted (${held.endedReason ?? "it was never accepted"})`,
    });
    return { events, placed: true };
  }
  events.push({
    atMs: acceptedAt,
    text:
      `a client's connection was held through the door on ${on}` +
      (answered.length === 0 ? ", and nothing was ever said to it while it was held" : ""),
  });
  for (const answer of answered) {
    const at = Date.parse(String(answer?.at ?? ""));
    if (!Number.isFinite(at)) continue;
    const before = Number.isFinite(swapped) ? at < swapped : held.answeredBeforeSwap === true;
    events.push({
      atMs: at,
      text:
        `the connection held across the swap was answered ${answer?.status ?? "?"} — ` +
        (before
          ? "BEFORE the port changed hands, while the run it was piped to was still serving"
          : "after the port had changed hands"),
    });
  }
  return { events, placed: true };
}

/** What the account says about the last thing asked of the held connection, as a clause. */
function afterStopClause(held) {
  const answer = held?.afterStop;
  if (typeof answer !== "string") return "";
  if (answer === "503") {
    return "; the last thing asked of it was answered 503 — the door's refusal for a connection whose run has gone";
  }
  if (/^[1-5]\d\d$/.test(answer)) {
    return `; the last thing asked of it was answered ${answer} after the run it was piped to had been stopped`;
  }
  return `; the last thing asked of it was never answered (${answer.startsWith("!") ? answer.slice(1) : answer})`;
}

/** The reload's own evidence: the record's sentence when the account has the record. */
function evidenceOf(row) {
  if (row.record) return reloadEvidence(row.record);
  const window =
    row.swappedAt === null || row.swappedAt === undefined
      ? "no window was ever open"
      : `window ${row.windowUsedMs ?? "?"}ms, closed by ${row.closedBy ?? "-"}`;
  return `${window}; ${row.served ?? 0} real connection(s) from the app, ${row.checks ?? 0} health check(s)`;
}

/**
 * The events of one reload, in the order it lived through them.
 *
 * Every one is a fact the account already carries, put where it happened: the connection the
 * soak held opening (before the reload was even asked for) or failing to open, each answer to
 * it, asked, the port changing hands — with WHICH client that swap cost, when it cost one (`the
 * swap cost 1 client(s): the 63rd client handed to the door (`_client=63` in the app's own request
 * log) — the 2nd of the 5 client(s) the swap had at the door — the 1st of the 3 client(s) the run
 * this swap retired (port 4123) was handed`) — the connection's ending, the instant the door took
 * the count it reports, and the reload concluding — plus what the soak looked for afterwards and
 * what the supervisor's own record says about how it ended. They are ordered by that instant
 * rather than by the order they are written here, because the ending of a connection that ended
 * before the door took its count happened before it, and a timeline that says otherwise is worse
 * than no timeline.
 *
 * The cost of a swap is the one fact a count cannot carry, so it is read through the same
 * `describeSpent` the soak's own per-swap account is written with (scripts/soak-supervisor.mjs)
 * rather than spelled again here: which client it was of the clients the swap had AT THE DOOR,
 * and which one it was of the clients the run it handed them to was handed — plus the NAME that
 * client is the same one by, the ordinal it was handed to the door at (`nameSpent`), which is what
 * the app's own request log keys it by. The second place is the one a failure is usually about,
 * and the account can only give it when it names both ends of that run's tenure, which the summary
 * does — so a loss named in a downloaded account carries both, and the same loss on the watch's
 * one-swap evidence carries the first alone.
 *
 * A loss is also FOLLOWED, when the account carries the app's own output: the client's own
 * lines are printed under the loss, found by the same ordinal (see `clientLogLines`), so the
 * report does not stop at "which client" but shows what the app said to it — or says that the
 * app wrote nothing for it, which is what a client cut off before its answer looks like from
 * the app's side and is a different fact from a log the reader was not given.
 *
 * …and those lines are CLASSIFIED, because WHICH shape they are is what says why the loss looks
 * the way it does (see `classifyLogLines`): an ANSWERED client was finished by the app, so the
 * loss is an answer that did not come back through the door or a status the door would not pass;
 * an UNANSWERED one was handed to the app and never finished, so the connection ended under it;
 * and an ABSENT one never became a line at all, so it was cut off at the door before the app was
 * handed it. "The app has no line for it" and "the app has a line with no answer" are two
 * different failures, and a report that printed both as "nothing" would be naming one thing
 * where the log distinguishes two.
 *
 * @param {ReturnType<typeof reloadRows>[number]} row
 * @param {{ log?: string | null }} [account] the app's own output, when the account carries it
 */
export function reloadEvents(row, { log = null } = {}) {
  const events = [];
  const push = (at, text) => events.push({ atMs: at, text });
  const started = Date.parse(String(row.startedAt ?? ""));
  const swapped = Date.parse(String(row.swappedAt ?? ""));
  const landed = Date.parse(String(row.landedAt ?? ""));
  const asked = row.record?.asked ?? null;

  // The hold first, because it is opened first: the soak connects through the door and keeps
  // the connection before it asks for the reload, so the door is holding it while the run it
  // is piped to is still the one serving. Where the account names no instants for any of that
  // (a record written before they existed) nothing is placed, and the swap's line says it all.
  const hold = holdEvents(row);
  for (const event of hold.events) push(event.atMs, event.text);
  if (Number.isFinite(started)) push(started, `asked for the reload${typeof asked === "string" ? ` (by ${asked})` : ""}`);
  if (Number.isFinite(swapped)) {
    const from = row.retiredPort ?? null;
    const to = row.replacementPort ?? null;
    const ports =
      from !== null && to !== null
        ? `: port ${from} → ${to}`
        : from !== null
          ? `: the run in port ${from} stopped being it`
          : to !== null
            ? `: the replacement is in port ${to}`
            : "";
    push(swapped, `the port changed hands${ports}${hold.placed ? "" : holdClauses(row)}`);
  } else if (!hold.placed && hold.events.length === 0) {
    // No swap instant to hang the hold's facts on, and none of their own: the one thing left
    // to say is that the account does not carry them.
    push(null, holdClauses(row).replace(/^, /, ""));
  }
  // WHICH client the swap cost, at the instant the port changed hands — the reading a count
  // cannot give (the handle it can be looked up by and where it was, see `nameSpent`), placed
  // where it happened rather than at the reload's
  // conclusion, because the client had the door in its hands when it happened. Nothing is said
  // when the swap cost nothing: the count is printed either way (the run's own `problems`, and
  // the verdict line), and a second reading of a zero is a line about nothing.
  const spent = Array.isArray(row.swap?.spent) ? row.swap.spent : null;
  const lostAtTheSwap = Number(row.swap?.lost);
  if (spent !== null && spent.length > 0) {
    push(
      Number.isFinite(swapped) ? swapped : null,
      `the swap cost ${spent.length} client(s): ${spent.map(nameSpent).join("; ")}`,
    );
    // …and what the app itself said to that client, at the same instant, from the app's own
    // output in this account: the request line carrying the ordinal the loss was named with.
    // A loss the account names no ordinal for has nothing to look up, which is the absence the
    // loss line already spoke; an account with no log at all gets one run-level note instead of
    // a line per loss repeating that it has none (see `diagnoseAccount`).
    for (const entry of spent) {
      // The gaps the WATCH saw when it read this loss (`spent[].app.gaps`) are part of the account:
      // a log that was rotated or truncated under the watch is still the same file in the
      // artifact, and a line missing from it now is missing for the same reason it was then. Read
      // with those gaps, the account says `UNSEEN` where the watch said it rather than calling the
      // absence the app's afterwards.
      const gaps = Array.isArray(entry?.app?.gaps) ? entry.app.gaps : [];
      const found = clientLogLines(log, entry?.client, { gaps });
      if (found === null) continue;
      push(
        Number.isFinite(swapped) ? swapped : null,
        found.total === 0 && found.classification.shape !== "unseen"
          ? `the app's own log (${DEFAULTS.log}) carries no line for this client — the run wrote no answer for it, and the ` +
              "request never became a line at all, so it was cut off at the door before the app was handed it, which is " +
              "what a client lost at the swap looks like from the app's side"
          : describeAppLines(found, DEFAULTS.log),
      );
    }
  } else if (spent === null && Number.isFinite(lostAtTheSwap) && lostAtTheSwap > 0) {
    // Two different silences, said apart: an evidence block that lost nothing carries an empty
    // list, and one that lost a client it cannot place carries an entry saying so — while a
    // block written before the field existed carries no list at all, and this is that one.
    push(
      Number.isFinite(swapped) ? swapped : null,
      `the swap cost ${lostAtTheSwap} client(s), and which client each one was is not in this account (a summary written ` +
        "before a swap's evidence named its losses carries the count alone)",
    );
  }
  // The door's own number, at the instant the record's arithmetic names for it (the swap
  // plus the window the reload used, which is `leftoverCountInstant`'s reading). An account
  // that carries the count without those two clocks — a trend line names a reload by its
  // held connection and nothing else — still gets the line, without an instant, rather than
  // losing the number a door claim is about.
  const leftover = row.held === null ? null : row.held.leftoverConnections;
  const window = Number(row.windowUsedMs);
  if (Number.isInteger(leftover)) {
    const retired = row.retiredPort === null || row.retiredPort === undefined ? "" : ` (port ${row.retiredPort})`;
    push(
      Number.isFinite(swapped) && Number.isFinite(window) && window >= 0 ? swapped + window : null,
      `the door took its count on the run it retired${retired}: ${leftover} connection(s) still on it, and the connection ` +
        `it held across the swap ${
          row.held.endedBeforeCount === true
            ? "had already ended by then, so the count does not speak for it"
            : "was still open, so the count does"
        }`,
    );
  }
  const ended = Date.parse(String(row.held?.endedAt ?? ""));
  if (row.held !== null && row.held.accepted === true && Number.isFinite(ended)) {
    push(
      ended,
      `the connection held across the swap ended (${row.held.endedReason ?? "?"})` +
        (row.held.endedBeforeSwap === true ? ", before the port changed hands" : "") +
        (row.held.runGaveUp === true ? " — the run gave up on the request head it never received the end of (408)" : "") +
        afterStopClause(row.held),
    );
  }

  const verdict = verdictFor(row.outcome);
  const outcome =
    row.outcome === null
      ? "this reload's own outcome is not in the account (a run's outcomes are counted, not listed per reload)"
      : verdict === null
        ? `an outcome this reader does not know (${JSON.stringify(row.outcome)}) — the vocabulary is declared in src/lib/deploy/reload-history.ts`
        : `${verdict.word} — ${verdict.why}`;
  const left = [];
  if (row.retiredPortFree === false) left.push(`the run it retired STILL HOLDS PORT ${row.retiredPort}`);
  else if (row.retiredPortFree === true && row.retiredPort !== null) left.push(`the run it retired left port ${row.retiredPort} free`);
  if (Number.isFinite(row.descendants)) left.push(`${row.descendants} descendant process(es)`);
  if (Number.isFinite(row.handles)) left.push(`${row.handles} descriptor(s)`);
  // A reload whose account carries no clock, no outcome and no record has nothing to
  // conclude with, and a "concluded" line invented for it would be the one thing in this
  // report that is not a fact — so there is none (the trend line alone names a reload by
  // its held connection and nothing else, which is what that account is).
  if (Number.isFinite(landed) || row.outcome !== null || row.record !== undefined) {
    push(
      Number.isFinite(landed) ? landed : null,
      `reload concluded: ${outcome} (${evidenceOf(row)})` +
        (row.swappedAt === null || row.swappedAt === undefined ? ", and the record names no instant the port changed hands" : "") +
        (left.length > 0 ? `; afterwards: ${left.join(", ")}` : "") +
        (typeof row.record?.detail === "string" && row.record.detail !== "" ? `; the record says: ${row.record.detail}` : ""),
    );
  }

  // By instant, with an instant the account does not name kept where it was written
  // rather than sorted off the end of the reload it belongs to.
  return events
    .map((event, order) => ({ ...event, order }))
    .sort((a, b) => {
      const left = Number.isFinite(a.atMs) ? a.atMs : Infinity;
      const right = Number.isFinite(b.atMs) ? b.atMs : Infinity;
      return left === right ? a.order - b.order : left - right;
    });
}

/**
 * A downloaded `soak-account`, read as one incident: what was in it, what happened, and
 * what of it is a problem.
 *
 * @param {{ files: { key: string, path: string, text: string | null, error: string | null }[], dir?: string | null }} account
 */
export function diagnoseAccount({ files, dir = null }) {
  // Problems that belong to no reload: a line of the history this reader cannot use. And
  // `reading`, the notes about the READING itself — a file that is not there, a record
  // from another vocabulary — which are NOTE lines on the timeline like every other note,
  // rather than remarks printed nowhere.
  const fileProblems = [];
  const reading = [];
  const unreadable = [];
  const report = [];
  let summary = null;
  let trend = null;
  let history = null;
  // The app's own output, when the account carries it — the file a lost client is followed into.
  let log = null;

  for (const file of files) {
    if (file.error === "not there") {
      report.push({ key: file.key, path: file.path, present: false, detail: "not there" });
      continue;
    }
    if (file.error !== null) {
      report.push({ key: file.key, path: file.path, present: true, detail: `could not be read: ${file.error}` });
      unreadable.push(`${file.path}: ${file.error}`);
      continue;
    }
    const text = String(file.text ?? "");
    if (file.key === "summary") {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        report.push({ key: file.key, path: file.path, present: true, detail: `could not be read: ${error.message}` });
        unreadable.push(`${file.path}: not JSON (${error.message})`);
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        report.push({ key: file.key, path: file.path, present: true, detail: "could not be read: not a summary object" });
        unreadable.push(`${file.path}: not a summary object`);
        continue;
      }
      summary = parsed;
    } else if (file.key === "trend") {
      try {
        trend = parseJsonLines(text, file.path);
      } catch (error) {
        report.push({ key: file.key, path: file.path, present: true, detail: `could not be read: ${error.message}` });
        unreadable.push(error.message);
        continue;
      }
    } else if (file.key === "log") {
      // Plain text, so there is nothing to refuse: the app's own output is read as it stands,
      // and what of it names a client is decided at the point of use rather than parsed here.
      // What is counted here is only what the header says it holds — the lines that carry a
      // client's ordinal, and how many clients those are — so a reader can see that a loss has
      // somewhere to be followed to before reading a line of the timeline.
      log = { path: file.path, text };
      const clients = new Set();
      let named = 0;
      for (const line of text.split("\n")) {
        const match = /[?&]_client=(\d+)(?:&|\s|$)/.exec(line);
        if (match === null) continue;
        named += 1;
        clients.add(match[1]);
      }
      report.push({
        key: file.key,
        path: file.path,
        present: true,
        detail: `${named} line(s) naming a client, ${clients.size} distinct client(s)`,
      });
      continue;
    } else {
      history = parseReloadHistory(text);
      for (const line of history.unreadable) {
        fileProblems.push(`${file.path} line ${line.line}: a line of the account this reader cannot use (${line.reason})`);
      }
      for (const entry of history.records) {
        if (entry.record.schema !== RELOAD_HISTORY_SCHEMA) {
          reading.push(
            `${file.path} line ${entry.line}: the record carries schema ${JSON.stringify(entry.record.schema ?? null)} where this ` +
              `reader reads ${RELOAD_HISTORY_SCHEMA} — it is shown as it stands rather than judged`,
          );
        }
      }
    }
    report.push({ key: file.key, path: file.path, present: true, detail: null });
  }

  // THE RUN: when it concluded, and which of the trend file's lines is its own. A file
  // that accumulates across runs (a kept `--trend`) can carry other runs, and judging one
  // of those as this run would be diagnosing somebody else's soak.
  const at = instant(summary?.at) ?? instant(lastOf(trend)?.at) ?? instant(lastOf(history?.records)?.record?.at);
  const schemaRecords = (trend ?? []).filter((record) => record && record.schema === SOAK_TREND_SCHEMA);
  const own = at === null ? schemaRecords.slice(-1) : schemaRecords.filter((record) => instant(record.at) === at);
  const trendRecord = own.length > 0 ? own[own.length - 1] : null;
  if (schemaRecords.length === 0 && (trend ?? []).length > 0) {
    reading.push(`no line of the trend file is a record in ${SOAK_TREND_SCHEMA}, so what the run cost is not read`);
  } else if (own.length === 0 && schemaRecords.length > 0) {
    reading.push(
      `the trend file's ${schemaRecords.length} record(s) are from other runs (the newest is at ` +
        `${schemaRecords[schemaRecords.length - 1].at}), so what this run cost is not read from it`,
    );
  }

  const rows = reloadRows({ summary, trend: trendRecord, history });
  if (summary === null && trendRecord === null && rows.length === 0 && unreadable.length === 0) {
    unreadable.push(
      "nothing of the account is there (a soak that could not be run writes no summary and no trend line either — the job " +
        "log says what the runner said)",
    );
  }

  // THE TIMELINE: each reload's events in the order it lived through them (which is the
  // run's order — the soak asks for the next reload only once the last one's record has
  // landed), the problems the soak named sitting at the reload they are about, and then
  // the run's own lines: what names no reload, and the trend's reading of the run.
  /** @type {TimelineEvent[]} */
  const events = [];
  // The run's own account of what it found: the summary's two lists, or — when the summary
  // is not there — the trend line's, which carries the same two by projection (that is what
  // makes a run whose summary never got written still diagnosable from its line).
  const runProblems = Array.isArray(summary?.problems) ? summary.problems : Array.isArray(trendRecord?.problems) ? trendRecord.problems : [];
  const runNotes = Array.isArray(summary?.notes) ? summary.notes : Array.isArray(trendRecord?.notes) ? trendRecord.notes : [];
  if (summary === null && trendRecord !== null && runProblems.length + runNotes.length > 0) {
    reading.push("the run's own problems and notes are read from its trend line, which carries them because the summary is not there");
  }
  const runLevel = reading.map((text) => ({ level: "note", text }));
  const problemsByReload = new Map();
  for (const problem of runProblems) {
    if (typeof problem !== "string") continue;
    const named = /^reload (\d+) \(/.exec(problem);
    if (named) {
      const index = Number(named[1]);
      problemsByReload.set(index, [...(problemsByReload.get(index) ?? []), problem]);
    } else {
      runLevel.push({ level: "problem", text: problem });
    }
  }
  for (const note of runNotes) {
    if (typeof note === "string") runLevel.push({ level: "note", text: note });
  }

  // The trend line, judged by the reader that judges it in CI — including the lines it
  // writes about a red run's held connections (`heldNotes`), which are the trend half of
  // the same door claim the summary makes.
  const judgment = trendRecord === null ? null : judgeSoakTrend([trendRecord]);
  if (judgment !== null) {
    for (const line of judgment.judged) runLevel.push({ level: "event", text: `what the run cost: ${line}`, from: "trend" });
    for (const line of judgment.skipped) runLevel.push({ level: "note", text: `not judged: ${line}`, from: "trend" });
    for (const line of judgment.notes) runLevel.push({ level: "note", text: line, from: "trend" });
    for (const line of judgment.problems) runLevel.push({ level: "problem", text: line, from: "trend" });
  }

  for (const row of rows) {
    const who = `reload ${row.index} (${row.phase})`;
    const landed = Date.parse(String(row.landedAt ?? row.startedAt ?? ""));
    /** @type {TimelineEvent[]} */
    const mine = reloadEvents(row, { log: log === null ? null : log.text }).map((event) => ({
      atMs: event.atMs,
      when: null,
      offsetMs: null,
      who,
      reload: row.index,
      kind: "event",
      text: event.text,
    }));
    for (const problem of problemsByReload.get(row.index) ?? []) {
      mine.push({ atMs: Number.isFinite(landed) ? landed : null, when: null, offsetMs: null, who, reload: row.index, kind: "problem", text: problem });
    }
    if (row.outcome !== null && verdictFor(row.outcome) === null) {
      mine.push({
        atMs: Number.isFinite(landed) ? landed : null,
        when: null,
        offsetMs: null,
        who,
        reload: row.index,
        kind: "note",
        text: `the account names an outcome this reader does not know (${JSON.stringify(row.outcome)}) — a newer supervisor's vocabulary, read as it stands`,
      });
    }
    // The reload's own lines in the order its instants put them in, so a problem sits
    // where the reload reached it rather than after everything the reload did, and a line
    // with no instant is kept where it was written.
    events.push(
      ...mine
        .map((event, order) => ({ event, order }))
        .sort((a, b) => {
          const left = Number.isFinite(a.event.atMs) ? a.event.atMs : Infinity;
          const right = Number.isFinite(b.event.atMs) ? b.event.atMs : Infinity;
          return left === right ? a.order - b.order : left - right;
        })
        .map(({ event }) => event),
    );
  }

  // What names no reload is the run's own, and it belongs at the run's own instant — the
  // end of it. An account that names no instant at all still shows them, unclocked.
  const runAt = at === null ? null : Date.parse(at);
  for (const line of runLevel) {
    events.push({
      atMs: runAt,
      who: line.from === "trend" ? "trend" : "the run",
      reload: null,
      kind: line.level,
      text: line.text,
    });
  }

  // The problems, read off the timeline rather than gathered a second time: every
  // PROBLEM line the account produced is one, wherever it came from — the soak's own, the
  // reload it named, or the trend reader's — and then the lines of the history this reader
  // cannot use, which belong to no reload (the soak carries them too when it could, but a
  // summary that is not there leaves them nobody else's).
  // The problems, in the order the account names them: the run's own first — that is the
  // headline the soak would give, and the first line of this report quotes it — then what
  // the trend reader added, then the lines of the history this reader cannot use. Every
  // one of them is also a PROBLEM line on the timeline, at the reload it is about.
  const problems = [
    ...runProblems.filter((problem) => typeof problem === "string"),
    ...(judgment?.problems ?? []),
    ...fileProblems,
  ];
  const notes = events.filter((event) => event.kind === "note").map((event) => event.text);

  const base = events.reduce((first, event) => (Number.isFinite(event.atMs) && (first === null || event.atMs < first) ? event.atMs : first), null);
  for (const event of events) {
    event.when = Number.isFinite(event.atMs) ? new Date(event.atMs).toISOString().slice(11, 23) : null;
    event.offsetMs = base === null || !Number.isFinite(event.atMs) ? null : event.atMs - base;
  }

  return {
    verdict: unreadable.length > 0 ? "UNREADABLE" : problems.length > 0 ? "RED" : "PASS",
    dir,
    at,
    base,
    files: report,
    summary,
    trendRecord,
    history,
    reloads: rows,
    events,
    problems,
    notes,
    unreadable,
    // Filled in only when a stored baseline is named (see `baselineComparison`): an account
    // read on its own has nothing to have drifted FROM, and `null` says that rather than an
    // empty reading that would have to be told apart from a comparison that found nothing.
    drift: null,
  };
}

/** The last element of a list, or undefined — read by the run-instant fallbacks above. */
function lastOf(list) {
  return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : undefined;
}

/** What one of the three files held, as the header line for it. */
function describeFile(file, diagnosis) {
  if (file.detail !== null) return file.detail;
  if (file.key === "summary") {
    const profile = diagnosis.summary?.profile;
    return (
      `${diagnosis.summary?.verdict ?? "?"} at ${diagnosis.summary?.at ?? "?"}, ` +
      `${diagnosis.summary?.performed ?? "?"}/${diagnosis.summary?.reloads ?? "?"} reload(s), ` +
      `profile ${profile ? `${profile.platform}/${profile.arch}/${profile.node}` : "?"}, front port ${diagnosis.summary?.frontPort ?? "?"}`
    );
  }
  if (file.key === "history") {
    const records = diagnosis.history?.records?.length ?? 0;
    const unusable = diagnosis.history?.unreadable?.length ?? 0;
    return `${records} record(s), ${unusable} line(s) this reader cannot use`;
  }
  if (diagnosis.trendRecord === null) return "no line of it is this run's";
  return `${diagnosis.trendRecord.schema} at ${diagnosis.trendRecord.at} (${diagnosis.trendRecord.verdict ?? "?"})`;
}

/** The verdict, in one line, with what it rests on. */
function describeVerdict(diagnosis) {
  if (diagnosis.verdict === "UNREADABLE") {
    return `could not be read — ${diagnosis.unreadable[0] ?? "nothing of the account is there"}`;
  }
  if (diagnosis.problems.length === 0) {
    return `PASS — ${diagnosis.reloads.length} reload(s), and nothing in the account is a problem`;
  }
  return `RED — ${diagnosis.problems.length} problem(s): ${diagnosis.problems[0]}`;
}

/** `T+1234ms`, `T-40ms`, or `T+?` for a line the account puts on no clock. */
function offsetLabel(event) {
  if (event.offsetMs === null) return "T+?";
  const ms = Math.round(event.offsetMs);
  return ms >= 0 ? `T+${ms}ms` : `T-${Math.abs(ms)}ms`;
}

/**
 * The baseline half of one account's report: what the file held, what of it was a baseline for
 * this run, and the cost facts that moved beyond what the runs before it allow.
 *
 * The direction is named once, at the head of the facts, because a lone account has no
 * `first`/`second` for a reader to hold a `->` against: the value on the left is the BASELINE,
 * the one on the right is this run.
 */
function driftLines(drift) {
  const lines = [];
  const head = [`BASELINE — ${drift.path}`];
  if (drift.records > 0) {
    head.push(
      `${drift.records} record(s), ${drift.compared} of them a baseline for this run${drift.profile === null ? "" : ` (${drift.profile})`}`,
    );
  }
  lines.push("");
  lines.push(head.join(", "));
  for (const note of drift.notes) lines.push(`  NOTE ${note}`);
  for (const skip of drift.skips) lines.push(`  not compared: ${skip}`);
  if (drift.compared > 0) {
    lines.push("");
    if (drift.differences.length === 0) {
      lines.push(`  the run's cost is within what the ${drift.compared} run(s) before it allow — each phase's median and the run's total`);
    } else {
      lines.push(`DRIFTED — ${drift.differences.length} cost fact(s), the baseline before it  ->  this run`);
      lines.push("");
      const width = drift.differences.reduce((max, difference) => Math.max(max, difference.field.length), 0);
      for (const difference of drift.differences) {
        lines.push(`    ${difference.field.padEnd(width)}  ${showDifference(difference)}`);
      }
    }
  }
  return lines;
}

/**
 * The drift, as the machine-readable line a log reader takes.
 *
 * `NOT_COMPARED` is about the READING (a baseline with nothing of this run's profile in it, a
 * run with no trend line of its own, a file that could not be read) rather than about the
 * answer, which is what keeps `DRIFTED` usable in a pipeline the way `DIFFERENT` is.
 */
function driftLine(drift) {
  const verdict = drift.compared === 0 ? "NOT_COMPARED" : drift.differences.length > 0 ? "DRIFTED" : "WITHIN";
  return (
    `SOAK_DRIFT=${verdict} records=${drift.records} compared=${drift.compared} ` +
    `differences=${drift.differences.length} cost=${drift.cost === null || drift.cost === undefined ? "?" : `${signed(drift.cost)}ms`}`
  );
}

/** The human report: the header, then every line of the incident in order. */
export function renderDiagnosis(diagnosis) {
  const lines = [];
  lines.push(`soak-account: ${diagnosis.dir ?? "(the files named)"}`);
  for (const file of diagnosis.files) {
    lines.push(`  ${file.key.padEnd(8)} ${file.path} — ${describeFile(file, diagnosis)}`);
  }
  lines.push(`  verdict  ${describeVerdict(diagnosis)}`);
  lines.push("");
  lines.push(
    `TIMELINE — ${diagnosis.events.length} line(s) over ${diagnosis.reloads.length} reload(s), ` +
      `T+0 at ${diagnosis.base === null ? "an instant the account does not name" : new Date(diagnosis.base).toISOString()} (UTC)`,
  );
  const offsets = diagnosis.events.map((event) => offsetLabel(event).padStart(9));
  const whens = diagnosis.events.map((event) => event.when ?? "--:--:--.---");
  const whos = diagnosis.events.map((event) => event.who ?? "the run");
  const whoWidth = whos.reduce((max, value) => Math.max(max, value.length), 0);
  const labels = diagnosis.events.map((event) => (event.kind === "problem" ? "PROBLEM" : event.kind === "note" ? "NOTE" : ""));
  diagnosis.events.forEach((event, index) => {
    lines.push(`  ${offsets[index]}  ${whens[index]}  ${whos[index].padEnd(whoWidth)}  ${labels[index].padEnd(7)} ${event.text}`);
  });
  if (diagnosis.events.length === 0) lines.push("  (nothing in the account is on a clock)");
  // The baseline, when one was named: what the run drifted to, before the machine lines, so
  // the prose and the tokens end the report together.
  if (diagnosis.drift) lines.push(...driftLines(diagnosis.drift));
  lines.push("");
  lines.push(
    `SOAK_DIAGNOSIS=${diagnosis.verdict} files=${diagnosis.files.filter((file) => file.present).length} ` +
      `reloads=${diagnosis.reloads.length} events=${diagnosis.events.length} problems=${diagnosis.problems.length}`,
  );
  if (diagnosis.drift) lines.push(driftLine(diagnosis.drift));
  return lines;
}

// ---------------------------------------------------------------------------------------
// TWO ACCOUNTS: what changed between them
// ---------------------------------------------------------------------------------------

/**
 * One fact that is not the same in two consecutive runs.
 *
 * `changed` carries both sides; `added` and `removed` carry the one side that has it, which is
 * how a LIST MEMBER only one of the two has is reported — as itself, rather than as one end of
 * a list that is different. A whole fact that is simply NOT THERE in one of the two (a reload
 * the other run never performed, a phase whose median one of them does not name) is a
 * `changed` fact whose absent side prints as `(none)`, so one fact reads one way in a pair and
 * in a series of many.
 *
 * `run` is the position of the LATER run of the step a difference was found in, and `runs`
 * every position this exact change also happened at again — both 1-based, both filled in by
 * whoever knows where the step sits (`diffAccounts` for a pair, `seriesAccounts` for a
 * series). A pair never prints them: with two runs every difference happened at the second,
 * and naming it says nothing a reader did not already know.
 *
 * @typedef {{
 *   field: string,
 *   op: "changed" | "added" | "removed",
 *   a?: unknown,
 *   b?: unknown,
 *   value?: unknown,
 *   run?: number,
 *   runs?: number[],
 * }} Difference
 */

/**
 * `platform/arch/node`, the three things two runs have to agree about to be comparable.
 *
 * Carried as a COMPARED fact rather than a caveat, because two accounts from different
 * engines or machines are still worth diffing — the differences are real — but a reader has
 * to be able to see that the machines differ before believing a timing-shaped one.
 */
function profileLabel(diagnosis) {
  const profile = diagnosis.summary?.profile ?? diagnosis.trendRecord?.profile ?? null;
  if (profile === null || profile === undefined) return null;
  return `${profile.platform ?? "?"}/${profile.arch ?? "?"}/${profile.node ?? "?"}`;
}

/** Two values of a compared fact, equal as facts (lists compared member by member). */
function sameFact(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

/**
 * The facts of a comparison, walked as name → value maps so the comparison is one loop.
 *
 * A LIST is diffed by MEMBER rather than as a whole value: "a problem was added" is the
 * fact a reader wants, and "the problem list changed from [p1, p2] to [p2]" is the same
 * fact with the answer hidden inside it. So `problems`, `notes`, `unreadable` and the
 * statuses of a hold's answers all come out as `added`/`removed` lines, one per entry.
 *
 * @param {Record<string, unknown>} from the account on the left
 * @param {Record<string, unknown>} to the account on the right
 * @param {Difference[]} out
 * @param {string} [prefix] the field names are the hold's, spelled `held.<name>`
 */
function compareFacts(from, to, out, prefix = "") {
  for (const name of Object.keys(from)) {
    const left = from[name];
    const right = to[name];
    if (sameFact(left, right)) continue;
    const field = `${prefix}${name}`;
    if (Array.isArray(left) && Array.isArray(right)) {
      for (const value of left.filter((entry) => !right.includes(entry))) out.push({ field, op: "removed", value });
      for (const value of right.filter((entry) => !left.includes(entry))) out.push({ field, op: "added", value });
      continue;
    }
    out.push({ field, op: "changed", a: left, b: right });
  }
}

/**
 * The run-level facts two runs can be compared on, as name → value.
 *
 * What a file is, is its PRESENCE rather than its path: the two accounts are unpacked into
 * two different directories, so the paths always differ and comparing them would put three
 * lines at the top of every diff that say nothing. `not there` and `could not be read:` are
 * carried as they are, because which of those it was is the fact.
 */
function runFacts(diagnosis) {
  const presence = Object.fromEntries(diagnosis.files.map((file) => [file.key, file.present ? "present" : file.detail]));
  const facts = {
    verdict: diagnosis.verdict,
    profile: profileLabel(diagnosis),
    reloads: diagnosis.reloads.length,
  };
  for (const key of KINDS) facts[`file ${DEFAULTS[key]}`] = presence[key] ?? "not named";
  facts.problems = diagnosis.problems;
  facts.notes = diagnosis.notes;
  facts.unreadable = diagnosis.unreadable;
  return facts;
}

/**
 * The reload-level facts two runs can be compared on, as name → value.
 *
 * `served` and `checks` are deliberately NOT here, and the reason is measured rather than
 * argued: two real three-reload soaks of one build, compared through this function's first
 * version, differed by exactly one fact — reload 1 served 8 connections in one run and 7 in
 * the other. How many connections arrived inside a window is a fact of the traffic and the
 * window's length, not of what the app did, so it is the noise that teaches a reader to skim
 * a diff. What the traffic MEANT is the run's `problems`, and how the window ENDED is
 * `closedBy`, which is compared.
 */
function reloadFacts(row) {
  return {
    phase: row.phase,
    outcome: row.outcome,
    closedBy: row.closedBy,
  };
}

/**
 * The held connection's comparable facts, as name → value.
 *
 * The block is compared field by field rather than as a whole, because that is the question:
 * whether the door took the connection at all, what was said to it, when it ended. Its shape
 * MARKER is a compared fact like any other — two accounts in different shapes are compared
 * with that visible instead of one of them quietly reading as a quiet hold — and `answered`
 * is read through `answersOf`, the same gate the two readers use, so a shape this reader
 * does not know gives `(none)` rather than an empty list it would be inventing.
 *
 * An answer's own instant is deliberately not compared: it is a clock, and the two runs are
 * on two of them. WHAT was said to the connection is the comparable fact.
 */
function heldFacts(held) {
  const answers = answersOf(held);
  return {
    shape: held?.shape ?? null,
    accepted: held?.accepted ?? null,
    answered: answers === null ? null : answers.map((answer) => answer?.status ?? "?"),
    answeredBeforeSwap: held?.answeredBeforeSwap ?? null,
    endedReason: held?.endedReason ?? null,
    endedBeforeSwap: held?.endedBeforeSwap ?? null,
    endedBeforeCount: held?.endedBeforeCount ?? null,
    runGaveUp: held?.runGaveUp ?? null,
    afterStop: held?.afterStop ?? null,
    leftoverConnections: held?.leftoverConnections ?? null,
  };
}

/**
 * A hold as one FACT, for when a run carries no block to compare field by field: the shape it
 * is in, or the plain statement that there are no such facts. That is deliberately not the
 * same answer as a hold that was answered nothing (`answers: []`), and not a hold in an
 * unknown shape either — three different things that three different readers must keep
 * apart. Nothing here names a side of the comparison, so the line reads the same in a pair
 * and in a series.
 */
function heldLabel(held) {
  if (held === null || held === undefined) return "no held-connection facts";
  return `a hold in ${held.shape === undefined || held.shape === null ? "an unmarked shape" : JSON.stringify(held.shape)}`;
}

/**
 * What a run COST, as the numbers `check:soak-trend` reads across runs: the median of each
 * phase's reload cells and the run's total over every reload it performed.
 *
 * Read from the trend line rather than re-derived from the reload rows, and not by
 * preference: that line is the file whose job is to carry what a run cost (`durations`,
 * written by `trendRecord` in scripts/soak-supervisor.mjs), and it is where the gate reads
 * the same two numbers from — so a diff and the gate cannot disagree about what a run cost.
 * An account with no such line has no cost to compare and says so, rather than costing
 * nothing.
 *
 * @param {ReturnType<typeof diagnoseAccount>} diagnosis
 * @returns {{ phases: Map<string, number>, total: number } | null}
 */
function costReadings(diagnosis) {
  const durations = diagnosis.trendRecord?.durations;
  if (durations === null || durations === undefined || typeof durations !== "object") return null;
  const phases = new Map();
  let total = 0;
  for (const phase of Object.keys(durations)) {
    const values = (Array.isArray(durations[phase]) ? durations[phase] : []).filter((value) => Number.isFinite(value));
    if (values.length === 0) continue;
    phases.set(phase, median(values));
    for (const value of values) total += value;
  }
  return total > 0 ? { phases, total } : null;
}

/** A movement, as the sign a reader needs to see on it. */
const signed = (value) => (value > 0 ? `+${value}` : String(value));

/**
 * The cost side of two accounts, read the way `check:soak-trend` reads cost across runs.
 *
 * A duration is not the identity of ONE run the way a port or an instant is — it is the thing
 * a regression shows up in, which is exactly why it is worth comparing — but two readings of
 * one are not equal either, so comparing them as raw facts would put a line in every diff and
 * teach a reader to skim. What makes a movement a fact here is the allowance the gate already
 * carries for the same comparison (a quarter of a phase's median or 2s, a fifth of the run's
 * total or 10s), read from that file rather than second-guessed here, and only a movement PAST
 * it is reported — in either direction, because a run that came out faster is a difference
 * too, whatever it means.
 *
 * The profiles have to agree first. Two machines are not two measurements of one thing, which
 * is the same reason the gate refuses this comparison across profiles, so a pair that ran
 * elsewhere is REPORTED as not compared rather than diffed on noise.
 *
 * @param {ReturnType<typeof diagnoseAccount>} a the account on the left
 * @param {ReturnType<typeof diagnoseAccount>} b the account on the right
 * @param {string[]} skips what could not be compared, appended to
 * @returns {{ differences: Difference[], delta: number | null }} the cost facts that moved,
 *   and how much more (or less) the second run cost in total — null when there was nothing
 *   to read a cost from
 */
function costComparison(a, b, skips) {
  const left = costReadings(a);
  const right = costReadings(b);
  if (left === null || right === null) {
    // Which side it is missing from is NOT said: the file set is one of the compared facts, so
    // the report's own `file soak-trend.jsonl` line says it — and with its RUN when the
    // comparison is a series, which a side of a step cannot do.
    skips.push(
      left === null && right === null
        ? "the cost side: neither account left a trend line, and that is the file that names what a run cost"
        : "the cost side: a trend line is missing on one side, and that is the file that names what a run cost",
    );
    return { differences: [], delta: null };
  }
  const profileA = profileKey(a.trendRecord?.profile);
  const profileB = profileKey(b.trendRecord?.profile);
  if (profileA === null || profileB === null) {
    skips.push(
      "the cost side: a record that names no profile names no machine or engine, and its timings are not two " +
        "measurements of one thing",
    );
    return { differences: [], delta: null };
  }
  if (profileA !== profileB) {
    skips.push(
      `the cost side: the two ran on different profiles (${profileA} against ${profileB}), and two machines are ` +
        "not two measurements of one thing",
    );
    return { differences: [], delta: null };
  }

  return costDifferences(left, right);
}

/**
 * Two cost readings, as the facts that moved between them — the arithmetic BOTH the pair
 * comparison and the baseline comparison are made of, so the two cannot disagree about what a
 * movement past an allowance is.
 *
 * `earlier` is the number a run is read against (the one run before it in a pair, the median
 * of the runs before it against a stored baseline) and `now` is the run itself; a reading is
 * what `costReadings` returns, or what `baselineReadings` reduces a file of runs to.
 *
 * `delta` is null when either side names no total at all: a cost that is not there is not a
 * cost of zero, and a machine line reading `+0ms` for it would be the report inventing one.
 *
 * @param {{ phases: Map<string, number>, total: number | null }} earlier
 * @param {{ phases: Map<string, number>, total: number | null }} now
 * @returns {{ differences: Difference[], delta: number | null }}
 */
function costDifferences(earlier, now) {
  const { durationRatio, durationAllowanceMs, totalRatio, totalAllowanceMs } = TREND_BUDGETS;
  const differences = /** @type {Difference[]} */ ([]);
  for (const phase of [...new Set([...earlier.phases.keys(), ...now.phases.keys()])].sort()) {
    const before = earlier.phases.get(phase);
    const after = now.phases.get(phase);
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
      // A phase whose median one of the two does not name is a fact that is NOT THERE rather
      // than a different number, and `(none)` is this report's word for that everywhere: it is
      // what keeps the same fact readable at step 2 of a pair and at step 5 of a series.
      differences.push({
        field: `${phase} median`,
        op: "changed",
        a: Number.isFinite(before) ? `${before}ms` : null,
        b: Number.isFinite(after) ? `${after}ms` : null,
      });
      continue;
    }
    const allowed = Math.max(durationAllowanceMs, Math.round(before * durationRatio));
    if (Math.abs(after - before) > allowed) {
      differences.push({
        field: `${phase} median`,
        op: "changed",
        a: `${before}ms`,
        b: `${after}ms (${signed(after - before)}ms, more than the ${allowed}ms allowed)`,
      });
    }
  }
  if (Number.isFinite(earlier.total) && Number.isFinite(now.total)) {
    const allowed = Math.max(totalAllowanceMs, Math.round(earlier.total * totalRatio));
    if (Math.abs(now.total - earlier.total) > allowed) {
      differences.push({
        field: "total cost",
        op: "changed",
        a: `${earlier.total}ms`,
        b: `${now.total}ms (${signed(now.total - earlier.total)}ms, more than the ${allowed}ms allowed)`,
      });
    }
  }
  const delta = Number.isFinite(earlier.total) && Number.isFinite(now.total) ? now.total - earlier.total : null;
  return { differences, delta };
}

/**
 * A run's cost as ONE number: every reload cell in its trend record, summed — the same sum
 * `check:soak-trend` makes of the same field (`costOf`, in its across-runs half), so "the run's
 * total" means one thing in both readers.
 */
function costOf(record) {
  return Object.values(record?.durations ?? {})
    .flat()
    .reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

/**
 * What a movement in the door's RATES has to clear before it is called one, and why those
 * numbers — MEASURED, as the cost side's allowances are.
 *
 * Three soaks of one build on one machine, five reloads each with four-second windows, against
 * the fixture server the suite soaks (`tests/fixtures/prod-death-server.mjs`), counted 61, 59
 * and 62 requests through the front door and served 61, 59 and 62 of them 200: the RAW count
 * moved by three between runs of the same build while the RATE did not move at all (100.0% in
 * each of the three), which is the whole reason this comparison is made in rates. Three
 * requests in sixty is five percentage points, so a movement that size is the traffic rather
 * than the door, and that is the whole allowance for a share: a share is already a proportion,
 * so there is no scale left to correct for, and the numbers a reader needs to discount a thin
 * sample are printed beside every rate. A client is the unit that can move at the swap and a
 * run has only a handful of them, so the mean in flight takes half a client.
 *
 * Those same three runs read `timeouts` 0.0%, `connection errors` 0.0% and `clients in flight`
 * 0.00 in every one of them — which is the other half of the measurement: on a build that
 * works the door's failures are not a level the traffic wobbles around, they are absent, so
 * anything that appears at all is worth a reader's eye once it clears the floor.
 *
 * A LOST CLIENT is read against the clients each swap had AT THE DOOR rather than against the
 * traffic or against the clients in flight, because that is the set the loss is counted among: the
 * soak's own per-swap account says "N client(s) at the door ... L lost", and the band is wider than
 * the instant, so a client answered inside the window but after the port changed hands was at the
 * door and never in flight — dividing losses by the in-flight count would read a loss off a sample
 * that never held it, and can read it as more than all of the clients that mean was over.
 *
 * It does NOT share the floor above. A loss is held to HALF A CLIENT of the sample it was counted
 * among, because a client is the unit the door's promise is made in ("a swap may not cost a client
 * its answer") and this is the rate with the denominator to say it in: five points of mix knows
 * nothing about how many clients a run had, and would get LOOSER as the sample grows, which is the
 * wrong way round for a promise made per client — one client of three is 33.3 points and three
 * clients of a hundred and twenty is 2.5, so the loss a large sample can hide is exactly the one
 * the traffic's own wobble would call nothing.
 *
 * The half is taken of a client of the LARGER of the two runs' samples, and that is the point of
 * the rule rather than a detail of it: one client lost in the run with more of them moves the rate
 * by the LEAST (`1/N`), so half of that step sits UNDER every single client either run can lose, and
 * a client the door cost its answer is a movement at ANY sample size. Half a client of the run with
 * FEWER clients is the other candidate, and it fails that promise exactly where the two differ: a
 * client lost among forty (2.5 points) beside a run of three would have to clear a floor of 16.7
 * points and would read as nothing at all. `doorAllowance` is where that is decided.
 *
 * None of that makes the loss a GATE: the soak already raises one on the run that carries it, so a
 * run that lost a client did not pass, and this line is the MAGNITUDE of that finding rather than
 * the finding. What the allowance decides is only whether a reader of two runs is shown it.
 */
const DOOR = { pointsFloor: 0.05, clientFloor: 0.5 };

/**
 * The clients the swaps had at the door — the sample a LOST client is counted among, and the one
 * fact of the door that is judged in CLIENTS rather than in points of mix (see `DOOR`).
 */
const DOOR_CLIENTS = "clientsAtTheDoor";

/**
 * The door's counters, as the run wrote them.
 *
 * Read from the trend line's `door` block first — the same file the cost side is read from, and
 * a projection of the summary written by `trendRecord`, so the two cannot disagree — and from
 * the summary itself when there is no such line, which is where those counters are measured in
 * the first place.
 *
 * The two client facts (how many clients the swaps had at the door, and how many of them were
 * lost) are read by name from whichever source that is when it names them, and summed from its own
 * per-swap detail when it does not: the trend line carries the aggregates and no swaps, the summary
 * carries the swaps, and a record written before a field existed carries neither. Every fact comes
 * from ONE record — a rate is never one run's count over another run's clients.
 *
 * A record that names no traffic at all (an account from before the field existed, or a run
 * whose door never saw a request) has no counters to read a rate from, and `null` says that
 * rather than an account with a door that answered nothing — three zero-counts and a hundred
 * shares of nothing are not the same fact. A single MISSING field is the other case and is
 * `null` on its own: a record that does not name its losses does not say there were none.
 *
 * @param {ReturnType<typeof diagnoseAccount>} diagnosis
 * @returns {{ requests: number, byStatus: Record<string, number>, timeouts: number | null, connectionErrors: number | null, swapsWithAClient: number | null, clientsInFlight: number | null, clientsAtTheDoor: number | null, lost: number | null } | null}
 */
function doorCounts(diagnosis) {
  const block = diagnosis.trendRecord?.door;
  const from = block !== null && block !== undefined && typeof block === "object" && Number.isFinite(block.requests) ? block : diagnosis.summary;
  if (from === null || from === undefined || typeof from !== "object") return null;
  const requests = Number.isFinite(from.requests) ? from.requests : null;
  if (requests === null || requests <= 0) return null;
  // A record that carries the swaps themselves (a summary) is summed where the facts are; one that
  // carries the projection (a trend line) is read by name. A swap whose own number is missing adds
  // nothing rather than a zero it never measured.
  const swaps = Array.isArray(from.swapsAtTheDoor) ? from.swapsAtTheDoor : null;
  const overSwaps = (of) =>
    swaps === null ? null : swaps.reduce((total, swap) => total + (Number.isFinite(swap?.[of]) ? swap[of] : 0), 0);
  const named = (field) => (Number.isFinite(from[field]) ? from[field] : null);
  return {
    requests,
    byStatus: from.byStatus !== null && typeof from.byStatus === "object" ? from.byStatus : {},
    timeouts: Number.isFinite(from.timeouts) ? from.timeouts : null,
    connectionErrors: Number.isFinite(from.connectionErrors) ? from.connectionErrors : null,
    swapsWithAClient: Number.isFinite(from.swapsWithAClient) ? from.swapsWithAClient : null,
    clientsInFlight: Number.isFinite(from.clientsInFlight) ? from.clientsInFlight : null,
    // How many clients the swaps had at the door (each swap's own band): the sample a loss is a
    // share OF, and a fact in its own right — a swap with no client at it is a reload that never
    // exercised what the door does to one, which the soak says for itself.
    clientsAtTheDoor: named("clientsAtTheDoor") ?? overSwaps("band"),
    // ...and how many of those the door cost an answer, which is the soak's own count and the
    // numerator of the rate below.
    lost: named("lost") ?? overSwaps("lost"),
  };
}

/** One of those counters as the rate it is compared as, or null when it has no denominator. */
const share = (value, of) => (Number.isFinite(value) && Number.isFinite(of) && of > 0 ? value / of : null);

/**
 * The door's counters as RATES, which is the only form two runs of different traffic can be
 * compared in.
 *
 * Every one of them is a share of what the door was OFFERED rather than a count of what
 * happened, and each is carried with the counts it was divided from, so a reader can see the
 * sample a percentage came from instead of trusting the percentage.
 *
 * Only the door's own ANSWERS are statuses here. The soak counts a failure at the connection
 * under a `!` key of the same map (`!timeout`, `!no status line`), and those are compared by the
 * `timeouts` and `connection errors` lines below — one fact, one line, rather than the same
 * failures reported twice at two denominators.
 *
 * `clients in flight` is a mean rather than a share (per swap that had a client at the door),
 * because that is the denominator the question has — but normalised all the same, which is what
 * lets two runs with different numbers of reloads be read against each other.
 *
 * `clients lost` is a share of the clients the swaps had AT THE DOOR, which is the set the soak
 * counts a loss among (see `DOOR`): of the clients that were there for a port change, how many it
 * cost an answer. A record that does not name its losses is SKIPPED rather than read as none — a
 * run that lost nothing and a run whose account never spoke are not the same fact — while a record
 * that names `lost: 0` is the zero it is, out of the clients it had. It is the one percent fact
 * judged in CLIENTS rather than in points of mix — half a client of the sample it was counted among
 * (`doorAllowance`) — which is why the fact carries that sample by name rather than by default.
 *
 * Every share carries the SAMPLE it was divided by (`sample`), because a share a record does not
 * name at all has to be read as zero out of that run's own sample rather than out of a count that
 * belongs to something else (`absentShare`): answers are shares of the traffic, a loss is a share
 * of the clients at the door.
 *
 * @param {ReturnType<typeof doorCounts>} counts
 * @returns {Map<string, { rate: number | null, count: number | null, of: number | null, percent: boolean, sample: string }>}
 */
function doorRates(counts) {
  const facts = new Map();
  for (const [key, value] of Object.entries(counts.byStatus)) {
    if (!/^\d{3}$/.test(key)) continue;
    facts.set(`status ${key}`, { rate: share(value, counts.requests), count: value, of: counts.requests, percent: true, sample: "requests" });
  }
  for (const [field, value] of [
    ["timeouts", counts.timeouts],
    ["connection errors", counts.connectionErrors],
  ]) {
    if (value === null) continue;
    facts.set(field, { rate: share(value, counts.requests), count: value, of: counts.requests, percent: true, sample: "requests" });
  }
  if (counts.lost !== null) {
    facts.set("clients lost", {
      rate: share(counts.lost, counts.clientsAtTheDoor),
      count: counts.lost,
      of: counts.clientsAtTheDoor,
      percent: true,
      sample: DOOR_CLIENTS,
    });
  }
  facts.set("clients in flight", {
    rate: share(counts.clientsInFlight, counts.swapsWithAClient),
    count: counts.clientsInFlight,
    of: counts.swapsWithAClient,
    percent: false,
    sample: "swapsWithAClient",
  });
  return facts;
}

/**
 * A SHARE a run's record does not name at all, read as the zero it is: the door gave no such
 * answer, or cost no client its answer, out of what that run itself offered.
 *
 * The zero is divided by the MISSING run's own sample for that fact — `sample`, which every share
 * carries, rather than the traffic by default: no answer out of the requests it was offered, and no
 * client lost out of the clients its own swaps had at the door. The sample belongs to the run being
 * read, so a rate can never be one run's count over another run's traffic or clients.
 *
 * `undefined` for a fact that is not a share (the mean in flight), which is NOT THERE rather than
 * zero.
 */
function absentShare(other, counts) {
  if (other === undefined || !other.percent) return undefined;
  const of = Number.isFinite(counts?.[other.sample]) ? counts[other.sample] : null;
  return { rate: of === null || of <= 0 ? null : 0, count: 0, of, percent: true, sample: other.sample };
}

/** A rate as it is printed, with the counts it was read from — or null when there is no rate. */
function showRate(fact) {
  if (fact === undefined || fact === null || fact.rate === null) return null;
  const value = fact.percent ? `${(fact.rate * 100).toFixed(1)}%` : fact.rate.toFixed(2);
  return `${value} (${fact.count ?? "?"}/${fact.of ?? "?"})`;
}

/** A rate's magnitude, in its own unit: percentage points, or clients per swap. */
const rateValue = (value, percent) => (percent ? (value * 100).toFixed(1) : value.toFixed(2));

/** ...and with the sign a movement has to carry, since a rate can move either way. */
const signedRate = (value, percent) => `${value > 0 ? "+" : value < 0 ? "-" : ""}${rateValue(Math.abs(value), percent)}`;

/**
 * The allowance a DOOR fact is judged by, and the unit it was taken in.
 *
 * Which rule applies is read from what the fact is a share OF — the SAMPLE it was divided by —
 * rather than from what the fact is called, because that is what fixes what one unit of it is
 * worth:
 *
 *   - a fact measured over the TRAFFIC keeps `DOOR.pointsFloor`: how much traffic arrived is the
 *     generator's business, and three requests in sixty is the wobble that floor was measured at.
 *   - `clients lost` is measured over the CLIENTS the swaps had at the door, so it takes
 *     `DOOR.clientFloor` — half a client — as a share of the sample: half of a client of the LARGER
 *     of the two runs' samples, for the reason `DOOR` gives (a client is worth least there, so half
 *     of it is under every single client either run can lose).
 *   - the mean in flight is not a share at all (it is clients per swap), so half a client is
 *     already in its own unit and is taken as it stands.
 *
 * The unit comes back with the number so the line can say where its allowance came from, rather
 * than leaving a reader to work out what one client of that sample was worth. It is empty where
 * there is nothing to explain: five points of mix is one fixed allowance on every line that carries
 * it, and a mean's half a client is already the unit its own rate is printed in.
 *
 * Both rates were read before this is asked, so a fact reaches it with a sample on each side that is
 * a count and positive — `share` gives no rate at all from a denominator that is not one, and a fact
 * with no rate has no allowance to be judged by (`doorComparison` reports those on their own).
 *
 * @param {{ sample: string, of: number | null, percent: boolean }} fact one run's reading of a fact
 * @param {number | null} otherOf the other run's sample for the same fact
 * @returns {{ allowance: number, unit: string }}
 */
function doorAllowance(fact, otherOf) {
  if (fact.sample !== DOOR_CLIENTS) {
    return fact.percent ? { allowance: DOOR.pointsFloor, unit: "" } : { allowance: DOOR.clientFloor, unit: "" };
  }
  const sample = Math.max(fact.of, otherOf);
  return {
    allowance: DOOR.clientFloor / sample,
    unit: ` — half a client of the ${sample} at the door, where a whole one is worth ${rateValue(1 / sample, true)} points`,
  };
}

/**
 * The door's counters of two runs, compared as rates.
 *
 * The allowance is `DOOR`'s, which was measured (see there): a share of the traffic is judged by the
 * movement the traffic itself makes, a mean in flight by half a client, and a LOST client by half a
 * client of the sample it was counted among (`doorAllowance`).
 *
 * A STATUS one run never saw is read as the zero it is rather than as a missing fact — the door
 * counts every answer it gives, so a status absent from that map is one it never gave, and
 * saying it was never given is exactly the fact (a 503 that appeared where there were none). The
 * same rule reads the LOSSES of a run whose record names them (a run that lost nothing out of the
 * clients it had is a zero, not a silence) and does not invent one for a record that never named
 * them. A MEAN with no denominator is the other case and is genuinely NOT THERE — a run whose swaps
 * had no client at the door has no clients in flight to have a mean of — printed as `(none)`, which
 * is the same rule the cost side follows for a phase median only one of the two names. A share with
 * no denominator (a loss against no clients at the door, a record that names one and not the other)
 * prints that way too, which is why the counts beside every rate are its denominator and not a
 * footnote.
 *
 * @param {ReturnType<typeof diagnoseAccount>} a the run on the left
 * @param {ReturnType<typeof diagnoseAccount>} b the run on the right
 * @param {string[]} skips what could not be compared, appended to
 * @returns {{ differences: Difference[] }}
 */
function doorComparison(a, b, skips) {
  const left = doorCounts(a);
  const right = doorCounts(b);
  if (left === null || right === null) {
    skips.push(
      left === null && right === null
        ? "the door's counters: neither account left a door count, so there is no traffic to read a rate from"
        : "the door's counters: one of the two accounts left no door count, and a rate needs the traffic of both runs",
    );
    return { differences: [] };
  }
  const from = doorRates(left);
  const to = doorRates(right);
  const differences = /** @type {Difference[]} */ ([]);
  for (const field of [...new Set([...from.keys(), ...to.keys()])].sort()) {
    const earlier = from.get(field) ?? absentShare(to.get(field), left);
    const now = to.get(field) ?? absentShare(from.get(field), right);
    const before = showRate(earlier);
    const after = showRate(now);
    if (before === after) continue;
    if (before === null || after === null) {
      differences.push({ field, op: "changed", a: before, b: after });
      continue;
    }
    const percent = earlier.percent;
    // The allowance is read from the two runs' own samples and the movement from their rates as
    // they were divided, not from the rounded numbers the line prints: a loss of 2.5% is judged as
    // 2.5 points, against half a client of the 120 it was counted among (0.4167, printed 0.4).
    const { allowance, unit } = doorAllowance(earlier, now.of);
    const moved = now.rate - earlier.rate;
    if (Math.abs(moved) <= allowance) continue;
    differences.push({
      field,
      op: "changed",
      a: before,
      b: `${after} (${signedRate(moved, percent)}${percent ? " points" : ""}, more than the ${rateValue(allowance, percent)}${percent ? " points" : ""} allowed${unit})`,
    });
  }
  return { differences };
}

/**
 * A stored trend line, reduced to the baseline a run is read against.
 *
 * What comes out is the same SHAPE a single run's cost is read in (`costReadings`), which is
 * what lets the comparison itself be the one arithmetic above: a phase's median is the median
 * of the medians the baseline's records each read, and the total is the median of their
 * totals — the across-runs half of `check:soak-trend`, in its words and its filters.
 *
 * Three records are NOT a baseline, and each is counted and said rather than quietly dropped:
 * a line that is not a record in this schema with a timestamp (nothing to read), an earlier run
 * on ANOTHER profile (two machines are not two measurements of one thing), and a run that did
 * not PASS (a run that leaked must not become what normal looks like — and the numbers of a
 * run that stopped read as the numbers of a fast one). THIS RUN'S OWN LINE is not one either:
 * a trend file kept across runs has the run's own line in it, and a run is not a baseline for
 * itself. It is recognised by the instant the run carries, which is the same fact
 * `diagnoseAccount` reads its own record by, and named when it is found so a reader knows the
 * file they named is the file this run appended to.
 *
 * @param {Record<string, any>[]} records every line of the baseline file, in file order
 * @param {{ profile: string | null, at: string | null, path: string }} where what to compare
 *   against, the instant of the run being measured, and the file's name for the messages
 * @param {string[]} notes what was left out of the baseline, and why, appended to
 * @param {string[]} skips why the baseline cannot be compared at all, appended to
 * @returns {{ phases: Map<string, number> | null, total: number | null, runs: number }}
 */
function baselineReadings(records, { profile, at, path }, notes, skips) {
  const usable = records.filter(
    (record) => record && record.schema === SOAK_TREND_SCHEMA && Number.isFinite(Date.parse(record.at ?? "")),
  );
  const unreadable = records.length - usable.length;
  if (unreadable > 0) {
    notes.push(`${unreadable} line(s) of the baseline are not records in ${SOAK_TREND_SCHEMA} with a timestamp this reader can read, and are not a baseline`);
  }
  const own = usable.filter((record) => instant(record.at) === at);
  if (own.length > 0) {
    notes.push(
      `the baseline file carries this run's own line (at ${own[own.length - 1].at}), which is not a baseline for itself — ` +
        "a trend file kept across runs has the run that just finished in it, beside the runs before it",
    );
  }
  const others = usable.filter((record) => !own.includes(record));
  const elsewhere = others.filter((record) => profileKey(record.profile) !== profile);
  if (elsewhere.length > 0) {
    notes.push(
      `${elsewhere.length} earlier record(s) of the baseline ran on another profile (${profile} is the profile being compared), ` +
        "and two machines are not two measurements of one thing",
    );
  }
  const sameMachine = others.filter((record) => profileKey(record.profile) === profile);
  const failed = sameMachine.filter((record) => record.verdict !== "PASS");
  if (failed.length > 0) {
    notes.push(
      `${failed.length} earlier record(s) of the baseline did not pass, and are not a baseline: a run that leaked must not become ` +
        "what normal looks like, and the numbers of a run that stopped read as the numbers of a fast one",
    );
  }
  const baseline = sameMachine.filter((record) => record.verdict === "PASS");
  if (baseline.length === 0) {
    skips.push(`the baseline: ${path} carries no earlier passing run of ${profile} to read this run against`);
    return { phases: null, total: null, runs: 0 };
  }
  if (baseline.length < TREND_BUDGETS.minBaseline) {
    notes.push(
      `the baseline is ${baseline.length} run(s), and check:soak-trend judges across runs only from ${TREND_BUDGETS.minBaseline}: ` +
        "a median of two runs is a coin toss — the drift below is that reading rather than the gate's answer",
    );
  }
  const phases = new Map();
  for (const phase of new Set(baseline.flatMap((record) => Object.keys(record.durations ?? {})))) {
    const earlier = median(baseline.map((record) => median(record.durations?.[phase] ?? [])).filter(Number.isFinite));
    if (earlier !== null) phases.set(phase, earlier);
  }
  const total = median(baseline.map(costOf).filter((value) => value > 0));
  return { phases, total, runs: baseline.length };
}

/**
 * ONE account against a stored baseline trend line: how far the run drifted from the runs
 * before it.
 *
 * This is the comparison a single artifact cannot otherwise make — the whole point of the
 * baseline — and it is read the way `check:soak-trend` reads a run across runs rather than by a
 * rule of this command's own: the same two numbers (each phase's median reload, the run's
 * total), against the same baseline (the earlier passing runs of this profile), under the same
 * allowances. A run with no trend line of its own has no cost to measure and says that; a
 * run whose record names no profile names no machine, and a timing is not comparable with one
 * that did not say where it was measured.
 *
 * The run's own VERDICT does not stop the reading, and the difference from the gate is
 * deliberate: `check-soak-trend` refuses to judge a run that did not pass, because there a
 * number is about to become the answer of a gate — while here the artifact in hand is a red
 * run being diagnosed, and a red run that got slower is exactly the finding a person came for.
 * So a red run is measured and the caveat is named on the report.
 *
 * @param {ReturnType<typeof diagnoseAccount>} diagnosis the run to measure
 * @param {Record<string, any>[]} records every line of the baseline file
 * @param {string} path the baseline file, as the command line named it
 * @returns {{
 *   path: string,
 *   records: number,
 *   compared: number,
 *   profile: string | null,
 *   differences: Difference[],
 *   cost: number | null,
 *   notes: string[],
 *   skips: string[],
 * }}
 */
export function baselineComparison(diagnosis, records, path) {
  const notes = [];
  const skips = [];
  const key = profileKey(diagnosis.trendRecord?.profile);
  const drift = {
    path,
    records: records.length,
    compared: 0,
    profile: key,
    differences: /** @type {Difference[]} */ ([]),
    cost: null,
    notes,
    skips,
  };
  const now = costReadings(diagnosis);
  // The trend line first, because it is the file the question is asked of: without one there is
  // no record of what the run cost, and the profile it would have named is a second thing the
  // account does not carry rather than the first answer to give.
  if (now === null) {
    skips.push("the baseline: this run left no trend line, and that is the file that names what a run cost");
    return drift;
  }
  if (key === null) {
    skips.push("the baseline: this run's record names no profile, so its timings are not two measurements of one thing");
    return drift;
  }
  const earlier = baselineReadings(records, { profile: key, at: diagnosis.at, path }, notes, skips);
  if (earlier.phases === null) return drift;
  drift.compared = earlier.runs;
  if (diagnosis.verdict !== "PASS") {
    notes.push(
      `the run being measured is ${diagnosis.verdict}, and check:soak-trend judges only a run that passed, because the numbers of a run that ` +
        "stopped read as the numbers of a fast one — the drift below is reported anyway, and read as that",
    );
  }
  const { differences, delta } = costDifferences(earlier, now);
  drift.differences = differences;
  drift.cost = delta;
  return drift;
}

/**
 * The groups of ONE STEP of a comparison: the run, the run's cost, the door, and each reload the
 * two disagree about, in the order the accounts live them.
 *
 * A pair is the unit because two accounts are what a person usually has, and because a series
 * is made of pairs (see `seriesAccounts`): a step reports the facts on both of its sides, and
 * the RUN a fact moved in is added by whoever knows where the step sits in the series rather
 * than guessed at here.
 *
 * The unit of a difference is one NAMED fact: the run's verdict, profile, files, problems and
 * notes, and each reload's phase, outcome, ending and held connection. Facts that agree
 * produce nothing — that is what makes this readable, and why the comparison is by name rather
 * than by text — and a reload only one of the two has is reported as such instead of being
 * diffed against a reload that is not there.
 *
 * What the run COST is compared too, but not as another fact of this kind: a duration is a
 * measurement rather than an identity, so it is read under the gate's own budgets instead
 * (see `costComparison`), which is what lets a comparison name a run that got slower. The
 * door's counters are the third thing that is not an identity but a measurement, and they are
 * compared as rates for the same reason and for one more: their raw counts are the traffic
 * (see `doorComparison`).
 *
 * @param {ReturnType<typeof diagnoseAccount>} a the earlier run of the step
 * @param {ReturnType<typeof diagnoseAccount>} b the later one
 * @param {string[]} skips what the cost half could not compare, appended to
 * @returns {{ groups: { where: string, differences: Difference[] }[], cost: number | null }}
 */
function pairGroups(a, b, skips) {
  const groups = [];
  const run = { where: "the run", differences: /** @type {Difference[]} */ ([]) };
  compareFacts(runFacts(a), runFacts(b), run.differences);
  if (run.differences.length > 0) groups.push(run);

  // What the run COST, straight after the run itself: it is a fact about the run rather than
  // about one reload, and it is the half of a regression that comparing what the two runs DID
  // cannot name — two accounts carrying the same problems, one of them slower, are a finding.
  const cost = costComparison(a, b, skips);
  if (cost.differences.length > 0) groups.push({ where: "the run's cost", differences: cost.differences });

  // The door, beside it: what the run's traffic was ANSWERED, as rates. A run whose door turned
  // a share of its traffic into 503s, or timed out on it, is a finding even when both runs carry
  // the same problems — and the counts themselves would not be, since how much traffic arrived
  // is the load generator's rather than the deploy's (see `DOOR`). The clients a swap cost an
  // answer are in here at their own rate for the same reason: the reload a loss happened at is
  // the run group's fact, and how much of what was at the door it cost is this group's.
  const door = doorComparison(a, b, skips);
  if (door.differences.length > 0) groups.push({ where: "the door", differences: door.differences });

  const byIndex = (diagnosis) => new Map(diagnosis.reloads.map((row) => [row.index, row]));
  const left = byIndex(a);
  const right = byIndex(b);
  const indexes = [...new Set([...left.keys(), ...right.keys()])].sort((one, other) => one - other);
  for (const index of indexes) {
    const one = left.get(index);
    const other = right.get(index);
    const where = `reload ${index}`;
    if (one === undefined || other === undefined) {
      // A reload one of the two never performed is the fact that the reload is NOT THERE: a
      // `changed` fact whose absent side prints as `(none)`, like every other fact an account
      // does not carry — so the line reads the same way at step 2 of a pair and step 5 of a
      // series.
      groups.push({
        where,
        differences: [
          {
            field: "the reload",
            op: "changed",
            a: one === undefined ? null : `a ${one.phase} reload`,
            b: other === undefined ? null : `a ${other.phase} reload`,
          },
        ],
      });
      continue;
    }
    const differences = /** @type {Difference[]} */ ([]);
    compareFacts(reloadFacts(one), reloadFacts(other), differences);
    // One block missing is ONE fact (the account is from before the field, or from a shape
    // that carries no hold), so it is said once rather than as ten fields that all went
    // from nothing to something.
    if (one.held === null || other.held === null) {
      if (one.held !== other.held) {
        differences.push({ field: "held", op: "changed", a: heldLabel(one.held), b: heldLabel(other.held) });
      }
    } else {
      compareFacts(heldFacts(one.held), heldFacts(other.held), differences, "held.");
    }
    if (differences.length > 0) groups.push({ where, differences });
  }

  return { groups, cost: cost.delta };
}

/**
 * Name the run a step's differences were found in, on every one of them.
 *
 * The step knows only that it was between two runs; the caller knows which two. Both modes tag
 * their differences the same way, so a machine consumer has one shape either way.
 */
function atRun(groups, run) {
  for (const group of groups) {
    for (const difference of group.differences) {
      difference.run = run;
      difference.runs = [run];
    }
  }
  return groups;
}

/**
 * One difference as the key a series merges by: the same field, at the same op, with the same
 * values. Two steps that lost and regained the same thing are one difference and not two, and
 * two steps that moved a fact to two different values are two differences and not one.
 */
function differenceKey(difference) {
  return [difference.field, difference.op, JSON.stringify([difference.a ?? null, difference.b ?? null, difference.value ?? null])].join("\u0000");
}

/**
 * The cost of a series' LAST run against its FIRST, for the machine line: read under the same
 * rule the steps are read by, and `null` when the two ends are not comparable at all. The
 * skips of this reading are thrown away rather than reported, because the steps have already
 * said why it could not be compared — if either end is incomparable, a step is.
 */
function endToEndCost(diagnoses) {
  return costComparison(diagnoses[0], diagnoses[diagnoses.length - 1], []).delta;
}

/**
 * Two accounts, compared on the facts of them that mean the same thing in both runs.
 *
 * What a step is, is `pairGroups`; this is that step with the run it was found in named, and
 * the shape a consumer reads. That run is always 2, because two accounts are two runs and the
 * second is the only one anything can have changed in.
 *
 * @param {ReturnType<typeof diagnoseAccount>} a the account named first
 * @param {ReturnType<typeof diagnoseAccount>} b the account named second
 * @returns {{
 *   mode: "diff",
 *   dirs: (string | null)[],
 *   verdicts: string[],
 *   read: boolean,
 *   reloads: number[],
 *   groups: { where: string, differences: Difference[] }[],
 *   differences: number,
 *   cost: number | null,
 *   skips: string[],
 *   notes: string[],
 * }}
 */
export function diffAccounts(a, b) {
  const skips = [];
  const { groups, cost } = pairGroups(a, b, skips);
  atRun(groups, 2);
  return {
    mode: "diff",
    dirs: [a.dir, b.dir],
    verdicts: [a.verdict, b.verdict],
    read: a.verdict !== "UNREADABLE" && b.verdict !== "UNREADABLE",
    reloads: [a.reloads.length, b.reloads.length],
    groups,
    differences: groups.reduce((total, group) => total + group.differences.length, 0),
    cost,
    skips,
    notes: [],
  };
}

/**
 * Three or more accounts, as ONE regression series.
 *
 * The comparison is the CONSECUTIVE PAIRS of the series (run 1 against 2, 2 against 3, ...),
 * each read exactly as a pair is, and then MERGED: a group is one group wherever in the series
 * it appeared, and a fact that moved is one line carrying the run it first moved in, which is
 * the question a regression asks. A fact that moved to the same different value again later
 * carries every run that happened at (`runs`), because a report that says a series is flat
 * when it is not would be the worse of the two.
 *
 * A step is judged against the run BEFORE it rather than against the first run, which is what
 * "first changed" means and is also how `check:soak-trend` reads a run against the runs before
 * it: a series whose numbers crept up a little at every step is a regression even though no
 * single run is far from the first.
 *
 * @param {ReturnType<typeof diagnoseAccount>[]} diagnoses the runs, oldest first
 * @returns {{
 *   mode: "series",
 *   dirs: (string | null)[],
 *   verdicts: string[],
 *   read: boolean,
 *   reloads: number[],
 *   groups: { where: string, differences: Difference[] }[],
 *   differences: number,
 *   cost: number | null,
 *   skips: string[],
 *   notes: string[],
 * }}
 */
export function seriesAccounts(diagnoses) {
  const skips = [];
  const notes = [];
  const groups = [];
  const byWhere = new Map();
  const byKey = new Map();
  for (let index = 1; index < diagnoses.length; index += 1) {
    const run = index + 1;
    const step = pairGroups(diagnoses[index - 1], diagnoses[index], skips);
    for (const group of step.groups) {
      let merged = byWhere.get(group.where);
      if (merged === undefined) {
        merged = { where: group.where, differences: /** @type {Difference[]} */ ([]) };
        byWhere.set(group.where, merged);
        groups.push(merged);
      }
      for (const difference of group.differences) {
        const key = `${group.where}\u0000${differenceKey(difference)}`;
        const seen = byKey.get(key);
        if (seen === undefined) {
          const tagged = { ...difference, run, runs: [run] };
          byKey.set(key, tagged);
          merged.differences.push(tagged);
        } else {
          seen.runs.push(run);
        }
      }
    }
  }
  // A run nobody could read is not something the series can say anything about: the steps into
  // and out of it are that account's absence of facts, and a reader has to be told that before
  // believing a change point found at one of them.
  const unreadable = diagnoses
    .map((diagnosis, index) => (diagnosis.verdict === "UNREADABLE" ? index + 1 : null))
    .filter((run) => run !== null);
  if (unreadable.length > 0) {
    notes.push(
      `run${unreadable.length > 1 ? "s" : ""} ${unreadable.join(", ")} could not be read, so the steps into and out of ` +
        `${unreadable.length > 1 ? "them" : "it"} are that account's absence of facts rather than a difference between two runs`,
    );
  }
  return {
    mode: "series",
    dirs: diagnoses.map((diagnosis) => diagnosis.dir),
    verdicts: diagnoses.map((diagnosis) => diagnosis.verdict),
    read: diagnoses.every((diagnosis) => diagnosis.verdict !== "UNREADABLE"),
    reloads: diagnoses.map((diagnosis) => diagnosis.reloads.length),
    groups,
    differences: groups.reduce((total, group) => total + group.differences.length, 0),
    cost: endToEndCost(diagnoses),
    skips: [...new Set(skips)],
    notes,
  };
}

/** One side of a comparison, as the line the report opens with. */
function describeAccount(dir, verdict, reloads) {
  return `${dir ?? "(the files named)"} — ${verdict}, ${reloads} reload(s)`;
}

/**
 * A fact's value as it is printed.
 *
 * An EMPTY LIST and NOTHING are printed differently — `[]` against `(none)` — because they
 * are different facts everywhere in this account, and the difference is the one the readers
 * are most careful about: a hold that was answered nothing carries an empty list, while a
 * hold whose answers this reader cannot read carries no list at all.
 */
function show(value) {
  if (value === null || value === undefined) return "(none)";
  if (Array.isArray(value)) return `[${value.map((entry) => show(entry)).join(", ")}]`;
  return String(value);
}

/** One difference as its own line's tail. */
function showDifference(difference) {
  if (difference.op === "added") return `+ ${show(difference.value)}`;
  if (difference.op === "removed") return `- ${show(difference.value)}`;
  return `${show(difference.a)}  ->  ${show(difference.b)}`;
}

/**
 * Where a fact changed, as the label a series line carries.
 *
 * Nothing is said for a pair: with two runs every difference happened at the second, and a
 * reader who named two accounts already knows which one is the new one. In a series the label
 * is the whole point — and a change that happened more than once names every run it did.
 */
function runsLabel(difference) {
  const runs = Array.isArray(difference.runs) ? difference.runs : difference.run === undefined ? [] : [difference.run];
  if (runs.length === 0) return "";
  return runs.length === 1 ? `   (run ${runs[0]})` : `   (runs ${runs.join(", ")})`;
}

/**
 * The foot of a comparison, which both modes print: what was compared, what was not, and the
 * machine line.
 *
 * It names what was NOT compared because a report that hides its own exclusions is one a
 * reader has to reverse-engineer: the excluded facts are the identity of ONE run, so
 * comparing them would report a change in every comparison.
 */
function comparisonFoot(diff) {
  const lines = [];
  lines.push("");
  lines.push(
    "  compared: each run's verdict, profile, file set, problems and notes; every reload's phase, outcome and",
  );
  lines.push(
    "            how its window ended, with the facts of the connection it held across the swap; the door's own",
  );
  lines.push(
    "            counters as RATES — each status's share of the requests it was offered, its timeouts and its",
  );
  lines.push(
    "            connection errors as shares of the same, the clients in flight per swap that had one, and the",
  );
  lines.push(
    "            clients lost across a swap as a share of the clients those swaps had at the door — the one rate held to",
    "            half a client of that sample rather than to the points of mix, so a client the door cost an answer is a",
    "            movement however many there were; and what the",
  );
  lines.push(
    "            run COST — each phase's median reload and the run's total, off its trend line — against the",
  );
  lines.push(
    "            allowances check:soak-trend judges those same numbers with (a quarter of a phase's median or 2s, a",
  );
  lines.push("            fifth of the run's total or 10s), so the two cannot disagree about what 'slower' is.");
  lines.push(
    "  not compared: instants, ports, window durations, descriptor counts, how many connections each run happened",
  );
  lines.push(
    "            to serve, and the door's raw counts — how many requests arrived, how many answers of each status",
  );
  lines.push(
    "            came back, how many clients its swaps had at the door and how many of them it lost. Every one of",
  );
  lines.push(
    "            them is a fact of ONE run's clock, ports or traffic, so every comparison would report them as",
  );
  lines.push(
    "            changes: the request count moved 3 in 60 across three runs of one build while the mix did not move",
  );
  lines.push(
    "            at all, which is why the door is read as rates. The VERDICT those counts feed is the run's",
  );
  lines.push(
    "            problems, which IS compared — a client the door cost an answer is named at its reload there, and",
  );
  lines.push("            the rate above is how much of the traffic at the change that cost.");
  for (const line of diff.skips ?? []) lines.push(`  not compared: ${line}`);
  lines.push("");
  lines.push(
    `SOAK_DIFF=${diff.read ? (diff.differences === 0 ? "SAME" : "DIFFERENT") : "UNREADABLE"} ` +
      `accounts=${diff.dirs.length} differences=${diff.differences} reloads=${diff.reloads.join("/")} ` +
      `cost=${diff.cost === null || diff.cost === undefined ? "?" : `${signed(diff.cost)}ms`}`,
  );
  return lines;
}

/**
 * The facts that moved, as the lines both modes print: one group per part of an account, one
 * line per fact, and — in a series — the run each fact first moved in.
 */
function differenceLines(diff) {
  const lines = [];
  for (const group of diff.groups) {
    lines.push("");
    lines.push(`  ${group.where}`);
    const width = group.differences.reduce((max, difference) => Math.max(max, difference.field.length), 0);
    for (const difference of group.differences) {
      const run = diff.mode === "series" ? runsLabel(difference) : "";
      lines.push(`    ${difference.field.padEnd(width)}  ${showDifference(difference)}${run}`);
    }
  }
  return lines;
}

/** Two named accounts, as the lines a person reads. */
function renderPair(diff) {
  const lines = [];
  lines.push(`soak-account diff: ${diff.dirs[0] ?? "?"}  vs  ${diff.dirs[1] ?? "?"}`);
  lines.push("");
  lines.push(`  first   ${describeAccount(diff.dirs[0], diff.verdicts[0], diff.reloads[0])}`);
  lines.push(`  second  ${describeAccount(diff.dirs[1], diff.verdicts[1], diff.reloads[1])}`);
  lines.push("");
  // An account that could not be read has no facts to be equal to, so the lines below are
  // about the OTHER account rather than about a difference between two. Said first, because
  // everything after it is misleading until it has been.
  if (!diff.read) {
    lines.push(
      "  NOTE one of the two accounts could not be read, so what follows is that account's absence of facts " +
        "rather than a difference between two runs.",
    );
    lines.push("");
  }
  if (diff.differences === 0) {
    lines.push("  the two accounts agree on every fact that two runs can be compared on");
  } else {
    lines.push(`CHANGED — ${diff.differences} fact(s), grouped the way the accounts are`);
    lines.push(...differenceLines(diff));
  }
  return [...lines, ...comparisonFoot(diff)];
}

/**
 * A series of runs, as the lines a person reads: every run named in the order it is compared,
 * and then every fact that moved, at the run it FIRST moved in.
 *
 * The header names all the runs because the numbers in the differences are positions in this
 * list — and because a series given out of order is then visible, which it could not be from
 * a report that shows only what changed.
 */
function renderSeries(diff) {
  const lines = [];
  const runs = diff.dirs.length;
  lines.push(`soak-account series: ${runs} run(s), compared in the order they are named`);
  const pad = String(runs).length;
  for (let index = 0; index < runs; index += 1) {
    lines.push(
      `  run ${String(index + 1).padStart(pad)}  ${describeAccount(diff.dirs[index], diff.verdicts[index], diff.reloads[index])}`,
    );
  }
  lines.push("");
  for (const note of diff.notes ?? []) lines.push(`  NOTE ${note}`);
  if ((diff.notes ?? []).length > 0) lines.push("");
  if (diff.differences === 0) {
    lines.push(`  the ${runs} accounts agree on every fact that runs can be compared on`);
  } else {
    lines.push(`CHANGED — ${diff.differences} fact(s) across the series, each named at the run it FIRST changed in`);
    lines.push(...differenceLines(diff));
  }
  return [...lines, ...comparisonFoot(diff)];
}

/**
 * The comparison, as the lines a person reads: a diff for two accounts, a series for more.
 *
 * @param {ReturnType<typeof diffAccounts> | ReturnType<typeof seriesAccounts>} diff
 */
export function renderDiff(diff) {
  return diff.mode === "series" ? renderSeries(diff) : renderPair(diff);
}

/**
 * Read an account — or compare accounts, as a diff or a series — print it, and say so with an
 * exit code.
 *
 * The reader is injectable so the report can be exercised against files a test wrote, as
 * well as through the real process against a real artifact — which is what a person with
 * a downloaded `soak-account` runs.
 *
 * @param {string[]} [argv]
 * @param {{
 *   readFile?: (path: string) => string,
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 * }} [deps]
 * @returns {number} one account: 0 nothing in it is a problem, 1 something is, 2 nothing
 *   could be read (or, with `--baseline`, the baseline file could not be read); accounts
 *   compared: 0 every one of them was read, 2 one of them was not
 */
export function main(argv = process.argv.slice(2), deps = {}) {
  const {
    readFile = (path) => readFileSync(path, "utf8"),
    out = (text) => process.stdout.write(text),
    err = (text) => process.stderr.write(text),
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

  // TWO OR MORE ACCOUNTS: the comparison, which is a report of its own rather than N timelines.
  // Two of them are a diff, more are a series in the order they were named (see the MANY
  // ACCOUNTS section above) — the same reader either way, one step at a time.
  if (options.accounts.length > 1) {
    const diagnoses = options.accounts.map((account) => {
      const files = accountFiles({ account, summary: null, history: null, trend: null });
      return diagnoseAccount({ files: readAccount(files, readFile), dir: files.dir });
    });
    const diff = diagnoses.length === 2 ? diffAccounts(diagnoses[0], diagnoses[1]) : seriesAccounts(diagnoses);
    const human = options.json ? err : out;
    human(`${renderDiff(diff).join("\n")}\n`);
    if (options.json) out(`${JSON.stringify(diff)}\n`);
    return diff.read ? 0 : 2;
  }

  const files = accountFiles(options);
  const diagnosis = diagnoseAccount({ files: readAccount(files, readFile), dir: files.dir });
  // THE STORED BASELINE, when one is named: the run against the runs BEFORE it, which is the
  // question one artifact cannot otherwise answer (see the ONE ACCOUNT AGAINST A STORED
  // BASELINE section at the top of this file). A file that cannot be read at all is not a
  // refused command line but an answer this command cannot give: the account is printed in
  // full, the baseline says what could not be read, and the exit code is 2 — the same
  // reasoning as for a file of the account itself, since half a comparison read as a whole one
  // is how a wrong diagnosis gets made.
  let baselineUnreadable = false;
  if (options.baseline !== null) {
    const path = resolve(options.baseline);
    try {
      diagnosis.drift = baselineComparison(diagnosis, parseJsonLines(readFile(path), path), path);
    } catch (error) {
      diagnosis.drift = {
        path,
        records: 0,
        compared: 0,
        profile: null,
        differences: [],
        cost: null,
        notes: [],
        skips: [`the baseline could not be read: ${error.message}`],
      };
      baselineUnreadable = true;
    }
  }
  const human = options.json ? err : out;
  human(`${renderDiagnosis(diagnosis).join("\n")}\n`);
  if (options.json) {
    out(
      `${JSON.stringify({
        verdict: diagnosis.verdict,
        dir: diagnosis.dir,
        files: diagnosis.files,
        at: diagnosis.at,
        reloads: diagnosis.reloads,
        events: diagnosis.events,
        problems: diagnosis.problems,
        notes: diagnosis.notes,
        unreadable: diagnosis.unreadable,
        drift: diagnosis.drift,
      })}\n`,
    );
  }
  if (baselineUnreadable) return 2;
  return diagnosis.verdict === "UNREADABLE" ? 2 : diagnosis.verdict === "RED" ? 1 : 0;
}

// Run only when executed directly (the tests import the reader's parts).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
