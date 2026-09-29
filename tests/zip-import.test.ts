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

/** Workspace paths of a project, sorted (readability in assertions). */
async function store_listPaths(projectId: string): Promise<string[]> {
  const store = await import("../src/lib/store");
  return store.listAppFiles(projectId).map((f: { path: string }) => f.path).sort();
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

/** The metadata envelope the download route writes into exports. */
function metaEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    anybase: 1,
    id: "oldid-123",
    name: "Exported app",
    description: "original description",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  });
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

  it("treats the anybase envelope as metadata; fresh id, restored name/description", async () => {
    const mod = await freshZipImport();
    const buf = await zipOf({
      "project.json": metaEnvelope(),
      "index.html": "<p>ok</p>",
    });
    const result = await mod.importProjectFromZip(buf);
    // Metadata-aware: the export's original identity is restored…
    expect(result.project.name).toBe("Exported app");
    expect(result.project.description).toBe("original description");
    // …but the envelope's OLD id/timestamps never leak into the fresh project.
    expect(result.project.id).not.toBe("oldid-123");
    expect(result.imported.map((f: { path: string }) => f.path)).toEqual(["index.html"]);
    // The imported project's OWN project.json is intact on disk.
    const onDisk = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "projects-data", result.project.id, "project.json"),
        "utf8",
      ),
    );
    expect(onDisk.name).toBe("Exported app");
    expect(onDisk.id).toBe(result.project.id);
    // The envelope was consumed, not written into the workspace.
    expect(await store_listPaths(result.project.id)).toEqual(["index.html"]);
  });

  it("priority: explicit name > export metadata > filename fallback > default", async () => {
    const mod = await freshZipImport();
    const base = { "project.json": metaEnvelope(), "index.html": "<p>x</p>" };

    const metaWins = await mod.importProjectFromZip(await zipOf(base), {
      fallbackName: "From Filename",
    });
    expect(metaWins.project.name).toBe("Exported app");

    const fallbackWins = await mod.importProjectFromZip(
      await zipOf({ "index.html": "<p>x</p>" }),
      { fallbackName: "From Filename" },
    );
    expect(fallbackWins.project.name).toBe("From Filename");

    const explicitWins = await mod.importProjectFromZip(await zipOf(base), {
      name: "Explicit",
      fallbackName: "From Filename",
    });
    expect(explicitWins.project.name).toBe("Explicit");

    const plain = await mod.importProjectFromZip(await zipOf({ "index.html": "<p>x</p>" }));
    expect(plain.project.name).toBe("Imported app");
  });

  it("a foreign app's root project.json is RESERVED, never imported (clobber guard)", async () => {
    const mod = await freshZipImport();
    // Root project.json resolves to the store record path — importing it
    // as a workspace file would overwrite the fresh project's record.
    // Valid JSON without the marker: skipped as reserved, name NOT hijacked.
    const buf = await zipOf({
      "project.json": JSON.stringify({ name: "Foreign App", version: 2 }),
      "index.html": "<p>foreign</p>",
    });
    const result = await mod.importProjectFromZip(buf, { fallbackName: "From Filename" });
    expect(result.imported.map((f: { path: string }) => f.path)).toEqual(["index.html"]);
    expect(result.skipped).toEqual([
      { path: "project.json", reason: mod.SKIP_REASONS.RESERVED },
    ]);
    expect(result.project.name).toBe("From Filename");
    expect(await store_listPaths(result.project.id)).toEqual(["index.html"]);
    // The store record survived intact — this is the clobber the guard exists for.
    const onDisk = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "projects-data", result.project.id, "project.json"),
        "utf8",
      ),
    );
    expect(onDisk.name).toBe("From Filename");
    expect(onDisk.id).toBe(result.project.id);

    // Unparseable project.json: same reserved skip.
    const buf2 = await zipOf({ "project.json": "{not json", "index.html": "<p>x</p>" });
    const result2 = await mod.importProjectFromZip(buf2);
    expect(result2.skipped).toEqual([
      { path: "project.json", reason: mod.SKIP_REASONS.RESERVED },
    ]);
  });

  it("reserved-name check is case-insensitive (PROJECT.JSON would clobber on Windows)", async () => {
    const mod = await freshZipImport();
    const result = await mod.importFromEntries([
      { name: "PROJECT.JSON", size: 5, async: async () => "{}" },
      entry("index.html", "<p>x</p>"),
    ]);
    expect(result.imported.map((f: { path: string }) => f.path)).toEqual(["index.html"]);
    expect(result.skipped).toEqual([
      { path: "PROJECT.JSON", reason: mod.SKIP_REASONS.RESERVED },
    ]);
    // Nested project.json files are ordinary files.
    const nested = await mod.importFromEntries([
      { name: "config/project.json", size: 2, async: async () => "{}" },
      entry("index.html", "<p>x</p>"),
    ]);
    expect(nested.imported.map((f: { path: string }) => f.path)).toEqual([
      "config/project.json",
      "index.html",
    ]);
  });

  it("throws on a junk-only zip and leaves no project directory behind", async () => {
    const mod = await freshZipImport();
    const buf = await zipOf({ "__MACOSX/x/._y": "junk", ".DS_Store": "junk" });
    await expect(mod.importProjectFromZip(buf)).rejects.toThrow(/No importable files/);
    // No orphan project dir under the (now-empty) store root.
    expect(fs.readdirSync(path.join(process.cwd(), "projects-data"))).toEqual([]);
  });

  it("round-trips through the real download route: files AND metadata restored", async () => {
    const store = await import("../src/lib/store");
    const { GET } = await import("../src/app/api/projects/[projectId]/download/route");
    const mod = await freshZipImport();

    const original = store.createProject("Round Trip", "desc here");
    store.saveAppFile(original.id, "index.html", "<html><h1>RT</h1></html>");
    store.saveAppFile(original.id, "styles.css", "h1{color:red}");
    store.saveAppFile(original.id, "app.js", "console.log('rt')");

    // Export through the REAL route handler.
    const res = await GET(
      new Request(`http://localhost:3000/api/projects/${original.id}/download`) as never,
      { params: Promise.resolve({ projectId: original.id }) } as never,
    );
    expect(res.status).toBe(200);
    const exported = Buffer.from(await res.arrayBuffer());

    // Import without any name hints — metadata must carry the identity.
    const result = await mod.importProjectFromZip(exported);
    expect(result.imported).toHaveLength(3);
    expect(result.skipped).toEqual([]);
    expect(result.project.name).toBe("Round Trip");
    expect(result.project.description).toBe("desc here");
    expect(result.project.id).not.toBe(original.id);
    for (const f of store.listAppFiles(original.id)) {
      expect(store.readAppFile(result.project.id, f.path)).toBe(f.content);
    }
    // The envelope never leaks into the workspace listing.
    expect(await store_listPaths(result.project.id)).not.toContain("project.json");
  });

  it("export writes the envelope; nested app project.json files stay ordinary files", async () => {
    const store = await import("../src/lib/store");
    const { GET } = await import("../src/app/api/projects/[projectId]/download/route");
    const mod = await freshZipImport();

    const p = store.createProject("Own Meta", "with a nested manifest");
    store.saveAppFile(p.id, "config/manifest.json", '{"app":true}');
    store.saveAppFile(p.id, "index.html", "<p>x</p>");

    const res = await GET(
      new Request(`http://localhost:3000/api/projects/${p.id}/download`) as never,
      { params: Promise.resolve({ projectId: p.id }) } as never,
    );
    const exported = Buffer.from(await res.arrayBuffer());

    // Import restores name/description from the envelope; the nested
    // manifest is an ordinary file; the root envelope is consumed. (A
    // nested file NAMED project.json would never appear here at all:
    // listAppFiles excludes reserved BASENAMES at any depth.)
    const result = await mod.importProjectFromZip(exported);
    expect(result.imported.map((f: { path: string }) => f.path).sort()).toEqual([
      "config/manifest.json",
      "index.html",
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.project.name).toBe("Own Meta");
    expect(result.project.description).toBe("with a nested manifest");
  });
});
