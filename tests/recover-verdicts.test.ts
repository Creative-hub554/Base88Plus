/**
 * Pins for scripts/recover-verdicts.mjs - the pass that re-posts a verifier
 * verdict whose run finished without recording it.
 *
 * The fixtures are not invented. `OCT3_LOG` is the exact, complete contents of
 * run 37157439771's `oct3-verify-log` artifact (15 lines), and the two comment
 * bodies are the real ones this repo exchanged over issue #18 - the 2026-10-05
 * heartbeat comment that *reported* the verdict missing, and the 2026-10-09
 * recovery comment that supplied it. Both are load-bearing:
 *
 *   - the heartbeat comment contains the receipt marker `post-Oct-3 verifier`
 *     (it quotes it while saying the verdict was never recorded), so a receipt
 *     test of `body.includes(marker)` credits it. That is the false positive
 *     that made #18's receipt contract read satisfied while nothing was
 *     recorded, and `isReceipted` exists in its strict form to refuse it;
 *   - the artifact's `SNAPSHOT ... age=1d` line is the detail the hand recovery
 *     of 2026-10-09 paraphrased as "0 days old", which is why the reconstruction
 *     path quotes the artifact instead of describing it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

// RECEIPTS is a derived view over the single declaration, so it is imported from
// the declaration: heartbeat-audit.mjs no longer owns a copy of a contract fact.
import { RECEIPTS, contractFor } from "../scripts/verdict-contract.mjs";
import {
  BODY_MARKER,
  RECOVERABLE,
  RETENTION_DAYS,
  buildRecoveredBody,
  isReceipted,
  parseRecordLog,
  selectUnreceipted,
  unzipEntry,
} from "../scripts/recover-verdicts.mjs";

/**
 * The record shape of one workflow, taken from the declaration rather than from a
 * global regex - which is the whole point: a single global shape cannot both see
 * oct28-verify's NO_DISPATCH_RUN and refuse it as a PASS.
 */
const SHAPE = (workflow: string) => contractFor(workflow).shape;

/** Verbatim contents of run 37157439771's oct3-verify-log artifact. */
const OCT3_LOG = [
  "RUN id=37123382655 conclusion=success url=https://github.com/Creative-hub554/Base88Plus/actions/runs/37123382655",
  "PUSH_MARKER ok",
  "COMMIT 130cbf58 by github-actions[bot] - chore: refresh node release schedule snapshot [skip ci]",
  "STEPS refresh=success commit=success",
  "SNAPSHOT _fetchedAt=2026-10-03 age=1d",
  "LIVE not compared (commit found)",
  "VERDICT=PASS_REFRESHED",
  "COMMENT_FAILED Response status code does not indicate success: 403 (Forbidden).",
  "",
  "{",
  '  "message": "Resource not accessible by integration",',
  '  "documentation_url": "https://docs.github.com/rest/issues/comments#create-an-issue-comment",',
  '  "status": "403"',
  "}",
  "exit=0",
].join("\n");

/** The heartbeat comment that reported the verdict missing (real, comment 5998613523). */
const HEARTBEAT_COMPLAINT =
  "Weekly schedule heartbeat (2026-10-05): **2 finding(s)** - a schedule looks dead or disabled.\n\n" +
  "- `Oct 3 verifier (.github/workflows/oct3-verify.yml)` cron `47 7 3 10 *` DID run - run " +
  "37157439771 finished `success` - but the Oct 3 verdict was never recorded on #18 (no comment " +
  "carrying `post-Oct-3 verifier` since 2026-10-03T07:47:00.000Z).";

/** The recovery comment that supplied it (real, comment 6073315277). */
const RECOVERY_COMMENT =
  "post-Oct-3 verifier (run 37157439771, 2026-10-03): **PASS_REFRESHED**\n\n" +
  "> **Recovered by hand on 2026-10-09.** All three Oct 3 verifier runs computed this verdict...";

const comment = (id: number, created_at: string, body: string) => ({ id, created_at, body });
const run = (id: number, created_at: string, extra: Record<string, unknown> = {}) => ({
  id,
  created_at,
  status: "completed",
  conclusion: "success",
  ...extra,
});

const OCT3 = RECOVERABLE["oct3-verify.yml"];
const OCT4 = RECOVERABLE["oct4-sentinel.yml"];

describe("verdict recovery: the receipt test refuses the false positive", () => {
  it("does NOT accept the heartbeat's complaint that the verdict is missing", () => {
    // The body contains the marker verbatim. That is the whole trap.
    expect(HEARTBEAT_COMPLAINT.includes(OCT3.marker)).toBe(true);
    // ...and it carries no verdict, which is what makes it not a receipt.
    expect(SHAPE("oct3-verify.yml").test(HEARTBEAT_COMPLAINT)).toBe(false);
    expect(
      isReceipted(
        [comment(5998613523, "2026-10-05T16:26:10Z", HEARTBEAT_COMPLAINT)],
        OCT3,
        Date.parse("2026-10-03T22:08:49Z"),
      ),
    ).toBe(false);
  });

  it("accepts the verdict that actually landed", () => {
    expect(SHAPE("oct3-verify.yml").test(RECOVERY_COMMENT)).toBe(true);
    expect(
      isReceipted(
        [comment(6073315277, "2026-10-09T02:56:39Z", RECOVERY_COMMENT)],
        OCT3,
        Date.parse("2026-10-03T22:08:49Z"),
      ),
    ).toBe(true);
  });

  it("credits a verdict recorded after the run, so a retry chain cannot post three times", () => {
    // The Oct 3 chain declares three attempts. One landed verdict is the ask:
    // every earlier attempt is covered by the later receipt.
    const comments = [comment(6073315277, "2026-10-09T02:56:39Z", RECOVERY_COMMENT)];
    for (const startedAt of ["2026-10-03T12:43:49Z", "2026-10-03T14:15:51Z", "2026-10-03T22:08:49Z"]) {
      expect(isReceipted(comments, OCT3, Date.parse(startedAt))).toBe(true);
    }
  });

  it("will not accept a verdict recorded before the run as this run's receipt", () => {
    expect(
      isReceipted(
        [comment(7, "2026-10-02T22:12:00Z", RECOVERY_COMMENT)],
        OCT3,
        Date.parse("2026-10-03T22:08:49Z"),
      ),
    ).toBe(false);
  });

  it("ignores the other verifier's receipt entirely", () => {
    expect(
      isReceipted(
        [comment(1, "2026-10-29T00:00:00Z", "post-Oct-28 verifier (run 1, 2026-10-28): **PASS_REFRESHED**")],
        OCT3,
        Date.parse("2026-10-03T22:08:49Z"),
      ),
    ).toBe(false);
  });
});

describe("verdict recovery: reading the run's own artifact", () => {
  it("parses the real Oct 3 artifact into a verdict and keeps its log whole", () => {
    const r = parseRecordLog(OCT3_LOG);
    expect(r.verdict).toBe("PASS_REFRESHED");
    // `RUN id=` is the CI run the verifier INSPECTED, not the verifier's own
    // run - 37157439771 is the verifier, 37123382655 is what it looked at.
    expect(r.inspectedRunId).toBe(37123382655);
    expect(r.commentFailed).toContain("403 (Forbidden)");
    expect(r.verbatim).toBeNull(); // this artifact predates the body dump

    // The log is kept WHOLE, not filtered to a whitelist of interesting lines.
    // The oct4 sentinel's most useful output - "scheduled oct3-verify attempts
    // in ...", "#18 verifier comments since Oct 3: 0 (PASS: 0)" - matches no
    // prefix such a whitelist would have carried, and a whitelist silently
    // drops whatever a future script starts printing.
    expect(r.log).toBe(OCT3_LOG.trim());
    for (const line of [
      "COMMIT 130cbf58 by github-actions[bot] - chore: refresh node release schedule snapshot [skip ci]",
      "PUSH_MARKER ok",
      "STEPS refresh=success commit=success",
      "SNAPSHOT _fetchedAt=2026-10-03 age=1d",
      "LIVE not compared (commit found)",
      "COMMENT_FAILED Response status code does not indicate success: 403 (Forbidden).",
    ]) {
      expect(r.log, line).toContain(line);
    }
    // Even the JSON error blob is kept - it is the reason the record was lost.
    expect(r.log).toContain("Resource not accessible by integration");
  });

  it("reports no verdict for a run that legitimately produced none", () => {
    // A date gate refusing on a non-cron day logs nothing verdict-shaped.
    const r = parseRecordLog(
      "REFUSED_DATE_GATE today=2026-10-09 cron fires 2026-10-03T07:17Z\nexit=2\n",
    );
    expect(r.verdict).toBeNull();
    expect(r.verbatim).toBeNull();
  });

  it("prefers the composed body verbatim when the run printed one", () => {
    const body = "post-Oct-3 verifier (run 9, 2026-10-03): **ATTENTION_COMMIT_MISSING**\n\n- Steps: x\n\nNext: y";
    const r = parseRecordLog(`${OCT3_LOG}\n${BODY_MARKER}\n${body}\n`);
    expect(r.verdict).toBe("PASS_REFRESHED");
    expect(r.verbatim).toBe(body);
  });

  it("quotes the artifact rather than paraphrasing it (the age=1d detail)", () => {
    const record = parseRecordLog(OCT3_LOG);
    const body = buildRecoveredBody({
      run: run(37157439771, "2026-10-03T22:08:49Z"),
      spec: OCT3,
      record,
    });
    // The identity names the run the RECORD names: the CI run this verifier
    // inspected (OCT3_LOG's `RUN id=`), not the verifier's own run - because that
    // is the string the verifier's own ALREADY_RECORDED guard searches for, and a
    // recovered record the sender cannot see is a duplicate waiting to happen.
    expect(body).toContain("post-Oct-3 verifier (run 37123382655, 2026-10-03): **PASS_REFRESHED**");
    expect(body).not.toContain("post-Oct-3 verifier (run 37157439771");
    // The exact bytes, not a rendering: the hand recovery said "0 days old".
    expect(body).toContain("SNAPSHOT _fetchedAt=2026-10-03 age=1d");
    expect(body).not.toMatch(/age=0d/);
    expect(SHAPE("oct3-verify.yml").test(body)).toBe(true);
    expect(body.includes(OCT3.marker)).toBe(true);
  });

  it("copies a verbatim body through unchanged, with the header prepended", () => {
    const inner = "post-Oct-3 verifier (run 1, 2026-10-03): **PASS_REFRESHED**\n\nNext: nothing";
    const body = buildRecoveredBody({
      run: run(37157439771, "2026-10-03T22:08:49Z"),
      spec: OCT3,
      record: parseRecordLog(`${BODY_MARKER}\n${inner}\n`),
    });
    expect(body).toContain(inner);
    // No `RUN id=` line in this log, so which run the record names is unknown and
    // the run being recovered is the only id there is - the fallback, pinned here.
    expect(body.startsWith("post-Oct-3 verifier (run 37157439771, 2026-10-03)")).toBe(true);
  });
});

describe("verdict recovery: which runs need it", () => {
  const runs = [
    run(37123811425, "2026-10-03T12:43:49Z"),
    run(37129011940, "2026-10-03T14:15:51Z"),
    run(37157439771, "2026-10-03T22:08:49Z"),
  ];

  it("finds all three Oct 3 runs when nothing landed, oldest first", () => {
    const todo = selectUnreceipted(runs, [], OCT3);
    expect(todo.map((r) => r.id)).toEqual([37123811425, 37129011940, 37157439771]);
  });

  it("finds none once one verdict has landed", () => {
    const comments = [comment(6073315277, "2026-10-09T02:56:39Z", RECOVERY_COMMENT)];
    expect(selectUnreceipted(runs, comments, OCT3)).toEqual([]);
  });

  it("still wants a receipt when only the heartbeat's complaint exists", () => {
    // The state this pass exists to repair, and the state the loose marker test
    // would have called healthy.
    const comments = [comment(5998613523, "2026-10-05T16:26:10Z", HEARTBEAT_COMPLAINT)];
    expect(selectUnreceipted(runs, comments, OCT3)).toHaveLength(3);
  });

  it("skips a run that has not finished - it may still be about to post", () => {
    const todo = selectUnreceipted(
      [run(1, "2026-10-03T12:00:00Z", { status: "in_progress", conclusion: null })],
      [],
      OCT3,
    );
    expect(todo).toEqual([]);
  });

  it("does not filter by conclusion - a lost FAIL_ is as lost as a lost PASS", () => {
    const todo = selectUnreceipted(
      [
        run(1, "2026-10-03T12:00:00Z", { conclusion: "failure" }),
        run(2, "2026-10-03T13:00:00Z", { conclusion: "success" }),
      ],
      [],
      OCT3,
    );
    expect(todo.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("verdict recovery: the log's own contract", () => {
  const SCRIPTS: Record<string, string> = {
    "oct3-verify.yml": "scripts/verify-oct3.ps1",
    "oct28-verify.yml": "scripts/verify-oct28.ps1",
    "oct4-sentinel.yml": "scripts/oct4-sentinel.ps1",
    "oct29-sentinel.yml": "scripts/oct29-sentinel.ps1",
  };

  it("the verifier markers equal the auditor's RECEIPTS markers, both ways", () => {
    // Two components answer "did the verdict land?" - the auditor, which
    // reports, and this pass, which repairs. Disagreeing answers would mean the
    // reporter flags what the repairer calls fine, or worse the reverse.
    //
    // Only the verifiers have a RECEIPTS contract; the sentinels are TRIPPERS -
    // their record is posted only on a trip, so the auditor judges them by their
    // run conclusion instead. Their marker is pinned against their own script
    // in the next test.
    const verifiers = Object.entries(RECOVERABLE).filter(([, v]) => v.postsWhen === "always");
    expect(verifiers).toHaveLength(Object.keys(RECEIPTS).length);
    expect(verifiers.map(([wf, v]) => [wf, v.marker]).sort()).toEqual(
      Object.entries(RECEIPTS).map(([wf, c]) => [wf, c.marker]).sort(),
    );
  });

  it("every marker, artifact and log name still exists where it is written", () => {
    // A name here is a contract between three parties, and each name has exactly
    // one owner. The marker is written by the script that posts it; the artifact
    // and the .log inside it are declared by the WORKFLOW that runs the script
    // and tees its stdout (the scripts only ever write to stdout - checking the
    // .log against the script was this pin's first, wrong, draft). Renaming any
    // of them would leave the recovery looking for something nobody produces and
    // reporting "nothing to do" forever.
    expect(Object.keys(SCRIPTS).sort()).toEqual(Object.keys(RECOVERABLE).sort());
    for (const [workflow, spec] of Object.entries(RECOVERABLE)) {
      const script = readFileSync(path.join(process.cwd(), SCRIPTS[workflow]), "utf8");
      // The marker is not a literal in the script any more - it is the `header`
      // template in the declaration, rendered by the one function both this side
      // and the recovery side call. So the pin is that the script RESOLVES its own
      // entry and renders its identity from it: a rename in the declaration then
      // moves the writer and the reader together, which is the property the
      // literal pin was reaching for.
      expect(script, `${workflow}: resolves its own record`).toContain(
        "Get-VerdictRecord -Contract $contract -ScriptPath $PSCommandPath",
      );
      expect(script, `${workflow}: renders its record identity`).toContain("Format-VerdictHeader");

      const wf = readFileSync(path.join(process.cwd(), ".github/workflows", workflow), "utf8");
      expect(wf, `${workflow}: artifact name`).toContain(`name: ${spec.artifact}`);
      expect(wf, `${workflow}: log path`).toContain(spec.log);
    }
  });

  it("every sentinel verdict the scripts can emit is visible to the sentinel record shape", () => {
    // The shape test is the whole difference between "a record landed" and
    // "something mentioned the marker". If a sentinel ever emits a verdict the
    // shape cannot see, recovery would post a duplicate over a record that
    // exists - so derive the verdicts from the scripting itself rather than
    // listing the ones we happen to remember.
    for (const script of [SCRIPTS["oct4-sentinel.yml"], SCRIPTS["oct29-sentinel.yml"]]) {
      const src = readFileSync(path.join(process.cwd(), script), "utf8");
      const emitted = new Set([...src.matchAll(/SENTINEL_[A-Z_]+/g)].map((m) => m[0]));
      expect(emitted.size, `${script} emits sentinel verdicts`).toBeGreaterThan(0);
      for (const v of emitted) {
        expect(SHAPE("oct4-sentinel.yml").test(`**${v}**`), `${script}: ${v}`).toBe(true);
      }
    }
  });

  it("each sentinel counts its comments through @(...), the only shape that survives cardinality 1", () => {
    // PowerShell hands an intrinsic .Count to arrays and hashtables but NOT to a
    // lone PSCustomObject: at exactly one element .Count reads *empty*, so every
    // `-gt 0` gate on a single comment is silently false. One verdict comment is
    // the normal case, and a forced dry run over a repo in that state reported
    // SENTINEL_RUN_NO_PASS over a good PASS. Node cannot exercise PowerShell's
    // count rules, so the pin is on the shape that encodes them: @(...) around
    // the RESULT. It must not wrap the raw response instead - @($null) is a
    // ONE-element array, so that obvious fix would turn "no comments" into 1.
    //
    // The filter is on the VERIFIER marker, not the sentinel's own: a sentinel
    // judges itself by the verifier's recorded verdict, so a rename to the
    // sentinel's own marker here would search for a comment it never posts.
    for (const file of [SCRIPTS["oct4-sentinel.yml"], SCRIPTS["oct29-sentinel.yml"]]) {
      const src = readFileSync(path.join(process.cwd(), file), "utf8");
      const assign = src.match(/^\s*\$verdictComments = (.*)$/m);
      expect(assign, `${file}: has a $verdictComments assignment`).not.toBeNull();
      const rhs = (assign as RegExpMatchArray)[1].trim();
      // `$watched` is the WITNESS's entry (`($record.witnesses)`), so the marker it
      // filters on is the verifier's own - pinned here as well as in the shape, so
      // a rename to the sentinel's own marker (a comment it never posts) fails.
      expect(src, `${file}: resolves the witness entry`).toContain(
        "$watched = $contract.workflows.($record.witnesses)",
      );
      expect(rhs, `${file}: wraps the result and filters on the witness marker`).toMatch(
        /^@\(@\(\$comments\) \| Where-Object \{ \$_\.body -like "\*\$\(\$watched\.marker\)\*" \}\)$/,
      );
      expect(rhs, `${file}: does not wrap the raw response`).not.toMatch(/^@\(\$comments\)/);
      // No second, unwrapped assignment hiding elsewhere in the file. Anchored
      // to `= ` on purpose: the wrapped form *contains* `@($comments) | Where-Object`
      // as a substring, so an unanchored search would fail on correct code.
      expect(src, `${file}: no unwrapped assignment`).not.toMatch(/=\s*@\(\$comments\) \| Where-Object/);
    }
  });

  it("stays inside GitHub's retention window", () => {
    // Artifacts and logs expire; a window longer than that would promise a
    // recovery it can never perform.
    expect(RETENTION_DAYS).toBe(90);
  });
});

describe("verdict recovery: the zero-dependency zip reader", () => {
  /**
   * Build a real zip from one or more entries, deflated or stored.
   *
   * Multi-entry matters: each central-directory record must be walked with the
   * accumulated local-header offset, which is the one piece of the reader that a
   * single-entry fixture leaves untested.
   */
  function zipEntries(entries: { name: string; content: string; method: 0 | 8 }[]) {
    const parts: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const { name, content, method } of entries) {
      const raw = Buffer.from(content, "utf8");
      const data = method === 8 ? deflateRawSync(raw) : raw;
      const nameBuf = Buffer.from(name, "utf8");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(method, 8);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      parts.push(local, nameBuf, data);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(method, 10);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(raw.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42); // local header offset
      centrals.push(central, nameBuf);
      offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cd, eocd]);
  }

  const zip = (name: string, content: string, method: 0 | 8 = 8) =>
    zipEntries([{ name, content, method }]);

  it("reads a deflated entry - the shape actions/upload-artifact produces", () => {
    const buf = zip("oct3-verify.log", OCT3_LOG, 8);
    expect(unzipEntry(buf, "oct3-verify.log")?.toString("utf8")).toBe(OCT3_LOG);
  });

  it("reads a stored entry", () => {
    expect(unzipEntry(zip("a.log", "hello", 0), "a.log")?.toString("utf8")).toBe("hello");
  });

  it("walks past earlier entries to resolve one by name", () => {
    // A real artifact may carry more than one file; picking by name - not by
    // position - is what stops the recovery from parsing the wrong one.
    const buf = zipEntries([
      { name: "other.log", content: "nope", method: 8 },
      { name: "oct3-verify.log", content: OCT3_LOG, method: 8 },
    ]);
    expect(unzipEntry(buf, "oct3-verify.log")?.toString("utf8")).toBe(OCT3_LOG);
    expect(unzipEntry(buf, "other.log")?.toString("utf8")).toBe("nope");
    expect(unzipEntry(buf, "missing.log")).toBeNull();
  });

  it("refuses something that is not a zip", () => {
    expect(() => unzipEntry(Buffer.from("not a zip at all, not even close"), "x")).toThrow();
  });
});

/** Verbatim contents of run 37183204922's oct4-sentinel-log artifact. */
const OCT4_LOG = [
  "scheduled oct3-verify attempts in 2026-10-03..2026-10-04: 3",
  "  run 37157439771 completed/success started 10/03/2026 22:08:49 - https://github.com/Creative-hub554/Base88Plus/actions/runs/37157439771",
  "  run 37129011940 completed/success started 10/03/2026 14:15:51 - https://github.com/Creative-hub554/Base88Plus/actions/runs/37129011940",
  "  run 37123811425 completed/success started 10/03/2026 12:43:49 - https://github.com/Creative-hub554/Base88Plus/actions/runs/37123811425",
  "#18 verifier comments since Oct 3: 0 (PASS: 0)",
  "VERDICT=SENTINEL_RUN_NO_PASS",
  "COMMENT_POSTED id=5977355581",
  "exit=1",
].join("\n");

/** The sentinel's real comment on #18 (id 5977355581), trimmed to its head and tail. */
const OCT4_SENTINEL_COMMENT =
  "post-Oct-3 sentinel (checked 2026-10-04): **SENTINEL_RUN_NO_PASS**\n\n" +
  "The Oct 4 sentinel found 3 completed scheduled oct3-verify attempt(s) in the " +
  "2026-10-03..2026-10-04 window (latest conclusion: success), but NO comment on #18 " +
  "carries a PASS verdict marker (bold PASS_...; verifier comments found: 0). ... " +
  "Then re-run the sentinel to clear.";

/** The sentinel run itself - note it concluded `failure`, which for a sentinel is the report. */
const OCT4_TRIPPED = run(37183204922, "2026-10-04T06:34:35Z", {
  status: "completed",
  conclusion: "failure",
});

/** An oct4 run that found nothing wrong: silent by design, owes no comment. */
const OCT4_SATISFIED = run(37183204922, "2026-10-04T06:34:35Z", {
  status: "completed",
  conclusion: "success",
});

describe("verdict recovery: sentinels post only when they trip", () => {
  it("a tripped sentinel whose comment landed is receipted", () => {
    // Real ids and times: the comment landed 8 seconds after the run started.
    expect(
      isReceipted(
        [comment(5977355581, "2026-10-04T06:34:43Z", OCT4_SENTINEL_COMMENT)],
        OCT4,
        Date.parse("2026-10-04T06:34:35Z"),
      ),
    ).toBe(true);
    expect(selectUnreceipted([OCT4_TRIPPED], [comment(5977355581, "2026-10-04T06:34:43Z", OCT4_SENTINEL_COMMENT)], OCT4)).toEqual([]);
  });

  it("a tripped sentinel whose comment was lost is a candidate", () => {
    expect(selectUnreceipted([OCT4_TRIPPED], [], OCT4).map((r) => r.id)).toEqual([37183204922]);
  });

  it("a SATISFIED sentinel is never a candidate - silence is its design, not a gap", () => {
    // The dangerous regression: judging a sentinel like a verifier would turn
    // every green sentinel run into an invented finding, and this pass would
    // spend its life reporting good news as a lost record.
    expect(selectUnreceipted([OCT4_SATISFIED], [], OCT4)).toEqual([]);
  });

  it("does not accept a PASS verdict as a sentinel's own record", () => {
    // The shapes are disjoint on purpose: a verifier's receipt must not
    // discharge a sentinel's obligation, or vice versa.
    expect(SHAPE("oct4-sentinel.yml").test(RECOVERY_COMMENT)).toBe(false);
    expect(SHAPE("oct3-verify.yml").test(`**SENTINEL_RUN_NO_PASS**`)).toBe(false);
    expect(
      isReceipted([comment(9, "2026-10-04T07:00:00Z", RECOVERY_COMMENT)], OCT4, Date.parse("2026-10-04T06:34:35Z")),
    ).toBe(false);
  });

  it("quotes the whole sentinel log, including the lines a whitelist would drop", () => {
    // The oct4 artifact's two most useful lines match no "interesting prefix"
    // rule - which is exactly why the earlier whitelist draft was wrong.
    const body = buildRecoveredBody({
      run: OCT4_TRIPPED,
      spec: OCT4,
      record: parseRecordLog(OCT4_LOG),
    });
    expect(body).toContain("scheduled oct3-verify attempts in 2026-10-03..2026-10-04: 3");
    expect(body).toContain("#18 verifier comments since Oct 3: 0 (PASS: 0)");
    expect(body).toContain("VERDICT=SENTINEL_RUN_NO_PASS");
    expect(body).toContain("COMMENT_POSTED id=5977355581");
    expect(parseRecordLog(OCT4_LOG).verdict).toBe("SENTINEL_RUN_NO_PASS");
  });

  it("phrases the header the way the sentinel does, carrying its own day marker", () => {
    const body = buildRecoveredBody({
      run: OCT4_TRIPPED,
      spec: OCT4,
      record: parseRecordLog(OCT4_LOG),
    });
    // Byte-for-byte the sentence the sentinel writes, so the comment is
    // recognisable to the script that would otherwise re-post it.
    expect(body.split("\n")[0]).toBe(
      "post-Oct-3 sentinel (checked 2026-10-04): **SENTINEL_RUN_NO_PASS**",
    );
    // The sentinel dedupes on `sentinel (checked <day>)`; the run id must sit
    // OUTSIDE those parentheses or the recovered comment is invisible to it.
    expect(body).toContain("sentinel (checked 2026-10-04)");
    expect(body.split("\n")[0]).not.toContain(`checked 2026-10-04, run`);
    // ...and the run id is still recorded, in the recovery note.
    expect(body).toContain("observed by run 37183204922 on 2026-10-04");
  });

  it("warns that a recovered sentinel is history, not a new alert", () => {
    // A sentinel reports a condition at one moment. Re-posted days later it must
    // not read as an alert about now, and it must not claim to clear itself.
    const sentinelBody = buildRecoveredBody({
      run: OCT4_TRIPPED,
      spec: OCT4,
      record: parseRecordLog(OCT4_LOG),
    });
    expect(sentinelBody).toContain("historical report, not a new alert");
    expect(sentinelBody).toContain("Re-run the sentinel to clear it");
    expect(sentinelBody).toContain("2026-10-04");

    // A verifier's record is a historical fact with no such caveat - it says
    // what the cron day produced, and that does not expire.
    const verifierBody = buildRecoveredBody({
      run: run(37157439771, "2026-10-03T22:08:49Z"),
      spec: OCT3,
      record: parseRecordLog(OCT3_LOG),
    });
    expect(verifierBody).not.toContain("historical report");
    expect(verifierBody).toContain("post-Oct-3 verifier (run 37123382655, 2026-10-03)");
  });

  it("keeps the four record-keepers distinct, each with its own artifact", () => {
    const artifacts = Object.values(RECOVERABLE).map((s) => s.artifact);
    expect(new Set(artifacts).size).toBe(artifacts.length);
    expect(RECOVERABLE["oct4-sentinel.yml"].artifact).toBe("oct4-sentinel-log");
    expect(RECOVERABLE["oct29-sentinel.yml"].artifact).toBe("oct29-sentinel-log");
    for (const spec of Object.values(RECOVERABLE)) {
      expect(spec.postsWhen === "always" || spec.postsWhen === "tripped").toBe(true);
    }
  });
});
