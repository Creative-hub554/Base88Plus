/**
 * Pinned best version: a turn snapshot can be marked as THE version
 * publishing always uses, independent of the live workspace.
 *
 * Pins the store contract:
 *   - setPinnedSnapshot / clearPinnedSnapshot / pinned state on the project
 *   - publishProject ships the PINNED snapshot's files when a pin exists
 *     (even though the live workspace differs), and the live files when not
 *   - the pin is a dangling reference once its snapshot is pruned → the
 *     manifest records it, publishing falls back to the live workspace
 *   - restoring the pinned version into the workspace clears the pin
 *     (workspace and public page agree again)
 *
 * Hermetic: store re-imported after chdir into a fresh temp cwd.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-pin-"));
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

describe("pinned best version publishing", () => {
  it("publishes the pinned snapshot's files instead of the live workspace", async () => {
    const store = await freshStore();
    const id = store.createProject("Pin", "")!.id;

    store.saveAppFile(id, "index.html", "<p>v1</p>");
    store.recordTurnSnapshot(id, "msg-a", store.listAppFiles(id));
    // Live workspace moves on after the snapshot.
    store.saveAppFile(id, "index.html", "<p>v2-live</p>");
    store.saveAppFile(id, "extra.js", "console.log('live only')");

    // Unpinned: publish ships the live files.
    store.publishProject(id, "pin-app");
    let pub = store.readPublishedFile(id, "index.html");
    expect(pub).toBe("<p>v2-live</p>");

    // Pin msg-a and republish: the public page serves the PINNED v1.
    const pinned = store.setPinnedSnapshot(id, "msg-a");
    expect(pinned?.pinnedSnapshot?.messageId).toBe("msg-a");
    expect(store.getProject(id)!.pinnedSnapshot?.messageId).toBe("msg-a");

    store.publishProject(id, "pin-app");
    expect(store.readPublishedFile(id, "index.html")).toBe("<p>v1</p>");
    expect(store.readPublishedFile(id, "extra.js")).toBeNull();
    const manifest = store.getPublishManifest(id)!;
    expect(manifest.files).toEqual(["index.html"]);
    expect(manifest.pinnedFrom).toBe("msg-a");

    // Clear the pin and republish: back to the live workspace.
    store.clearPinnedSnapshot(id);
    store.publishProject(id, "pin-app");
    expect(store.readPublishedFile(id, "index.html")).toBe("<p>v2-live</p>");
    expect(store.readPublishedFile(id, "extra.js")).toBe("console.log('live only')");
  });

  it("falls back to the live workspace when the pin dangles (snapshot pruned)", async () => {
    const store = await freshStore();
    const id = store.createProject("Dangle", "")!.id;
    store.saveAppFile(id, "index.html", "<p>old</p>");
    store.recordTurnSnapshot(id, "old-turn", store.listAppFiles(id));
    store.setPinnedSnapshot(id, "old-turn");

    // Evict the pinned snapshot: overflow the cap (TURN_SNAPSHOT_CAP) —
    // each record prunes the oldest beyond the cap.
    for (let i = 0; i < store.TURN_SNAPSHOT_CAP; i++) {
      store.saveAppFile(id, "index.html", `<p>turn ${i}</p>`);
      store.recordTurnSnapshot(id, `t${i}`, store.listAppFiles(id));
    }

    // The pin reference survives but is dangling; publish falls back.
    expect(store.getProject(id)!.pinnedSnapshot?.messageId).toBe("old-turn");
    store.publishProject(id, "dangle-app");
    expect(store.readPublishedFile(id, "index.html")).toBe("<p>turn 9</p>");
    expect(store.getPublishManifest(id)!.pinnedFrom).toBeUndefined();
  });

  it("clears the pin when the pinned version is restored into the workspace", async () => {
    const store = await freshStore();
    const id = store.createProject("Restore", "")!.id;
    store.saveAppFile(id, "index.html", "<p>v1</p>");
    store.recordTurnSnapshot(id, "msg-a", store.listAppFiles(id));
    store.saveAppFile(id, "index.html", "<p>v2</p>");
    store.setPinnedSnapshot(id, "msg-a");

    store.restoreTurnSnapshot(id, "msg-a");
    // Workspace now equals the pinned snapshot → pin is moot, drop it.
    expect(store.getProject(id)!.pinnedSnapshot).toBeUndefined();
    // Pinning the SAME snapshot again is a no-op that stays pinned.
    store.setPinnedSnapshot(id, "msg-a");
    expect(store.getProject(id)!.pinnedSnapshot?.messageId).toBe("msg-a");
    // Unknown snapshot cannot be pinned.
    expect(store.setPinnedSnapshot(id, "nope")).toBeNull();
  });
});
