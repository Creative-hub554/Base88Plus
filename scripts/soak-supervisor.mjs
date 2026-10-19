#!/usr/bin/env node
/**
 * soak-supervisor — do many reloads back to back and check what they left behind.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other check of the production supervisor looks at ONE reload: a swap
 * that never closed the port, a rollback that took the port back, a window the
 * app's traffic decided. What none of them can see is the thing a supervisor
 * running for a week is judged on — whether a hundred reloads leave the machine
 * the way a single one did. A warm run whose stop missed, a port a retired server
 * kept, a socket the door forgot to tear down, a record written twice or not at
 * all: each is invisible in one reload and obvious in thirty, and each is only
 * cheap to find while the supervisor is still there to be asked.
 *
 * So this asks for a reload, waits for its record, checks, and does it again —
 * touching the sentinel only after the previous record has landed, so that
 * `reloads` requests are exactly `reloads` reloads rather than however many the
 * queue happened to coalesce.
 *
 * WHAT IT VARIES, AND WHY THAT MATTERS
 * ------------------------------------
 * The window the way back is kept is decided by the rate the app is using the
 * replacement at (see `rollbackWindowFor` in scripts/supervise.mjs), so a soak
 * that only ever hammered the server would only ever exercise one branch of it.
 * The traffic therefore cycles through three phases, one per reload:
 *
 *   busy      a real request rate through the front door — the app's own traffic
 *             is what proves the replacement, so the window closes on `traffic`
 *             in seconds;
 *   trickle   one connection every few seconds — too few to prove anything, so
 *             the little rate it does show decides a window and the clock closes
 *             it;
 *   quiet     nothing at all — the window with no evidence in it, which runs to
 *             the operator's ceiling because there is nothing to shorten it with.
 *
 * All three end with the run that was replaced retired, so all three are paths
 * through the same stop, the same audit and the same record — which is the point:
 * the leak checks below run after every one of them, not only after the busy ones.
 *
 * WHAT IT CHECKS
 * --------------
 * Four leaks, each measured rather than argued about:
 *
 *   processes  the supervisor's own audit is read back out of its log (a
 *              retirement that reported a survivor, or a force kill that left one
 *              holding the port, is a finding), and — where the platform can
 *              answer cheaply — the soak counts the supervisor's descendants
 *              after every reload and insists the count does not grow. On Linux
 *              that read is `/proc` and costs nothing; on Windows it is the
 *              persistent PowerShell watcher below, because reading that table
 *              costs seconds per read (measured in scripts/supervise.mjs) and a
 *              subprocess per check would cost more than the soak;
 *   ports      every port a record names is bound by the soak once the reload has
 *              concluded: a retired run that still holds its port IS a leaked warm
 *              process, caught without needing to see the process at all. All of
 *              them, plus the public one, are checked again once the supervisor
 *              has been stopped;
 *   sockets    the front door answers every request with the app's own answer for
 *              the whole soak — a hung or half-closed piped socket shows up here
 *              as a timeout — and the supervisor's own descriptor count (file
 *              descriptors on Linux, handles on Windows) is watched for a floor
 *              that RISES across the soak. This is the one instrument noisier than
 *              the leak it looks for: a retirement's own sockets and pipes take a
 *              moment to be released, so consecutive readings of a clean supervisor
 *              on the machine this was measured on differ by up to 13 handles when
 *              it is quiet and 15 under load (three twelve-reload runs of a real
 *              build). Each reading is therefore the lowest of several, and what is
 *              compared is a phase's own floor in the second half of its reloads
 *              against the
 *              first: churn raises single readings, a leak raises the floor, and
 *              comparing one phase with itself keeps the phases' different loads
 *              (a busy window has a page's worth of requests in flight, a quiet one
 *              has none) out of the comparison;
 *   records    exactly one record per reload, in order, all readable by the same
 *              parser the gate uses (`src/lib/deploy/reload-history.ts`), each
 *              carrying the fields the verdict rests on — and, per reload, the
 *              phase's own expectation: a busy one shortened by the traffic rather
 *              than run to its ceiling, a trickle and a quiet one closed by the
 *              clock, the quiet one with nothing served in it at all.
 *
 * And one claim that is not about a leak at all, because a swap is the moment the
 * front door is FOR: what the door does to the clients that were there when the port
 * changed hands. Every answer is timed when it is asked for, so the clients AT a
 * swap are known — a request whose connection was accepted before the change and
 * answered after it is one the door had in its hands while it moved — and none of
 * them may be a 503 or a refused connection: the port belongs to the door and never
 * closes, and a client already being served may not be handed a failure for it. The
 * door is held to the same claim from the other side by a connection the soak KEEPS
 * OPEN across the swap (see `holdConnection`): opened before the reload is even asked
 * for, held as a request nothing may finish — on the wire, in use, and beyond the
 * reach of the idle clock a run is entitled to close a connection with — and judged
 * afterwards on two things — the door's own account of the retirement says that run
 * was still holding it (`leftoverConnections`, read at the instant the door took it
 * and only for a connection that was still open then: one that had already ended
 * leaves a run legitimately holding nothing), and once that run is gone the connection
 * ends WITH it rather than being answered by the replacement. Every swap reports how many clients
 * it had; a busy one with none says so instead of passing on nothing. What that connection WAS is
 * part of the account, per reload: whether the door accepted it at all (and why it ended if not),
 * WHEN it was accepted, what was said to it while it was held — each answer as its status and the
 * instant it arrived — and whether any of that came before or after the swap, when it ended,
 * whether that ending came before the count the door took, and the count itself. The run
 * carries it into BOTH the summary `--json` writes and the trend line it appends, so a red door
 * claim is diagnosed from the account that was uploaded rather than from a re-run (see
 * `trendRecord` below and `heldNotes` in scripts/check-soak-trend.mjs).
 *
 * WATCHING A DEPLOY INSTEAD
 * -------------------------
 * `--attach <port> --history <path>` turns the same file into a watch on a deploy
 * somebody else is running, which is the half of this an operator actually has
 * during a deploy: a supervisor nobody here started, on a port somebody else chose,
 * performing swaps nobody asked this script for. The load is held against that
 * port, one connection is kept open through it, and the deploy's OWN HISTORY is
 * what says a swap happened — read as it grows, so each swap is reported within a
 * poll of the record that describes it, with a line on stderr as it lands and (with
 * `--json`) one object per swap on stdout, rather than in one summary at the end.
 *
 * The claim is the same one the soak makes about a swap (see above): no client that
 * had the port in its hands while it changed hands may be handed a 503 or a
 * refused connection, and the connection held across it must be the retired run's —
 * answered by that run while it served, still on it when it was retired, and ended
 * WITH it rather than handed to the replacement. What is different is that the
 * reloads are the deploy's: a swap that happened before the watch attached is
 * reported as NOT JUDGED rather than judged on evidence nothing was watching for, a
 * swap with no client at the door is a finding for every swap (the load is always
 * on), and the deploy's own outcome is not a finding at all — a rollback is a
 * legitimate thing for a deploy to do, and only the door is on trial here.
 *
 * AND WHY THE LOSS LOOKS THE WAY IT DOES
 * --------------------------------------
 * Naming the client is half a finding: whether the app finished its request or was cut off
 * under it is what decides whether the door failed to carry an answer back or the app never
 * wrote one. The watch reads that off the deploy's own output — `--server-log`, default
 * `server.log` beside `--history` — at the moment the loss lands, and puts the same
 * classification on the live line that `soak:diagnose` prints under the loss in a downloaded
 * account (`classifyLogLines`, and `describeAppLines` for the sentence). A client the file
 * does not name is given one short second look before the silence is called the app's,
 * because the output reaches that file through somebody else's pipe while the loss is read
 * from a record a different process wrote.
 *
 * A log is somebody else's file, so it can be ROTATED or TRUNCATED under the watch: the file
 * at `--server-log` is not the same file it was a minute ago, and the line for the client this
 * swap cost may be in the copy that was renamed away. The watch therefore keeps what it has
 * read (`startAppLogView`) instead of re-reading a path as if it were immutable: it reads the
 * tail of `<server-log>.1` when a rename rotation leaves one, keeps every line it has already
 * seen, and — when it cannot vouch for the file's whole history — says the absence is `UNSEEN`
 * rather than `NO LINE AT ALL`. The app's silence and the log's are two different findings, and
 * a reader that could only read the file once has no business reporting the second as the first.
 *
 * A reload that never swapped the port is not a swap at all, and it is reported as
 * NOT JUDGED rather than counted against the deploy: `kept` — a replacement that
 * never came up — leaves the port where it was, so there was no change at the door
 * and nothing about the door to fail. A watch that saw nothing but those ends as
 * NOTHING_JUDGED, not as a failure; what fails it is a client the door cost an
 * answer, and nothing else.
 *
 * That is the right report for a watcher and the wrong answer for a pipeline whose
 * question is "did this deploy actually swap the port under load?": a watch that
 * judged nothing cannot say yes. `--require-swap` asks for that reading — a watch
 * that judges no swap at all then FAILS (exit 1, with the reason) instead of
 * reporting NOTHING_JUDGED (2). It changes nothing about what a judged swap has to
 * have done; it only refuses to let "nothing to judge" pass as "nothing wrong".
 *
 * AND WHERE SOMEBODY ACTUALLY GETS TOLD
 * -------------------------------------
 * A log is read by whoever happens to be looking at it, and a deploy that cost a
 * client its answer at three in the morning is not fixed by a line in a file nobody
 * opened. `--alert pagerduty` pages on-call through PagerDuty's Events API v2 the
 * moment the watch finds the door costing a client an answer — the same instant the
 * per-swap line is written, not at the end of the deploy — and `--alert <url>` posts
 * the same account as JSON to any endpoint that will have it (a chat webhook, an
 * automation, an alert relay). The alert includes the app-side classification for each
 * lost client — its status or the reason it did not answer — without forwarding the raw
 * request line, which may contain a private URL or query string.
 *
 * Two things about WHEN it fires, because a pager that cries wolf is worse than one
 * that does not exist. It fires on the door's own findings and nothing else: a client
 * that had the port in its hands and was handed a 503 or a refusal, a connection held
 * across the swap that was not the retired run's, a swap with no client at the door,
 * or evidence the watch could not place. It does NOT fire for the deploy's own
 * outcome (a rollback is legitimate), for a reload that changed nothing, for a swap
 * that happened before the watch attached, or for `--require-swap`'s "nothing to
 * judge" — those are answers about coverage, and their reader is the pipeline that
 * asked, not whoever is on call. A run that judged swaps and found nothing at the
 * door RESOLVES the PagerDuty alert with the same dedup key, so an incident opened by
 * an earlier run of the same watch does not sit open after a clean one.
 *
 * The dedup key is the watch's own identity (`anybase-swap-watch:<front port>:<history
 * path>`), stable across the runs of one deploy, so the three swaps of one bad deploy
 * are one incident with three trigger entries rather than three pages — and a later
 * run of the same watch that fails again attaches to that same open incident instead
 * of opening a second one. The routing key is read from `PAGERDUTY_ROUTING_KEY` and
 * nowhere else: never an argument, never printed, never in the summary or the log.
 * Nothing about the alert can change the verdict — a page that could not be sent is
 * reported loudly and the door's own answer stands, since failing the run twice for
 * one problem would only mislead whoever reads it.
 *
 * It is NOT the soak: there are no descendants to count, no ports to bind after a
 * retirement, nothing to stop, and no way to know what the deploy was configured
 * with. Those checks need the supervisor this script started and owns.
 *
 * AND AS A DAEMON
 * ---------------
 * `--daemon <log>` is the same watch, held open, with its verdicts APPENDED to a
 * file: one JSON line per swap as it lands, and the summary as the last line when
 * the daemon ends. That is the interface a step in a deploy actually has — a log it
 * can follow (`tail -F`) and its own copy of the evidence afterwards — rather than a
 * pipe it has to keep alive, and a pipe that ends when somebody's step is restarted
 * is a pipe that loses the swaps that happened while it was down. The lines are the
 * same objects `--json` prints, so the log and the stream cannot say different
 * things, and the file is APPENDED to: a redeployed watch adds to the account rather
 * than starting it again. Because it is a daemon it has no stopping count — `--swaps`
 * is refused with it — and it ends on SIGINT, SIGTERM, or `--wait` if one was named.
 * The exit code at the end is the same verdict it always was (0/1/2), which a daemon
 * stopped by a signal reports for the swaps it did judge.
 *
 * Exit codes: 0 every judged swap kept the claim, 1 any of them did not, 2 nothing
 * could be judged (nothing serving on the port, no reload landed while the watch was
 * up, or every reload it saw changed nothing). With `--require-swap` the two of those
 * that are a VERDICT — a watch that ran and judged nothing — become a 1, because
 * nothing to judge, when proof was demanded, is the failure being asked about. A
 * watch that never got as far as a verdict (nothing serving on the port, a daemon log
 * that cannot be written) is still a 2: the check could not be run rather than run
 * and answered no.
 *
 * WHAT IT NEEDS
 * -------------
 * A production build: `npm run build` first. By default it supervises the real
 * `next start` over `.next` (what `npm start` does), which is the surface the
 * claim is about. `--server '<command>'` runs something else instead — the same
 * `PROD_SERVER_CMD` the supervisor's own tests use, which is how the test suite
 * exercises this file's checks against a fixture rather than a build.
 *
 * Usage: node scripts/soak-supervisor.mjs [options]
 *
 *   --attach N             WATCH MODE: the port a running deploy's front door holds,
 *                          instead of soaking a supervisor of this script's own.
 *                          Everything below that asks for reloads is refused with
 *                          it; --history, --swaps and --wait are its own (see the
 *                          end of this list).
 *   --history PATH         WATCH MODE: the reload history that deploy writes (its
 *                          PROD_RELOAD_HISTORY). Required with --attach.
 *   --daemon PATH          WATCH MODE: append one verdict per swap to this log as
 *                          it lands, and never stop for a count — a long-lived
 *                          watch a deploy pipeline reads by following a FILE, which
 *                          is the interface a step in a deploy has. Ends on
 *                          SIGINT/SIGTERM, or on --wait if one was named; it does
 *                          not end because it has judged some number of swaps, and
 *                          --swaps is refused with it.
 *   --server-log PATH      WATCH MODE: where the deploy's app output is written, so a lost
 *                          client can be classified the moment the loss lands (default:
 *                          server.log beside --history, the way a soak keeps its account).
 *                          The watch keeps what it reads, so the file being rotated (the old
 *                          one left as <PATH>.1) or truncated under it does not turn an answer
 *                          the app gave into an absence it never had: the kept lines are still
 *                          searched, and a client the log cannot vouch for is reported UNSEEN.
 *                          Without the file — or when it is not there at all — the loss is
 *                          named and not classified, and the watch says so at the start.
 *   --swaps N              WATCH MODE: stop after N swaps have been judged (default:
 *                          keep watching until --wait runs out or a signal arrives)
 *   --wait MS              WATCH MODE: stop after this long, whether or not a swap
 *                          was judged (default: no limit)
 *   --require-swap         WATCH MODE: demand proof. A watch that judges no swap at
 *                          all FAILS (exit 1, with the reason) instead of reporting
 *                          NOTHING_JUDGED (2), which is what a pipeline that is
 *                          checking the deploy actually swapped the port wants — a
 *                          watch with nothing to judge cannot say that it did. It
 *                          does not change what a judged swap has to have done.
 *   --alert pagerduty|URL  WATCH MODE: page somebody when the DOOR costs a client an
 *                          answer. The alert includes the app-side classification for
 *                          each lost client, without its raw request line. `pagerduty`
 *                          posts a PagerDuty Events API v2 trigger (the routing key
 *                          comes from PAGERDUTY_ROUTING_KEY and is never an argument
 *                          or a log line); an http(s) URL posts the same account as
 *                          JSON to that endpoint. It fires as the finding lands, not
 *                          when the deploy ends, one incident per watched deploy (see
 *                          the dedup key above), and it never changes the verdict.
 *
 *   --reloads N            how many reloads to perform, back to back (default 30)
 *   --phases a,b,c         the traffic phases, one per reload, cycling (default
 *                          busy,trickle,quiet)
 *   --port N               the public port; default: one the OS is not using
 *   --path P               the path the traffic asks for (default /)
 *   --window-ms N          PROD_ROLLBACK_MS for the soak (default 6000 — the
 *                          soak's own ceiling, not the operator's 90s, so that a
 *                          quiet window does not cost a minute and a half)
 *   --min-ms N             PROD_ROLLBACK_MIN_MS (default 1500)
 *   --proof N              PROD_ROLLBACK_CONNECTIONS (default 3)
 *   --busy-rate N          requests per second in the busy phase (default 8 —
 *                          evidence, not a load test: a rate the app cannot serve
 *                          turns the soak into an overload test and fails reloads
 *                          for reasons that are not leaks)
 *   --max-in-flight N      how many requests may be outstanding at once, whatever
 *                          the rate (default 4 — concurrency is what wedges an app
 *                          that cannot serve it, and a client that piles up sixty
 *                          of them measures itself)
 *   --trickle-gap-ms N     the gap between connections when trickling (default 4000)
 *   --request-timeout-ms N how long a request may take before it counts as hung
 *                          (default 8000)
 *   --settle-ms N          how long a phase runs before the reload is asked for,
 *                          so the window really sees it (default 700)
 *   --handle-slack N       how many descriptors the supervisor may gain between
 *                          the first half of a phase's reloads and the second
 *                          (default 8; see the descriptor note below)
 *   --server '<command>'   run this instead of `next start` (tests)
 *   --dir PATH             where the temp history and sentinel live (default: a
 *                          fresh directory under the OS temp)
 *   --trend PATH           where this run's own trend record is appended, one JSON
 *                          line per run (default: <dir>/soak-trend.jsonl). Point it
 *                          at a path you keep and the runs accumulate while `--dir`
 *                          stays a fresh one per run — the history in a dir belongs to
 *                          ONE run, and two sharing one leave records neither can
 *                          read (measured: a concurrent pair blamed each other's front
 *                          port). The reader is scripts/check-soak-trend.mjs.
 *
 * BESIDE THE HISTORY, `server.log`: everything the supervisor streamed from the app it
 * supervised, which is where the app's OWN REQUEST LOG is — the lines a run writes as it
 * answers, `GET /?_client=17 200 in 3ms (next.js: …)` and the run's own notices. It is
 * written for the same reason the history is: a client a swap cost is named in the account
 * by the ordinal it was handed to the door at (`spent[].client`), and that ordinal is on the
 * request the client asked with — so the app's line for that client is one grep away, provided
 * the app's output is in the artifact. `soak:diagnose` reads it and prints those lines under
 * the loss (`SERVER_LOG` is the file's name in both readers). A watch (`--attach`) writes no
 * account of its own, but it reads the same file: `--server-log` names where the deploy's
 * output is (default: `server.log` beside `--history`, the way a soak keeps it), and a client
 * a swap cost is CLASSIFIED from it on the line that reports the loss.
 *   --json                 write the summary to stdout as one JSON object
 *   -h, --help             this text.
 *
 * Exit codes:
 *   0  every leak check passed
 *   1  something leaked, or a reload did not behave as its phase says it should
 *   2  the soak could not be run: no build, a bad option, a supervisor that never
 *      came up, or a test that could not be helped
 *
 * In watch mode (`--attach`) the exit codes are the swap watch's: 0 every judged
 * swap kept the claim, 1 any of them did not, 2 nothing could be judged.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OUTCOME_VERDICT, parseReloadHistory } from "../src/lib/deploy/reload-history.ts";
import { RELOAD_HISTORY_SCHEMA, descendantsOf, readProcessTable, selfUrl } from "./supervise.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The app's own output, as the supervisor streamed it, beside the account it belongs to.
 *
 * The supervisor passes a run's stdout and stderr through untouched (see `startRun` in
 * scripts/supervise.mjs), so this file is where the app's request log actually lives during a
 * soak: the ` GET /path 200 in 3ms (…)` line per request, whatever the app wrote to stderr,
 * and the supervisor's own `[start]` lines between them. It is captured WHOLE rather than
 * filtered to request lines, because a line that fails a pattern is exactly the line nobody
 * predicted — the app's stderr is where a page that threw says so — and because filtering is
 * a judgement this file is not entitled to make.
 *
 * The name is shared with the reader rather than written twice: `soak:diagnose` looks for
 * exactly this file in an account (scripts/soak-diagnose.mjs, `DEFAULTS.log`), and a client a
 * swap cost is followed into it by the `_client=` ordinal the loss was named with.
 */
export const SERVER_LOG = "server.log";

/**
 * The shapes a line of the app's own output has, read for the client it names.
 *
 * `answered` is a line carrying a STATUS — the app's request log prints one per request it
 * finished (` GET /?_client=63 200 in 3ms (next.js: …)`); `unanswered` a line that names the
 * client and carries no status (a closure note, an error trace, anything the app wrote ABOUT a
 * request rather than in answer to it); `mixed` a client the log has both kinds of line for;
 * `absent` one it does not name at all; and `unseen` one it does not name in a log the reader
 * knows it could not read whole (see `LOG_GAP_KINDS`) — the same zero lines as `absent`, and a
 * different finding: there the LOG is missing, not the app's side of the request. The vocabulary
 * is exported so the watch's live line and the timeline `soak:diagnose` prints read the same
 * words rather than spelling them a second time.
 */
export const LOG_SHAPES = ["answered", "unanswered", "mixed", "absent", "unseen"];

/**
 * The ways the app's own output can be less than whole when it is read, and what each one says.
 *
 * A log is read AT the loss, so a file that was rotated or truncated between one read and the
 * next is a file this reader has only part of — and a client that part does not name is not the
 * same finding as a client the app never saw. The kinds are the reason a reading says `unseen`
 * instead of `NO LINE AT ALL`: what was lost is the LOG, not the answer.
 */
export const LOG_GAP_KINDS = ["rotated", "truncated", "missing", "dropped"];

/** What each kind of gap did to the app's output, as a phrase that follows "the app's own output …". */
const GAP_SAID = {
  rotated: "was replaced (rotated or truncated) while the watch was reading it",
  truncated: "was cut back while the watch was reading it",
  missing: "was not there when the watch looked",
  dropped: "lost its oldest lines to the watch's own size cap",
};

/**
 * The gaps of one reading as one phrase: the kinds that happened, said once each.
 *
 * @param {{ kind?: string }[]} gaps
 * @returns {string}
 */
function describeGaps(gaps) {
  const kinds = [...new Set((Array.isArray(gaps) ? gaps : []).filter((gap) => gap && typeof gap.kind === "string").map((gap) => gap.kind))];
  if (kinds.length === 0) return "could not be read whole";
  const said = kinds.map((kind) => GAP_SAID[kind] ?? `could not be read whole (${kind})`);
  return said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}`;
}

/**
 * One line of the app's own output, read for what it says about the client it names.
 *
 * The status is a token of its own in the 1xx–5xx range, which is why the request's own query
 * can never be mistaken for one (`?page=200` is part of the path token, not a status), and
 * neither can a duration (`3ms`), a port or an instant. A line with no such token is not a
 * failure to read it: it is the interesting case — the app naming a request it never answered.
 *
 * @param {string} line
 * @returns {{ shape: "answered" | "unanswered", status: number | null }}
 */
export function classifyLogLine(line) {
  const status = String(line ?? "")
    .split(/\s+/)
    .map((token) => token.replace(/[),.;]+$/, ""))
    .find((token) => /^[1-5]\d\d$/.test(token));
  return status === undefined ? { shape: "unanswered", status: null } : { shape: "answered", status: Number(status) };
}

/**
 * A lost client's own lines, CLASSIFIED: what shapes the log has for it, and what those shapes
 * say about the loss the account already counted.
 *
 * A log can settle exactly one thing about a loss — the app's SIDE of the request — and that is
 * enough to tell three different failures apart:
 *
 *   - an ANSWERED client was finished by the app, so a loss the door counted is an answer that
 *     did not come back through the door, or an answer the door would not pass (a 5xx is an
 *     answer, and the loss is that answer — the status, not a silence);
 *   - an UNANSWERED one was handed to the app and never finished, so the connection ended under
 *     it: a client cut off at the swap, from the app's side;
 *   - an ABSENT one never became a line, so it was cut off at the door BEFORE the app was handed
 *     it — upstream of the app rather than inside it.
 *
 * A client can be named on more than one line (a retry, a stalled request the app later closed),
 * so a client with both shapes is `mixed` and its reading says what was answered and what was
 * not, rather than choosing one — the app's side of that client is not one thing.
 *
 * @param {string[]} lines the client's own lines, as `clientLogLines` matched them
 * @param {{ gaps?: { kind?: string }[] }} [reading] what the reader knows it did not get: the
 *   gaps in the output, from `startAppLogView` (a file rotated or truncated under the reader).
 *   A client the lines do not name is `unseen` rather than `absent` when there are any — the
 *   absence is the LOG's, and saying it was the app's would be a finding the evidence cannot
 *   support.
 * @returns {{ shape: string, statuses: number[], answered: number, silent: number, total: number, why: string }}
 */
export function classifyLogLines(lines, { gaps = [] } = {}) {
  const read = (Array.isArray(lines) ? lines : []).map(classifyLogLine);
  const answers = read.filter((line) => line.shape === "answered");
  const statuses = [...new Set(answers.map((line) => line.status))];
  const unseen = (Array.isArray(gaps) ? gaps : []).length > 0;
  const shape =
    read.length === 0
      ? unseen
        ? "unseen"
        : "absent"
      : answers.length === 0
        ? "unanswered"
        : answers.length === read.length
          ? "answered"
          : "mixed";
  const silent = read.length - answers.length;
  let why;
  if (shape === "unseen") {
    why =
      `UNSEEN: the app's own output ${describeGaps(gaps)}, so a client this log does not name is not one the app never ` +
      "saw — a line for it may have been written into the part the watch could not keep";
  } else if (shape === "absent") {
    why =
      "NO LINE AT ALL: the request never became a line, so it was cut off at the door before the app was handed it — " +
      "the app is not the thing that lost it";
  } else if (shape === "unanswered") {
    why =
      "NO ANSWER: not one line here carries a status, so the app was handed the request and never finished it — the " +
      "connection ended under it, which is what a client cut off at the swap leaves on the app's side";
  } else if (shape === "answered") {
    const failed = statuses.filter((status) => status < 200 || status >= 300);
    why = failed.length > 0
      ? `ANSWERED (${statuses.join("/")}): the client got an answer on every line it has here, so nothing was cut off on ` +
        `the app's side — the loss is the status it got (${failed.join("/")}), not a silence`
      : `ANSWERED (${statuses.join("/")}): the app finished every request it logged for this client, so what the swap ` +
        "cost is that answer on its way back through the door, not work the app never did";
  } else {
    why =
      `MIXED: ${answers.length} line(s) ANSWERED (${statuses.join("/")}) and ${silent} with no status — part of what this ` +
      "client was handed came back, and part ended under the app";
  }
  return { shape, statuses, answered: answers.length, silent, total: read.length, why };
}

/**
 * The lines of the app's own output that name a client by the ordinal it was handed to the door
 * at, for one such ordinal — as the text both readers print, or null when there is nothing to
 * look a client up in.
 *
 * The match is on the QUERY, not the substring: `_client=6` must not find the line for client 63
 * (the value has to end at `&`, whitespace or the end of the line) — the mistake a substring
 * regex makes and a `grep -F` of the whole handle does not.
 * A client is one request in this traffic, so one line is the ordinary answer; more is kept, a
 * few, then counted, because a log that names a client twice is a fact about the traffic and not
 * something to hide behind the first line.
 *
 * What those lines SAY about the loss is settled over ALL of them rather than over the three
 * printed (`classification`, see `classifyLogLines`): a client named four times is read whole
 * even though it is printed short.
 *
 * @param {string | null} log the app's own output, or null when there is none to read
 * @param {number | null | undefined} client one `spent` entry's `client`
 * @param {{ gaps?: { kind?: string }[] }} [reading] what the reader knows it did not get (see
 *   `classifyLogLines`), carried into the classification and into the account beside the lines
 * @returns {{ lines: string[], more: number, total: number, gaps: { kind?: string }[], classification: ReturnType<typeof classifyLogLines> } | null}
 *   the client's own lines, or null when there is nothing to say about them (no log, or no
 *   ordinal to look one up by)
 */
export function clientLogLines(log, client, { gaps = [] } = {}) {
  if (typeof log !== "string" || !Number.isFinite(client)) return null;
  const seen = Array.isArray(gaps) ? gaps : [];
  const pattern = new RegExp(`[?&]_client=${client}(?:&|\\s|$)`);
  const lines = log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => pattern.test(line));
  return {
    lines: lines.slice(0, 3),
    more: Math.max(0, lines.length - 3),
    total: lines.length,
    gaps: seen,
    classification: classifyLogLines(lines, { gaps: seen }),
  };
}

/**
 * What the app itself said about one lost client, as a sentence both readers print.
 *
 * The watch puts this on the line it writes as the loss lands, and `soak:diagnose` prints it
 * under the same loss in a downloaded account — one function, so an incident read during the
 * deploy and the same incident read afterwards cannot say different things about the app's
 * side of it. The lines are the app's own words, quoted with the reason the reading gives
 * them; a client the output never names is the absence SAID rather than an empty quote, since
 * "the app wrote nothing" is the finding.
 *
 * @param {ReturnType<typeof clientLogLines>} found one client's own lines
 * @param {string} [log] the file's name, as the reader knows it
 * @returns {string} the app's side of the loss, in words
 */
export function describeAppLines(found, log = SERVER_LOG) {
  if (found === null || found === undefined) return `the app's own log (${log}) says nothing about this client`;
  if (found.total === 0 && found.classification?.shape === "unseen") {
    return `the app's own log (${log}) names no line for this client, and cannot be read whole — ${found.classification.why}`;
  }
  if (found.total === 0) return `the app's own log (${log}) carries no line for this client — ${found.classification.why}`;
  return (
    `the app's own log (${log}) names this client on ${found.total} line(s): ${found.lines.join(" | ")}` +
    (found.more > 0 ? ` (and ${found.more} more)` : "") +
    ` — ${found.classification.why}`
  );
}

/**
 * The app's own output as a READER keeps it, rather than as the file happens to be at one instant.
 *
 * A log is somebody else's file: a deploy or a log manager rotates it (`server.log` renamed to
 * `server.log.1` and a new one started) or truncates it in place, and a reader that opens the
 * path afresh at each loss then sees a file that no longer contains what the app wrote before it
 * was replaced. That is how a client the app ANSWERED is reported as one that never reached it —
 * the same words for two different failures, and the wrong one for the loss.
 *
 * So each look is compared with the previous one and the view keeps what it has read: growth is
 * appended as the delta, a file cut back to something it already said is noted as a truncation,
 * and a file that was REPLACED is noted as a rotation — after the tail of the file it replaced is
 * recovered from `<file>.1`, which is where a rename rotation leaves it. The bytes written into
 * the old file between the last look and the rename are exactly that tail, so an ordinary
 * rotation costs nothing at all: the line for the lost client is still found, still classified.
 *
 * What cannot be recovered is SAID rather than passed off as the app's silence: the view keeps a
 * list of gaps (`LOG_GAP_KINDS`), and a client absence with a gap behind it is classified
 * `unseen` (see `classifyLogLines`) — the absence is the log's, not the app's. The view is read
 * at the loss and at the grace's second look, not on a timer: the file is somebody else's, and
 * what has to survive is the reading, not a follower that polls it.
 *
 * Memory is bounded by `keepChars`; when the cap drops old lines, `dropped` is a gap like any
 * other, so an absence that may have scrolled out is not called the app's either.
 *
 * @param {string} file the app's own output, as the reader was told where it is
 * @param {{
 *   read?: (path: string) => string,
 *   keepChars?: number,
 *   now?: () => number,
 * }} [deps]
 * @returns {{
 *   file: string,
 *   sample: () => { text: string, present: boolean, gaps: { kind: string, at: number }[] },
 *   state: () => { text: string, present: boolean, gaps: { kind: string, at: number }[] },
 * }}
 */
export function startAppLogView(file, {
  read = (path) => readFileSync(path, "utf8"),
  keepChars = DEFAULTS.appLogKeepChars,
  now = () => Date.now(),
} = {}) {
  // Everything read so far, across every file this path has been. This is what a lookup is made
  // against: a line read before a rotation is still evidence after it.
  let kept = "";
  // The file as it stood at the previous look, so the next look can tell growth from replacement.
  let last = null;
  let present = false;
  let pendingMissingGap = null;
  const gaps = [];
  const note = (kind) => {
    const existing = gaps.find((gap) => gap.kind === kind);
    if (existing) return existing;
    const gap = { kind, at: now() };
    gaps.push(gap);
    return gap;
  };
  const keep = (chunk) => {
    if (typeof chunk !== "string" || chunk === "") return;
    kept += chunk;
    if (kept.length <= keepChars) return;
    // The newest `keepChars`, starting at a line the cap did not cut in half.
    const edge = kept.indexOf("\n", kept.length - keepChars);
    kept = kept.slice(edge === -1 ? kept.length - keepChars : edge + 1);
    note("dropped");
  };
  /**
   * The part of the file this one replaced, when a rename rotation left it behind as `<file>.1`.
   *
   * The rotated file has to START with what this view already read (it is the same file, renamed);
   * only then is the rest of it the lines written since the last look. A `.1` that does not is a
   * different era's file, and guessing from it would put somebody else's lines on this client.
   */
  const recover = () => {
    if (last === null) return false;
    let rotated;
    try {
      rotated = read(`${file}.1`);
    } catch {
      return false;
    }
    // An empty previous sample proves no prefix at all: `.1` may be an older rotation,
    // so treating any file as its continuation would import unrelated clients as evidence.
    if (last.length === 0 || typeof rotated !== "string" || !rotated.startsWith(last)) return false;
    keep(rotated.slice(last.length));
    // If we observed the brief interval between rename and create, this verified `.1` tail
    // proves that no output was lost during that interval. Remove only that pending gap.
    if (pendingMissingGap !== null) {
      const index = gaps.indexOf(pendingMissingGap);
      if (index >= 0) gaps.splice(index, 1);
      pendingMissingGap = null;
    }
    return true;
  };
  const sample = () => {
    let text = null;
    try {
      text = read(file);
    } catch {
      text = null;
    }
    if (typeof text !== "string") {
      // Not there this time: between a rename and the new file, or a deploy that stopped writing.
      // Either way what was read is kept, and the absence of a client in it says nothing.
      present = false;
      if (last !== null && pendingMissingGap === null) pendingMissingGap = note("missing");
      return { text: kept, present, gaps: [...gaps] };
    }
    if (!present && last !== null) {
      // A read missed the interval between rename and create. Recover the old file's tail
      // before treating the returned path as a new file; do this even when the new file is
      // empty, where a plain prefix comparison would otherwise mistake it for truncation.
      // Without a verified `.1`, keep the missing gap and still reset the comparison baseline
      // so the new file is read from its beginning rather than compared to an unrelated era.
      recover();
      last = "";
    }
    present = true;
    if (last === null) {
      keep(text);
    } else if (text === last) {
      // Unchanged since the last look.
    } else if (text.startsWith(last)) {
      // Grew: the ordinary case, and the delta is all that is new.
      keep(text.slice(last.length));
    } else if (text.length < last.length && last.startsWith(text)) {
      // Cut back to something it already said, including the empty file. The bytes between the
      // two are gone, and they may have been lines this view never read. Advance the baseline
      // to this shorter prefix so the next append is captured as growth instead of being
      // compared forever against the pre-truncation file.
      note("truncated");
      last = text;
    } else {
      // Replaced: a rename rotation (the old file is `<file>.1`), or a truncation with fresh
      // content. The recovered tail closes the rotation without a gap; without it, one is said.
      if (!recover()) note("rotated");
      keep(`${kept === "" || kept.endsWith("\n") ? "" : "\n"}${text}`);
    }
    last = text;
    return { text: kept, present, gaps: [...gaps] };
  };
  return { file, sample, state: () => ({ text: kept, present, gaps: [...gaps] }) };
}

/**
 * The supervisor this soak runs, as a path. Read lazily and defensively: this
 * module is imported by a test file as well as being run as a script, and a
 * runner that hands it a module URL that is not a file URL should not be able to
 * stop the file being imported at all.
 */
function startScript() {
  try {
    return fileURLToPath(new URL("./start.mjs", import.meta.url));
  } catch {
    return join(process.cwd(), "scripts", "start.mjs");
  }
}

/** The three traffic phases, in the order that exercises each branch in turn. */
export const PHASES = ["busy", "trickle", "quiet"];

export const DEFAULTS = {
  reloads: 30,
  path: "/",
  windowMs: 6_000,
  minMs: 1_500,
  proof: 3,
  // The busy phase exists to be EVIDENCE — enough real connections for the app's
  // traffic to shorten the window and prove the replacement — and not a load test.
  // Measured, against this repository's own build: forty requests a second of a real
  // SSR page saturates the app on one machine, and so does a mere handful of
  // CONCURRENT ones, after which every answer times out, the replacement cannot pass
  // its health check inside the window, and the supervisor rolls back correctly for
  // a reason that has nothing to do with a leak. `--busy-rate` and
  // `--max-in-flight` raise both where the app and the machine can take it.
  busyRate: 8,
  // How many requests may be outstanding at once, whatever the rate. This is the
  // knob that matters: an app that takes half a second per page and is asked for
  // eight a second is a handful of connections in flight, and a client that opens
  // sixty against a server that cannot serve them measures the client.
  maxInFlight: 4,
  trickleGapMs: 4_000,
  settleMs: 700,
  // See `handleTrendProblems`: the slack is applied to a floor that the reading
  // itself and the halves comparison have already taken the churn out of, and 8 is
  // measured against a judged-statistic spread of 0–3 over a twelve-reload soak.
  handleSlack: 8,
  // How long a reload may take, from the ask to its record, before the soak calls
  // it stuck. A record is written when the reload CONCLUDES, and the three things
  // between the ask and that moment are all allowed to be slow: the replacement's
  // own boot (up to the supervisor's 30s probe, and measured at 12–17s for this
  // repository's own build on the machine the soak was written on), the window the
  // way back is kept, and the audited stop of the run it replaced. This is a
  // TIMEOUT, so being generous costs nothing on the reloads that are quick.
  recordBudgetMs: 60_000,
  // How long a request through the door may take before the soak calls it hung.
  // A real page under a real build can take a second on a cold route; what this is
  // looking for is a connection that never gets an answer at all.
  requestTimeoutMs: 8_000,
  // How long ONE attempt at the readiness check may go unanswered before it is
  // abandoned and asked again. Every other request this file makes has a clock of
  // its own; this one did not, so a door holding the connection open would hang the
  // loop that the 30s deadline below is meant to end — and a door holding a
  // connection open on purpose is exactly what the fixture's loss knobs are (see
  // `FAKE_STALL_RUNS` in tests/fixtures/prod-death-server.mjs). Generous enough that
  // a real app's cold first page is not mistaken for one: it is asked again rather
  // than called a failure.
  readyAttemptMs: 5_000,
  // How wide the band around the instant the port changed hands is, when asking
  // which clients were AT the swap: a request that was opened within this many
  // milliseconds of it either way is one the swap is answerable for. See
  // `swapProblems` for why it is a band and not the single instant.
  swapBandMs: 500,
  // How long the connection held across a swap may go unanswered once the run it
  // was piped to has been stopped, before the soak calls the socket stuck rather
  // than ended. The door tears a client's socket down when its upstream ends, so
  // this is the shape of a door that did not.
  holdEndMs: 3_000,
  // How often the watch looks at the deploy's history for a reload that has
  // landed. A record is the ONLY thing that says a swap happened — the port never
  // closes and nothing else reports it — so this is how live the watch is: the
  // line for a swap appears within a poll of the record that describes it.
  watchPollMs: 200,
  // How long a connection the watch has stopped holding is still asked about. A
  // record lands AFTER the swap it describes, so the connection that was open
  // across that swap has already ended by the time the watch reads about it, and
  // a swap is judged against the connection that was open at its instant rather
  // than against whatever is open now.
  heldKeepMs: 60_000,
  // How often the pool checks that it is still holding a connection, and opens
  // one if it is not — a run that died, a door that answered 503 with nothing
  // behind it, a connection the run it was piped to retired.
  heldPollMs: 250,
  // How long a client the app's own output says nothing about is given a second look before
  // the watch calls that silence the app's. The app's lines reach the file through somebody
  // else's pipe while the loss is read from a record a different process wrote, so "not there
  // yet" and "never written" are one short wait apart. Paid only when a swap cost a client AND
  // the output has no line for it — the rare case, not the poll.
  appLogGraceMs: 500,
  // How much of the app's own output the watch KEEPS as it reads it. The file is read at each
  // loss rather than followed, so what lets a loss survive the file being rotated or truncated
  // is this copy of everything already read, capped so a long deploy cannot grow the watch's
  // memory with its log. Lines older than this are a `dropped` gap (see `startAppLogView`), so
  // a client that may have scrolled out is `unseen` rather than absent.
  appLogKeepChars: 2_000_000,
  // How long a port that should be free may still refuse a bind before that
  // counts: a stopped process's port is released when its socket closes, and a
  // closed socket is not always gone from the OS in the same millisecond.
  portWaitMs: 4_000,
  // How long to wait for a sample of the supervisor's state taken AFTER a reload
  // concluded, where reading it costs a subprocess (Windows).
  sampleWaitMs: 6_000,
  // How long a descendant count that has not come back down to the baseline is
  // given before it is called a leak, so a process that is mid-stop is not one.
  descendantGraceMs: 3_000,
  // How many readings a reload's observation is the lowest of, so that what is
  // held only while a request is in flight is not read as what is held for good.
  sampleCount: 3,
};

/**
 * The phase each reload runs, cycling through the list — the soak's whole
 * schedule, as data, so what a run did can be read back from its summary.
 *
 * @param {number} reloads
 * @param {string[]} [phases]
 * @returns {string[]}
 */
export function planPhases(reloads, phases = PHASES) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("a soak needs at least one traffic phase");
  }
  const unknown = phases.filter((phase) => !PHASES.includes(phase));
  if (unknown.length) {
    throw new Error(`unknown phase(s): ${unknown.join(", ")} (have ${PHASES.join(", ")})`);
  }
  return Array.from({ length: reloads }, (_unused, index) => phases[index % phases.length]);
}

/**
 * What a phase means to the traffic driver: a rate to hold, a gap between single
 * connections, or nothing at all.
 *
 * @param {string} name
 * @param {{ busyRate?: number, trickleGapMs?: number }} [options]
 * @returns {{ name: string, kind: "rate" | "gap" | "none", perSecond: number, gapMs: number }}
 */
export function phaseTraffic(name, { busyRate = DEFAULTS.busyRate, trickleGapMs = DEFAULTS.trickleGapMs } = {}) {
  if (name === "busy") return { name, kind: "rate", perSecond: busyRate, gapMs: 0 };
  if (name === "trickle") return { name, kind: "gap", perSecond: 0, gapMs: trickleGapMs };
  if (name === "quiet") return { name, kind: "none", perSecond: 0, gapMs: 0 };
  throw new Error(`unknown phase: ${name}`);
}

/**
 * The command line, as options — or a thrown Error naming what is wrong with it.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = {
    reloads: DEFAULTS.reloads,
    phases: [...PHASES],
    port: 0,
    path: DEFAULTS.path,
    windowMs: DEFAULTS.windowMs,
    minMs: DEFAULTS.minMs,
    proof: DEFAULTS.proof,
    busyRate: DEFAULTS.busyRate,
    trickleGapMs: DEFAULTS.trickleGapMs,
    requestTimeoutMs: DEFAULTS.requestTimeoutMs,
    maxInFlight: DEFAULTS.maxInFlight,
    settleMs: DEFAULTS.settleMs,
    handleSlack: DEFAULTS.handleSlack,
    attach: null,
    history: null,
    serverLog: null,
    daemon: null,
    swaps: 0,
    waitMs: 0,
    requireSwap: false,
    alert: null,
    server: null,
    dir: null,
    trend: null,
    json: false,
    help: false,
  };
  const numbers = {
    "--reloads": "reloads",
    "--attach": "attach",
    "--swaps": "swaps",
    "--wait": "waitMs",
    "--port": "port",
    "--window-ms": "windowMs",
    "--min-ms": "minMs",
    "--proof": "proof",
    "--busy-rate": "busyRate",
    "--max-in-flight": "maxInFlight",
    "--trickle-gap-ms": "trickleGapMs",
    "--request-timeout-ms": "requestTimeoutMs",
    "--settle-ms": "settleMs",
    "--handle-slack": "handleSlack",
  };
  /** Every flag the caller actually named, so a mode can refuse the other one's knobs. */
  const given = new Set();
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
    if (flag in numbers) {
      given.add(flag);
      const raw = take();
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${flag}: not a number: ${JSON.stringify(raw)}`);
      }
      options[numbers[flag]] = value;
      continue;
    }
    given.add(flag);
    switch (flag) {
      case "--history":
        options.history = take();
        break;
      case "--server-log":
        options.serverLog = take();
        break;
      case "--daemon":
        options.daemon = take();
        break;
      case "--require-swap":
        options.requireSwap = true;
        break;
      case "--alert":
        options.alert = alertDestination(take());
        break;
      case "--phases":
        options.phases = take()
          .split(",")
          .map((phase) => phase.trim())
          .filter(Boolean);
        break;
      case "--path":
        options.path = take();
        break;
      case "--server":
        options.server = take();
        break;
      case "--dir":
        options.dir = take();
        break;
      case "--trend":
        options.trend = take();
        break;
      case "--rearm-ms":
        // Removed WITH the re-arm itself. The connection the soak holds is the unfinished
        // head of a request, so nothing a run does ends it for being idle and there is
        // nothing left to re-arm (see `holdConnection`). Refused BY NAME rather than left
        // as an unknown option, so a caller whose script still passes it is told what
        // became of it instead of being left to wonder which spelling was wrong.
        throw new Error(
          "--rearm-ms: nothing to re-arm — the held connection is the unfinished head of a request, and no clock of a run's ends it for being idle",
        );
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (options.attach !== null) {
    // Watching a deploy in flight: the swaps are the deploy's and the load is
    // held against its door. Everything that only means something when this script
    // is the one asking for reloads is refused BY NAME rather than ignored, so a
    // caller cannot believe it asked for a soak.
    const watching = new Set([
      "--attach",
      "--history",
      "--server-log",
      "--daemon",
      "--swaps",
      "--wait",
      "--require-swap",
      "--alert",
      "--path",
      "--busy-rate",
      "--max-in-flight",
      "--request-timeout-ms",
      "--json",
      "-h",
      "--help",
    ]);
    const refused = [...given].filter((flag) => !watching.has(flag));
    if (refused.length > 0) {
      throw new Error(`${refused.join(", ")}: with --attach the reloads are the deploy's own, so a soak's schedule cannot be asked for`);
    }
    if (!(options.attach > 0)) throw new Error("--attach: the front door to watch is a port");
    if (options.history === null) {
      throw new Error("--attach: watching a deploy needs the history it writes its reloads to — pass --history <path> (its PROD_RELOAD_HISTORY)");
    }
    // A daemon is the one thing that cannot also be bounded by a count: the count
    // is a stopping condition, and a daemon's whole job is to not have one. Refused
    // by name rather than ignored, so a caller cannot believe it asked for a daemon
    // and get a five-swap watch that exited while the deploy was still going.
    if (options.daemon !== null && options.swaps > 0) {
      throw new Error(
        "--swaps: a daemon does not stop after a count of swaps — drop --swaps (a bounded watch is --swaps without --daemon) or drop --daemon",
      );
    }
    return options;
  }
  // A daemon log belongs to a watch: a soak performs the reloads itself, so there
  // is no somebody else's swap to append a line to, and naming a log without
  // --attach is a mistake rather than an option nobody needed.
  if (options.daemon !== null) {
    throw new Error(
      "--daemon: only a watch has swaps it did not perform, so a daemon log needs --attach <port> --history <path>",
    );
  }
  // Where the app's own output is belongs to a watch: a soak writes it beside its own account
  // (`server.log`, see `SERVER_LOG`) and reads it from there, so naming somewhere else is a
  // mistake rather than an option nobody needed.
  if (options.serverLog !== null) {
    throw new Error(
      "--server-log: a soak writes the app's own output beside its account as server.log, so there is nowhere else to look — it needs --attach <port> --history <path>",
    );
  }
  // Demanding proof belongs to a watch for a different reason: a soak's reloads are
  // its own, performed on a schedule it chose, and the account of them is judged by
  // what the records say rather than by what could be watched — a soak whose reload
  // changed nothing is already a failure there (`checkHistory`), so a flag that fails
  // a run with nothing to judge has nothing left to say in this mode.
  if (options.requireSwap) {
    throw new Error(
      "--require-swap: a soak performs its own reloads and judges their records, so there is no watch of somebody else's swaps to demand proof from — it needs --attach <port> --history <path>",
    );
  }
  // Paging belongs to a watch too, and more sharply: a soak that finds something is
  // run by a person looking at its output, while the watch is the thing standing in a
  // deploy.
  if (options.alert !== null) {
    throw new Error(
      "--alert: only a watch of somebody else's deploy pages somebody — it needs --attach <port> --history <path>",
    );
  }
  // The schedule is validated here rather than after a server has been started, so
  // a mistyped phase costs a usage line and not a supervisor.
  planPhases(options.reloads, options.phases);
  if (!(options.windowMs > 0)) throw new Error("--window-ms: a soak needs a rollback window to read");
  if (options.reloads < 1) throw new Error("--reloads: a soak performs at least one reload");
  return options;
}

/**
 * The history a soak produced, judged as the account of N reloads that all landed.
 *
 * The parse is the gate's own (`parseReloadHistory` with the writer's schema
 * constant), so a record this file accepts is one `npm run check:reload-history`
 * accepts — and a record it cannot read is a problem here for the same reason it
 * is a problem there: a pipeline cannot branch on a line nobody can parse.
 *
 * @param {string} text the history file's contents
 * @param {{
 *   expected: number,
 *   windowMs: number,
 *   proof: number,
 *   frontPort?: number | null,
 *   windowSlackMs?: number,
 * }} options
 * @returns {{ entries: ReturnType<typeof parseReloadHistory>["records"], problems: string[] }}
 */
export function checkHistory(text, { expected, windowMs, proof, frontPort = null, windowSlackMs = 1_500 }) {
  const { records: entries, unreadable } = parseReloadHistory(text, { schema: RELOAD_HISTORY_SCHEMA });
  const problems = [];
  for (const bad of unreadable) problems.push(`history line ${bad.line} is unreadable: ${bad.reason}`);
  if (entries.length !== expected) {
    problems.push(`the history holds ${entries.length} record(s), not the ${expected} reloads that were asked for`);
  }
  let previousAt = null;
  entries.forEach((entry, index) => {
    const { record } = entry;
    const at = `record ${index + 1}`;
    const verdict = OUTCOME_VERDICT[record.outcome ?? ""] ?? null;
    if (verdict === null) {
      problems.push(`${at}: outcome ${JSON.stringify(record.outcome)} is not one this build knows`);
    } else if (!verdict.landed) {
      problems.push(`${at}: ${verdict.word} — a soak of a healthy server has no reload to undo (${verdict.why})`);
    }
    if (previousAt !== null && entry.atMs < previousAt) {
      problems.push(`${at}: landed at ${record.at}, before the record above it`);
    }
    previousAt = entry.atMs;
    if (Date.parse(record.startedAt ?? "") > entry.atMs) {
      problems.push(`${at}: started at ${record.startedAt} and landed at ${record.at}`);
    }
    if (record.windowMs !== windowMs) {
      problems.push(`${at}: windowMs ${JSON.stringify(record.windowMs)} is not the ${windowMs} the supervisor was given`);
    }
    if (record.proofConnections !== proof) {
      problems.push(`${at}: proofConnections ${JSON.stringify(record.proofConnections)} is not the ${proof} the supervisor was given`);
    }
    if (!Number.isInteger(record.replacementPort) || record.replacementPort <= 0) {
      problems.push(`${at}: no usable replacementPort (${JSON.stringify(record.replacementPort)})`);
    }
    if (frontPort !== null && record.frontPort !== frontPort) {
      problems.push(`${at}: frontPort ${JSON.stringify(record.frontPort)} is not the door's ${frontPort}`);
    }
    for (const field of ["served", "checks", "leftoverConnections"]) {
      const value = record[field];
      if (!Number.isInteger(value) || value < 0) {
        problems.push(`${at}: ${field} is ${JSON.stringify(value)}`);
      }
    }
    if (record.swappedAt === null || record.swappedAt === undefined) {
      problems.push(`${at}: no swappedAt, so no window was ever open`);
    } else if (!Number.isFinite(record.windowUsedMs)) {
      problems.push(`${at}: swapped in, but windowUsedMs is ${JSON.stringify(record.windowUsedMs)}`);
    } else if (record.windowUsedMs > windowMs + windowSlackMs) {
      // The window is re-read every tick, so it can overshoot by one: what it may
      // not do is run past the ceiling it was given by more than a tick.
      problems.push(`${at}: window used ${record.windowUsedMs}ms of a ${windowMs}ms ceiling`);
    }
    if (record.previousPort !== null && !Number.isInteger(record.previousPort)) {
      problems.push(`${at}: previousPort is ${JSON.stringify(record.previousPort)}`);
    }
  });
  return { entries, problems };
}

/**
 * The phase's own expectation, checked against what the record says happened.
 *
 * This is the soak's reason for cycling phases at all: the window is the app's
 * traffic's number, so a quiet phase must run to the ceiling with nothing arrived
 * in it, a trickle must not read as proof, and a busy one must have been SHORTENED
 * by the traffic rather than running to the clock it was given. A soak that
 * quietly measured the wrong thing — a driver that stopped sending, a phase that
 * never took effect — fails here instead of passing.
 *
 * The busy phase is not required to close on `traffic` specifically, and that is
 * measured rather than assumed. The window is re-decided every tick, but the ticks
 * are spaced by the health checks themselves, so a slow one stretches the window
 * by its own duration: measured on this repository's own build, its first reload
 * after a cold start served five connections and still closed on the clock, because
 * the first health check took four seconds and the deadline was only read after it.
 * What a busy reload has to show is therefore that the app's connections REACHED
 * the replacement and that the replacement stayed healthy through them — not how
 * long the supervisor took to notice. What it may not do is fail a check, which is
 * a replacement that was not healthy rather than a window at all.
 *
 * @param {{ record: { outcome?: string, closedBy?: string | null, served?: number, windowUsedMs?: number | null } }[]} entries
 * @param {string[]} phases one per record
 * @param {{ windowMs: number, proof: number, windowSlackMs?: number }} options
 * @returns {string[]}
 */
export function phaseProblems(entries, phases, { windowMs, proof, windowSlackMs = 1_500 }) {
  const problems = [];
  entries.forEach((entry, index) => {
    const phase = phases[index] ?? "?";
    const { closedBy, served = 0, windowUsedMs, outcome } = entry.record;
    const at = `reload ${index + 1} (${phase})`;
    if (phase === "busy") {
      if (closedBy !== "traffic" && closedBy !== "clock") {
        problems.push(`${at}: the replacement did not stay healthy under the app's traffic (closedBy ${JSON.stringify(closedBy)})`);
      }
      if (served < proof) {
        problems.push(`${at}: only ${served} connection(s) reached the replacement, fewer than the ${proof} a proof needs`);
      }
    }
    if (phase === "trickle") {
      if (closedBy !== "clock") {
        problems.push(`${at}: a trickle read as proof (closedBy ${JSON.stringify(closedBy)})`);
      }
      if (served >= proof) {
        problems.push(`${at}: ${served} connection(s) arrived on a ${DEFAULTS.trickleGapMs}ms gap inside a ${windowMs}ms window`);
      }
    }
    if (phase === "quiet") {
      if (closedBy !== "clock") {
        problems.push(`${at}: a window nothing arrived in was closed by ${JSON.stringify(closedBy)}`);
      }
      if (served !== 0) {
        problems.push(`${at}: ${served} connection(s) reached a window that was meant to have none`);
      }
      if (typeof windowUsedMs === "number" && windowUsedMs < windowMs - windowSlackMs) {
        problems.push(`${at}: a window with no traffic in it closed at ${windowUsedMs}ms, short of the ${windowMs}ms ceiling`);
      }
    }
    if (outcome !== "replaced") problems.push(`${at}: outcome ${JSON.stringify(outcome)}`);
  });
  return problems;
}

/**
 * What the supervisor's own log says about its kills.
 *
 * The mechanism audits every stop it performs and SAYS what it found (see
 * `terminate` in scripts/supervise.mjs): a tree gone with no survivors, a survivor
 * it then killed, or a process that outlived even a force kill — which is the one
 * line that admits the port may still be held. This reads that back, and also
 * insists the audit happened at all: a retirement with no line about the tree is a
 * stop nobody checked.
 *
 * @param {string} text the supervisor's output
 * @param {{ retirements: number }} options how many runs it should have retired
 * @returns {string[]}
 */
export function supervisorLogProblems(text, { retirements }) {
  const problems = [];
  const cleaned = String(text);
  const audited = cleaned.match(/tree gone — \d+ process\(es\), no survivors/g) ?? [];
  for (const line of cleaned.match(/tree gone — \d+ process\(es\), but \d+ survived: [^\n]*/g) ?? []) {
    problems.push(`the supervisor's own audit: ${line}`);
  }
  for (const line of cleaned.match(/still alive after a force kill: [^\n]*/g) ?? []) {
    problems.push(`a process outlived the kill: ${line}`);
  }
  if (cleaned.includes("the port may still be held")) {
    problems.push("the supervisor said a survivor may still be holding a port");
  }
  if (audited.length < retirements) {
    problems.push(
      `the supervisor reported ${audited.length} audited tree kill(s) for ${retirements} retirement(s): a stop that was never ` +
        "checked is a stop that could have left something behind",
    );
  }
  for (const line of cleaned.match(/its record could not be written[^\n]*/g) ?? []) {
    problems.push(`the history lost a record: ${line}`);
  }
  return problems;
}

/** A port is free when this process can bind it — the proof, rather than a guess. */
export function probePort(port, { host = "127.0.0.1" } = {}) {
  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;
    const settle = (free) => {
      if (settled) return;
      settled = true;
      try {
        probe.close(() => resolve(free));
      } catch {
        resolve(free);
      }
    };
    probe.once("error", () => settle(false));
    probe.once("listening", () => settle(true));
    probe.listen(port, host);
  });
}

/**
 * Every port that should be free, looked at again for a moment before any of them
 * is called held — because "the port is free" is the one leak check that does not
 * need to see the process that leaked it, on any platform, and a false accusation
 * would be worse than a slow one.
 *
 * @param {number[]} ports
 * @param {{
 *   waitMs?: number,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 *   probe?: (port: number) => Promise<boolean>,
 * }} [options]
 * @returns {Promise<{ free: number[], held: number[] }>}
 */
export async function checkPortsFree(ports, {
  waitMs = DEFAULTS.portWaitMs,
  sleepImpl = sleep,
  probe = probePort,
} = {}) {
  const unique = [...new Set(ports)].filter((port) => Number.isInteger(port) && port > 0);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const held = [];
    for (const port of unique) {
      if (!(await probe(port))) held.push(port);
    }
    if (held.length === 0) return { free: unique, held };
    if (Date.now() >= deadline) return { free: unique.filter((port) => !held.includes(port)), held };
    // Not yet, but the shape of the answer is already known: what a retry can
    // change is whether the port was merely still closing.
    await sleepImpl(Math.max(1, Math.min(250, deadline - Date.now())));
  }
}

/**
 * Whether the supervisor's descriptor count drifted upward over the soak.
 *
 * Descriptors are the one leak check whose instrument is noisier than the leak it
 * is looking for, and the noise is MEASURED: on this machine consecutive readings
 * of a supervisor that leaks nothing differ by up to 13 handles (15 under load),
 * because a retirement's own sockets and pipes take a moment to be released after its
 * process is gone. A single reading therefore cannot tell churn from a leak — and on a
 * LOADED machine a run of high readings can move the floor itself, observed once in
 * three twelve-reload runs of the real build on Windows, where the reading is sampled
 * rather than live.
 *
 * Two things fix that, and neither is a guess. Each reading is already the LOWEST
 * of several samples (see `observe`), which throws away what was held only
 * transiently; and what is compared is the lowest reading of the first half of a
 * phase's reloads against the lowest of the second. A leak raises that floor, while
 * churn can only ever raise one reading at a time — so a burst of noise has to
 * cover half a phase's readings, the whole soak apart, before it can look like a
 * leak. A phase with fewer than `minReadings` reloads is not judged at all, and
 * says so: a verdict is worth less than the truth about what was measured.
 *
 * The floors themselves are returned as numbers as well as as the sentence above:
 * `floors` is what the trend record carries, and a floor that rises BETWEEN runs is
 * the same signal over a longer time than the one this judges within a run
 * (scripts/check-soak-trend.mjs). The halves rule is declared here, once, so the two
 * cannot disagree about what a floor is.
 *
 * @param {Map<string, number[]>} readings descriptors observed, per phase, in order
 * @param {{ slack?: number, minReadings?: number }} [options]
 * @returns {{
 *   problems: string[],
 *   judged: string[],
 *   skipped: string[],
 *   floors: Record<string, { first: number, second: number }>,
 * }}
 */
export function handleTrendProblems(readings, { slack = DEFAULTS.handleSlack, minReadings = 4 } = {}) {
  const problems = [];
  const judged = [];
  const skipped = [];
  const floors = {};
  for (const [phase, values] of readings) {
    if (values.length < minReadings) {
      skipped.push(`${phase} (${values.length} reading(s))`);
      continue;
    }
    const half = Math.floor(values.length / 2);
    const first = Math.min(...values.slice(0, half));
    const second = Math.min(...values.slice(half));
    judged.push(`${phase} ${first}→${second}`);
    floors[phase] = { first, second };
    if (second - first > slack) {
      problems.push(
        `the ${phase} phase's lowest descriptor count rose from ${first} to ${second} across ${values.length} reload(s) — ` +
          `more than the ${slack} allowed, so something is not being released (series: ${values.join(", ")})`,
      );
    }
  }
  return { problems, judged, skipped, floors };
}

/**
 * @typedef {{
 *   requests: number,
 *   byStatus: Record<string, number>,
 *   timeouts: number,
 *   errors: number,
 *   byPhase: Record<string, number>,
 *   answers: {
 *     phase: string,
 *     startedAt: number,
 *     connectedAt: number | null,
 *     finishedAt: number,
 *     opened: number | null,
 *     status: number | null,
 *     error?: string | null,
 *   }[],
 * }} TrafficStats
 *
 * `opened` is the ordinal this client was handed to the door at — taken when its connection was
 * ESTABLISHED, which is the moment the door's queue received it — and it is carried TWICE:
 * here, as the tie-break the account's order is read with (see `byAccept` in `swapProblems`),
 * and on the request the client asks with (`_client=` on the path), so the run the door hands
 * it to can see which client of the door's queue it was — which is what lets a fixture's own
 * count of the clients it was handed be read against this account (`spent[].client`).
 */

/**
 * Traffic through the front door, in the phase it is told to be in.
 *
 * A client that keeps asking and remembers every answer, with a timeout per
 * request: a connection the door accepted and never answered (a piped socket
 * leaked or half-closed) is a finding here, and so is any answer that is not the
 * app's own — the door's 503 while nothing is behind it, or anything else.
 *
 * `setPhase` takes effect at the next tick, which is what lets the soak turn the
 * traffic down BEFORE it asks for a reload: the window a reload opens is measured
 * from the connections that arrive inside it, so the phase has to be already
 * running when the swap happens.
 *
 * Every client this hands over carries the ORDINAL it was handed over at, in the request
 * itself (`_client=N`, the same number `opened` holds), and the ordinal is taken when the
 * connection is established rather than when the request was fired — the instant the door's
 * queue received it, which is what makes it an ordinal of the door rather than of this loop.
 * Riding on the request is the only way a run can be told which client of the door's queue it
 * was given, so a run that counts the clients it was handed — which is how the fixture names
 * the one a loss shape spends (`FAKE_AFTER_CLIENTS` in tests/fixtures/prod-death-server.mjs)
 * — can say WHICH client it spent in the same terms the account does. The marker is appended
 * to the path the driver asks for, the way this tooling's other marker is (`SELF_MARKER` in
 * scripts/supervise.mjs, which the door strips before its warm list reads a line), so it
 * changes no route and no query the path already had.
 *
 * @param {number} port
 * @param {{
 *   path?: string,
 *   busyRate?: number,
 *   trickleGapMs?: number,
 *   requestTimeoutMs?: number,
 *   maxInFlight?: number,
 *   phase?: string,
 * }} [options]
 * @returns {{ stats: TrafficStats, setPhase: (name: string) => void, stop: () => Promise<TrafficStats> }}
 */
export function startTraffic(port, {
  path = DEFAULTS.path,
  busyRate = DEFAULTS.busyRate,
  trickleGapMs = DEFAULTS.trickleGapMs,
  requestTimeoutMs = DEFAULTS.requestTimeoutMs,
  maxInFlight = DEFAULTS.maxInFlight,
  phase = "quiet",
} = {}) {
  let current = phaseTraffic(phase, { busyRate, trickleGapMs });
  let running = true;
  let inFlight = 0;
  let credit = 0;
  /** @type {TrafficStats} */
  const stats = { requests: 0, answers: [], byStatus: {}, timeouts: 0, errors: 0, byPhase: {} };

  // When each request began, when the door accepted its connection, and when its
  // answer arrived: the three instants a swap is judged against. They are taken
  // here rather than counted anywhere, because the question the swap asks is not
  // how many requests were answered but WHICH ONES were in a client's hands when
  // the port changed — a connection the door accepted before the swap and answered
  // after it is the whole claim, and no total can say which of these it was.
  // The path a client asks for, with the ordinal it is being handed over at ON it: a query
  // is one `?` followed by `&`-separated parts, so a path that already carries one keeps it.
  const asked = (ordinal) => `${path}${path.includes("?") ? "&" : "?"}_client=${ordinal}`;

  /**
   * How many clients have been HANDED to the door — the ordinals, in the order the door's
   * queue received them (see the `connect` handler below, and `fire`).
   */
  let handed = 0;

  const request = (phaseName, startedAt) =>
    new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1");
      let text = "";
      let settled = false;
      let connectedAt = null;
      let opened = null;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve({ phase: phaseName, startedAt, connectedAt, finishedAt: Date.now(), opened, ...result });
      };
      const timer = setTimeout(() => done({ status: null, error: "timeout" }), requestTimeoutMs);
      timer.unref?.();
      socket.on("connect", () => {
        connectedAt = Date.now();
        // WHICH client this is, as the ordinal the door was handed it at — counted HERE, at the
        // instant the connection is ESTABLISHED, because that is the instant the door's queue
        // received it: the kernel queues a connection and answers the SYN as one step, so the
        // order these fire in is the order the door accepts them in. Counting at FIRE time
        // instead is only a proxy for it, and one that is measurably wrong: a real soak through
        // the front door had 2 of one run's 127 clients arrive in the reverse of the order they
        // were fired, while the order their connections were established in was the order they
        // arrived. (Answers are recorded when they SETTLE, which is an order the door's own
        // clients can come back in a different one of — see `byAccept` in `swapProblems`.)
        opened = (handed += 1);
        socket.write(`GET ${asked(opened)} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      });
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.on("error", (error) => done({ status: null, error: String(error?.code ?? error) }));
      socket.on("close", () => {
        const line = /^HTTP\/1\.1 (\d{3})/.exec(text);
        done(line ? { status: Number(line[1]) } : { status: null, error: "no status line" });
      });
    });

  const record = (result) => {
    stats.answers.push(result);
    const key = result.status === null ? `!${result.error}` : String(result.status);
    stats.byStatus[key] = (stats.byStatus[key] ?? 0) + 1;
    stats.byPhase[result.phase] = (stats.byPhase[result.phase] ?? 0) + 1;
    if (result.error === "timeout") stats.timeouts += 1;
    else if (result.status === null) stats.errors += 1;
  };

  const fire = (phaseName) => {
    if (inFlight >= maxInFlight) return;
    inFlight += 1;
    // The REQUEST count, which is how much traffic there was rather than which client this is:
    // what identifies a client is the ordinal it is handed over at, taken when its connection is
    // established (see `request`). `stats.requests` counts the requests this driver asked for, so
    // it is bumped here — including one whose connection never came up, which has no ordinal at
    // all rather than somebody else's.
    stats.requests += 1;
    request(phaseName, Date.now())
      .then(record)
      .finally(() => {
        inFlight -= 1;
      });
  };

  const loop = (async () => {
    while (running) {
      const spec = current;
      if (spec.kind === "none") {
        await sleep(100);
        continue;
      }
      if (spec.kind === "gap") {
        fire(spec.name);
        await sleep(spec.gapMs);
        continue;
      }
      // The rate is honoured exactly rather than per tick, because a rate below
      // ten a second IS one request every so often, and rounding it up to one per
      // tick would make `--busy-rate 1` ten times what it says.
      const tick = 100;
      credit += (spec.perSecond * tick) / 1000;
      const batch = Math.floor(credit);
      credit -= batch;
      for (let i = 0; i < batch; i += 1) fire(spec.name);
      await sleep(tick);
    }
  })();

  return {
    stats,
    setPhase: (name) => {
      current = phaseTraffic(name, { busyRate, trickleGapMs });
    },
    stop: async () => {
      running = false;
      await loop;
      // Anything still in flight is given its own timeout to land, so the count
      // of answers is the count of requests.
      const deadline = Date.now() + requestTimeoutMs + 500;
      while (inFlight > 0 && Date.now() < deadline) await sleep(25);
      return stats;
    },
  };
}

/** A client's answer, said in the words the client would use. */
function describeAnswer(answer) {
  if (answer?.status !== null && answer?.status !== undefined) return `was answered ${answer.status}`;
  if (answer?.error === "timeout") return "was never answered (the door took the connection and hung)";
  if (answer?.error === "no status line") return "was closed with no answer at all";
  return `was refused (${answer?.error ?? "unknown"})`;
}

/**
 * A count as the word a reader would say it with: 1st, 2nd, 3rd, 11th.
 *
 * Exported because a PLACE is not the only thing said in these words: the ordinal a client was
 * handed over at is read out in the same voice by whoever prints a loss (`describeSpent` here,
 * and the timeline `soak:diagnose` builds out of the same evidence), so the one reader that
 * spells those places spells this too rather than growing a second way of saying "63rd".
 */
export function ordinal(n) {
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/**
 * WHICH client a swap cost, as a clause a person reads.
 *
 * `lost` is a count, and a count does not say which client it was of the ones the swap is
 * answerable for — the difference between "a client was lost" and "the third client it took was
 * lost". Two readings of that, and this says both when the account can:
 *
 *   - which one it was of the clients the swap had AT THE DOOR, in the order the door accepted
 *     them, which is the set the loss is a rate of (see `doorAllowance`) and the only set a
 *     single swap can be asked about on its own;
 *   - which one it was of the clients the RUN it went to was handed, which is the reading the
 *     failure is usually about ("that deploy cost the second client it served its answer") and
 *     which needs the run's own tenure, so it is `null` when the account does not name both ends
 *     of that tenure (see `handedRun`, and `swapProblems` for what a caller has to pass).
 *
 * The two are different denominators and are never mixed: a rate is taken over the door's clients
 * (`clientsAtTheDoor`) and a client's ORDINAL is taken over the clients of the run it was handed
 * to, which the account reads from the swap instants alone.
 *
 * A place is not a NAME, and the entry carries one of those too: `client` is the ordinal the client
 * was handed to the door at (see `swapProblems`), which is what a person correlating this account
 * with the run's own log of the clients it was handed looks it up by. This clause does not recite
 * it — a reader acting on a finding acts on where the client was, and the places are those — so
 * the handle stays in the evidence rather than being repeated inside this clause. It is spoken
 * one level up instead, by `nameSpent`, which is what BOTH readers that put a lost client in front
 * of a person use: the watch's live line (`describeSwap`) and the timeline `soak:diagnose` prints.
 * That is deliberate rather than convenient — a swap read as it lands and the same swap read out
 * of a downloaded account are one incident, so the client has to be named the same way in both,
 * and the name has to be the handle the app's own log keys it by.
 *
 * @param {{
 *   client?: number | null,
 *   acceptedAt?: string | null,
 *   atTheDoor?: { nth: number, of: number } | null,
 *   handed?: { side: string, port: number | null, nth: number, of: number } | null,
 * } | null | undefined} spent one entry of a swap's `spent`
 * @returns {string} the clause, without a trailing comma
 */
export function describeSpent(spent) {
  const clauses = [];
  const door = spent?.atTheDoor ?? null;
  if (door !== null && Number.isFinite(door.nth) && Number.isFinite(door.of)) {
    clauses.push(`the ${ordinal(door.nth)} of the ${door.of} client(s) the swap had at the door`);
  }
  const handed = spent?.handed ?? null;
  if (handed !== null && Number.isFinite(handed.nth) && Number.isFinite(handed.of)) {
    const run = handed.side === "retired" ? "the run this swap retired" : "the run it handed them to";
    const port = handed.port === null || handed.port === undefined ? "" : ` (port ${handed.port})`;
    clauses.push(`the ${ordinal(handed.nth)} of the ${handed.of} client(s) ${run}${port} was handed`);
  }
  if (clauses.length === 0) return "a client the account names no place for";
  return clauses.join(" — ");
}

/**
 * A lost client's NAME, as the one handle both ends of a loss carry.
 *
 * `spent[].client` is the ordinal the client was handed to the door at, which is also the number
 * the client itself carried into the app: the traffic appends `_client=` to the path it asks with
 * (see `asked`), the request arrives with that query on it, and the app's own request log
 * therefore names this client by THIS number. So whoever reads a loss — the watch as the swap
 * lands, or `soak:diagnose` over a downloaded account afterwards — is given the ordinal, and can
 * find the client's lines in a log without opening the JSON to look the number up first.
 *
 * The absence is SAID rather than left as a hole where a handle would be, because a line naming
 * only the places reads the same whether the account never had an ordinal or the reader lost it —
 * and an account whose clients were not the traffic driver's carries `client: null` for them by
 * design (see `swapProblems`). The handle is the one fact here that is not about the door's own
 * band, so an account that does not name it is the one thing a reader correlating the two CANNOT
 * do, and it is spoken aloud.
 *
 * @param {number | null | undefined} client one `spent` entry's `client`
 * @returns {string} the name, ready to be followed by where the client was
 */
export function clientHandle(client) {
  return Number.isFinite(client)
    ? `the ${ordinal(client)} client handed to the door (\`_client=${client}\` in the app's own request log)`
    : "a client this account names no `_client=` ordinal for";
}

/**
 * One lost client as both readers name it: the handle it can be looked up by, then where it was
 * (see `clientHandle` and `describeSpent`).
 *
 * The two readers are the watch's live line (`describeSwap`, via `spentClause`) and the timeline
 * `soak:diagnose` prints (`reloadEvents`), and they use this one function rather than spelling a
 * name each, so an incident read during the deploy and the same incident read from the account
 * afterwards say the same words about the same client.
 *
 * @param {{ client?: number | null } | null | undefined} spent one entry of a swap's `spent`
 * @returns {string} the entry's clause
 */
export function nameSpent(spent) {
  return `${clientHandle(spent?.client)} — ${describeSpent(spent)}`;
}

/**
 * Which client of a run an answer was, as "the 2nd of the 23 that run was handed" — or `null`
 * when the account does not name both ends of the run's tenure.
 *
 * A run's clients are the connections the door accepted while that run was the one behind the
 * door, so the tenure is bounded by the swaps rather than by whatever answers a caller happens
 * to hold: the swap that handed the run the port (`handedAt` on the entry — `null` for the
 * beginning of the account, which is where the first run's tenure starts) and the one that took
 * it away (the swap that RETIRES it, or for the run a swap hands clients to, the next swap in
 * the list, or the end of the account). Both ends are read from the swaps the caller NAMES, so a
 * caller that names only this swap gets `null` rather than a count of its own window: a watch
 * judging one swap as it lands cannot say which client of a run it was, and says nothing instead
 * of something that would be true of a different set.
 *
 * The order is the order the door accepted them in, because that is what "the Nth client" can
 * only mean: a connection is accepted when it connects, before a byte of it is read, so the
 * instant the client saw its own `connect` is the door's own accept instant as the account can
 * know it. The run the answer went to is read off the same boundary the front door uses — a
 * connection accepted at or before the swap went to the run the swap RETIRED — which is the
 * rule `swapProblems` reads a client IN FLIGHT by, so the two cannot disagree about which run a
 * lost client belonged to.
 *
 * @param {object} answer the client whose place is asked for
 * @param {{
 *   swap: { index: number, phase: string, at: number, handedAt?: number | null, previousPort?: number | null, replacementPort?: number | null },
 *   position: number,
 *   swaps: object[],
 *   accepted: object[],
 *   openedAt: (answer: object) => number,
 * }} where the swap among the ones the caller named, and the answers in accept order
 * @returns {{ side: string, port: number | null, nth: number, of: number } | null}
 */
function handedRun(answer, { swap, position, swaps, accepted, openedAt }) {
  // No `handedAt` at all is a caller saying it does not know when this run got the port — a
  // watch, which judges one swap rather than the line of them a tenure is read between.
  if (!Object.hasOwn(swap, "handedAt")) return null;
  const retired = openedAt(answer) <= swap.at;
  const from = retired ? swap.handedAt : swap.at;
  const next = position + 1 < swaps.length ? swaps[position + 1].at : null;
  const to = retired ? swap.at : next;
  const clients = accepted.filter(
    (other) => (from === null || openedAt(other) > from) && (to === null || openedAt(other) <= to),
  );
  const at = clients.indexOf(answer);
  if (at === -1) return null;
  return {
    side: retired ? "retired" : "replacement",
    port: (retired ? swap.previousPort : swap.replacementPort) ?? null,
    nth: at + 1,
    of: clients.length,
  };
}

/**
 * What the front door did to the clients that were AT the swap.
 *
 * A swap is a pointer move: the port stays open, and what changes is which run a
 * NEW connection is piped to. So the claim a swap has to keep is about the clients
 * that had the port in their hands while it happened. Two things can go wrong
 * there, and neither is visible in a total: the door can cut a connection it had
 * already accepted (the client never gets its answer), or it can refuse a new one
 * (nothing is listening any more, which is the one thing a front door exists to
 * make impossible). Both read as a request that did not come back 200, at the
 * instant the port changed hands — which is why every answer is timed when it is
 * asked for and this is judged from those instants rather than from the statuses.
 *
 * The band is a window around the swap rather than the instant itself, and that is
 * a fact about clocks and connections rather than a convenience: a connection the
 * door accepts a few hundred milliseconds either side of the swap is one whose
 * answer crosses it, and the swap is what it is answerable for. A request IN FLIGHT
 * across it — open before, answered after — is the case the mechanism is built for
 * (it is piped to the run it was piped to, and the drain before the retirement is
 * the time it has to come back in), and it is reported as such.
 *
 * Evidence is part of the verdict, not a footnote: a phase that sends traffic has
 * to have had a client at the swap, and one that did not says so. A soak whose
 * traffic had stopped while it reloaded would otherwise pass this check by having
 * nothing to judge — the same failure the phase checks exist to catch.
 *
 * A loss is more than a count, so the evidence names WHICH client each one was as well: its
 * place in the order the door accepted the clients this swap had, and — when the swaps the
 * caller names bound the run's own tenure — its place among the clients that run was handed
 * (see `handedRun`, and `describeSpent` for the two readings). The list is in accept order, so
 * the lost clients of one swap read oldest first, and a caller that names the line of swaps
 * (the soak) gets the run's side while a caller that names one of them (the watch) gets `null`
 * there rather than a number read off a different set.
 *
 * Every place in that evidence is a place in the order the DOOR accepted its clients — the accept
 * instant, and the ordinal `startTraffic` handed a client over at for the clients that share one
 * (see `byAccept`) — so a burst of concurrent clients names the same client a slow, sequential run
 * would, and the order the answers came back in can never move a loss onto the wrong client.
 *
 * A place is a place in an order, and an order is only worth as much as the agreement about WHICH
 * client it is a place of — so each spent entry carries the client itself, as the ordinal it was
 * handed to the door at (`client`, the same number the client carried into the app as `_client=`
 * on the path, and the same one this file's own tie-break reads). That is the handle a run which
 * counts the clients it was handed can be read against: the fixture's `FAKE_AFTER_CLIENTS=N` spends
 * the Nth client a run is handed, and the account names that client's place (`handed.nth`) and the
 * client itself (`client`), so "the Nth client the fixture spent" and "the Nth client the account
 * says was lost" are two readings of ONE client rather than two orderings that happen to agree.
 * It is `null` for an account whose clients carry no such ordinal (a hand-made one), which is the
 * same shape `handed` takes when the account does not name both ends of a run's tenure.
 *
 * @param {{ status: number | null, error?: string | null, phase?: string, startedAt?: number, connectedAt?: number | null, finishedAt?: number, opened?: number | null }[]} answers
 *   every answer through the door, in ANY order — the places below are read from the instants
 *   (`connectedAt`, then `opened` for clients that share one), never from the order the array
 *   happens to be in, which is the order the answers settled rather than the order the door took them
 * @param {{
 *   index: number,
 *   phase: string,
 *   at: number,
 *   handedAt?: number | null,
 *   previousPort?: number | null,
 *   replacementPort?: number | null,
 * }[]} swaps one per reload that had one, in order. `handedAt` is the instant the door started
 *   handing this swap's retired run its clients (`null` for the beginning of the account), and
 *   its ABSENCE is a caller saying it does not know it — which is what stops the run's side of a
 *   loss from being read off whatever window that caller happens to hold.
 * @param {{
 *   bandMs?: number,
 *   requireAt?: string[],
 *   reported?: Set<unknown>,
 * }} [options] `reported` is an answer set the caller keeps across calls, so that a
 *   refusal is said once and at the first swap it can be attributed to rather than
 *   again at every later one. The soak passes nothing (all its swaps are judged at
 *   once); the swap watch, which judges one at a time as they land, passes the same
 *   set to every call.
 * @returns {{ problems: string[], evidence: { index: number, phase: string, at: number, band: number, inFlight: number, lost: number, spent: { client: number | null, acceptedAt: string, atTheDoor: { nth: number, of: number }, handed: { side: string, port: number | null, nth: number, of: number } | null }[] }[] }}
 */
export function swapProblems(answers, swaps, { bandMs = DEFAULTS.swapBandMs, requireAt = ["busy"], reported = new Set() } = {}) {
  const problems = [];
  const all = Array.isArray(answers) ? answers : [];
  // A connection's life: when it was asked for, when the door accepted it (the
  // instant the swap is about), and when its answer landed. `connectedAt` is null
  // for a connection that was refused, which is itself the finding below.
  const openedAt = (answer) => answer.connectedAt ?? answer.startedAt ?? 0;
  const endedAt = (answer) => answer.finishedAt ?? openedAt(answer);
  // WHOSE PLACE IS WHOSE, and why it is not the array's order. A client's place among the clients
  // of a swap is the order the DOOR accepted them in, and the instants are what says so: the array
  // itself is in the order the answers SETTLED in (every answer is recorded when its socket ends),
  // which is a fact about answers rather than about clients — the first client the door takes can
  // be the last one whose page comes back, and a reader that counted in that order would name the
  // wrong client for a loss the door is answerable for.
  //
  // A burst of clients routinely shares an accept instant to the millisecond, and there the ordinal
  // a client was HANDED OVER at is the tie-break (`opened` — taken when the connection is
  // ESTABLISHED, which is when the door's queue receives it, so it is the order the door accepts
  // them in rather than the order the requests were fired), because it is the only one that is
  // about the door rather than about the answers. An account that carries no such ordinal (a
  // hand-made one) keeps the order it was given, which is the best a reader can do.
  const opened = (answer) => (Number.isFinite(answer.opened) ? answer.opened : 0);
  const byAccept = (one, other) => openedAt(one) - openedAt(other) || opened(one) - opened(other);
  // The whole account in the order the door accepted it, which is what "the Nth client" is
  // counted in (see `handedRun`).
  const accepted = [...all].sort(byAccept);
  const evidence = [];
  swaps.forEach((swap, position) => {
    const band = all
      .filter((answer) => openedAt(answer) <= swap.at + bandMs && endedAt(answer) >= swap.at - bandMs)
      .sort(byAccept);
    const inFlight = all.filter((answer) => openedAt(answer) <= swap.at && endedAt(answer) >= swap.at);
    // WHICH clients the swap cost, in the order the door accepted them: the lost ones, each
    // with the two places it can be named by. Nothing is measured twice — this reads the same
    // band the findings below and the count below are read from — and a swap that lost nothing
    // says so with the empty list it has rather than with a field that is not there. The answer
    // itself is carried as far as the findings and dropped from the evidence, because what
    // names the client is where it was in the queue, not the request object it happened to be.
    const lost = band
      .map((answer, nth) => ({ answer, nth: nth + 1 }))
      .filter(({ answer }) => answer.status !== 200)
      .map(({ answer, nth }) => ({
        answer,
        // WHICH client, by the handle the run it was handed to has as well: the ordinal the
        // traffic driver handed it over at (see the marker in `asked`, and `startTraffic`).
        client: Number.isFinite(answer.opened) ? answer.opened : null,
        acceptedAt: new Date(openedAt(answer)).toISOString(),
        atTheDoor: { nth, of: band.length },
        handed: handedRun(answer, { swap, position, swaps, accepted, openedAt }),
      }));
    for (const answer of band) {
      if (answer.status === 200) continue;
      reported.add(answer);
      // …and the finding says which client it was as well as what happened to it, because a
      // count of lost clients is a fact about a number rather than about the client the swap
      // cost — "a client was lost" and "the third client this swap took was lost" are read
      // differently by whoever has to act on it.
      const lostHere = lost.find((entry) => entry.answer === answer);
      problems.push(
        `reload ${swap.index} (${swap.phase}): a client ${inFlight.includes(answer) ? "in flight across the port change" : "at the port change"} ` +
          `${describeAnswer(answer)}${lostHere === undefined ? "" : ` — ${describeSpent(lostHere)}`} — the front door holds the port and never closes it, so a swap may not cost a client its answer`,
      );
    }
    const spent = lost.map((entry) => ({
      client: entry.client,
      acceptedAt: entry.acceptedAt,
      atTheDoor: entry.atTheDoor,
      handed: entry.handed,
    }));
    evidence.push({
      index: swap.index,
      phase: swap.phase,
      at: swap.at,
      band: band.length,
      inFlight: inFlight.length,
      lost: spent.length,
      spent,
    });
  });
  for (const item of evidence) {
    if (!requireAt.includes(item.phase) || item.band > 0) continue;
    problems.push(
      `reload ${item.index} (${item.phase}): no client had a connection open within ${bandMs}ms of the port changing hands, so what the door does to ` +
        "a client at a swap was never exercised by this reload",
    );
  }
  // A refusal anywhere is a door that was not listening, which is not a thing that
  // is allowed to happen at all — a swap is only the most likely moment for it, so
  // the ones the swaps have not already spoken for are reported on their own.
  for (const answer of all) {
    if (reported.has(answer) || typeof answer.error !== "string") continue;
    if (!/ECONNREFUSED|ECONNRESET|EPIPE|ECONNABORTED/.test(answer.error)) continue;
    const near = evidence.find((item) => openedAt(answer) <= item.at + bandMs && endedAt(answer) >= item.at - bandMs);
    problems.push(
      `the front door ${describeAnswer(answer)}${near ? ` at reload ${near.index} (${near.phase})'s swap` : ""} — the port belongs to the door for the ` +
        "whole soak, so a client should never be refused it",
    );
  }
  return { problems, evidence };
}

/**
 * A connection through the front door that is HELD across a swap.
 *
 * The other half of what a swap claims cannot be measured from the door's own
 * totals or from a status count, because both of them are about connections the
 * door is finished with. The claim is about a connection it is NOT finished with: a
 * client that keeps its socket open — which is what a browser does, and the reason
 * a swap can be invisible to one — is piped to the run it was piped to when it
 * connected, and a swap does not move it. So this opens a socket to the door before
 * the reload is even asked for and keeps it open across the whole window, and hands
 * the whole account to `heldConnectionProblems` once the reload has concluded.
 *
 * WHAT "KEPT OPEN" MEANS HERE, and what it costs. A run may close a connection nobody is
 * using — its keep-alive clock is armed when a response FINISHES, measured at 6020ms
 * through this repository's own supervisor with the production fixture — and a
 * connection a run ends for its own reasons says nothing about the door. So the hold is
 * the head of a request whose terminating empty line never arrives: a run cannot
 * dispatch it (there is no request), cannot answer it (there is nothing to answer), and
 * cannot reach it with that clock (no response of its ever finishes). Nothing is written
 * into it after that head — there is no re-arm and nothing to keep alive — because the
 * clock a re-arm would have been written against is the one that ends a connection a run
 * is FINISHED with, which this one is not.
 *
 * The run's OTHER clock does reach it, at a time the app chooses, and that is the one
 * thing this shape is not immune to: `headersTimeout`, which a run applies to a request
 * whose head it never received the end of — and, measured here, to a connection it was
 * never asked anything on at all, so no shape is immune to it. Measured against a real
 * run: it gives up at the first check after that timeout and ANNOUNCES it rather than
 * closing quietly (`HTTP/1.1 408 Request Timeout`, then the close), which is ~90s of
 * holding against Node's defaults (a 60s clock, checked every 30s) and proportionally
 * sooner for an app that sets a tighter one. Two things follow, and both are the reason
 * the shape and the verdict are what they are: the hold has to be YOUNGER than that
 * clock for the whole time it is judged — it is, by an order of magnitude, in the soak at
 * least (a held connection lives one reload, ~10-20s, against the 64s budget one may take
 * and a 60s default clock) — and a run that did end it must be visible as the one that
 * did, which the 408 is (see `heldConnectionProblems`).
 *
 * The one question this connection ever asks is the one `stop` asks: it finishes the
 * head, and the answer — the run it stayed piped to, the door's 503, or the socket
 * simply ending with the retired run — is the `final` the record is judged against.
 * Everything the door says BEFORE that is unprompted, which is why `requests` normally
 * stays empty and why anything in it is recorded rather than assumed away: a refusal
 * written to a connection whose request was never finished is exactly the finding this
 * connection is here for.
 *
 * One connection per reload, and it is deliberately the client the mechanism's own
 * documentation names: a kept-alive one. The door counts a connection when it ACCEPTS
 * it, before a byte of the request has been read, so the question "was this client still
 * on the run it was piped to?" is answerable — from the door's own `leftoverConnections`
 * in the record — without the door ever having to look inside the connection, which it
 * does not do by design.
 *
 * Everything a real network does badly is handled as an answer rather than an
 * exception: a door that refuses the connection, a socket that is torn down, bytes
 * that never come. `accepted: false` is a finding in itself, and is reported as one
 * rather than being treated as a connection that behaved.
 *
 * @param {number} port the front door
 * @param {{
 *   path?: string,
 *   host?: string,
 *   holdEndMs?: number,
 *   connectImpl?: typeof connect,
 * }} [options]
 * @returns {Promise<{
 *   accepted: boolean,
 *   acceptedAt: number | null,
 *   endedAt: number | null,
 *   endedReason: string | null,
 *   requests: { at: number, status: number | null, error?: string | null }[],
 *   final: { at: number, status: number | null, error?: string | null } | null,
 *   stop: () => Promise<{ at: number, status: number | null, error?: string | null }>,
 * }>}
 */
export async function holdConnection(port, {
  path = DEFAULTS.path,
  host = "127.0.0.1",
  holdEndMs = DEFAULTS.holdEndMs,
  connectImpl = connect,
} = {}) {
  const held = {
    accepted: false,
    acceptedAt: null,
    endedAt: null,
    endedReason: null,
    requests: [],
    final: null,
    stop: async () => ({ at: Date.now(), status: null, error: "never held" }),
  };
  const socket = connectImpl(port, host);
  socket.setNoDelay?.(true);
  let buffer = "";
  let pending = null;
  const finish = (reason) => {
    if (held.endedAt === null) {
      held.endedAt = Date.now();
      held.endedReason = reason;
    }
    if (pending !== null) {
      const waiting = pending;
      pending = null;
      clearTimeout(waiting.timer);
      waiting.resolve({ status: null, error: reason });
    }
  };
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const end = buffer.indexOf("\r\n\r\n");
    if (end === -1) return;
    const head = buffer.slice(0, end);
    buffer = buffer.slice(end + 4);
    const line = /^HTTP\/1\.[01] (\d{3})/.exec(head);
    // Header only, because every request this makes is a HEAD: the status line IS
    // the answer, and there is no body to be read before the next one.
    const answer = line ? { status: Number(line[1]) } : { status: null, error: "no status line" };
    if (pending === null) {
      // The door answered a connection that had asked it nothing. It writes that
      // answer for one reason only — a refusal, because the run behind it is gone —
      // and it is recorded and judged like any other rather than being dropped:
      // losing it would be losing the finding this connection is held to catch.
      held.requests.push({ at: Date.now(), ...answer });
      return;
    }
    const waiting = pending;
    pending = null;
    clearTimeout(waiting.timer);
    waiting.resolve(answer);
  });
  socket.on("error", (error) => finish(String(error?.code ?? error)));
  socket.on("close", () => finish("closed"));
  // A peer that has finished its side of a connection has ended it, so the ending is
  // recorded on the FIN rather than waiting for the socket to be torn down a tick later:
  // the verdict reads the instant, and one tick is the difference between an ending and a
  // timeout for whoever asks immediately after (see `stop`).
  socket.on("end", () => finish("ended"));

  const accepted = await new Promise((resolve) => {
    socket.once("connect", () => {
      held.acceptedAt = Date.now();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  if (!accepted) {
    socket.destroy();
    return held;
  }
  held.accepted = true;

  /**
   * Write to the held socket, one write at a time and in order: the line that finishes
   * the head — written by `stop`, and only by `stop` — has to land INSIDE it, after the
   * head this hold wrote, whatever the two are doing to each other.
   */
  let queue = Promise.resolve(null);
  const send = (text) => {
    queue = queue.then(
      () =>
        new Promise((resolve) => {
          if (socket.destroyed || held.endedAt !== null) {
            resolve(held.endedReason ?? "closed");
            return;
          }
          socket.write(text, (error) => resolve(error ? String(error.code ?? error) : null));
        }),
    );
    return queue;
  };

  // The hold itself, and the whole of it: the head of a request whose terminating
  // empty line never arrives (see the note above), which is what makes the connection
  // one a run is waiting on rather than one it has rules about. It goes first so that
  // the connection is the run's from the first byte — the door pipelines it on accept —
  // and it is never finished until `stop` finishes it.
  await send(`HEAD ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n`);

  /**
   * The answer to the one question this connection ever asks: the caller has JUST
   * finished the head, and this resolves with what came back or with why nothing
   * did. `timeout` is the only answer that is not the connection ending, which is
   * the distinction the record reads it with.
   */
  const ask = (waitMs) =>
    new Promise((resolve) => {
      const at = Date.now();
      if (held.endedAt !== null || socket.destroyed) {
        resolve({ at, status: null, error: held.endedReason ?? "closed" });
        return;
      }
      const waiting = {
        timer: setTimeout(() => {
          if (pending === waiting) pending = null;
          resolve({ at, status: null, error: "timeout" });
        }, waitMs),
        resolve: (result) => resolve({ at, ...result }),
      };
      pending = waiting;
      send("\r\n").then((error) => {
        if (!error) return;
        if (pending === waiting) pending = null;
        clearTimeout(waiting.timer);
        resolve({ at, status: null, error });
      });
    });

  held.stop = async () => {
    if (held.endedAt !== null) {
      // The run it was piped to is gone and the door ended the connection with it,
      // which is what is supposed to happen: there is nothing to ask any more.
      held.final = { at: Date.now(), status: null, error: held.endedReason ?? "ended" };
    } else {
      // The one question, asked now and only now: the head is finished, and what
      // answers it — the run this connection stayed piped to, or the door — is the
      // answer the record is judged against.
      held.final = await ask(holdEndMs);
    }
    // ...and the ENDING this connection is judged on has to be settled before this
    // returns. A socket torn down here reports its close a tick later, and an ending is
    // divided from the door's own count by an instant (`heldConnectionProblems`), so a
    // connection that is still on its way to being closed when the verdict reads it
    // would be read as the other author's — the race this hold exists to be free of.
    // Waiting for the close is waiting for `finish`, which is what sets `endedAt`.
    if (held.endedAt === null) {
      await new Promise((resolve) => {
        let timer = null;
        const settled = () => {
          if (timer !== null) clearTimeout(timer);
          resolve(null);
        };
        timer = setTimeout(settled, 250);
        socket.once("close", settled);
        socket.once("error", settled);
        socket.destroy();
      });
    } else {
      socket.destroy();
    }
    return held.final;
  };
  return held;
}

/**
 * The instant the door read the leftover count its record reports.
 *
 * `windowUsedMs` is measured from the swap to the moment the reload's verdict landed,
 * and `leftoverConnections` is read at that same moment — before the drain and the
 * audited stop that follow it (see `reloadRecord`, and the retirement path in
 * `supervise.mjs`). So the record's own arithmetic says WHEN its count was true, on
 * the same clock the held connection's ending is measured on, which is the only thing
 * that makes the two comparable at all.
 *
 * @param {{ swappedAt?: string | null, windowUsedMs?: number | null }} record
 * @returns {number | null} when the count was taken, or null when the record names no
 *   instant the port changed hands
 */
export function leftoverCountInstant(record) {
  const swappedAt = Date.parse(String(record?.swappedAt ?? ""));
  if (!Number.isFinite(swappedAt)) return null;
  const windowUsedMs = Number(record?.windowUsedMs);
  return swappedAt + (Number.isFinite(windowUsedMs) && windowUsedMs > 0 ? windowUsedMs : 0);
}

/**
 * The held connection, judged against the claim it was opened to test.
 *
 * Three questions, in the order the connection lives through them. What was said to it
 * while the run it was piped to was serving — normally nothing at all, because this
 * connection asks nothing while it is held (see `holdConnection`) — and the two things
 * that can arrive unprompted come from opposite sides. The DOOR's own words: a 503 or
 * a refusal written to a connection whose request was never finished is a client the
 * door cost its answer, exactly as it would be on a connection that had asked for one.
 * Or the RUN's: its header timeout, giving up on a request head it never received the
 * end of — which it announces as a 408 rather than as a silent close (measured against
 * a real run, and through a real door), so a run that ended the connection is visible as
 * one and is never read as the door ending it. Did it
 * survive the swap and the whole window the swap opened (a connection the door had
 * already accepted may not be closed by a pointer move, and the run behind it is
 * still serving for the length of that window — a client holding the connection is
 * not a client of the replacement until the replacement is the only run left). And
 * was the run the door stopped still holding it: when the door retires a run it
 * reports how many connections were still on it, and a count of zero, while a client
 * was holding one that had been piped to it, says the held connection was moved or
 * dropped whatever its socket looked like from outside. That count is read at ONE
 * instant (`leftoverCountInstant`), and it speaks for this connection exactly while
 * the connection was still open at that instant: a run with no connection left on it
 * is what a count of zero should say, so a connection that had already ended by then
 * is not read against the count at all. That ending is judged instead, on the same
 * instant — and it is the door's, because the one clock of the run's that can reach this
 * shape says when it did (the 408 above) and a swap is a pointer move: a client that
 * keeps its connection is piped to the run it was piped to, and nothing behind the door
 * may cost it that connection inside the window the swap opened.
 *
 * Then the ending, which is the other half of the same claim. The run it was piped to
 * is gone, so the connection ends with it — a dead socket, a door 503 for a connection
 * whose upstream went away, either way NOT an answer from the replacement. An answer
 * from a run after that run's retirement is the door handing a client's established
 * connection to a server it never made a request to, which is exactly what piping per
 * connection is supposed to make impossible. Unless the run gave up on the request
 * first: its own header timeout ends the connection, and a run that ended it is not the
 * door ending it, so that ending is reported (the record says which one it was) rather
 * than laid at the door's feet.
 *
 * A reload that did not LAND as `replaced` has no retirement to judge the ending
 * against — the run this connection was piped to is still serving it, or the reload
 * never happened — so the ending checks are skipped there rather than guessing. That
 * reload is already a finding in its own right (`phaseProblems`), and its held
 * connection's answers are still judged: a door that cost a client an answer has done
 * it whatever became of the reload.
 *
 * @param {{
 *   accepted?: boolean,
 *   endedAt?: number | null,
 *   endedReason?: string | null,
 *   requests?: { status: number | null, error?: string | null }[],
 *   final?: { status: number | null, error?: string | null } | null,
 * } | null} held
 * @param {{
 *   outcome?: string | null,
 *   swappedAt?: string | null,
 *   windowUsedMs?: number | null,
 *   leftoverConnections?: number,
 *   previousPort?: number | null,
 * }} record
 * @param {{ index: number, phase: string }} where
 * @returns {string[]}
 */
export function heldConnectionProblems(held, record, { index, phase }) {
  const at = `reload ${index} (${phase})`;
  if (!held || held.accepted !== true) {
    return [
      `${at}: no connection could be held open through the door across the swap (${held?.endedReason ?? "it was never accepted"}), so what a client that ` +
        "keeps its connection is handed was never tested by this reload",
    ];
  }
  const problems = [];
  const swappedAt = Date.parse(String(record?.swappedAt ?? ""));
  if (!Number.isFinite(swappedAt)) {
    return [`${at}: the record names no instant the port changed hands, so the held connection cannot be judged against one`];
  }
  const requests = held.requests ?? [];
  // The one ending a RUN can give this connection, and it says so itself: the header
  // timeout a run applies to a request head it never received the end of. Measured —
  // against a real run with that timeout turned down and with its defaults, and through
  // a real front door — the run gives up at the first check after it (30s by default, so
  // ~90s of holding against Node's 60s default) and ANNOUNCES it, `HTTP/1.1 408 Request
  // Timeout` and then the close. It is the hold's own shape and not a client the door
  // cost an answer, so it is not pushed as a problem here; that it says WHICH ending this
  // was is what lets the ending below be laid at the door without hedging. (The door
  // forwards those bytes like any others, though a run that ends its socket abruptly can
  // still be reported by the door as its own 503 — the refusal a connection with nothing
  // behind it gets — which the checks already accept from the swap.)
  const gaveUp = requests.some((answer) => answer.status === 408);
  for (const answer of requests) {
    if (answer.status === 200 || answer.status === 408) continue;
    // The one answer the door is allowed to write to this connection unprompted: a
    // retry-503 for a connection whose run has gone, which is the discharge the
    // ending is judged by rather than an answer (a `final` of 503 is not the
    // replacement answering either). It is that answer alone, and only from the
    // instant the port changed hands — the run behind the door is still serving until
    // then, so a refusal before the swap is still the door costing a client its
    // answer, and so is anything else the door says however late it says it.
    if (answer.status === 503 && Number(answer.at) >= swappedAt) continue;
    problems.push(
      `${at}: the connection held across the swap ${describeAnswer(answer)} while the run it was piped to was serving — a client that keeps its ` +
        "connection is piped to the run it was piped to, and that run answers the app",
    );
  }
  if (record?.outcome !== "replaced" || record?.previousPort === null || record?.previousPort === undefined) return problems;
  const windowUsedMs = Number(record?.windowUsedMs);
  const window = Number.isFinite(windowUsedMs) && windowUsedMs > 0 ? windowUsedMs : 0;
  const countedAt = swappedAt + window;
  const ended = held.endedAt ?? null;
  // WHO ENDED IT: one rule, and nothing hedged around it. No clock of the run's ends
  // this connection for being idle — it is never idle, since nothing is written into it
  // after the head it holds the run with and no response of its ever finishes (see
  // `holdConnection`, where that is measured against a real run) — and the one clock of
  // the run's that DOES reach this shape announces itself rather than closing quietly (a
  // 408, `gaveUp` above). So there are two authors and one instant between them: until
  // the door took its count the run behind the door was serving this connection, and an
  // ending before that instant is the door closing a connection it had already accepted
  // — a finding, however early it comes — unless the run said the ending was its own.
  // An ending at or after the count is the ordinary shape of a swap that worked: the run
  // is stopped after the count is read, and the connection ends with it.
  if (ended !== null && ended < countedAt) {
    // The one case where this is the run's ending rather than the door's: the run gave up
    // on a request head it never received the end of, so the door did nothing and the
    // count (taken after the connection was already gone) says nothing about the run
    // either. Reported rather than pushed as a problem — the ending is the hold's own
    // shape, not a client the door cost an answer (see the note on `gaveUp`), and the
    // record and the line say which ending it was.
    if (!gaveUp) {
      const how = ended < swappedAt ? `${swappedAt - ended}ms BEFORE the port changed hands` : `only ${ended - swappedAt}ms into the ${window}ms window the swap opened`;
      problems.push(
        `${at}: the door closed a connection a client was holding ${how} — the run it was piped to was still serving it, and a swap is a pointer move, so it may ` +
          "not cost a client the connection it already has",
      );
    }
  } else {
    // The connection was open when the door counted — the ending came at or after that
    // instant, or never — so the run it was piped to must have been holding it: here
    // the count IS evidence, and zero is the finding. (Ending not at all means the door
    // moved the connection to the replacement instead.)
    const leftover = record?.leftoverConnections;
    if (!Number.isInteger(leftover) || leftover < 1) {
      problems.push(
        `${at}: the door reported ${JSON.stringify(leftover)} connection(s) still on the run it retired, while a client was holding one that had been piped ` +
          "to it — the held connection was moved off that run, or dropped, at the swap",
      );
    }
  }
  const final = held.final;
  if (final && final.status !== null && final.status !== 503) {
    problems.push(
      `${at}: a connection accepted before the swap was answered ${final.status} after the run it was piped to had been stopped — the door handed an ` +
        "established connection to the replacement instead of ending it with the run it was piped to",
    );
  }
  return problems;
}

/**
 * The schema of the lines the swap watch writes, so a pipeline reading them can
 * tell a change to what a line MEANS from a change to the numbers in it.
 */
export const SWAP_WATCH_SCHEMA = "base88.swap-watch/1";

/**
 * The phase name the watch judges its swaps under.
 *
 * The swap checks take a phase per reload because the soak cycles three of them;
 * a deploy has no phases at all, and one name is enough to say whose swap this is
 * in every message that comes out of them.
 */
const SWAP_PHASE = "deploy";

/**
 * A pool of ONE connection, held open through the front door, that keeps the
 * recent past so a swap can be asked what it had.
 *
 * The watch cannot choose when a deploy swaps, which changes what "a client held
 * across the swap" means: the connection has to be open BEFORE the swap, and the
 * only thing that says a swap happened is the record the deploy writes after it.
 * So one connection is kept alive continuously — re-opened the moment it ends,
 * which is what a retirement of the run it was piped to does — and every
 * connection is kept in a short list afterwards, so that the record arriving can
 * be matched to the connection that was open at ITS instant rather than to
 * whatever happens to be open now.
 *
 * Ending is expected and is not an error: a connection is piped to the run the
 * door was pointed at when it connected, and that run is retired at the end of
 * every swap's window. What the pool must never do is leave the watch with no
 * connection at all while a swap it cannot predict is coming, which is why a
 * connection that ended (or was never accepted, or was answered 503 by the door
 * itself because nothing was behind it) is replaced on the next tick.
 *
 * @param {number} port the deploy's front door
 * @param {{
 *   path?: string,
 *   keepMs?: number,
 *   pollMs?: number,
 *   hold?: typeof holdConnection,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 * }} [options]
 */
export function startHeldPool(port, {
  path = DEFAULTS.path,
  keepMs = DEFAULTS.heldKeepMs,
  pollMs = DEFAULTS.heldPollMs,
  hold = holdConnection,
  sleepImpl = sleep,
} = {}) {
  /** Every connection opened, oldest first. The ended ones are still asked about. */
  const entries = [];
  let running = true;
  let live = null;

  const loop = (async () => {
    while (running) {
      if (live === null || live.endedAt !== null) {
        try {
          const handle = await hold(port, { path });
          entries.push(handle);
          // A connection the door never accepted, or one it answered itself and
          // closed, is not one a run is serving: it is replaced, not held.
          live = handle.accepted === true && handle.endedAt === null ? handle : null;
        } catch {
          // The door is not answering a new connection at all. That is a finding on
          // somebody else's account (the watch reports a swap with nothing held),
          // and here it is only a reason to try again.
          live = null;
        }
      }
      const oldest = Date.now() - keepMs;
      while (entries.length > 0 && entries[0].endedAt !== null && entries[0].endedAt !== undefined && entries[0].endedAt < oldest) {
        entries.shift();
      }
      await sleepImpl(pollMs);
    }
  })();

  return {
    entries,
    /**
     * The connection a client had open at an instant: accepted at or before it and
     * not ended before it — the one a swap at that instant is answerable for. Null
     * when there was none, which is a fact about the watch rather than about the
     * door, and is reported as such.
     */
    across: (instant) => {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.acceptedAt === null || entry.acceptedAt === undefined) continue;
        if (entry.acceptedAt > instant) continue;
        if (entry.endedAt !== null && entry.endedAt !== undefined && entry.endedAt < instant) continue;
        return entry;
      }
      return null;
    },
    stop: async () => {
      running = false;
      await loop;
      for (const entry of entries) {
        if (entry.endedAt === null) await entry.stop?.();
      }
      return entries;
    },
  };
}

/**
 * One swap a deploy performed, as the watch saw it — the report a person reads and
 * the findings a pipeline branches on.
 *
 * The door's half is the same claim the soak makes (see `swapProblems`): no client
 * that had the port in its hands while it changed hands may be handed a 503 or a
 * refusal, and clients IN FLIGHT across the change are named as such. What is
 * different here is who decided to reload, and that shows up in three places. The
 * load is always on, so a swap with no client at the door is a finding for every
 * swap and not only for a phase with traffic in it. The connection judged against
 * it is the one that was open at its instant (the caller looks it up — see
 * `startHeldPool`), and no connection at all means the claim was not tested here.
 * And a swap that happened before the watch attached is reported as not judged: the
 * history a deploy keeps is its past, and judging the past on evidence nothing was
 * watching for is how a check starts lying.
 *
 * A deploy's own outcome is NOT a finding. The soak fails a reload that rolled
 * back or changed nothing, because a soak of a healthy server should have nothing
 * to undo; a deploy may legitimately do either, and the only thing this watch is
 * about is what the swap did to the clients. The outcome is reported, and
 * `heldConnectionProblems` skips the ending checks for it (there is no retirement to
 * judge an ending against when the door went back).
 *
 * A reload that never swapped the port at all is not a swap and is not a finding
 * either — it is the ABSENCE of one, and it is reported the way a pre-attach swap
 * is: not judged, with the reason, and no problem against the deploy's name. There
 * was no change at the door, so there is nothing about the door to fail, and a
 * watch that saw nothing but those ends as NOTHING_JUDGED (nothing to judge) rather
 * than as a failure. The line is drawn on the writer's own vocabulary: `swappedAt`
 * is null exactly when no window was ever open (see `reloadRecord`), so a record
 * with none has no door to be judged against, while an instant that IS there and
 * cannot be read is unreadable evidence rather than an absent swap — this watch
 * does not pass on a swap it cannot place.
 *
 * @param {{
 *   swappedAt?: string | null,
 *   outcome?: string | null,
 *   closedBy?: string | null,
 *   windowUsedMs?: number | null,
 *   leftoverConnections?: number | null,
 *   previousPort?: number | null,
 * }} record one line of the deploy's history
 * @param {{
 *   index: number,
 *   attachedAt: number,
 *   answers?: object[],
 *   held?: object | null,
 *   bandMs?: number,
 *   reported?: Set<unknown>,
 * }} context
 * @returns {{ judged: boolean, report: Record<string, unknown>, problems: string[] }}
 */
export function watchedSwap(record, { index, attachedAt, answers = [], held = null, bandMs = DEFAULTS.swapBandMs, reported = new Set() } = {}) {
  const at = Date.parse(String(record?.swappedAt ?? ""));
  const report = {
    schema: SWAP_WATCH_SCHEMA,
    swap: index,
    swappedAt: record?.swappedAt ?? null,
    outcome: record?.outcome ?? null,
    closedBy: record?.closedBy ?? null,
    windowUsedMs: record?.windowUsedMs ?? null,
    leftoverConnections: record?.leftoverConnections ?? null,
    judged: false,
    held: null,
    problems: [],
  };
  if (!Number.isFinite(at)) {
    if (record?.swappedAt === null || record?.swappedAt === undefined) {
      // No instant because there was never a swap: `swappedAt` is null exactly when
      // no window was ever open, which is what a reload that changes nothing leaves
      // behind. Nothing about the door is claimed, so nothing about the door can
      // fail — the record is reported and the verdict is left to the swaps that did
      // land. A deploy that performs no swap at all therefore ends as
      // NOTHING_JUDGED (2) rather than as a failure (1).
      report.why = `the reload never swapped the port (${record?.outcome ?? "no outcome"}) — no window was ever open, so there was no change at the door to judge`;
      return { judged: false, report, problems: [] };
    }
    // An instant that is there and cannot be read is the other thing entirely:
    // unreadable evidence, not an absent swap. The watch says so rather than
    // passing a swap it cannot place.
    const problems = [
      `swap ${index}: the record claims a swap at an instant that cannot be read (${JSON.stringify(record.swappedAt)}), so nothing can be said about what the door did`,
    ];
    report.why = "the record claims a swap at an instant that cannot be read";
    report.problems = problems;
    return { judged: false, report, problems };
  }
  if (at < attachedAt) {
    report.why = "the port changed hands before the watch attached";
    return { judged: false, report, problems: [] };
  }
  const problems = [];
  const door = swapProblems(answers, [{ index, phase: SWAP_PHASE, at }], { bandMs, requireAt: [SWAP_PHASE], reported });
  problems.push(...door.problems);
  report.atTheDoor = door.evidence[0] ?? { index, phase: SWAP_PHASE, at, band: 0, inFlight: 0, lost: 0 };
  if (held === null || held === undefined) {
    problems.push(
      `swap ${index}: no connection was being held across the port change, so what the door does to a client that keeps its connection was not tested here`,
    );
  } else {
    problems.push(...heldConnectionProblems(held, record, { index, phase: SWAP_PHASE }));
    // Whether the connection had already ended when the door took the count it
    // reports — the fact that decides whether that count could be read for this
    // connection at all (see `heldConnectionProblems`), put in the record so a
    // pipeline reads the same boundary the verdict was made on. Null when it had not
    // ended (by the time this swap was reported), or when the record names no instant
    // the count was taken at.
    const countedAt = leftoverCountInstant(record);
    const endedAt = held.endedAt === null || held.endedAt === undefined ? null : held.endedAt;
    report.held = {
      acceptedAt: held.acceptedAt === null || held.acceptedAt === undefined ? null : new Date(held.acceptedAt).toISOString(),
      endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
      answers: (held.requests ?? []).length,
      afterStop: held.final === null || held.final === undefined ? null : held.final.status === null ? `!${held.final.error}` : String(held.final.status),
      endedBeforeCount: endedAt === null || countedAt === null ? null : endedAt <= countedAt,
      // Same fact, same name, as the soak's own per-reload record: whether the RUN gave
      // up on the request head this connection never received the end of (a 408, see
      // `heldConnectionProblems`), which is what decides whether its ending was the
      // door's to answer for at all.
      runGaveUp: (held.requests ?? []).some((answer) => answer.status === 408),
    };
  }
  report.judged = true;
  report.problems = problems;
  return { judged: true, report, problems };
}

/**
 * The clause a swap's `spent` list makes — which client each loss was — or nothing at all.
 *
 * Nothing for a swap that cost no client, and nothing for an evidence block written before the
 * field existed: the count is printed either way and it is the count that says whether anything
 * was lost, so a line that carried a second reading of the same number could only disagree with
 * itself. A swap whose loss the account cannot place still gets a clause — `describeSpent` says
 * so in words rather than leaving the reader to guess what the silence meant.
 *
 * Each loss is named by `nameSpent`, so the watch's line carries the same handle the timeline of
 * a downloaded account does: the ordinal the client was handed to the door at, spelled the way the
 * app's own log spells it. A watch reports one swap and cannot say which client of a run it was
 * (`handed` is `null` by design, see `handedRun`), so the handle is the one place a person can
 * carry this finding to the app's log with — the same way, during the deploy, that they will read
 * it out of the account afterwards.
 *
 * When the watch could read the app's own output at the moment the loss landed, the loss also
 * carries the app's SIDE of it (`app`, attached by `watchDeploy`): the lines that name this client
 * and what shape they make. That is the half that says WHY the loss looks the way it does — an
 * answer that never came back through the door, or a request the app never finished — and it is
 * the same sentence `soak:diagnose` prints under this loss afterwards (`describeAppLines`).
 */
function spentClause(spent) {
  if (!Array.isArray(spent)) return "";
  if (spent.length === 0) return "";
  return ` (${spent
    .map((entry) => {
      const app = entry?.app ?? null;
      return `${nameSpent(entry)}${app === null ? "" : ` — ${describeAppLines(app, app.log ?? SERVER_LOG)}`}`;
    })
    .join("; ")})`;
}

/** What the watch says about one swap, as a line a person reads as it lands. */
export function describeSwap(report) {
  if (report?.judged !== true) {
    return `swap ${report?.swap ?? "?"}: NOT JUDGED — ${report?.why ?? "the record describes no swap"}`;
  }
  const door = report.atTheDoor ?? { band: 0, inFlight: 0, lost: 0 };
  const held = report.held ?? null;
  const ending =
    held === null
      ? "no connection was being held across it"
      : held.runGaveUp === true
        ? "was ended by the run it was piped to, which answered 408 for a request this connection never finished — the door was not judged through it"
        : held.endedBeforeCount === true
        ? "ended before the run it was piped to was retired"
        : held.afterStop === null || held.afterStop === undefined
          ? "still open at the end"
          : held.afterStop.startsWith("!") || held.afterStop === "503"
            ? "ended with the run it was piped to"
            : `answered ${held.afterStop} after the run it was piped to had been stopped`;
  return (
    `swap ${report.swap}: ${String(report.outcome ?? "?")}, closed by ${String(report.closedBy ?? "none")}, window ${report.windowUsedMs ?? "?"}ms — ` +
    `${door.band} client(s) at the door, ${door.inFlight} in flight across the change, ${door.lost} lost${spentClause(door.spent)}; ` +
    (held === null
      ? ending
      : `the connection held across it (${held.answers === 0 ? "a request in flight, never answered" : `${held.answers} answer(s)`}) ${ending}`)
  );
}

/** Where a PagerDuty Events API v2 trigger goes. */
export const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";

/** The variable the routing key is read from — and nowhere else, ever. */
export const PAGERDUTY_ROUTING_KEY_ENV = "PAGERDUTY_ROUTING_KEY";

/**
 * `--alert`'s value as the destination it names — or a thrown Error saying why not.
 *
 * Two destinations and no third: `pagerduty` for an Events API v2 trigger that pages
 * somebody, or any http(s) URL to post the same account to as JSON (a chat webhook, an
 * automation, an alert relay). Checked here so a typo costs a usage line rather than a
 * page nobody gets.
 *
 * @param {string} value
 * @returns {string} `pagerduty`, or the URL to post to
 */
export function alertDestination(value) {
  const text = String(value ?? "").trim();
  if (text === "pagerduty") return text;
  let url = null;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`--alert: expected \`pagerduty\` or an http(s) URL, not ${JSON.stringify(value)}`);
  }
  return url.toString();
}

/**
 * One finding, as the thing a person is woken by.
 *
 * The same account either way — which swap, what the door did at it, and the problem
 * in words — so the two destinations cannot say different things, the way the daemon
 * log and `--json` cannot. The PagerDuty shape is the Events API v2 trigger, whose
 * only credential is the routing key in the body; `severity: error` because a client
 * was cost an answer, not because the whole site is down. The generic shape leads with
 * `text`, which is the field a chat webhook renders, and carries the structure beside
 * it for whatever reads it instead. Both include the app-side reason for each lost
 * client, without forwarding the raw request line to an external destination.
 *
 * @param {string} destination `pagerduty` or the URL
 * @param {string} routingKey the routing key, only ever for `pagerduty`
 * @param {{
 *   dedupKey: string,
 *   frontPort: number,
 *   history: string,
 *   swap: number,
 *   outcome?: string | null,
 *   swappedAt?: string | null,
 *   problem: string,
 *   appSide?: { client: number | null, reading: string }[],
 *   judged: number,
 *   watched: number,
 *   inFlight: number,
 *   lost: number,
 * }} finding
 */
export function swapAlertBody(destination, routingKey, finding) {
  const summary = `anybase swap watch: the front door on :${finding.frontPort} cost a client an answer at swap ${finding.swap}`;
  const appSide = Array.isArray(finding.appSide) ? finding.appSide : [];
  const appSideText = appSide.length === 0
    ? ""
    : ` — app side: ${appSide.map((entry) => `${entry.client === null ? "unmatched client" : `_client=${entry.client}`} — ${entry.reading}`).join("; ")}`;
  const details = {
    frontPort: finding.frontPort,
    history: finding.history,
    swap: finding.swap,
    swappedAt: finding.swappedAt ?? null,
    outcome: finding.outcome ?? null,
    problem: finding.problem,
    appSide,
    judged: finding.judged,
    watched: finding.watched,
    inFlight: finding.inFlight,
    lost: finding.lost,
    dedupKey: finding.dedupKey,
  };
  if (destination === "pagerduty") {
    return {
      routing_key: routingKey,
      event_action: "trigger",
      dedup_key: finding.dedupKey,
      payload: {
        summary,
        source: `anybase-swap-watch:${finding.frontPort}`,
        severity: "error",
        custom_details: details,
      },
    };
  }
  return { text: `${summary} — ${finding.problem}${appSideText}`, severity: "error", ...details };
}

/**
 * The same alert, closed again — or null for a destination with no such idea.
 *
 * PagerDuty is the one that has one, and it needs the SAME routing key and dedup key
 * as the trigger. A resolve with no open alert behind it creates nothing, which is why
 * a clean run can always send it.
 */
export function swapAlertResolution(destination, routingKey, dedupKey) {
  if (destination !== "pagerduty") return null;
  return { routing_key: routingKey, event_action: "resolve", dedup_key: dedupKey };
}

/**
 * Send one alert, and answer with what came back rather than throwing it.
 *
 * The watch's whole point is that it keeps running while somebody else's deploy keeps
 * going, so a pager that is unreachable must not take the watch down with it: the
 * outcome is returned and the caller says it. Two attempts, because the failure that
 * matters is a page that never arrived — a 429 is PagerDuty throttling and a 5xx is
 * their side having a moment, and both are worth asking again. Any other 4xx is this
 * watch's own mistake (a dead URL, a revoked key) and asking again would only repeat
 * it, so it is reported at once.
 *
 * @param {string} endpoint where the POST goes
 * @param {object} body the JSON to send
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   attempts?: number,
 *   retryMs?: number,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 * }} [deps]
 * @returns {Promise<{ delivered: boolean, status: number | null, error: string | null, said: string }>}
 */
export async function deliverSwapAlert(endpoint, body, {
  fetchImpl = fetch,
  timeoutMs = 5_000,
  attempts = 2,
  retryMs = 1_000,
  sleepImpl = sleep,
} = {}) {
  let last = { delivered: false, status: null, error: "no attempt was made", said: "" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Raced against the clock rather than aborted: `fetch` is a documented global in
      // this repository's lint config and the web-platform timeout helpers are not — the
      // same trade the supervisor's own probe makes.
      const answer = await Promise.race([
        fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        sleepImpl(timeoutMs).then(() => {
          throw new Error(`no answer within ${timeoutMs}ms`);
        }),
      ]);
      const said = (await answer.text().catch(() => "")).slice(0, 200);
      if (answer.ok) return { delivered: true, status: answer.status, error: null, said };
      last = { delivered: false, status: answer.status, error: `${answer.status} ${answer.statusText}`.trim(), said };
      if (answer.status !== 429 && answer.status < 500) return last;
    } catch (error) {
      last = { delivered: false, status: null, error: error?.message ?? String(error), said: "" };
    }
    if (attempt < attempts) await sleepImpl(retryMs);
  }
  return last;
}

/**
 * Watch a deploy that is already running, and report what each swap it performs
 * does to the clients at its front door.
 *
 * The soak OWNS its supervisor: it starts one, drives it and stops it, and every
 * number it reads is one it made. This mode is the other half of that, and it is
 * the half an operator actually has during a deploy — a supervisor somebody else
 * started, on a port somebody else decided, performing swaps nobody asked this
 * script for. So it attaches instead: the port is given, the load is held against
 * it, a connection is kept open through it, and the deploy's OWN HISTORY is what
 * says a swap happened — read as it grows, so each swap is reported within a poll
 * of the record that describes it rather than in a summary at the end.
 *
 * What it does NOT do is any of the leak checking. There are no descendants to
 * count (this is not the supervisor's parent), no ports to bind after a retirement
 * (it does not know when that is until the record lands), nothing to stop at the
 * end, and no way to know what the deploy was configured with. Those are the soak's
 * checks and the soak owns them; this is the front door's, and it is the one that
 * matters while somebody else's deploy is in progress.
 *
 * The load is real traffic as far as the supervisor is concerned — a front door
 * counts the connections it hands a replacement, and this mode hands them — so a
 * deploy watched under load will close its rollback window earlier than a deploy
 * watched by nobody. That is the point of watching it under load, and it is worth
 * knowing before the numbers are read.
 *
 * As a DAEMON (`--daemon <log>`) it is the same watch with the count removed and
 * a file added: every verdict is appended as a line the moment it is reached, the
 * summary is appended when the daemon ends, and the only things that end it are a
 * signal or the window `--wait` names. See the file's header for why the log is the
 * interface a deploy step has and a pipe is not.
 *
 * `--require-swap` is the one thing here that is about the WATCH rather than about
 * the deploy: by default a watch that judged nothing is an abstention (exit 2), and
 * under this flag it is a failure (exit 1, with a problem naming what was demanded
 * and what was seen). Nothing about a judged swap changes.
 *
 * `--alert` is about who FINDS OUT. It pages when the DOOR costs a client an answer,
 * as the finding lands rather than at the end, and only then: the deploy's own
 * outcome, a reload that changed nothing, a pre-attach swap and `--require-swap`'s
 * nothing-to-judge are all reported and none of them pages. See the file's header for
 * the dedup key that makes the bad swaps of one deploy one incident, and for why a
 * page that could not be sent is reported rather than allowed to change the verdict.
 *
 * @param {{
 *   attach: number,
 *   history: string,
 *   serverLog?: string | null,
 *   daemon?: string | null,
 *   path?: string,
 *   busyRate?: number,
 *   maxInFlight?: number,
 *   requestTimeoutMs?: number,
 *   swaps?: number,
 *   waitMs?: number,
 *   requireSwap?: boolean,
 *   alert?: string | null,
 *   json?: boolean,
 * }} options
 * @param {{
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 *   traffic?: typeof startTraffic,
 *   hold?: typeof holdConnection,
 *   pool?: typeof startHeldPool,
 *   read?: (path: string) => string,
 *   appendFile?: (path: string, text: string) => void,
 *   now?: () => number,
 *   env?: Record<string, string | undefined>,
 *   deliver?: typeof deliverSwapAlert,
 *   signals?: { on?: (name: string, fn: () => void) => unknown, off?: (name: string, fn: () => void) => unknown },
 * }} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function watchDeploy(options, {
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
  sleepImpl = sleep,
  traffic = startTraffic,
  hold = holdConnection,
  pool = startHeldPool,
  read = (path) => readFileSync(path, "utf8"),
  appendFile = appendFileSync,
  now = () => Date.now(),
  env = process.env,
  deliver = deliverSwapAlert,
  signals = process,
} = {}) {
  const port = options.attach;
  const daemonLog = options.daemon ?? null;
  // Proof demanded rather than abstention reported: see the end of this function
  // for what it does to the verdict, and the file's header for why.
  const requireSwap = options.requireSwap === true;
  // Where a person is told, when the door costs a client an answer. The dedup key is
  // the watch's OWN identity rather than the swap's: stable across the runs of one
  // deploy, so the three bad swaps of one deploy are one incident with three trigger
  // entries instead of three pages, and a later run of the same watch attaches to that
  // incident rather than opening a second one.
  const alertTo = options.alert ?? null;
  const dedupKey = alertTo === null ? null : `anybase-swap-watch:${port}:${options.history}`;
  const alertEndpoint = alertTo === "pagerduty" ? PAGERDUTY_EVENTS_URL : alertTo;
  const routingKey = alertTo === "pagerduty" ? String(env?.[PAGERDUTY_ROUTING_KEY_ENV] ?? "") : "";
  if (alertTo === "pagerduty" && routingKey.trim() === "") {
    // The routing key IS the credential, and it is the one thing that cannot be read
    // from anywhere else: an argument is visible in every process listing and a log
    // line is a file somebody else can read, so it comes from the environment or the
    // watch does not start at all rather than starting with a page nobody receives.
    err(
      `--alert pagerduty: no routing key in ${PAGERDUTY_ROUTING_KEY_ENV} — it is the integration key of the service's Events API v2 integration in PagerDuty, and it is read from the environment so it is never an argument or a log line\n`,
    );
    return 2;
  }
  const log = (message) => err(`[watch] ${message}\n`);
  // The app's own output, when the deploy leaves it somewhere this watch can read it. A soak
  // writes `server.log` beside its history (see `SERVER_LOG`), so that is what a watch assumes;
  // `--server-log` names another file. A running deploy is somebody else's process, so this can
  // be absent altogether — and then a loss is named but not classified, said once at the start
  // rather than on every loss.
  const appLogPath = options.serverLog ?? join(dirname(String(options.history ?? "")), SERVER_LOG);
  const appLogName = basename(appLogPath);
  // Read through a VIEW rather than the path, so a log rotated or truncated between two losses
  // is still everything this watch has read of it: a line the app wrote before its file was
  // replaced is evidence at the next loss, and a line missing from a replaced file is `unseen`
  // rather than the app's silence (see `startAppLogView`).
  const appLog = startAppLogView(appLogPath, { read });
  // Whether the output has ever been readable, so a file that is rotated INTO existence (or
  // created after the watch attached) is announced once instead of contradicting the line that
  // said there was none.
  let appOutputPresent = false;
  /**
   * The app's own side of the clients a swap cost, read the moment those losses land.
   *
   * `spent` is the swap's own evidence (see `swapProblems`), so each entry already carries the
   * ordinal the client was handed to the door at — the handle the app's log names the same
   * client by. Each one whose client the output knows about gets `app` attached: the lines and
   * the shape they make, as `describeAppLines` prints them on the line and in the daemon log.
   *
   * The lookup is against everything the view has KEPT, not against the file as it is now, so a
   * rotation after the app answered a client does not turn that answer into an absence — and
   * the view's gaps (a file rotated, truncated, missing, or trimmed) are carried into the
   * classification, so an absence the log cannot vouch for is `UNSEEN` rather than `NO LINE AT
   * ALL`.
   *
   * A client the output says nothing about gets ONE short second look before the silence is
   * called the app's, because the app's lines reach this file through somebody else's pipe while
   * the loss is read from a record a different process wrote — two routes into one incident, a
   * poll apart. Nothing else is retried: an entry with no reading keeps the line it would have
   * had without any log at all.
   */
  const appSideOf = async (spent) => {
    const entries = Array.isArray(spent) ? spent : [];
    if (!entries.some((entry) => Number.isFinite(entry?.client))) return entries;
    const announce = (look) => {
      if (!look.present || appOutputPresent) return;
      appOutputPresent = true;
      log(`app output appeared at ${appLogPath} — a lost client is followed into it from here`);
    };
    const withReading = (look) => {
      // Nothing was ever there and nothing was lost: the watch was pointed at no output at all,
      // so the loss stays named rather than explained (the start line already said so).
      if (look.text === "" && !look.present && look.gaps.length === 0) return entries;
      return entries.map((entry) => {
        const found = clientLogLines(look.text, entry?.client, { gaps: look.gaps });
        return found === null ? entry : { ...entry, app: { ...found, log: appLogName } };
      });
    };
    const first = appLog.sample();
    announce(first);
    const firstReading = withReading(first);
    if (firstReading === entries || firstReading.every((entry) => entry.app === undefined || entry.app.total > 0)) {
      return firstReading;
    }
    await sleepImpl(DEFAULTS.appLogGraceMs);
    return withReading(appLog.sample());
  };
  // One line per swap, APPENDED as it is reached rather than held until the end:
  // the point of the log is that a deploy step can follow it, and a line written
  // when the watch exits is a line a deploy that is still going cannot read. The
  // record is the very object `--json` prints, so the file and the stream cannot
  // disagree about a swap.
  const toDaemonLog = (record) => {
    if (daemonLog === null) return;
    appendFile(daemonLog, `${JSON.stringify(record)}\n`);
  };
  if (daemonLog !== null) {
    try {
      // Opened (created, never truncated) before anything is watched: a log the
      // daemon cannot write to has to cost a line here, not a crash on the first
      // swap of the deploy it was started to watch.
      appendFile(daemonLog, "");
    } catch (error) {
      err(
        `cannot write the daemon log ${daemonLog} (${error?.message ?? error}) — it is where the verdict for each swap goes\n`,
      );
      return 2;
    }
  }

  // The door has to be there. A port that refuses a connection is not a deploy to
  // watch, and saying so is better than watching nothing and reporting nothing.
  const probe = await hold(port, { path: options.path });
  if (probe.accepted !== true) {
    err(`nothing is serving on ${port} (${probe.endedReason ?? "the connection was refused"}) — the watch attaches to a deploy's front door, so the port has to be one it holds\n`);
    await probe.stop?.();
    return 2;
  }
  // The probe's own answer is the last thing it does: holding is what proves the
  // port is there, and the answer comes when the hold is finished (see
  // `holdConnection`), so what the door answered is read from what stopping it gave
  // back rather than from anything the hold itself collected.
  const probeAnswer = await probe.stop?.();
  const answering = probeAnswer && probeAnswer.status !== null ? [probeAnswer.status] : [];

  const attachedAt = now();
  const held = pool(port, { path: options.path, hold, sleepImpl });
  const driver = traffic(port, {
    path: options.path,
    busyRate: options.busyRate,
    maxInFlight: options.maxInFlight,
    requestTimeoutMs: options.requestTimeoutMs,
    phase: "busy",
  });
  const problems = [];
  // The door's own findings, kept apart from the rest: `problems` also holds what is
  // wrong with the WATCH (a history line nobody can read, a `--require-swap` nothing
  // to judge), and only the door's are a person's business at three in the morning.
  const doorProblems = [];
  const alerts = [];
  const reports = [];
  const reported = new Set();
  const unreadable = new Set();
  let watched = 0;
  let judged = 0;
  let seen = -1;
  let stopped = false;
  const stopNow = () => {
    stopped = true;
  };
  signals.on?.("SIGINT", stopNow);
  // SIGTERM as well, and for the daemon it is the one that matters: a service
  // manager and a deploy step both stop a long-lived process with it, and a daemon
  // that could only be stopped with a signal it does not handle is a daemon nothing
  // can stop cleanly.
  signals.on?.("SIGTERM", stopNow);
  const until = options.waitMs > 0 ? now() + options.waitMs : null;

  try {
    log(`watching the front door on ${port} — it answered ${answering.join(", ") || "nothing"} before the load started`);
    log(`history: ${options.history}`);
    // Whether a loss can be classified at all is said ONCE, here: a watch of a deploy whose
    // output nobody captured still names the client, and every later line repeating that it
    // cannot read a file would be noise in the log a person is following.
    const startupOutput = appLog.sample();
    appOutputPresent = startupOutput.present;
    log(
      startupOutput.present
        ? `app output: ${appLogPath} — a lost client is followed into it as the loss lands, and kept across a rotation or truncation of the file`
        : `no app output at ${appLogPath}, so a lost client is named and not classified — point --server-log at the deploy's own output to have the line say why it looks the way it does`,
    );
    if (daemonLog !== null) {
      log(`daemon: appending a verdict per swap to ${daemonLog} — no stopping count; SIGINT, SIGTERM${until === null ? "" : ", or the window asked for"} ends it`);
    }
    if (requireSwap) {
      log("--require-swap: a watch that judges no swap at all will FAIL rather than report NOTHING_JUDGED");
    }
    if (alertTo !== null) {
      log(
        `--alert ${alertTo}: the door's own findings go to ${alertEndpoint} the moment they land${alertTo === "pagerduty" ? `, under the dedup key ${dedupKey} (one incident per deploy)` : ""} — nothing else does`,
      );
    }
    log(`${options.busyRate} request(s)/s with at most ${options.maxInFlight} in flight, and one connection kept open across every swap`);
    for (;;) {
      if (options.swaps > 0 && judged >= options.swaps) break;
      if (until !== null && now() >= until) break;
      if (stopped) break;

      let text = null;
      try {
        text = read(options.history);
      } catch {
        // Not written yet: a deploy that has never reloaded has no history, and
        // waiting for it is the whole point of attaching before the first swap.
        text = null;
      }
      const parsed = text === null ? { records: [], unreadable: [] } : parseReloadHistory(text, { schema: RELOAD_HISTORY_SCHEMA });

      if (seen === -1) {
        // The first read is the deploy's PAST: the history holds every reload it
        // has ever performed, and none of them is this watch's to report.
        seen = parsed.records.length;
        log(seen > 0 ? `${seen} record(s) already in the history, from before the watch: waiting for the next swap` : "no reloads in the history yet: waiting for the first swap");
      } else if (parsed.records.length > seen) {
        for (const entry of parsed.records.slice(seen)) {
          watched += 1;
          const at = Date.parse(String(entry.record.swappedAt ?? ""));
          // The connection that was open at the swap's own instant, and no other:
          // the one that ended because that swap retired the run it was piped to.
          const across = Number.isFinite(at) && at >= attachedAt ? held.across(at) : null;
          if (across !== null) await across.stop?.();
          const verdict = watchedSwap(entry.record, {
            index: watched,
            attachedAt,
            answers: driver.stats.answers,
            held: across,
            bandMs: options.swapBandMs,
            reported,
          });
          reports.push(verdict.report);
          problems.push(...verdict.problems);
          if (verdict.judged) judged += 1;
          // The app's own side of any loss, read HERE rather than at the end of the watch: the
          // line for this swap is the one a person reads while the deploy is still running, so
          // the reading has to be on it at the moment it is written. It goes into the report
          // before the report is logged, printed as JSON or appended to the daemon log, so the
          // three cannot disagree about what the app said.
          const door = verdict.report.atTheDoor;
          if (door && Array.isArray(door.spent) && door.spent.length > 0) {
            door.spent = await appSideOf(door.spent);
          }
          log(describeSwap(verdict.report));
          for (const problem of verdict.problems) err(`problem: ${problem}\n`);
          if (options.json) out(`${JSON.stringify(verdict.report)}\n`);
          toDaemonLog(verdict.report);
          if (verdict.problems.length > 0) {
            doorProblems.push(...verdict.problems);
            // Paged HERE rather than at the end, for the same reason the per-swap line
            // is written here: a deploy under load runs for minutes, and a page that
            // waits for it is a page the on-call engineer gets after the deploy step
            // has already moved on.
            if (alertTo !== null) {
              const door = verdict.report.atTheDoor ?? { inFlight: 0, lost: 0 };
              const outcome = await deliver(
                alertEndpoint,
                swapAlertBody(alertTo, routingKey, {
                  dedupKey,
                  frontPort: port,
                  history: options.history,
                  swap: watched,
                  outcome: verdict.report.outcome,
                  swappedAt: verdict.report.swappedAt,
                  problem: verdict.problems[0],
                  // Keep the app's reason in the page itself, not only in the watch's line and
                  // daemon record. Do not forward raw request lines to an external alert target:
                  // the classification's reason/status is enough to distinguish an app-side
                  // answer, an unfinished request, an absent line or a log that was not whole.
                  appSide: (Array.isArray(door.spent) ? door.spent : []).map((entry) => ({
                    client: Number.isFinite(entry?.client) ? entry.client : null,
                    reading: entry?.app?.classification?.why ?? (
                      Number.isFinite(entry?.client)
                        ? "NOT CLASSIFIED: the app's output was unavailable when this loss landed"
                        : "NOT CLASSIFIED: this loss has no _client= ordinal to match in the app's output"
                    ),
                  })),
                  judged,
                  watched,
                  inFlight: door.inFlight ?? 0,
                  lost: door.lost ?? 0,
                }),
                { sleepImpl },
              );
              alerts.push({ swap: watched, ...outcome });
              log(
                outcome.delivered
                  ? `alert delivered for swap ${watched} — ${alertEndpoint} answered ${outcome.status}`
                  : `alert NOT delivered for swap ${watched} — ${outcome.error ?? "no reason given"}`,
              );
              if (!outcome.delivered) {
                err(
                  `[watch] THE ALERT WAS NOT SENT for swap ${watched} (${outcome.error ?? "no reason given"}) — the finding is still in the summary and the daemon log, but nobody was paged for it\n`,
                );
              }
            }
          }
        }
        seen = parsed.records.length;
      } else if (parsed.records.length < seen) {
        // Truncated or rotated under us: count from here rather than treating old
        // records as new ones.
        seen = parsed.records.length;
        log("the history got shorter — it was truncated or rotated, so the watch counts from here again");
      }
      for (const bad of parsed.unreadable) {
        if (unreadable.has(bad.line)) continue;
        unreadable.add(bad.line);
        problems.push(`history line ${bad.line} is unreadable: ${bad.reason}`);
      }
      await sleepImpl(DEFAULTS.watchPollMs);
    }
  } finally {
    signals.off?.("SIGINT", stopNow);
    signals.off?.("SIGTERM", stopNow);
    await driver.stop().catch(() => null);
    await held.stop().catch(() => null);
  }

  // A run that JUDGED swaps and found nothing at the door closes the incident an
  // earlier run of this same watch may have opened — the dedup key is the watch's, not
  // the swap's, so that is the incident this run would have attached to. Only a verdict
  // can close one: a watch that judged nothing has no clean answer to report, and
  // closing an incident on its silence is exactly the lie a paging integration must not
  // tell. A destination with no such idea (any plain URL) sends nothing here.
  const resolution =
    alertTo !== null && judged > 0 && doorProblems.length === 0
      ? swapAlertResolution(alertTo, routingKey, dedupKey)
      : null;
  let resolved = false;
  if (resolution !== null) {
    const outcome = await deliver(alertEndpoint, resolution, { sleepImpl });
    resolved = outcome.delivered;
    log(
      outcome.delivered
        ? `the door held at every swap — resolved the alert for ${dedupKey}${outcome.status === null ? "" : ` (${outcome.status})`}`
        : `could not resolve the alert for ${dedupKey} (${outcome.error ?? "no reason given"}) — nothing was open, or PagerDuty did not answer`,
    );
  }

  const stats = driver.stats ?? { requests: 0, answers: [], byStatus: {}, timeouts: 0, errors: 0 };
  const inFlight = reports.reduce((total, report) => total + (report.atTheDoor?.inFlight ?? 0), 0);
  const lost = reports.reduce((total, report) => total + (report.atTheDoor?.lost ?? 0), 0);
  // Proof, when it was asked for. NOTHING_JUDGED (2) is the honest answer to a watch
  // that never got to judge a swap, and it is the one a person watching a deploy
  // wants — the door was never put to the test, so nothing is claimed either way. A
  // pipeline that passed --require-swap asked a different question ("did the deploy
  // prove it can swap the port under load?") and for that question nothing to judge
  // is a FAILURE rather than an abstention. It is raised as a problem, so it travels
  // the same road as every other finding — the summary, the daemon log, the exit
  // code — and only when there was no finding at the door already: a watch that
  // caught the door costing a client an answer does not need saying twice.
  if (requireSwap && judged === 0 && problems.length === 0) {
    problems.push(
      watched > 0
        ? `--require-swap asked this watch to prove the deploy swapped the port under load, and it judged no swap: ${watched} reload(s) landed while it was up and every one of them changed nothing at the door`
        : "--require-swap asked this watch to prove the deploy swapped the port under load, and it judged no swap: no reload landed while it was up",
    );
  }
  const verdict = problems.length > 0 ? "FAIL" : judged > 0 ? "PASS" : "NOTHING_JUDGED";
  const summary = {
    schema: SWAP_WATCH_SCHEMA,
    verdict,
    frontPort: port,
    history: options.history,
    watched,
    judged,
    requireSwap,
    inFlight,
    lost,
    // What happened to the paging, in the account rather than only on stderr: `failed`
    // is the number a pipeline can branch on if it cares about the page as much as
    // about the door (the exit code is the door's and stays the door's).
    alert:
      alertTo === null
        ? null
        : {
            destination: alertEndpoint,
            findings: doorProblems.length,
            sent: alerts.filter((entry) => entry.delivered).length,
            failed: alerts.filter((entry) => !entry.delivered).length,
            error: alerts.find((entry) => !entry.delivered)?.error ?? null,
            resolved,
          },
    requests: stats.requests,
    byStatus: stats.byStatus,
    timeouts: stats.timeouts,
    connectionErrors: stats.errors,
    swaps: reports,
    problems,
  };

  err(
    `through the door: ${stats.requests} request(s), statuses ${JSON.stringify(stats.byStatus)}, ${stats.timeouts} timeout(s), ` +
      `${stats.errors} connection error(s)\n`,
  );
  if (alertTo !== null) {
    err(
      `alerting: ${summary.alert.sent} of ${summary.alert.findings} finding(s) alerted to ${alertEndpoint}, ${summary.alert.failed} could not be sent` +
        `${resolved ? "; the alert was resolved because the door held at every judged swap" : ""}\n`,
    );
  }
  for (const problem of problems) err(`problem: ${problem}\n`);
  const line =
    `SWAP_VERDICT=${verdict} swaps=${judged}/${watched} watched=${watched} in_flight=${inFlight} lost=${lost} ` +
    `problems=${problems.length} history=${options.history}\n`;
  if (judged === 0 && problems.length === 0) {
    err(
      watched > 0
        ? `${watched} reload(s) landed while the watch was up and not one of them was a swap it could judge — there is nothing to report about the door\n`
        : "no swap was judged: the watch never saw a reload land while it was up, so there is nothing to report about the door\n",
    );
  }
  err(line);
  // The summary ends the log as well, so a reader that followed the file knows the
  // account is complete rather than merely quiet — the same object, in the same
  // place, as a pipeline that read stdout instead.
  toDaemonLog(summary);
  if (options.json) out(`${JSON.stringify(summary)}\n`);
  else out(line);
  return problems.length > 0 ? 1 : judged > 0 ? 0 : 2;
}

/**
 * The supervisor's descendants and its handle count, as this platform can afford
 * to read them.
 *
 * Linux answers both from `/proc` with no subprocess at all, which is why the soak
 * can afford to look after EVERY reload. Windows cannot: reading its process table
 * costs PowerShell seconds per read (measured in scripts/supervise.mjs), so a
 * persistent watcher is started instead and asked to poll for itself — one
 * PowerShell process for the whole soak, whose latest sample the soak reads
 * whenever it wants one. A platform with neither says so rather than reporting a
 * clean bill of health it never took: `measured` is what the verdict rests on.
 *
 * @param {number} pid the supervisor
 * @param {{
 *   platform?: string,
 *   pollMs?: number,
 *   spawnImpl?: typeof spawn,
 *   table?: () => { pid: number, ppid: number, command: string }[],
 *   readDir?: (path: string) => string[],
 *   engines?: string[],
 * }} [options]
 */
export function startSampler(pid, {
  platform = process.platform,
  pollMs = 400,
  spawnImpl = spawn,
  table = readProcessTable,
  readDir = readdirSync,
  engines = ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
} = {}) {
  if (platform !== "win32") {
    return {
      measured: { rows: true, handles: existsSync(`/proc/${pid}/fd`) },
      latest: () => {
        let rows = [];
        try {
          rows = descendantsOf(table(), pid);
        } catch {
          rows = [];
        }
        let handles = null;
        try {
          handles = readDir(`/proc/${pid}/fd`).length;
        } catch {
          handles = null;
        }
        // A live read is already this instant's answer, so `at` is now — and the
        // caller's freshness rule (a sample taken after the reload concluded) is
        // therefore always satisfied.
        return { rows, handles, at: Date.now() };
      },
      stop: () => {},
    };
  }

  // One watcher, polling for itself: a query per sample would cost more than the
  // interval, and a process that lives for a moment would be missed while it was
  // being asked about. Each sample is a handle count for the supervisor and one
  // line per child, ended by a blank line.
  const query =
    `$ErrorActionPreference='Stop';$t=${pid};` +
    "while ($true) {" +
    " $h=(Get-Process -Id $t -ErrorAction SilentlyContinue).HandleCount;" +
    " 'H ' + $(if ($null -eq $h) { '' } else { $h });" +
    ` Get-CimInstance Win32_Process -Filter "ParentProcessId = $t" |` +
    " ForEach-Object { 'K ' + $_.ProcessId + ' ' + $_.CommandLine };" +
    " '';" +
    ` Start-Sleep -Milliseconds ${pollMs}` +
    " }";
  let watcher = null;
  for (const engine of engines) {
    const attempt = spawnImpl(engine, ["-NoProfile", "-NonInteractive", "-Command", query], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    // A missing engine fails asynchronously: without this the soak would die of an
    // unhandled 'error' rather than falling through to the next spelling.
    attempt.on("error", () => {});
    if (attempt.pid) {
      watcher = attempt;
      break;
    }
  }
  if (!watcher) {
    return { measured: { rows: false, handles: false }, latest: () => null, stop: () => {} };
  }

  let latest = null;
  let buffer = "";
  let sample = { rows: [], handles: null };
  watcher.stdout.setEncoding("utf8");
  watcher.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
      if (line === "") {
        latest = { ...sample, at: Date.now() };
        sample = { rows: [], handles: null };
        continue;
      }
      if (line.startsWith("H ")) {
        const value = Number.parseInt(line.slice(2).trim(), 10);
        sample.handles = Number.isInteger(value) ? value : null;
        continue;
      }
      if (line.startsWith("K ")) {
        const match = /^K (\d+) (.*)$/.exec(line);
        if (match) sample.rows.push({ pid: Number(match[1]), command: match[2] });
      }
    }
  });
  return {
    measured: { rows: true, handles: true },
    latest: () => latest,
    stop: () => watcher.kill(),
  };
}

/**
 * A sample taken AFTER a given instant, waited for where the platform answers
 * asynchronously (Windows), and immediate where the read itself is live (Linux).
 * Null means no such sample could be had — which is reported, never treated as a
 * clean bill of health.
 *
 * @param {{ latest: () => { rows?: unknown[], handles?: number | null, at: number } | null }} sample
 * @param {{ platform?: string, after: number, sleepImpl: (ms: number) => Promise<unknown>, waitMs?: number }} options
 */
async function sampleAfter(sample, { platform = process.platform, after, sleepImpl, waitMs = DEFAULTS.sampleWaitMs }) {
  const first = sample.latest();
  if (first === null) return null;
  if (platform !== "win32") return first;
  const deadline = Date.now() + waitMs;
  let latest = first;
  while (latest.at < after && Date.now() < deadline) {
    await sleepImpl(150);
    const next = sample.latest();
    if (next !== null) latest = next;
  }
  return latest.at >= after ? latest : null;
}

/**
 * The supervisor's descendants and descriptors once a reload has concluded, as the
 * LOWEST of a few samples rather than one reading.
 *
 * The minimum is the honest statistic for a leak on both counts. A retirement that
 * left a run behind is there in every sample, so it lowers nothing; a stop that is
 * merely still finishing is only there in the first. And descriptors are held
 * TRANSIENTLY as well as leaked — a request in flight through the door is a socket
 * for as long as it takes, so one reading taken just after a busy phase reads high
 * for a reason that will be gone a second later. What no reading can do is read
 * LOWER than what is actually held.
 *
 * A count still above the floor at the end of the window is reported rather than
 * retried forever: that is what a leak looks like.
 *
 * @returns {Promise<{ rows: { pid: number, command?: string }[] | null, handles: number | null }>}
 */
async function observe(sample, { platform, after, descendants, sleepImpl }) {
  const deadline = Date.now() + DEFAULTS.descendantGraceMs;
  let rows = null;
  let handles = null;
  let taken = 0;
  for (;;) {
    const fresh = await sampleAfter(sample, { platform, after, sleepImpl });
    if (fresh === null) return { rows: null, handles: null };
    taken += 1;
    if (rows === null || fresh.rows.length < rows.length) rows = fresh.rows;
    if (fresh.handles !== null && (handles === null || fresh.handles < handles)) handles = fresh.handles;
    const above = descendants !== null && rows.length > descendants;
    if (taken >= DEFAULTS.sampleCount && !above) break;
    if (Date.now() >= deadline) break;
    await sleepImpl(200);
  }
  return { rows, handles };
}

/** A port nothing holds, so the soak's supervisor can be given a public one. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(null)));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(() => resolve(null)));
  return port;
}

/** Stop the supervisor — politely, then not — so the leak checks see the end state. */
async function stopSupervisor(child, { platform, sleepImpl, log }) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  log(`stopping the supervisor (pid ${child.pid})`);
  const exited = new Promise((resolve) => child.once("close", () => resolve("closed")));
  try {
    child.kill(platform === "win32" ? undefined : "SIGTERM");
  } catch {
    // Already gone between the check and the signal.
  }
  const stopped = await Promise.race([exited, sleepImpl(5_000).then(() => "timeout")]);
  if (stopped === "closed") return;
  // Windows has no SIGTERM to deliver and a supervisor that ignores this one would
  // otherwise leave a server behind — which is a finding, so it is not hidden, it
  // is just not left running.
  log("the supervisor did not stop on its own; taking the tree down");
  if (platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
  await Promise.race([exited, sleepImpl(5_000)]);
}

/**
 * Run the soak.
 *
 * @param {string[]} [argv]
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 *   spawnImpl?: typeof spawn,
 *   sampler?: typeof startSampler,
 *   traffic?: typeof startTraffic,
 *   cwd?: string,
 * }} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    env = process.env,
    out = (text) => process.stdout.write(text),
    err = (text) => process.stderr.write(text),
    sleepImpl = sleep,
    spawnImpl = spawn,
    sampler = startSampler,
    traffic = startTraffic,
    hold = holdConnection,
    cwd = process.cwd(),
  } = deps;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(`${error.message}\n\nUsage: node scripts/soak-supervisor.mjs [--reloads N] [--phases a,b,c] [--server '<command>']\n`);
    return 2;
  }
  if (options.help) {
    out("Usage: node scripts/soak-supervisor.mjs [options]\n\nSee the header of scripts/soak-supervisor.mjs for what each option does.\n");
    return 2;
  }
  // Watching somebody else's deploy rather than running one: a different mode
  // with a different claim, and none of the leak checks (see `watchDeploy`).
  if (options.attach !== null) {
    return watchDeploy(options, { out, err, sleepImpl, traffic, hold, env });
  }

  const log = (message) => err(`[soak] ${message}\n`);
  const phases = planPhases(options.reloads, options.phases);
  if (options.server === null && !existsSync(join(cwd, ".next", "BUILD_ID"))) {
    err(
      "there is no production build to soak: this supervises `next start` over .next, so run `npm run build` " +
        "first — or name another server with --server '<command>'.\n",
    );
    return 2;
  }

  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "base88-soak-"));
  const history = join(dir, "reloads.jsonl");
  // The app's own output, in the artifact that is downloaded to read a red run: the request
  // log lines a lost client's ordinal is looked up in are the app's, not this script's, so
  // they have to be carried out of the run with the rest of the account (see `SERVER_LOG`).
  const serverLog = join(dir, SERVER_LOG);
  writeFileSync(serverLog, "");
  // The run's own trend line, beside the history it was measured from: a run that
  // leaves no account of what it cost is a run nobody can compare with the next one.
  const trend = options.trend ?? join(dir, "soak-trend.jsonl");
  const sentinel = join(dir, "reload");
  writeFileSync(history, "");
  const port = options.port || (await freePort());

  const child = spawnImpl(process.execPath, [startScript(), "--port", String(port)], {
    cwd,
    env: {
      ...env,
      PROD_RELOAD_FILE: sentinel,
      PROD_RELOAD_HISTORY: history,
      PROD_ROLLBACK_MS: String(options.windowMs),
      PROD_ROLLBACK_MIN_MS: String(options.minMs),
      PROD_ROLLBACK_CONNECTIONS: String(options.proof),
      PROD_BACKOFF_MS: "20",
      PROD_BACKOFF_MAX_MS: "40",
      ...(options.server === null ? {} : { PROD_SERVER_CMD: options.server }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let supervisorLog = "";
  // Both streams, in the order they arrive, into the account verbatim: this is the app's own
  // request log as much as it is the supervisor's, and reordering or filtering it would be
  // this script writing a different history from the one the app wrote.
  const keep = (chunk) => {
    const text = chunk.toString();
    supervisorLog += text;
    appendFileSync(serverLog, text);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("error", (error) => {
    const line = `[soak] could not start the supervisor: ${error.message}\n`;
    supervisorLog += line;
    appendFileSync(serverLog, line);
  });

  const problems = [];
  const notes = [];
  const reloads = [];
  const runPorts = new Set([port]);
  // What a leak is measured against. Descendants get the LOWEST count seen: a run
  // that was left behind is there in every later sample, so a floor that rose is a
  // leak however the phases differ. Descriptors get a baseline per PHASE, because
  // the counts legitimately differ between them — a busy window has a page's worth
  // of requests in flight and a quiet one has none — and a leak still accumulates
  // within any one phase's line of reloads.
  const baseline = { descendants: null };
  /** Descriptors seen, per phase, in order — the series the leak trend is read from. */
  const readings = new Map();
  let descendantsUnreadable = false;
  let handlesUnreadable = false;
  let trafficDriver = null;
  let sample = null;
  let doorStats = null;

  try {
    log(`supervising on ${port} with ${options.reloads} reload(s): ${phases.join(", ")}`);
    log(`history: ${history}`);
    log(`trend: ${trend}`);

    // The door answers 503 until a run is up behind it, so the first 200 is what
    // "running" means. The request carries this tooling's own marker for the same
    // reason the supervisor's probe does (`SELF_MARKER` in scripts/supervise.mjs):
    // it is a CHECK, not a client's page — it is this soak asking whether the port
    // answers — and the run behind the door has to be able to tell the two apart.
    // Unmarked, this one request is the first client an app is handed, and a run
    // that was asked to cost a client its answer would spend it on the soak's own
    // probe, which nobody is waiting on a page from. Each attempt is raced against a
    // clock of its own as well, the way the supervisor's probe does it (`probeUp` in
    // scripts/supervise.mjs): a check that is never answered is asked AGAIN rather
    // than waited on past the deadline below, which is the only thing that should be
    // able to end this loop.
    const started = Date.now();
    for (;;) {
      try {
        const response = await Promise.race([
          fetch(selfUrl("127.0.0.1", port, options.path), { redirect: "manual" }),
          sleepImpl(DEFAULTS.readyAttemptMs).then(() => {
            throw new Error(`no answer in ${DEFAULTS.readyAttemptMs}ms`);
          }),
        ]);
        if (response.status === 200) break;
      } catch {
        // Not up yet.
      }
      if (Date.now() - started > 30_000) {
        err(`the supervisor never answered 200 on ${port} within 30s\n---\n${supervisorLog}`);
        return 2;
      }
      await sleepImpl(50);
    }
    const firstRunPort = Number(/back up — http:\/\/[\d.]+:(\d+)/.exec(supervisorLog)?.[1] ?? 0);
    if (firstRunPort > 0) runPorts.add(firstRunPort);

    sample = sampler(child.pid, { spawnImpl });
    trafficDriver = traffic(port, {
      path: options.path,
      busyRate: options.busyRate,
      trickleGapMs: options.trickleGapMs,
      requestTimeoutMs: options.requestTimeoutMs,
      maxInFlight: options.maxInFlight,
    });

    for (let index = 0; index < phases.length; index += 1) {
      const phase = phases[index];
      trafficDriver.setPhase(phase);
      await sleepImpl(options.settleMs);
      // A connection held OPEN across the swap, opened before the reload is even
      // asked for: the run serving this port is the run it is piped to, and it is
      // the client the mechanism's own contract is about. `heldConnectionProblems`
      // judges it once the reload has concluded; nothing here decides anything.
      const held = await hold(port, { path: options.path });
      writeFileSync(sentinel, "reload\n");

      const budget = DEFAULTS.recordBudgetMs + options.windowMs;
      const deadline = Date.now() + budget;
      let entries = [];
      for (;;) {
        entries = parseReloadHistory(readFileSync(history, "utf8"), { schema: RELOAD_HISTORY_SCHEMA }).records;
        if (entries.length > index) break;
        if (Date.now() > deadline) {
          problems.push(`reload ${index + 1} (${phase}): no record within ${budget}ms`);
          break;
        }
        await sleepImpl(100);
      }
      if (entries.length <= index) {
        await held.stop();
        break;
      }
      const record = entries[index].record;

      // The record lands when the reload CONCLUDED — after the drain and after the
      // audited stop of the run it replaced — so this is the first moment the run
      // the held connection was piped to is known to be gone. Whatever that
      // connection does from here it does with that run retired.
      const heldFinal = await held.stop();
      problems.push(...heldConnectionProblems(held, record, { index: index + 1, phase }));

      // A record lands when the reload concluded — after the drain and after the
      // audited stop of the run it replaced — so this is the moment to look for
      // what that stop left behind.
      const after = Date.now();
      const seen = await observe(sample, { platform: process.platform, after, descendants: baseline.descendants, sleepImpl });
      if (seen.handles === null) handlesUnreadable = true;
      if (seen.rows === null) {
        descendantsUnreadable = true;
      } else {
        const count = seen.rows.length;
        if (baseline.descendants !== null && count > baseline.descendants) {
          problems.push(
            `reload ${index + 1} (${phase}): the supervisor has ${count} descendant process(es), where it has had as few as ` +
              `${baseline.descendants} — a retirement left a run behind: ` +
              seen.rows.map((row) => `${row.pid} ${row.command ?? ""}`.trim()).join(" | "),
          );
        }
        baseline.descendants = baseline.descendants === null ? count : Math.min(baseline.descendants, count);
      }
      if (seen.handles !== null) {
        readings.set(phase, [...(readings.get(phase) ?? []), seen.handles]);
      }

      const retired = record.previousPort ?? null;
      let retiredFree = null;
      if (retired !== null) {
        runPorts.add(retired);
        retiredFree = (await checkPortsFree([retired], { sleepImpl })).held.length === 0;
        if (!retiredFree) {
          problems.push(
            `reload ${index + 1} (${phase}): the run this reload retired still holds port ${retired} — a warm process that outlived its stop`,
          );
        }
      }
      if (record.replacementPort) runPorts.add(record.replacementPort);
      // When the door took the count it reports, which decides whether that count could
      // be read for the held connection at all (see `leftoverCountInstant`).
      const countedAt = leftoverCountInstant(record);
      // ...and the fact the VERDICT turns on above it: whether the run it was piped to
      // gave up on the request head this connection never received the end of, which is
      // the one ending of this connection that is not the door's (see
      // `heldConnectionProblems`).
      const runGaveUp = held.requests.some((answer) => answer.status === 408);
      // The instant the port changed hands, read once — three facts below are measured
      // against it — and whether anything was said to the held connection BEFORE that
      // instant, which is the half of the "answered while serving" claim that is a
      // finding (the door's own retry-503 for a connection whose run has gone is the
      // discharge the ending is judged by instead).
      const swappedAtMs = Date.parse(String(record.swappedAt ?? ""));
      const answeredBeforeSwap = held.requests.some((answer) => answer.at < swappedAtMs);
      reloads.push({
        index: index + 1,
        phase,
        outcome: record.outcome ?? null,
        closedBy: record.closedBy ?? null,
        // The reload's own clock, which is the part a slow regression moves: `startedAt`
        // is when it was asked for and `landedAt` when its record was written, so the
        // two are the whole cell — the replacement's boot, the window, the stop of the
        // run it replaced — rather than one leg of it.
        startedAt: record.startedAt ?? null,
        landedAt: record.at ?? null,
        swappedAt: record.swappedAt ?? null,
        served: record.served ?? 0,
        checks: record.checks ?? 0,
        windowUsedMs: record.windowUsedMs ?? null,
        replacementPort: record.replacementPort ?? null,
        retiredPort: retired,
        retiredPortFree: retiredFree,
        descendants: seen.rows === null ? null : seen.rows.length,
        handles: seen.handles,
        // The connection this reload held across its swap, as the facts a door claim
        // is judged on — what was said to it while the run it was piped to was
        // serving, when it ended and why, whether that ending came before the count
        // the door took, and the count itself. ALWAYS an object, including for a
        // connection that was never accepted: that is a finding in its own right
        // (`heldConnectionProblems`), and a null here would leave the account with the
        // problem text and no reason behind it. `trendRecord` projects this block, so
        // both the summary and the trend line carry it (see the header of
        // scripts/check-soak-trend.mjs for what reads it and why).
        held: {
          // Which SHAPE this block is, so a reader knows what it is reading rather than
          // inferring it from which fields happen to be present (see `HELD_SHAPE`). It is
          // written into every hold, including one that was never accepted, so the marker
          // is the one fact that is always there to be read.
          shape: HELD_SHAPE,
          accepted: held.accepted === true,
          // WHEN the door took the connection, which is the instant this hold began — and
          // it is opened BEFORE the reload is even asked for, so a timeline reads it first.
          // Null for a connection that was never accepted: there is no instant to name, and
          // `endedAt` (the instant the attempt failed) is the one there is.
          acceptedAt: held.acceptedAt === null ? null : new Date(held.acceptedAt).toISOString(),
          // Normally empty: this connection asks nothing while it is held (see
          // `holdConnection`), so anything here is the door — or the run, for the 408 —
          // speaking unprompted. One object per answer, its `status` and the instant it
          // arrived TOGETHER, because they are facts of the same answer: two lists beside
          // each other are two lists that can drift, and `length` is the count, so there is
          // none to keep in step either. Whether an answer is a FINDING is still the fact
          // the verdict turns on and is read from `answeredBeforeSwap` and these statuses,
          // which is why a reader of the trend line (where no per-reload swap instant
          // exists) classifies them that way rather than comparing instants itself.
          answered: held.requests.map((answer) => ({
            status: answer.status ?? String(answer.error ?? "?"),
            at: new Date(answer.at).toISOString(),
          })),
          // ...and whether any of them arrived BEFORE the port changed hands, which is
          // the half of that claim that is a finding: the run behind the door is still
          // serving until then, so an answer written before the swap is the door
          // costing a client its answer, while the door's own retry-503 for a
          // connection whose run has gone is the discharge the ending is judged by
          // (see `heldConnectionProblems`).
          answeredBeforeSwap,
          endedAt: held.endedAt === null ? null : new Date(held.endedAt).toISOString(),
          // How it ended, in the socket's own words: `closed`, `ended` (the peer's FIN),
          // `EPIPE`, `ECONNREFUSED` when the door was not there at all. The one fact a
          // hold that was never accepted has to explain itself with.
          endedReason: held.endedReason,
          endedBeforeSwap: held.endedAt !== null && held.endedAt < swappedAtMs,
          // Same fact, same name, as the watch's own per-swap record: whether the
          // connection had ended before the count was taken, which is what decides
          // whether the count could be read for it at all.
          endedBeforeCount: held.endedAt === null || countedAt === null ? null : held.endedAt <= countedAt,
          // The other boundary fact, under the same name the watch gives it: the
          // run gave up on a request this connection never finished sending.
          runGaveUp,
          afterStop: heldFinal.status === null ? `!${heldFinal.error}` : String(heldFinal.status),
          leftoverConnections: record.leftoverConnections ?? null,
        },
      });
      log(
        `reload ${index + 1}/${options.reloads} (${phase}): ${record.outcome} closed by ${record.closedBy}, ` +
          `${record.served} connection(s), window ${record.windowUsedMs}ms` +
          (seen.rows === null ? "" : `, ${seen.rows.length} descendant(s)`) +
          (seen.handles === null ? "" : `, ${seen.handles} descriptor(s)`) +
          (retiredFree === null ? "" : retiredFree ? `, port ${retired} free` : `, PORT ${retired} STILL HELD`) +
          (held.accepted === true
            ? `, held connection ${
                runGaveUp
                  ? "was given up on by the run it was piped to (408, for a request it never received in full)"
                  : held.requests.length === 0
                    ? "answered nothing while it was held"
                    : answeredBeforeSwap
                      ? `answered ${held.requests.length}x while the run it was piped to was serving`
                      : `answered ${held.requests.length}x after the port had changed hands`
              }, then ${heldFinal.status === null ? `ended (${heldFinal.error})` : `answered ${heldFinal.status}`}`
            : `, NO HELD CONNECTION (${held.endedReason ?? "it was never accepted"})`),
      );
    }

    doorStats = await trafficDriver.stop();
    trafficDriver = null;
  } finally {
    await trafficDriver?.stop?.().catch(() => {});
    sample?.stop?.();
  }

  const text = readFileSync(history, "utf8");
  const { entries, problems: historyProblems } = checkHistory(text, {
    expected: options.reloads,
    windowMs: options.windowMs,
    proof: options.proof,
    frontPort: port,
  });
  problems.push(...historyProblems);
  problems.push(...phaseProblems(entries, phases, { windowMs: options.windowMs, proof: options.proof }));
  problems.push(
    ...supervisorLogProblems(supervisorLog, {
      retirements: entries.filter((entry) => entry.record.outcome === "replaced").length,
    }),
  );
  // What the door did to the clients that were AT each swap: the reloads are the
  // only thing that says WHEN the port changed hands, and the answers carry when
  // each one was in a client's hands, so the two are read together here.
  // ...and each one names the two runs it is between, which is what lets a loss say WHICH client
  // of a run it was (`spent`): `handedAt` is when the run this swap retires was handed the port
  // — the swap before it, or the beginning of the account for the first one, since a soak's
  // account begins with the traffic that its first run was handed — and the entries after it are
  // what says when the run it points at stopped being handed clients (see `handedRun`).
  const swaps = entries
    .map((entry, index) => ({
      index: index + 1,
      phase: phases[index] ?? "?",
      at: Date.parse(String(entry.record.swappedAt ?? "")),
      previousPort: entry.record.previousPort ?? null,
      replacementPort: entry.record.replacementPort ?? null,
    }))
    .filter((swap) => Number.isFinite(swap.at))
    .map((swap, position, list) => ({ ...swap, handedAt: position === 0 ? null : list[position - 1].at }));
  const door = swapProblems(doorStats?.answers ?? [], swaps, { bandMs: options.swapBandMs });
  problems.push(...door.problems);

  await stopSupervisor(child, { platform: process.platform, sleepImpl, log });

  const ports = await checkPortsFree([...runPorts], { sleepImpl });
  for (const held of ports.held) {
    problems.push(`port ${held} is still held after the supervisor was stopped — something outlived it`);
  }
  if (descendantsUnreadable) {
    notes.push("descendant processes are not readable on this platform, so a leaked run is caught by its port instead");
  }
  const handles = handleTrendProblems(readings, { slack: options.handleSlack });
  problems.push(...handles.problems);
  if (handles.skipped.length > 0) {
    notes.push(
      `the descriptor trend is not judged for ${handles.skipped.join(", ")}: fewer than four reloads of a phase is too few for a ` +
        "floor to be read from",
    );
  }
  if (handlesUnreadable || sample?.measured?.handles === false) {
    notes.push("the supervisor's handle count is not readable on this platform, so a leaked socket would show as a timeout instead");
  }

  return report({
    options,
    phases,
    reloads,
    doorStats,
    swaps: door.evidence,
    records: entries,
    problems,
    notes,
    descriptors: Object.fromEntries(readings),
    floors: handles.floors,
    port,
    history,
    trend,
    out,
    err,
  });
}

/**
 * The trend record's schema, and the ONE place its shape is declared — the reader
 * (scripts/check-soak-trend.mjs) imports this and the name with it, the way a
 * reader of the reload history takes its schema from the module that writes it.
 */
export const SOAK_TREND_SCHEMA = "anybase-soak-trend/1";

/**
 * The shape of a reload's `held` block, written into every one of them so that a reader
 * knows what it is reading rather than inferring it from which fields happen to be present.
 *
 * Version 2 writes the answers as ONE OBJECT PER ANSWER (`answered`, each with its own
 * `status` and `at`), so the status and the instant cannot drift apart and the list's length
 * IS the count — there is no second list and no number to keep in step. Version 1 — every
 * hold written before this marker existed — put the count in `answers` and the facts in two
 * parallel lists beside it (`answerStatuses`, `answerInstants`), and carries no `shape` at
 * all. So the ABSENCE of this field is information too: it says the block is an older shape
 * whose answers a reader that knows only version 2 must not read as if they were its own.
 *
 * The readers (scripts/check-soak-trend.mjs, scripts/soak-diagnose.mjs) take the marker at
 * its word — `answersOf` reads answers only from a block that names THIS shape — rather than
 * guessing from the fields present, which is the whole reason the marker is written.
 *
 * This describes the RELOAD's held block, the one the summary's `reloadsDetail[].held` and
 * the trend line's `held` both carry. `swapsAtTheDoor[].held` is a different block with a
 * different job (the watch's per-swap account, counted rather than listed) and is not read
 * by those two readers.
 */
export const HELD_SHAPE = "anybase-held/2";

/**
 * One soak run, as the trend's own line: what the run cost and what it left behind.
 *
 * The summary is the run's account and this is a projection of it, so nothing is
 * measured twice and the two cannot disagree. What the projection adds is shape: the
 * per-reload durations and windows are grouped by phase and in order, outcomes are
 * counted rather than listed, and `profile` is carried so that runs from different
 * machines or engines are never compared as if they were the same measurement —
 * which is the mistake a trend of timings makes if it is left to a reader's memory.
 *
 * The held connections are the exception to that shape, and on purpose: a door claim
 * names ONE reload ("the door reported 0 connection(s) still on the run it retired",
 * in reload 3), so the facts it rests on are carried per reload, in reload order,
 * under their own identity — `index`, `phase` and the port that run held — rather than
 * grouped by phase like a timing. They come straight from the reload's own `held`
 * block, so a summary and its trend line cannot tell two stories about one swap —
 * a copy of the block, marker and instants and all (`shape`, `acceptedAt`, `answered`),
 * rather than a second reading of the same connection.
 *
 * @param {Record<string, any>} summary the object `--json` writes
 * @returns {Record<string, any>} the record to append to a trend file
 */
export function trendRecord(summary) {
  const durations = {};
  const windows = {};
  const outcomes = {};
  const held = [];
  for (const reload of summary.reloadsDetail ?? []) {
    const phase = reload.phase ?? "?";
    // The reload's own ask→land cell. A record that predates these two fields (or a
    // run whose reload left no record) contributes nothing rather than a zero, so a
    // missing duration can never read as a fast one.
    const startedAt = Date.parse(reload.startedAt ?? "");
    const landedAt = Date.parse(reload.landedAt ?? "");
    if (Number.isFinite(startedAt) && Number.isFinite(landedAt)) {
      (durations[phase] ??= []).push(landedAt - startedAt);
    }
    if (Number.isFinite(reload.windowUsedMs)) (windows[phase] ??= []).push(reload.windowUsedMs);
    if (typeof reload.outcome === "string") outcomes[reload.outcome] = (outcomes[reload.outcome] ?? 0) + 1;
    // The connection this reload held across its swap, with the identity a claim
    // needs to be read against it. A reload whose held block is missing (a record
    // from before the field existed) contributes nothing here rather than an entry
    // that would read as a hold with no facts; an empty `held: []` says so.
    if (reload.held) {
      held.push({
        index: reload.index ?? null,
        phase,
        retiredPort: reload.retiredPort ?? null,
        ...reload.held,
      });
    }
  }
  const swaps = summary.swapsAtTheDoor ?? [];
  return {
    schema: SOAK_TREND_SCHEMA,
    at: summary.at ?? null,
    profile: summary.profile ?? null,
    verdict: summary.verdict,
    reloads: {
      asked: summary.reloads ?? null,
      performed: summary.performed ?? null,
      records: summary.records ?? null,
      byPhase: summary.byPhase ?? {},
    },
    durations,
    windows,
    floors: summary.floors ?? null,
    descriptors: summary.descriptors ?? null,
    outcomes,
    door: {
      requests: summary.requests ?? null,
      answers: summary.answers ?? null,
      byStatus: summary.byStatus ?? {},
      timeouts: summary.timeouts ?? null,
      connectionErrors: summary.connectionErrors ?? null,
      swapsWithAClient: summary.swapsWithAClient ?? null,
      clientsInFlight: summary.clientsInFlight ?? null,
      // How many clients the swaps had AT THE DOOR — each swap's own band — which is the sample a
      // loss is a rate OF. Not the same set as the clients in flight: the band is wider than the
      // instant, so a request answered inside the window but after the port changed hands was at
      // the door and never in flight, and dividing losses by the in-flight count would read a loss
      // off a sample that never held it. Carried here for the same reason as the rest of the
      // block: the account that OUTLIVES the run reads its rates without the run's summary beside
      // it, and a denominator missing from the line is a rate missing from that reading.
      clientsAtTheDoor: swaps.reduce((total, swap) => total + (swap.band ?? 0), 0),
      lost: swaps.reduce((total, swap) => total + (swap.lost ?? 0), 0),
    },
    // What each reload held across its swap (see above): the facts a red run's door
    // claims are read against, carried so the account that OUTLIVES the run — the
    // trend file, one line per run, accumulating across artifacts — can be diagnosed
    // without the run's summary beside it. `scripts/check-soak-trend.mjs` names the
    // ones that are not the ordinary shape when the newest record did not pass.
    held,
    notes: summary.notes ?? [],
    problems: summary.problems ?? [],
  };
}

/** The summary: a person's lines on stderr, the verdict on stdout as a line and a JSON object. */
function report({ options, phases, reloads, doorStats, swaps, records, problems, notes, descriptors, floors, port, history, trend, out, err }) {
  const closedBy = {};
  for (const reload of reloads) closedBy[reload.closedBy ?? "none"] = (closedBy[reload.closedBy ?? "none"] ?? 0) + 1;
  const byPhase = {};
  for (const reload of reloads) byPhase[reload.phase] = (byPhase[reload.phase] ?? 0) + 1;
  const verdict = problems.length === 0 ? "PASS" : "FAIL";
  const summary = {
    verdict,
    // When this run concluded, and what it ran ON: a timing or a descriptor count
    // means nothing without the machine and the engine it was read from, and the
    // trend reader compares only runs that agree about all three.
    at: new Date().toISOString(),
    profile: { platform: process.platform, arch: process.arch, node: process.versions.node.split(".")[0] },
    reloads: options.reloads,
    performed: reloads.length,
    phases,
    byPhase,
    closedBy,
    records: records.length,
    outcomes: [...new Set(records.map((entry) => entry.record.outcome))],
    frontPort: port,
    history,
    requests: doorStats?.requests ?? null,
    answers: doorStats?.answers.length ?? null,
    byStatus: doorStats?.byStatus ?? {},
    timeouts: doorStats?.timeouts ?? 0,
    connectionErrors: doorStats?.errors ?? 0,
    // What each swap had in its hands: the clients open across it, how many of
    // those were answered, and how many were lost — per swap, rather than as one
    // total for the soak, because the claim is about the instant the port moved.
    swapsAtTheDoor: swaps,
    swapsWithAClient: swaps.filter((swap) => swap.band > 0).length,
    clientsInFlight: swaps.reduce((total, swap) => total + swap.inFlight, 0),
    descriptors,
    // The floor each phase's halves read, as numbers: the leak check's own verdict on
    // them is in `problems`, and the trend carries them forward so a floor that rises
    // BETWEEN runs shows up as the slow regression it is (scripts/check-soak-trend.mjs).
    floors,
    reloadsDetail: reloads,
    notes,
    problems,
  };

  // Every run leaves its own line, a failed one included: a trend of the green runs
  // only is a trend that cannot show a regression, and the reader refuses a record
  // that did not pass as a baseline rather than averaging it in.
  appendFileSync(trend, `${JSON.stringify(trendRecord(summary))}\n`);

  err(`${options.reloads} reload(s) asked for, ${reloads.length} performed: ${phases.join(", ")}\n`);
  for (const reload of reloads) {
    err(
      `  ${reload.index}/${options.reloads} ${String(reload.phase).padEnd(7)} ${String(reload.outcome).padEnd(10)} ` +
        `closed by ${String(reload.closedBy).padEnd(8)} served ${String(reload.served).padStart(2)} ` +
        `window ${String(reload.windowUsedMs).padStart(5)}ms port ${String(reload.replacementPort).padStart(5)}` +
        (reload.descendants === null ? "" : ` descendants ${reload.descendants}`) +
        (reload.handles === null ? "" : ` handles ${reload.handles}`) +
        (reload.retiredPortFree === null ? "" : reload.retiredPortFree ? ` retired ${reload.retiredPort} free` : ` retired ${reload.retiredPort} HELD`) +
        "\n",
    );
  }
  if (doorStats) {
    err(
      `through the door: ${doorStats.requests} request(s), statuses ${JSON.stringify(doorStats.byStatus)}, ` +
        `${doorStats.timeouts} timeout(s), ${doorStats.errors} connection error(s)\n`,
    );
  }
  if (swaps.length > 0) {
    const inFlight = swaps.reduce((total, swap) => total + swap.inFlight, 0);
    err(
      `at the swaps: ${swaps.length} port change(s), a client at ${swaps.filter((swap) => swap.band > 0).length} of them, ` +
        `${inFlight} connection(s) in flight across the change, ${swaps.reduce((total, swap) => total + swap.lost, 0)} lost\n`,
    );
  }
  for (const note of notes) err(`note: ${note}\n`);
  for (const problem of problems) err(`problem: ${problem}\n`);
  const line =
    `SOAK_VERDICT=${verdict} reloads=${reloads.length}/${options.reloads} records=${records.length} ` +
    `closed_by=${Object.entries(closedBy).map(([key, count]) => `${key}:${count}`).join(",") || "-"} ` +
    `swaps_at_the_door=${swaps.filter((swap) => swap.band > 0).length}/${swaps.length} ` +
    `in_flight=${swaps.reduce((total, swap) => total + swap.inFlight, 0)} problems=${problems.length}\n`;
  err(line);
  if (options.json) out(`${JSON.stringify(summary)}\n`);
  else out(`${line.trim()} history=${history}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
