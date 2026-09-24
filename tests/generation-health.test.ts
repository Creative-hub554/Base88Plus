/**
 * Generation-health stats for the home cards: `getGenerationHealth`
 * derives success rate + retry rate from stored chat turns' finish
 * metadata. Pins: only real generation turns count (template-promote
 * seeds have no modelUsed and are excluded), degenerate turns count
 * against success, and projects with no generations get null — never a
 * meaningless 0%.
 *
 * Hermetic: the store resolves its data dir at import time, so every test
 * re-imports it AFTER chdir into a fresh temp cwd (same pattern as
 * pinned-cloudflare-probe.test.ts / refine-loop.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BuilderUIMessage } from "../src/lib/types";

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-health-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

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

/** Write a chat.json directly (the store's layout). */
function seedChat(projectId: string, messages: BuilderUIMessage[]) {
  fs.mkdirSync(path.join(process.cwd(), "projects-data", projectId), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(process.cwd(), "projects-data", projectId, "chat.json"),
    JSON.stringify(messages),
  );
}

const gen = (
  id: string,
  fileCount: number,
  opts: { retried?: boolean; degenerate?: boolean } = {},
) =>
  msg("a-" + id, "assistant", "```", {
    modelUsed: "qwen2.5-coder:1.5b",
    providerUsed: "Ollama (local)",
    fileCount,
    retried: opts.retried ?? false,
    degenerate: opts.degenerate ?? false,
  });

describe("getGenerationHealth", () => {
  it("computes success rate and retries/turn across generation turns", async () => {
    const { getGenerationHealth } = await freshStore();
    seedChat("p1", [
      msg("u1", "user", "build"),
      gen("1", 3),
      msg("u2", "user", "refine"),
      gen("2", 3, { retried: true }),
      msg("u3", "user", "more"),
      gen("3", 3, { retried: true }),
      gen("4", 0, { retried: true, degenerate: true }),
    ]);
    const h = getGenerationHealth("p1")!;
    expect(h.turns).toBe(4);
    expect(h.okTurns).toBe(3);
    expect(h.retriedTurns).toBe(3);
    expect(h.degenerateTurns).toBe(1);
    expect(h.successRate).toBeCloseTo(0.75);
    expect(h.avgRetries).toBeCloseTo(0.75);
  });

  it("excludes the template-promote seed (no modelUsed) and user turns", async () => {
    const { getGenerationHealth } = await freshStore();
    seedChat("p2", [
      msg("seed-1", "assistant", "Started from the Blog template", {
        fileCount: 3,
      }),
      msg("u1", "user", "hi"),
      gen("1", 3),
    ]);
    const h = getGenerationHealth("p2")!;
    expect(h.turns).toBe(1);
    expect(h.successRate).toBe(1);
  });

  it("returns null when there are no real generations yet", async () => {
    const { getGenerationHealth } = await freshStore();
    seedChat("p3", [
      msg("seed-1", "assistant", "Started from the Landing template", {
        fileCount: 2,
      }),
      msg("u1", "user", "make it blue"),
    ]);
    expect(getGenerationHealth("p3")).toBeNull();
  });

  it("returns null for a project with no chat at all", async () => {
    const { getGenerationHealth } = await freshStore();
    expect(getGenerationHealth("ghost")).toBeNull();
  });
});
