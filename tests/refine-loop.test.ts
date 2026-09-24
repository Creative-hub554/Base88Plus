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
