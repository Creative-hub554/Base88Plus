/**
 * Regression tests for the refine-loop fixes surfaced by driving the
 * pomodoro refine end-to-end:
 *
 * 1. History duplication — the AI SDK v5 transport sends the FULL
 *    conversation each turn, and the stream's onEnd also persists the
 *    response message. The old `[...existing, ...incoming]` append stored
 *    every earlier turn twice after the second chat turn (observed
 *    `[u1, a1, u1, a1]` in chat.json), doubling tokens every turn and
 *    teaching the small model to imitate the `[wrote N file(s)]` notes.
 * 2. Summary-imitation output — a turn that emits `[wrote 3 file(s)]`
 *    (with zero files parsed, no anybase fence) was classified as
 *    legitimate narration, so no retry fired and the user was told files
 *    were written when none were.
 *
 * Hermetic: the store resolves its data dir at import time, so every test
 * re-imports it AFTER chdir into a fresh temp cwd (same pattern as
 * pinned-cloudflare-probe.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSummaryImitation,
  isEmptyFenceOutput,
  shouldOfferContinue,
  extractFiles,
  extractPartialFiles,
  CONTINUE_REMINDER,
} from "../src/lib/prompt";
import type { BuilderUIMessage } from "../src/lib/types";

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-refine-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

/** Fresh store import bound to the current (temp) cwd. */
async function freshStore() {
  return import("../src/lib/store");
}

function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
  metadata?: Record<string, unknown>,
): BuilderUIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    ...(metadata !== undefined ? { metadata } : {}),
  } as BuilderUIMessage;
}

describe("appendMessages (history dedupe)", () => {
  it("appends a genuinely new turn", async () => {
    const { appendMessages, loadMessages } = await freshStore();
    appendMessages("p", [msg("u1", "user", "hi")]);
    appendMessages("p", [msg("a1", "assistant", "app")]);
    expect(loadMessages("p").map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("does not duplicate the full transcript the transport re-sends", async () => {
    const { appendMessages, loadMessages } = await freshStore();
    // Turn 1 stored; turn 2's request carries the conversation again.
    appendMessages("p", [msg("u1", "user", "hi")]);
    appendMessages("p", [msg("a1", "assistant", "app")]);
    appendMessages("p", [
      msg("u1", "user", "hi"),
      msg("a1", "assistant", "app"),
      msg("u2", "user", "refine"),
    ]);
    expect(loadMessages("p").map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("reproduces the exact observed duplication and repairs it", async () => {
    const { appendMessages, loadMessages } = await freshStore();
    // The on-disk state found during the pomodoro drive: u1/a1 twice.
    fs.mkdirSync(path.join(process.cwd(), "projects-data", "p"), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), "projects-data", "p", "chat.json"),
      JSON.stringify([
        msg("u1", "user", "hi"),
        msg("a1", "assistant", "app"),
        msg("u1", "user", "hi"),
        msg("a1", "assistant", "app"),
        msg("u2", "user", "refine"),
      ]),
    );
    // The next request re-sends the (duplicated) transcript.
    appendMessages("p", [
      msg("u1", "user", "hi"),
      msg("a1", "assistant", "app"),
      msg("u1", "user", "hi"),
      msg("a1", "assistant", "app"),
      msg("u2", "user", "refine"),
      msg("a2", "assistant", "v2"),
    ]);
    const ids = loadMessages("p").map((m) => m.id);
    expect(ids).toEqual(["u1", "a1", "u2", "a2"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("merges stream-final metadata into the stored message (same id)", async () => {
    const { appendMessages, loadMessages } = await freshStore();
    appendMessages("p", [msg("u1", "user", "hi")]);
    // onEnd persists the response message; the finished copy may gain
    // metadata (modelUsed, fileCount…) the mid-stream copy lacked.
    appendMessages("p", [
      msg("a1", "assistant", "app", { fileCount: 3, retried: true }),
    ]);
    const all = loadMessages("p");
    expect(all.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(all[1].metadata).toMatchObject({ fileCount: 3, retried: true });
  });

  it("always appends messages without an id (defensive)", async () => {
    const { appendMessages, loadMessages } = await freshStore();
    appendMessages("p", [msg("u1", "user", "hi")]);
    const anon = { role: "user", parts: [{ type: "text", text: "x" }] };
    appendMessages("p", [anon as unknown as BuilderUIMessage]);
    expect(loadMessages("p")).toHaveLength(2);
  });
});

describe("isSummaryImitation (degenerate refine detection)", () => {
  const attempt = (over: Partial<Parameters<typeof isSummaryImitation>[0]>) => ({
    hadFence: false,
    files: null,
    narrationText: "",
    ...over,
  });

  it("flags the observed failure: [wrote N file(s)] prose, zero files, no fence", () => {
    expect(
      isSummaryImitation(attempt({ narrationText: "```any\n[wrote 3 file(s)]" })),
    ).toBe(true);
  });

  it("does not flag a real generation (files present)", () => {
    expect(
      isSummaryImitation(attempt({ files: [{ path: "index.html" }], narrationText: "" })),
    ).toBe(false);
  });

  it("flags narration that mentions the note with zero files", () => {
    expect(
      isSummaryImitation(
        attempt({
          narrationText: "I will write the files next; [wrote 2 file(s)] is my report format.",
        }),
      ),
    ).toBe(true);
  });

  it("does not double-trigger when the degenerate retry already covers it", () => {
    // A fenced-but-empty attempt is caught by isDegenerate (hadFence).
    expect(
      isSummaryImitation(attempt({ hadFence: true, narrationText: "[wrote 1 file(s)]" })),
    ).toBe(false);
  });

  it("does not flag plain chat with no files and no note", () => {
    expect(isSummaryImitation(attempt({ narrationText: "Which framework do you prefer?" }))).toBe(
      false,
    );
  });
});

describe("shouldOfferContinue (one-click recovery flag)", () => {
  const attempt = (over: Partial<Parameters<typeof shouldOfferContinue>[0]>) => ({
    hadFence: false,
    files: null,
    error: null,
    narrationText: "",
    ...over,
  });

  it("offers Continue after a truncated (unclosed) fence with no files", () => {
    expect(shouldOfferContinue(attempt({ hadFence: true }))).toBe(true);
  });

  it("offers Continue after a stream/provider error with no files", () => {
    expect(shouldOfferContinue(attempt({ error: "connection reset" }))).toBe(true);
  });

  it("does NOT offer Continue when files were written", () => {
    expect(shouldOfferContinue(attempt({ hadFence: true, files: [{ path: "index.html" }] }))).toBe(
      false,
    );
  });

  it("does NOT offer Continue for plain successful narration (a chat reply)", () => {
    // No fence, no error, no files: a legitimate conversational reply.
    expect(shouldOfferContinue(attempt({}))).toBe(false);
  });

  it("offers Continue after the observed empty-fence degeneration", () => {
    // The live failure from the portfolio drive: the model emitted bare
    // empty fences (no anybase tag) and nothing else — degenerate:false
    // escaped every detector before isEmptyFenceOutput existed.
    expect(shouldOfferContinue(attempt({ narrationText: "```\n\n```" }))).toBe(true);
  });

  it("does NOT offer Continue for a real chat reply that contains a code snippet", () => {
    expect(
      shouldOfferContinue(
        attempt({ narrationText: "Here is the helper:\n```js\nconst x = 1;\n```\nWant me to add it?" }),
      ),
    ).toBe(false);
  });

  it("isEmptyFenceOutput: empty fences only, with or without a tag", () => {
    expect(isEmptyFenceOutput("```\n\n```")).toBe(true);
    expect(isEmptyFenceOutput("```any\n\n```any")).toBe(true);
    expect(isEmptyFenceOutput("```\n\n``` \n  ")).toBe(true);
    expect(isEmptyFenceOutput("```js\nconst x = 1;\n```\nDone!")).toBe(false);
    expect(isEmptyFenceOutput("plain prose")).toBe(false);
  });

  it("isEmptyFenceOutput: the explicit scan matches the regex it replaced", () => {
    // The oracle. `isEmptyFenceOutput` was rewritten as a hand-written
    // character scan (see its header for the measured reasons), and a rewrite
    // of a predicate is exactly where a subtle behaviour change hides — a
    // different whitespace set, an unterminated marker, a tag word with a digit
    // in it. So the implementation it replaced stays here, verbatim, as the
    // thing the new one has to agree with forever.
    //
    // This is the same move as tests/scanner-scaling.test.ts, which keeps the
    // pre-#115 regexes as a differential oracle after they were replaced: the
    // old code is the specification, and deleting it deletes the specification.
    const oracle = (narration: string): boolean => {
      if (!narration.includes("```")) return false;
      return narration.replace(/```[a-zA-Z]*/g, "").trim().length === 0;
    };
    const impl = isEmptyFenceOutput;

    // The hand-picked shapes first, each labelled with WHY it is a case. Every
    // one of these was a way to get the two to disagree.
    const CASES: Array<[string, string]> = [
      // The two documented answers.
      ["plain prose", "no fence at all"],
      ["```\n\n```", "the observed degeneration"],
      ["```any\n\n```any", "a tag word on both markers"],
      ["```js\nconst x = 1;\n```\nDone!", "a real snippet plus prose"],
      // `trim()` removes far more than space and newline, and the scan has to
      // agree about all of it or a reply padded with NBSP reads as degenerate.
      ["```\n\u00a0\u2028\u3000\ufeff```", "non-ASCII blank padding"],
      ["```\u2000\u200a\u202f\u205f\u1680```", "the rest of the Zs category"],
      ["```\r\n\t\v\f```", "every ASCII blank"],
      // A four-backtick run leaves one backtick behind, so it is NOT degenerate.
      // This is the case most likely to be got wrong by a scan that assumes
      // markers always come in threes.
      ["````", "a four-backtick run"],
      ["```\n````", "a three-run then a four-run"],
      // The tag word is [a-zA-Z]* and greedy but must not cross a newline, so
      // a digit or a dot ends it and whatever follows must be judged as text.
      ["```js1", "a tag word followed by a digit"],
      ["```js.any", "a tag word followed by a dot"],
      ["```JS", "an upper-case tag word"],
      ["```\u00e9", "a non-ASCII tag word, which is not a tag word"],
      // An unterminated marker is the shape that made the old scanners
      // quadratic, so the scan must terminate on it too.
      ["```", "a bare unterminated marker"],
      ["```js", "an unterminated marker with a tag word"],
      ["`\n`", "single backticks, which are not markers"],
      // Whitespace only, with no marker: not degenerate, because there is no
      // fence at all — the `includes` pre-pass decides this one.
      ["   \n  ", "whitespace with no fence"],
      ["", "the empty string"],
    ];
    for (const [input, why] of CASES) {
      expect(impl(input), `${why}: ${JSON.stringify(input)}`).toBe(oracle(input));
    }

    // Then the shapes nobody thought of. A fixed-seed LCG, because a fuzz that
    // cannot be replayed is a fuzz whose failure can never be reproduced.
    //
    // The alphabet is chosen for the ways the two can disagree rather than for
    // realism: every blank `trim()` knows, the pieces of a fence marker, and
    // the characters that terminate a tag word.
    const ALPHABET = ["`", "`", "`", "j", "s", "a", "Z", "1", ".", "\n", " ", "\u00a0", "x"];
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let checked = 0;
    for (let i = 0; i < 20000; i++) {
      const len = 1 + Math.floor(next() * 24);
      let s = "";
      for (let k = 0; k < len; k++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
      expect(impl(s), `fuzz #${i} seed 0x2f6e2b1: ${JSON.stringify(s)}`).toBe(oracle(s));
      checked++;
    }
    expect(checked).toBe(20000);
  });

  it("extractPartialFiles: streams only completed sections, matching extractFiles at close", () => {
    const head = 'narration\n```anybase\n=== index.html ===\n<html>full</html>\n\n';
    // Only index.html has a following boundary — styles.css is still growing.
    const mid = head + '=== styles.css ===\nbody { col';
    expect(extractPartialFiles(mid)).toEqual([{ path: "index.html", content: "<html>full</html>" }]);
    // The growing section never leaks a truncated tail.
    expect(extractPartialFiles(mid).map((f) => f.path)).not.toContain("styles.css");
    // At fence close, everything is final and identical to extractFiles.
    const closed = mid + 'or: red }\n```\n';
    const partial = extractPartialFiles(closed);
    expect(partial.map((f) => f.path)).toEqual(["index.html", "styles.css"]);
    expect(partial).toEqual(extractFiles(closed));
  });

  it("extractPartialFiles: no block or header-less block yields nothing", () => {
    expect(extractPartialFiles("plain narration only")).toEqual([]);
    expect(extractPartialFiles("```anybase\n<html>no headers</html>")).toEqual([]);
    // Header-less salvage stays a close-time behavior of extractFiles.
    expect(extractFiles("```anybase\n<!doctype html><html></html>\n```\n")).toEqual([
      { path: "index.html", content: "<!doctype html><html></html>" },
    ]);
  });

  it("pairs with the continue reminder the server appends in continue mode", () => {
    // The reminder must demand the full app and a closed fence — the exact
    // failure it is recovering from.
    expect(CONTINUE_REMINDER).toContain("COMPLETE app");
    expect(CONTINUE_REMINDER).toContain("close the code fence");
  });
});
