// @vitest-environment node
/**
 * Import route — the API contract the dashboard's ImportZipButton
 * consumes. Node environment: undici's Request.formData() parser (what
 * the Next route runs on) chokes on jsdom's Blob, so the multipart body
 * is hand-crafted here — which also pins the exact wire shape the
 * browser sends. Asserts the zip-magic gate, the 201 payload (project +
 * importedCount + skipped reasons), filename-stem naming, and the
 * junk-zip 400.
 *
 * Hermetic: store re-imported after chdir into a fresh temp cwd.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-import-api-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

async function zipOf(entries: Record<string, string | Uint8Array>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Hand-crafted multipart body — pins the browser's wire shape. */
function importReq(
  body: Buffer,
  filename = "app.zip",
  fields: Record<string, string> = {},
): Request {
  const BOUNDARY = "----anybaseimport";
  const fieldPart = Object.entries(fields)
    .map(
      ([k, v]) =>
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    )
    .join("");
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return new Request("http://localhost:3000/api/projects/import", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: Buffer.concat([fieldPart ? Buffer.from(fieldPart) : Buffer.alloc(0), head, body, tail]),
  });
}

describe("import route — API contract", () => {
  it("400s on a non-zip payload; 201 + payload on a valid zip; 400 on a junk zip", async () => {
    const { POST } = await import("../src/app/api/projects/import/route");

    // Text payload, zip magic missing → 400 with the not-a-zip message.
    const notZip = await POST(
      importReq(Buffer.from("hello, not a zip"), "app.txt") as never,
    );
    expect(notZip.status).toBe(400);
    expect((await notZip.json()).error).toMatch(/not a zip/i);

    // Valid zip → 201 with project + importedCount + skipped reasons.
    // The UI derives the app name from the filename and sends it as a
    // field; a name field must win over the default.
    const good = await zipOf({
      "index.html": "<p>hi</p>",
      "img/x.png": new Uint8Array([1, 2, 3]),
    });
    const ok = await POST(
      importReq(good, "app.zip", { name: "app", description: "restored" }) as never,
    );
    expect(ok.status).toBe(201);
    const data = await ok.json();
    expect(data.importedCount).toBe(1);
    expect(data.skipped).toEqual([
      { path: "img/x.png", reason: "binary file (not text)" },
    ]);
    expect(data.project.name).toBe("app");
    expect(data.project.description).toBe("restored");

    // Junk zip (right magic, nothing importable) → 400 with the thrown text.
    const junk = await zipOf({ ".DS_Store": "junk" });
    const bad = await POST(importReq(junk) as never);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/No importable files/);

    // Only ONE project was created — the junk zip left nothing behind.
    const store = await import("../src/lib/store");
    expect(store.listProjects()).toHaveLength(1);
  });

  it("rejects a form with no file field", async () => {
    const { POST } = await import("../src/app/api/projects/import/route");
    const BOUNDARY = "----anybaseimport";
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="name"\r\n\r\nNo file here\r\n--${BOUNDARY}--\r\n`,
    );
    const res = await POST(
      new Request("http://localhost:3000/api/projects/import", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
        body,
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Missing zip file/);
  });
});
