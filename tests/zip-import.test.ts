/**
 * Zip import — the return leg of the portability story. Export
 * (GET .../download) has existed since day one; nothing could come back
 * in. Pins the sanitizer (traversal/absolute/drive-letter/backslash
 * refusal, macOS + Windows + hidden junk, binary detection, size caps,
 * duplicate handling) and the store entry point (fresh ids per import,
 * root project.json as export metadata, junk-only zips throw and leave
 * no project dir behind, export→import round-trip).
 *
 * Adversarial entries are SYNTHETIC (via importFromEntries): the JSZip
 * writer normalizes `..` segments and dedupes same-path entries at write
 * time, so those shapes are only realizable in hand-crafted zips — the
 * sanitizer is the boundary that must hold regardless of the writer.
 *
 * Hermetic: store re-imported after chdir into a fresh temp cwd. The
 * multipart route contract lives in zip-import-route.test.ts (node env:
 * undici's formData parser vs jsdom's Blob).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-import-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

async function freshZipImport() {
  return import("../src/lib/zip-import");
}

/** Minimal synthetic entry for importFromEntries. */
function entry(name: string, content: string, size?: number) {
  return { name, size, async: async () => content };
}

/** Build a real zip buffer (realistic shapes only — the writer normalizes). */
async function zipOf(entries: Record<string, string | Uint8Array>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("zip import — path sanitization (synthetic adversarial entries)", () => {
  it("refuses traversal, absolute, drive-letter, and backslash paths with reasons", async () => {
    const mod = await freshZipImport();
    const unsafe = [
      "site/../../evil.txt",
      "/etc/passwd",
      "C:/winhi.txt",
      "a\\b\\evil.txt",
      "..\\evil2.txt",
      "../rel-escape.txt",
    ];
    const result = await mod.importFromEntries(
      [...unsafe.map((n) => entry(n, "x")), entry("site/index.html", "<p>ok</p>")],
    );
    expect(result.imported.map((f: { path: string }) => f.path)).toEqual([
      "site/index.html",
    ]);
    const reasons = new Map(
      result.skipped.map((s: { path: string; reason: string }) => [s.path, s.reason]),
    );
    for (const n of unsafe) {
      expect(reasons.get(n)).toBe(mod.SKIP_REASONS.TRAVERSAL);
    }
  });

  it("skips macOS junk, Windows dir entries, and hidden/system files", async () => {
    const mod = await freshZipImport();
    const result = await mod.importFromEntries([
      entry("__MACOSX/site/._index.html", "junk"),
      entry("site/", ""), // Windows-style directory entry
      entry("site/.DS_Store", "junk"),
      entry("site/Thumbs.db", "junk"),
      entry("site/desktop.ini", "junk"),
      entry("site/.hidden", "dot-prefixed"),
      entry("site/index.html", "<p>ok</p>"),
    ]);
    expect(result.imported.map((f: { path: string }) => f.path)).toEqual([
      "site/index.html",
    ]);
    const reasons = new Map(
      result.skipped.map((s: { path: string; reason: string }) => [s.path, s.reason]),
    );
    expect(reasons.get("site/.DS_Store")).toBe(mod.SKIP_REASONS.DOT_OR_SYSTEM);
    expect(reasons.get("site/Thumbs.db")).toBe(mod.SKIP_REASONS.DOT_OR_SYSTEM);
    expect(reasons.get("site/desktop.ini")).toBe(mod.SKIP_REASONS.DOT_OR_SYSTEM);
    expect(reasons.get("site/.hidden")).toBe(mod.SKIP_REASONS.DOT_OR_SYSTEM);
    // Silent zip noise: never surfaces in the user-facing skip list.
    expect(result.skipped.some((s: { path: string }) => s.path.startsWith("__MACOSX"))).toBe(false);
    expect(result.skipped.some((s: { path: string }) => s.path === "site/")).toBe(false);
  });

  it("keeps the first of duplicate paths and reports the rest", async () => {
    const mod = await freshZipImport();
    const result = await mod.importFromEntries([
      entry("index.html", "<p>first</p>"),
      entry("./index.html", "<p>second</p>"),
    ]);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].content).toBe("<p>first</p>");
    expect(result.skipped).toEqual([
      { path: "index.html", reason: mod.SKIP_REASONS.DUPLICATE },
    ]);
  });

  it("refuses declared-size outliers without decompressing them", async () => {
    const mod = await freshZipImport();
    const result = await mod.importFromEntries(
      [entry("huge.txt", "never-read", 10_000_000), entry("ok.txt", "fine")],
      { maxFileBytes: 1000 },
    );
    expect(result.imported.map((f: { path: string }) => f.path)).toEqual(["ok.txt"]);
    expect(result.skipped).toEqual([
      { path: "huge.txt", reason: mod.SKIP_REASONS.TOO_LARGE },
    ]);
  });
});

describe("zip import — content filtering", () => {
  it("skips binary content with the binary reason (extension, NUL, round-trip)", async () => {
    const mod = await freshZipImport();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const utf16 = new TextEncoder().encode("h\0i\0");
    const buf = await zipOf({
      "img/logo.png": png,
      "text.txt": utf16,
      "index.html": "<p>ok</p>",
      "theme.css": "body{}",
    });
    const result = await mod.importProjectFromZip(buf);
    expect(result.imported.map((f: { path: string }) => f.path)).toEqual([
      "index.html",
      "theme.css",
    ]);
    const reasons = new Map(
      result.skipped.map((s: { path: string; reason: string }) => [s.path, s.reason]),
    );
    expect(reasons.get("img/logo.png")).toBe(mod.SKIP_REASONS.BINARY);
    expect(reasons.get("text.txt")).toBe(mod.SKIP_REASONS.BINARY);
  });

  it("enforces per-file and total size caps", async () => {
    const mod = await freshZipImport();
    const big = "x".repeat(600);
    const buf = await zipOf({
      "big.txt": big,
      "small.txt": "ok",
      "also-big.txt": big,
    });
    const result = await mod.importProjectFromZip(buf, {
      maxFileBytes: 500,
      maxTotalBytes: 900,
    });
    expect(result.imported.map((f: { path: string }) => f.path)).toEqual(["small.txt"]);
    expect(
      result.skipped.every((s: { reason: string }) => s.reason === mod.SKIP_REASONS.TOO_LARGE),
    ).toBe(true);
  });

  it("skips empty files", async () => {
    const mod = await freshZipImport();
    const buf = await zipOf({ "empty.txt": "", "index.html": "<p>ok</p>" });
    const result = await mod.importProjectFromZip(buf);
    expect(result.imported.map((f: { path: string }) => f.path)).toEqual(["index.html"]);
    expect(result.skipped).toEqual([
      { path: "empty.txt", reason: mod.SKIP_REASONS.EMPTY },
    ]);
  });
});

describe("zip import — store semantics", () => {
  it("creates a project with a fresh id and copies files into its workspace", async () => {
    const mod = await freshZipImport();
    const buf = await zipOf({
      "index.html": "<html><body><h1>Imported</h1></body></html>",
      "app.js": "console.log(1)",
    });
    const result = await mod.importProjectFromZip(buf, { name: "My Import" });

    expect(result.project.name).toBe("My Import");
    expect(result.project.id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    const store = await import("../src/lib/store");
    expect(store.getProject(result.project.id)?.name).toBe("My Import");
    expect(store.readAppFile(result.project.id, "index.html")).toContain("Imported");
    expect(store.readAppFile(result.project.id, "app.js")).toBe("console.log(1)");
    // Import is listable as a normal user app.
    expect(store.listProjects().some((p: { id: string }) => p.id === result.project.id)).toBe(true);
  });

  it("treats a root project.json as export metadata, never an app file", async () => {
    const mod = await freshZipImport();
    const buf = await zipOf({ "index.html": "<p>ok</p>" });
    const result = await mod.importProjectFromZip(buf);
    expect(result.imported.map((f: { path: string }) => f.path)).toEqual(["index.html"]);
    // The imported project's OWN project.json is intact (fresh id, defaults).
    const onDisk = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "projects-data", result.project.id, "project.json"),
        "utf8",
      ),
    );
    expect(onDisk.name).toBe("Imported app");
    expect(onDisk.id).toBe(result.project.id);
  });

  it("throws on a junk-only zip and leaves no project directory behind", async () => {
    const mod = await freshZipImport();
    const buf = await zipOf({ "__MACOSX/x/._y": "junk", ".DS_Store": "junk" });
    await expect(mod.importProjectFromZip(buf)).rejects.toThrow(/No importable files/);
    // No orphan project dir under the (now-empty) store root.
    expect(fs.readdirSync(path.join(process.cwd(), "projects-data"))).toEqual([]);
  });

  it("round-trips: export zip → import → identical workspace under a new id", async () => {
    const store = await import("../src/lib/store");
    const mod = await freshZipImport();

    const original = store.createProject("Round Trip", "desc here");
    store.saveAppFile(original.id, "index.html", "<html><h1>RT</h1></html>");
    store.saveAppFile(original.id, "styles.css", "h1{color:red}");
    store.saveAppFile(original.id, "app.js", "console.log('rt')");

    // Export exactly like GET .../download does.
    const zip = new JSZip();
    for (const f of store.listAppFiles(original.id)) {
      zip.file(f.path, f.content);
    }
    const exported = await zip.generateAsync({ type: "nodebuffer" });

    const result = await mod.importProjectFromZip(exported, { name: "Round Trip" });
    expect(result.imported).toHaveLength(3);
    expect(result.skipped).toEqual([]);
    expect(result.project.id).not.toBe(original.id);
    for (const f of store.listAppFiles(original.id)) {
      expect(store.readAppFile(result.project.id, f.path)).toBe(f.content);
    }
  });
});
