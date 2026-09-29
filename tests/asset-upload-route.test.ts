// @vitest-environment node
/**
 * Asset upload route — the API contract behind the file panel's "+"/drop.
 * The server is the validator: extension allowlist, per-asset size cap,
 * empty/duplicate/unsafe-name rejection, per-file errors alongside 201
 * partial success. Hand-crafted multipart bodies pin the wire shape (see
 * the node-env landmine in docs/playbooks.md).
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-assets-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

/** Hand-crafted multipart body with N file fields (pins the wire shape). */
function assetReq(projectId: string, files: { name: string; body: Buffer }[]): Request {
  const BOUNDARY = "----anybaseassets";
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${f.name}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      f.body,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return new Request(`http://localhost:3000/api/projects/${projectId}/assets`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: Buffer.concat(parts),
  });
}

describe("asset upload route — validation contract", () => {
  it("404s for an unknown project, 400s with no files", async () => {
    const { POST } = await import(
      "../src/app/api/projects/[projectId]/assets/route"
    );
    const missing = await POST(
      assetReq("ghost-project", [{ name: "x.png", body: Buffer.from([1]) }]) as never,
      { params: Promise.resolve({ projectId: "ghost-project" }) } as never,
    );
    expect(missing.status).toBe(404);

    const { createProject } = await import("../src/lib/store");
    const { id } = createProject("Assets", "")!;
    const empty = await POST(
      new Request(`http://localhost:3000/api/projects/${id}/assets`, {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=----b",
        },
        body: Buffer.from("--b--\r\n"),
      }) as never,
      { params: Promise.resolve({ projectId: id }) } as never,
    );
    expect(empty.status).toBe(400);
  });

  it("saves valid assets as raw bytes; rejects unsupported/empty/oversize per-file", async () => {
    const { POST } = await import(
      "../src/app/api/projects/[projectId]/assets/route"
    );
    const store = await import("../src/lib/store");
    const { id } = store.createProject("Assets", "")!;

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
    const res = await POST(
      assetReq(id, [
        { name: "logo.png", body: png },
        { name: "notes.txt", body: Buffer.from("nope") }, // not an asset ext
        { name: "empty.woff2", body: Buffer.alloc(0) }, // empty
        { name: "big.png", body: Buffer.alloc(2_100_000, 1) }, // over cap
        { name: "sub/dir.svg.png", body: Buffer.from([9, 9]) }, // basename only
      ]) as never,
      { params: Promise.resolve({ projectId: id }) } as never,
    );
    expect(res.status).toBe(201); // partial success
    const data = await res.json();
    // Basename-only policy: "sub/dir.svg.png" landed as "dir.svg.png".
    expect(data.saved).toEqual([{ path: "logo.png" }, { path: "dir.svg.png" }]);
    const errs = new Map(data.errors.map((e: { filename: string; error: string }) => [e.filename, e.error]));
    expect(errs.get("notes.txt")).toMatch(/Unsupported/);
    expect(errs.get("empty.woff2")).toMatch(/Empty/);
    expect(errs.get("big.png")).toMatch(/Too large/);

    // Disk truth: raw bytes at the project root, nothing nested.
    expect(
      fs.readFileSync(path.join(process.cwd(), "projects-data", id, "logo.png")),
    ).toEqual(png);
    expect(fs.existsSync(path.join(process.cwd(), "projects-data", id, "sub"))).toBe(false);
    // Listed with the base64 layer; fileBytes decodes.
    const listed = store.listAppFiles(id).find((f: { path: string }) => f.path === "logo.png");
    expect(listed?.encoding).toBe("base64");
    expect(store.fileBytes(listed!)).toEqual(png);
  });

  it("rejects duplicates and never overwrites; touchProject bumps updatedAt", async () => {
    const { POST } = await import(
      "../src/app/api/projects/[projectId]/assets/route"
    );
    const store = await import("../src/lib/store");
    const { id } = store.createProject("Dupes", "")!;
    store.saveAppFile(id, "index.html", "<p>app</p>");
    store.saveAppFile(id, "logo.png", "aGk="); // pre-existing asset
    const before = store.getProject(id)!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));

    const res = await POST(
      assetReq(id, [
        { name: "logo.png", body: Buffer.from([1, 2, 3]) }, // collision
        { name: "font.woff2", body: Buffer.from([4, 5, 6]) }, // fine
      ]) as never,
      { params: Promise.resolve({ projectId: id }) } as never,
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.saved).toEqual([{ path: "font.woff2" }]);
    expect(data.errors[0].filename).toBe("logo.png");
    expect(data.errors[0].error).toMatch(/already exists/);
    // The generated file was NOT clobbered.
    expect(store.readAppFile(id, "index.html")).toBe("<p>app</p>");
    expect(store.getProject(id)!.updatedAt > before).toBe(true);
  });
});
