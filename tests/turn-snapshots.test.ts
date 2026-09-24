/**
 * Per-turn workspace snapshots (generation undo): recordTurnSnapshot
 * persists the exact post-turn workspace keyed by the assistant message
 * id, listTurnSnapshots feeds the UI, restoreTurnSnapshot performs a true
 * point-in-time restore (files added later are REMOVED). Pins the cap
 * pruning (TURN_SNAPSHOT_CAP), dedupe on regenerate (same messageId
 * replaces its snapshot), the exclusion of turn-snapshots/ from workspace
 * listings (snapshots must never leak into model context or exports), and
 * restore-of-missing returning null.
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-undo-"));
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

describe("snapshotMissingAssets", () => {
  it("lists local assets a snapshot's HTML references but lacks; ignores external URLs", async () => {
    const store = await freshStore();
    const id = store.createProject("Miss", "")!.id;
    const html = [
      "<html><head>",
      '<link rel="stylesheet" href="styles.css">',
      '<link rel="stylesheet" href="/absent.css">',
      '<script src="app.js"></script>',
      '<script src="https://cdn.example.com/x.js"></script>',
      '<img src="data:image/png;base64,AAA">',
      '<img src="logo.png?v=2">',
      "</head></html>",
    ].join("");
    store.recordTurnSnapshot(id, "m1", [
      { path: "index.html", content: html },
      { path: "styles.css", content: "body{}" },
    ]);

    const missing = store.snapshotMissingAssets(id, "m1");
    expect(missing).toEqual(["absent.css", "app.js", "logo.png"]);
    // Fully self-contained snapshot → empty.
    store.recordTurnSnapshot(id, "m2", [
      { path: "index.html", content: '<html><script src="a.js"></script></html>' },
      { path: "a.js", content: "1" },
    ]);
    expect(store.snapshotMissingAssets(id, "m2")).toEqual([]);
    // Gone snapshot → empty (nothing to warn about).
    expect(store.snapshotMissingAssets(id, "nope")).toEqual([]);
  });

  it("catches CSS @import and url() references (quoted, bare, with queries)", async () => {
    const store = await freshStore();
    const id = store.createProject("CssRefs", "")!.id;
    const css = [
      "@import \"missing-import.css\";",
      "@import url(second-missing.css);",
      "@import url('third-missing.css');",
      "body { background: url(\"img/bg.png\") no-repeat; }",
      "h1 { background-image: url(logo.webp?v=3); }",
      "@font-face { src: url('fonts/Inter.woff2') format('woff2'); }",
      ".ok { background: url(\"https://cdn.example.com/remote.png\"); }",
      ".also-ok { background: url(data:image/gif;base64,AAA); }",
      ".anchor-ok { content: url(#frag); }",
    ].join("\n");
    store.recordTurnSnapshot(id, "m-css", [
      { path: "index.html", content: "<html></html>" },
      { path: "theme.css", content: css },
    ]);

    expect(store.snapshotMissingAssets(id, "m-css")).toEqual([
      "fonts/Inter.woff2",
      "img/bg.png",
      "logo.webp",
      "missing-import.css",
      "second-missing.css",
      "third-missing.css",
    ]);
  });

  it("does not flag CSS references when the target exists (nested paths, presence across files)", async () => {
    const store = await freshStore();
    const id = store.createProject("CssOk", "")!.id;
    store.recordTurnSnapshot(id, "m-ok", [
      { path: "index.html", content: "<html></html>" },
      {
        path: "theme.css",
        content: '@import "vars.css";\n.a { background: url("img/x.png"); }',
      },
      { path: "vars.css", content: ":root{}" },
      { path: "img/x.png", content: "PNG" },
    ]);
    expect(store.snapshotMissingAssets(id, "m-ok")).toEqual([]);
  });
});

describe("snapshot fix — store merge semantics", () => {
  it("re-recording a messageId merges generated files without touching the workspace", async () => {
    const store = await freshStore();
    const id = store.createProject("FixMerge", "")!.id;
    store.saveAppFile(id, "index.html", "<p>live</p>");
    store.recordTurnSnapshot(id, "fx", [
      { path: "index.html", content: "<html><script src=\"app.js\"></script></html>" },
      { path: "styles.css", content: "body{}" },
    ]);
    expect(store.snapshotMissingAssets(id, "fx")).toEqual(["app.js"]);

    // The fix route's merge: originals + generated, workspace untouched.
    store.recordTurnSnapshot(id, "fx", [
      { path: "index.html", content: "<html><script src=\"app.js\"></script></html>" },
      { path: "styles.css", content: "body{}" },
      { path: "app.js", content: "console.log(42)" },
    ]);
    expect(store.snapshotMissingAssets(id, "fx")).toEqual([]);
    // Restore yields the MERGED snapshot...
    store.restoreTurnSnapshot(id, "fx");
    expect(store.readAppFile(id, "index.html")).toBe("<html><script src=\"app.js\"></script></html>");
    expect(store.readAppFile(id, "app.js")).toBe("console.log(42)");
    // ...and the pre-fix live file was never clobbered by snapshot content.
    expect(store.readAppFile(id, "styles.css")).toBe("body{}");
  });
});

describe("deploy version cap — prune hygiene", () => {
  it("deletes evicted version directories from disk (pinned at both manifest and disk level)", async () => {
    const store = await freshStore();
    const id = store.createProject("DV", "")!.id;

    for (let i = 0; i < store.DEPLOY_VERSION_CAP + 3; i++) {
      store.recordDeployVersion(id, [{ path: "index.html", content: `<p>v${i}</p>` }], {
        url: `https://demo.test/v${i}`,
        slug: "dv-app",
        deployedAt: new Date().toISOString(),
      });
    }

    const versions = store.listDeployVersions(id);
    expect(versions).toHaveLength(store.DEPLOY_VERSION_CAP);
    const nums = versions.map((v) => v.version);
    expect(nums[0]).toBe(store.DEPLOY_VERSION_CAP + 3);
    expect(nums).not.toContain(1);
    // Disk mirror: exactly the kept versions' dirs remain.
    const root = path.join("projects-data", id, "deploy-versions");
    expect(fs.readdirSync(root).sort()).toEqual(
      versions.map((v) => String(v.version)).sort(),
    );
  });

  it("sweeps orphan version dirs from a crash between dir write and manifest write", async () => {
    const store = await freshStore();
    const id = store.createProject("DVOrphan", "")!.id;
    store.recordDeployVersion(id, [{ path: "index.html", content: "<p>v1</p>" }], {
      url: "https://demo.test/v1",
      slug: "dvo-app",
      deployedAt: new Date().toISOString(),
    });

    // Simulate the crash window: an unmanifested dir on disk (also covers
    // a pre-cap manifest that stopped pruning but never deleted dirs).
    const orphan = path.join("projects-data", id, "deploy-versions", "99");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "index.html"), "<p>orphan</p>");

    store.recordDeployVersion(id, [{ path: "index.html", content: "<p>v2</p>" }], {
      url: "https://demo.test/v2",
      slug: "dvo-app",
      deployedAt: new Date().toISOString(),
    });

    // The orphan is gone from disk and never appears as a version.
    expect(fs.existsSync(orphan)).toBe(false);
    expect(store.listDeployVersions(id).map((v) => v.version)).toEqual([2, 1]);
  });
});

describe("turn snapshot cap — orphan reconciliation", () => {
  it("sweeps orphan snapshot dirs the manifest doesn't list (crash between dir and manifest write)", async () => {
    const store = await freshStore();
    const id = store.createProject("SnapOrphan", "")!.id;
    store.saveAppFile(id, "index.html", "<p>v1</p>");
    store.recordTurnSnapshot(id, "t1", store.listAppFiles(id));

    // Simulate the crash window: an unmanifested dir on disk (e.g. the
    // dir write landed but the manifest write never did).
    const orphan = path.join("projects-data", id, "turn-snapshots", "ghost-msg");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "index.html"), "<p>ghost</p>");

    store.recordTurnSnapshot(id, "t2", store.listAppFiles(id));

    // The orphan is swept on the next record; real snapshots untouched.
    expect(fs.existsSync(orphan)).toBe(false);
    expect(store.listTurnSnapshots(id).map((s) => s.messageId).sort()).toEqual(["t1", "t2"]);
    expect(store.restoreTurnSnapshot(id, "t1")).not.toBeNull();
  });
});

describe("recordTurnSnapshot — prune hygiene", () => {
  it("actually deletes evicted snapshot directories (regression: dead prune leaked them)", async () => {
    const store = await freshStore();
    const id = store.createProject("Prune", "")!.id;
    store.saveAppFile(id, "index.html", "<p>v</p>");

    for (let i = 0; i < store.TURN_SNAPSHOT_CAP + 2; i++) {
      store.recordTurnSnapshot(id, `t${i}`, store.listAppFiles(id));
    }

    const listed = store.listTurnSnapshots(id).map((s) => s.messageId);
    expect(listed).toHaveLength(store.TURN_SNAPSHOT_CAP);
    // Newest cap survive; the two oldest are gone from the manifest…
    expect(listed).toContain("t11");
    expect(listed).toContain("t10");
    expect(listed).not.toContain("t0");
    // …AND from disk — the old prune loop was dead code, so evicted dirs
    // leaked forever and this assertion failed against it.
    const snapshotsRoot = path.join("projects-data", id, "turn-snapshots");
    expect(fs.readdirSync(snapshotsRoot).sort()).toEqual([...listed].sort());
  });

  it("re-recording an existing turn keeps its snapshot restorable", async () => {
    const store = await freshStore();
    const id = store.createProject("ReRecord", "")!.id;
    store.saveAppFile(id, "index.html", "<p>v1</p>");
    store.recordTurnSnapshot(id, "same", store.listAppFiles(id));
    store.saveAppFile(id, "index.html", "<p>v2</p>");
    store.recordTurnSnapshot(id, "same", store.listAppFiles(id));

    expect(store.listTurnSnapshots(id)).toHaveLength(1);
    expect(store.restoreTurnSnapshot(id, "same")).not.toBeNull();
    expect(store.readAppFile(id, "index.html")).toBe("<p>v2</p>");
  });
});

describe("turn snapshots (per-generation undo)", () => {
  it("records, lists, and restores a turn's exact workspace state", async () => {
    const store = await freshStore();
    const project = store.createProject("Undo", "")!;
    const id = project.id;

    store.saveAppFile(id, "index.html", "<p>v1</p>");
    store.recordTurnSnapshot(id, "msg-a", store.listAppFiles(id));

    // Next turn changes the file and adds a new one.
    store.saveAppFile(id, "index.html", "<p>v2 — expanded</p>");
    store.saveAppFile(id, "styles.css", "body{}");
    store.recordTurnSnapshot(id, "msg-b", store.listAppFiles(id));

    const snaps = store.listTurnSnapshots(id);
    expect(snaps.map((s: { messageId: string }) => s.messageId)).toEqual([
      "msg-b",
      "msg-a",
    ]);
    expect(snaps[0].files).toEqual(["index.html", "styles.css"]);

    // Restore msg-a: index.html reverts AND the later styles.css is removed.
    const restored = store.restoreTurnSnapshot(id, "msg-a");
    expect(restored?.messageId).toBe("msg-a");
    const after = store.listAppFiles(id);
    expect(after.map((f: { path: string }) => f.path)).toEqual(["index.html"]);
    expect(after[0].content).toBe("<p>v1</p>");
  });

  it("prunes beyond the cap and dedupes a regenerated messageId", async () => {
    const store = await freshStore();
    const id = store.createProject("Cap", "")!.id;
    store.saveAppFile(id, "index.html", "<p>x</p>");

    for (let i = 0; i < store.TURN_SNAPSHOT_CAP + 3; i++) {
      store.saveAppFile(id, "index.html", `<p>turn ${i}</p>`);
      store.recordTurnSnapshot(id, `m${i}`, store.listAppFiles(id));
    }
    // Regenerate m2: replaces its snapshot, moves to the front (newest).
    store.saveAppFile(id, "index.html", "<p>m2 regenerated</p>");
    store.recordTurnSnapshot(id, "m2", store.listAppFiles(id));

    const snaps = store.listTurnSnapshots(id);
    expect(snaps).toHaveLength(store.TURN_SNAPSHOT_CAP);
    expect(snaps[0].messageId).toBe("m2");
    // m0..m2 (oldest) were pruned from disk.
    const restored = store.restoreTurnSnapshot(id, "m0");
    expect(restored).toBeNull();

    // The regenerated m2 restores the regenerated content.
    store.restoreTurnSnapshot(id, "m2");
    expect(store.listAppFiles(id)[0].content).toBe("<p>m2 regenerated</p>");
  });

  it("diffs a snapshot against the current workspace: added, removed, modified", async () => {
    const store = await freshStore();
    const id = store.createProject("Diff", "")!.id;

    // Snapshot state: index.html v1 + notes.md.
    store.saveAppFile(id, "index.html", "<p>v1</p>");
    store.saveAppFile(id, "notes.md", "hello");
    store.recordTurnSnapshot(id, "msg-a", store.listAppFiles(id));

    // Current workspace: index.html changed, notes.md deleted, styles.css added.
    store.saveAppFile(id, "index.html", "<p>v2</p>");
    store.saveAppFile(id, "styles.css", "body{}");
    store.deleteAppFile(id, "notes.md");

    const diff = store.turnSnapshotDiff(id, "msg-a");
    expect(diff).toEqual({
      messageId: "msg-a",
      added: ["notes.md"], // restore would re-add it
      removed: ["styles.css"], // restore would delete it
      modified: ["index.html"], // content differs → restore would revert it
    });

    // After restoring, the diff is empty (workspace equals the snapshot).
    store.restoreTurnSnapshot(id, "msg-a");
    expect(store.turnSnapshotDiff(id, "msg-a")).toEqual({
      messageId: "msg-a",
      added: [],
      removed: [],
      modified: [],
    });

    // Unknown or pruned snapshot → null.
    expect(store.turnSnapshotDiff(id, "nope")).toBeNull();
  });

  it("forks a snapshot into a new project, leaving the source untouched", async () => {
    const store = await freshStore();
    const id = store.createProject("Source", "")!.id;
    store.saveAppFile(id, "index.html", "<p>v1</p>");
    store.saveAppFile(id, "app.js", "console.log(1)");
    store.recordTurnSnapshot(id, "msg-a", store.listAppFiles(id));

    // Source moves on after the snapshot.
    store.saveAppFile(id, "index.html", "<p>v2</p>");

    const fork = store.forkTurnSnapshot(id, "msg-a");
    expect(fork).toBeTruthy();
    expect(fork!.id).not.toBe(id);
    // Default name derives from the source project.
    expect(fork!.name).toBe("Source (copy)");
    // The fork's workspace is the SNAPSHOT's files, not the source's current.
    const forkFiles = store.listAppFiles(fork!.id);
    const byPath = new Map(forkFiles.map((f: { path: string; content: string }) => [f.path, f.content]));
    expect(byPath.get("index.html")).toBe("<p>v1</p>");
    expect(byPath.get("app.js")).toBe("console.log(1)");
    // Source workspace untouched by the fork.
    const srcIndex = store.listAppFiles(id).find((f: { path: string }) => f.path === "index.html");
    expect(srcIndex?.content).toBe("<p>v2</p>");
    // Custom name wins.
    const named = store.forkTurnSnapshot(id, "msg-a", "My variant");
    expect(named!.name).toBe("My variant");
    // Unknown snapshot → null, nothing created.
    expect(store.forkTurnSnapshot(id, "nope")).toBeNull();
  });

  it("reads a single snapshot file and refuses traversal", async () => {
    const store = await freshStore();
    const id = store.createProject("Thumb", "")!.id;
    store.saveAppFile(id, "index.html", "<p>snapshot v1</p>");
    store.saveAppFile(id, "sub/page.html", "<p>nested</p>");
    store.recordTurnSnapshot(id, "msg-a", store.listAppFiles(id));

    expect(store.readTurnSnapshotFile(id, "msg-a", "index.html")).toBe(
      "<p>snapshot v1</p>",
    );
    expect(store.readTurnSnapshotFile(id, "msg-a", "sub/page.html")).toBe(
      "<p>nested</p>",
    );
    // Missing file / unknown snapshot → null.
    expect(store.readTurnSnapshotFile(id, "msg-a", "nope.css")).toBeNull();
    expect(store.readTurnSnapshotFile(id, "gone", "index.html")).toBeNull();
    // Traversal out of the snapshot dir must never read arbitrary files.
    expect(
      store.readTurnSnapshotFile(id, "msg-a", "../../project.json"),
    ).toBeNull();
  });

  it("never leaks snapshots into workspace listings", async () => {
    const store = await freshStore();
    const id = store.createProject("Leak", "")!.id;
    store.saveAppFile(id, "index.html", "<p>v1</p>");
    store.recordTurnSnapshot(id, "msg-a", store.listAppFiles(id));
    store.saveAppFile(id, "index.html", "<p>v2</p>");

    const listed = store.listAppFiles(id);
    expect(listed.map((f: { path: string }) => f.path)).toEqual(["index.html"]);
    // The snapshot copy of v1 stays on disk for the undo.
    const restored = store.restoreTurnSnapshot(id, "msg-a");
    expect(restored?.files).toEqual(["index.html"]);
    expect(store.listAppFiles(id)[0].content).toBe("<p>v1</p>");
  });
});
describe("workspaceMissingRefs — file + line for the code view", () => {
  it("reports each missing reference with its file and 1-based line", async () => {
    const store = await freshStore();
    const id = store.createProject("LineScan", "")!.id;
    store.saveAppFile(id, "index.html", [
      "<!doctype html>",
      "<html>",
      '  <link rel="stylesheet" href="styles.css">',
      '  <script src="app.js"></script>',
      "</html>",
    ].join("\n"));
    store.saveAppFile(id, "styles.css", "body{}");
    store.saveAppFile(id, "app.js", "1");

    const refs = store.workspaceMissingRefs(id);
    // styles.css + app.js exist; nothing missing.
    expect(refs).toEqual([]);

    // Remove app.js → its referencing line is reported, the styles one isn't.
    fs.rmSync(path.join(process.cwd(), "projects-data", id, "app.js"));
    const after = store.workspaceMissingRefs(id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ path: "app.js", from: "index.html", line: 4 });
  });

  it("scans CSS @import/url() with line numbers and sorts by file then line", async () => {
    const store = await freshStore();
    const id = store.createProject("CssLines", "")!.id;
    store.saveAppFile(id, "index.html", "<html></html>");
    store.saveAppFile(id, "theme.css", [
      "@import \"first-missing.css\";",
      "",
      ".hero { background: url(\"img/missing.png\"); }",
      ".badge { background-image: url('second-missing.webp'); }",
    ].join("\n"));

    const refs = store.workspaceMissingRefs(id);
    expect(refs).toEqual([
      { path: "first-missing.css", from: "theme.css", line: 1 },
      { path: "img/missing.png", from: "theme.css", line: 3 },
      { path: "second-missing.webp", from: "theme.css", line: 4 },
    ]);
  });
});
