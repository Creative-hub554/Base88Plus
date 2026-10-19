/**
 * The reload record, READ — one declaration of what a line of
 * `PROD_RELOAD_HISTORY` means, used by every surface that reads one.
 *
 * A reload of the production server leaves a JSON object per line: when it began,
 * when the port changed hands, when the verdict landed, what became of it, what
 * closed the rollback window, and the evidence for all of it. Three things read
 * that file, and they must not each decide for themselves what it says:
 *
 *   - `npm run check:reload-history` (scripts/check-reload-history.mjs), the gate
 *     a deploy pipeline branches on, which exits non-zero when the reload did not
 *     land;
 *   - `GET /api/deploy/reloads`, which the settings page calls;
 *   - the settings panel itself, which names each outcome in words.
 *
 * So the vocabulary lives here, once. `OUTCOME_VERDICT` is the whole of it: the
 * gate turns `landed: false` into a non-zero exit, and the panel turns the same
 * object into a red row carrying the same words — a page that coloured a rollback
 * green while the gate failed the deploy is exactly the drift this file exists to
 * make impossible.
 *
 * STRICT AND LENIENT, DELIBERATELY
 * --------------------------------
 * The gate is a gate: it refuses an outcome it has never heard of, and refuses to
 * judge at all while the file carries a line it cannot place, because a gate that
 * cannot read its evidence does not pass. The page is a view: it shows the records
 * it has, names an outcome it does not know verbatim instead of pretending it is
 * fine, and counts the lines it could not read rather than showing nothing.
 * `parseReloadHistory` therefore does both, and the difference is one argument —
 * the gate passes the writer's own schema constant (declared in
 * `scripts/supervise.mjs`, not restated here) and the page passes nothing.
 *
 * NO IMPORTS, ON PURPOSE
 * ----------------------
 * This module is imported by a plain `node` script (the gate), by a Next route,
 * and by a client component — so it carries no file access and no path alias, and
 * nothing that type-stripping cannot erase (no enums, no namespaces). Reading the
 * file belongs to the callers, whose needs differ anyway: the gate waits for a
 * record that has not been written yet, and the page degrades to a sentence when
 * the file is not there. `scripts/demo-link-audit.mjs` importing
 * `src/lib/demo-link-audit.ts` is the same arrangement.
 */

/** How many reloads a view shows. Ten is a deploy's recent history, not an archive. */
export const RELOAD_HISTORY_VIEW_LIMIT = 10;

/** One line of the history, as the writer wrote it. Every field is optional here. */
export interface ReloadRecord {
  schema?: string;
  at?: string;
  startedAt?: string;
  swappedAt?: string | null;
  /** What asked for the reload: the sentinel file's path, or `SIGHUP`. */
  asked?: string;
  outcome?: string;
  closedBy?: string | null;
  rolledBack?: boolean;
  windowMs?: number;
  windowUsedMs?: number | null;
  proofConnections?: number;
  served?: number;
  checks?: number;
  leftoverConnections?: number;
  replacementPort?: number | null;
  previousPort?: number | null;
  frontPort?: number | null;
  detail?: string | null;
}

/** What an outcome means for a deploy: whether it landed, and how to say it. */
export interface ReloadVerdict {
  landed: boolean;
  word: string;
  why: string;
}

/**
 * The vocabulary, and the only place it is decided.
 *
 * `replaced` and `stopped` landed — `stopped` is a shutdown that ended the reload
 * with the replacement already in place, which is a reload that happened and is
 * printed with its detail rather than reported as one that did not. `kept` is
 * nothing changed, `rolled-back` is the port going back to the run it replaced,
 * and `no-fallback` is a replacement that failed with no run left to go back to:
 * not a rollback and not a no-op, a deploy that landed BROKEN, which is the worst
 * of the three to hand a pipeline as green.
 */
export const OUTCOME_VERDICT: Record<string, ReloadVerdict> = {
  replaced: {
    landed: true,
    word: "REPLACED",
    why: "the replacement is serving and the run it replaced was retired",
  },
  stopped: {
    landed: true,
    word: "STOPPED",
    why: "the replacement is in place, but a shutdown ended the reload before the window did",
  },
  "rolled-back": {
    landed: false,
    word: "ROLLED BACK",
    why: "the replacement failed and the port went back to the run it replaced",
  },
  kept: {
    landed: false,
    word: "NOTHING CHANGED",
    why: "the run that was already serving kept serving",
  },
  "no-fallback": {
    landed: false,
    word: "LANDED BROKEN",
    why: "the replacement failed and the run it replaced was already gone, so it is serving anyway",
  },
};

/** The verdict for an outcome, or null for one this build has never heard of. */
export function verdictFor(outcome: string | null | undefined): ReloadVerdict | null {
  if (typeof outcome !== "string") return null;
  return OUTCOME_VERDICT[outcome] ?? null;
}

/** A record, plus this reader's notes about where it came from. */
export interface ReloadEntry {
  record: ReloadRecord;
  /** `at` as epoch milliseconds — what "newest" and "recent" are measured on. */
  atMs: number;
  /** Line number in the file, so a bad line can be named. */
  line: number;
  /** The verdict, or null when the outcome is not one this build knows. */
  verdict: ReloadVerdict | null;
}

/** A line this reader could not use, with the reason in a form a person can act on. */
export interface ReloadLineProblem {
  line: number;
  reason: string;
}

export interface ParsedReloadHistory {
  records: ReloadEntry[];
  unreadable: ReloadLineProblem[];
}

/**
 * The history file, as entries this reader can use and lines it cannot.
 *
 * Blank lines are nothing (a trailing newline is not a finding). Anything else
 * that is not a record object with an outcome and a readable `at` is reported
 * with its line number rather than skipped, because the caller's next question
 * about a skipped line is "and what did it say?".
 *
 * With `schema`, a line carrying a different one is unreadable too — that is the
 * gate's strictness, and it exists so a newer supervisor's record cannot be read
 * by an older gate as though it understood it. Without it, the line is kept and
 * its schema travels with it: a page showing records it half-understands is
 * useful, a gate passing on them is not.
 */
export function parseReloadHistory(
  text: string,
  options: { schema?: string } = {},
): ParsedReloadHistory {
  const { schema } = options;
  const records: ReloadEntry[] = [];
  const unreadable: ReloadLineProblem[] = [];

  String(text)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const at = index + 1;
      if (line.trim() === "") return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        unreadable.push({ line: at, reason: "not JSON" });
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        unreadable.push({ line: at, reason: "not a record object" });
        return;
      }
      const record = parsed as ReloadRecord;
      if (schema !== undefined && record.schema !== schema) {
        unreadable.push({
          line: at,
          reason: `schema ${JSON.stringify(record.schema ?? null)} is not ${schema}`,
        });
        return;
      }
      if (typeof record.outcome !== "string") {
        unreadable.push({ line: at, reason: "no outcome" });
        return;
      }
      const atMs = Date.parse(record.at ?? "");
      if (!Number.isFinite(atMs)) {
        unreadable.push({ line: at, reason: `no readable at: ${JSON.stringify(record.at ?? null)}` });
        return;
      }
      records.push({ record, atMs, line: at, verdict: verdictFor(record.outcome) });
    });

  return { records, unreadable };
}

/**
 * The evidence a verdict rests on, as one clause: which window was open, how long
 * it was allowed and how long it actually took, what closed it, and what the app
 * and the health checks actually did. A window that never opened is SAID rather
 * than shown as a zero — nothing was swapped in, so there is no window to measure.
 */
export function reloadEvidence(record: ReloadRecord): string {
  const window =
    record.swappedAt === null || record.swappedAt === undefined
      ? "no window was ever open"
      : `window ${record.windowUsedMs ?? "?"}ms of ${record.windowMs ?? "?"}ms, closed by ${record.closedBy ?? "-"}`;
  return (
    `asked by ${record.asked ?? "-"} at ${record.startedAt ?? "-"}; ${window}; ` +
    `${record.served ?? 0} real connection(s) from the app, ${record.checks ?? 0} health check(s)`
  );
}

/** One judged reload, as a single line for a log — the gate's own summary. */
export function describeReload(record: ReloadRecord, verdict: ReloadVerdict): string {
  return (
    `${record.at} ${verdict.word} — ${verdict.why} (${reloadEvidence(record)})` +
    (record.detail ? `: ${record.detail}` : "")
  );
}

/** Why there is nothing to show, in the two shapes that differ to an operator. */
export interface ReloadHistoryError {
  /** `missing`: no file yet. `unreadable`: a file that exists and could not be read. */
  kind: "missing" | "unreadable";
  message: string;
}

/** What a reader of the history gets: the path, the newest records, and what went wrong. */
export interface ReloadHistoryView {
  /** Whether a history file was named at all (`PROD_RELOAD_HISTORY`). */
  configured: boolean;
  path: string | null;
  /** Records the file holds, whether or not they are inside the view's limit. */
  total: number;
  /** Newest first, at most the view's limit of them. */
  records: ReloadEntry[];
  unreadable: ReloadLineProblem[];
  error: ReloadHistoryError | null;
}
