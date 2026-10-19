import { readFileSync } from "node:fs";

import {
  RELOAD_HISTORY_VIEW_LIMIT,
  parseReloadHistory,
  type ReloadHistoryView,
} from "@/lib/deploy/reload-history";

/**
 * GET → the reloads `npm start` has performed, newest first.
 *
 * The history is a file on the machine the server runs on, named by
 * `PROD_RELOAD_HISTORY`, so reading it is the server's job and this route is the
 * only way a page can see it. It is read per request and never cached — the point
 * of the surface is an operator watching a deploy, waiting for a line that has
 * not been written yet, and a cached answer would be a lie about exactly the
 * thing they are waiting on. `Cache-Control: no-store` says the same to anything
 * in front of this.
 *
 * The status is 200 even when there is nothing to show: "no file yet" and "no
 * reload has been performed" are answers, not failed requests. The body carries
 * `error` for the two shapes an operator has to tell apart — `missing` (nothing
 * has been written at that path) and `unreadable` (a file that exists and could
 * not be read) — and the page says which.
 *
 * What comes back is the PARSED records, never the file: the record carries times,
 * outcomes, window sizes and ports, and no credential of any kind. The one server
 * fact in it is the sentinel path that asked for the reload (`asked`), which is
 * the operator's own configuration and the thing they need to read a row's
 * provenance. Nothing here writes, and nothing here is a gate: the refusal to
 * judge a record it cannot read belongs to `scripts/check-reload-history.mjs`,
 * which is what a pipeline branches on.
 */

/** A live view of a file being appended to: nothing in front of this may cache it. */
const NO_STORE = { "Cache-Control": "no-store" };

/** Always read the file, never serve a build-time answer. */
export const dynamic = "force-dynamic";

/** `node:fs` — this is the machine's own state, not an edge-cacheable value. */
export const runtime = "nodejs";

function view(
  path: string | null,
  error: ReloadHistoryView["error"],
): ReloadHistoryView {
  return {
    configured: path !== null,
    path,
    total: 0,
    records: [],
    unreadable: [],
    error,
  };
}

export async function GET() {
  const path = process.env.PROD_RELOAD_HISTORY ?? null;
  // No path, no history: the supervisor only writes one when an operator names
  // it, and an empty view is the truthful answer rather than an error.
  if (path === null) return Response.json(view(null, null), { headers: NO_STORE });

  let text: string;
  try {
    // The opt-out is deliberate. `PROD_RELOAD_HISTORY` is wherever the operator
    // pointed the supervisor — there is no subfolder to scope this to, and the
    // alternative Turbopack chooses (tracing the whole project into the server
    // output, because the path could be any file) would put this repo's source
    // into every deployment to read one small JSONL file.
    text = readFileSync(/* turbopackIgnore: true */ path, "utf8");
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return Response.json(
      failure?.code === "ENOENT"
        ? view(path, {
            kind: "missing",
            message: `no reload history at ${path} yet — the file appears once a reload has been performed`,
          })
        : view(path, {
            kind: "unreadable",
            message: `${path} could not be read (${failure?.message ?? String(error)})`,
          }),
      { headers: NO_STORE },
    );
  }

  const { records, unreadable } = parseReloadHistory(text);
  // Newest first, by `at` rather than by position: a file does not have to be
  // strictly append-ordered to be readable.
  const ordered = [...records].sort((left, right) => right.atMs - left.atMs);
  const body: ReloadHistoryView = {
    configured: true,
    path,
    total: records.length,
    records: ordered.slice(0, RELOAD_HISTORY_VIEW_LIMIT),
    unreadable,
    error: null,
  };
  return Response.json(body, { headers: NO_STORE });
}
