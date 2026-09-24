/**
 * Publish-route contract: the exact API shapes the builder UI consumes.
 *
 * Two real drift bugs were found in review of the pin feature:
 *   1. The POST /publish response omitted `dirty` and `pinnedFrom`. The
 *      client REPLACES its PublishState with the POST response, so the
 *      "public page serves the pinned version" note (and the dirty flag)
 *      vanished after every republish while the pin held.
 *   2. The POST computed dirty independently from the GET. The client
 *      replaces its whole PublishState with the POST response, so the two
 *      must agree — POST now derives dirty from the same helper as GET
 *      (under a pin with a moved-on workspace, dirty stays true).
 *
 * These tests pin the contract so neither can drift back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-publish-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

const PUBLISH_ROUTE = "../src/app/api/projects/[projectId]/publish/route";

function makeReq(method: string, body?: unknown): Request {
  return new Request("http://localhost:3000/api/projects/p1/publish", {
    method,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

describe("publish route — UI contract", () => {
  it("POST response carries dirty:false and pinnedFrom so the pinned note survives republish", async () => {
    const { createProject, saveAppFile, recordTurnSnapshot, setPinnedSnapshot } =
      await import("@/lib/store");
    const { POST } = await import(PUBLISH_ROUTE);

    const { id } = createProject("Pin Contract", "")!;
    saveAppFile(id, "index.html", "<p>v1</p>");
    recordTurnSnapshot(id, "m-pin", [{ path: "index.html", content: "<p>v1</p>" }]);
    setPinnedSnapshot(id, "m-pin");

    const res = await POST(makeReq("POST", {}) as never, {
      params: Promise.resolve({ projectId: id }),
    } as never);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.published).toBe(true);
    expect(data.dirty).toBe(false);
    expect(data.pinnedFrom).toBe("m-pin");

    // Unpinning flips the field the UI note keys on.
    const { clearPinnedSnapshot } = await import("@/lib/store");
    clearPinnedSnapshot(id);
    const res2 = await POST(makeReq("POST", {}) as never, {
      params: Promise.resolve({ projectId: id }),
    } as never);
    expect((await res2.json()).pinnedFrom).toBeNull();
  });

  it("POST republish under a pin reports dirty:true while the live workspace is ahead", async () => {
    const { createProject, saveAppFile, recordTurnSnapshot, setPinnedSnapshot } =
      await import("@/lib/store");
    const { POST } = await import(PUBLISH_ROUTE);

    const { id } = createProject("Pin Dirty", "")!;
    saveAppFile(id, "index.html", "<p>v1</p>");
    recordTurnSnapshot(id, "m-pin", [{ path: "index.html", content: "<p>v1</p>" }]);
    setPinnedSnapshot(id, "m-pin");

    // Publish while workspace == pin → clean.
    const first = await (
      await POST(makeReq("POST", {}) as never, {
        params: Promise.resolve({ projectId: id }),
      } as never)
    ).json();
    expect(first.dirty).toBe(false);
    expect(first.pinnedFrom).toBe("m-pin");

    // Move the live workspace on; the pin still serves v1 publicly, but
    // the workspace IS ahead of the published folder → dirty must flip.
    saveAppFile(id, "index.html", "<p>v2-live</p>");
    const second = await (
      await POST(makeReq("POST", {}) as never, {
        params: Promise.resolve({ projectId: id }),
      } as never)
    ).json();
    expect(second.dirty).toBe(true);
    expect(second.pinnedFrom).toBe("m-pin");
  });

  it("status GET flags dirty when a published file is REMOVED from the workspace", async () => {
    const { createProject, saveAppFile, publishProject } = await import("@/lib/store");
    const { GET } = await import(PUBLISH_ROUTE);

    const { id } = createProject("Removal", "")!;
    saveAppFile(id, "index.html", "<h1>hello</h1>");
    saveAppFile(id, "app.js", "console.log(1)");
    publishProject(id, "removal-app");

    const status = async () => {
      const res = await GET(makeReq("GET") as never, {
        params: Promise.resolve({ projectId: id }),
      } as never);
      return (await res.json()) as Record<string, unknown>;
    };

    expect((await status()).dirty).toBe(false);

    // Remove a workspace file that exists in the published snapshot.
    fs.rmSync(path.join(process.cwd(), "projects-data", id, "app.js"));
    expect((await status()).dirty).toBe(true);
  });

  it("status GET stays clean when nothing changed (baseline guard)", async () => {
    const { createProject, saveAppFile, publishProject } = await import("@/lib/store");
    const { GET } = await import(PUBLISH_ROUTE);

    const { id } = createProject("Align", "")!;
    saveAppFile(id, "index.html", "<h1>hello</h1>");
    saveAppFile(id, "app.js", "console.log(1)");
    publishProject(id, "align-app");

    const res = await GET(makeReq("GET") as never, {
      params: Promise.resolve({ projectId: id }),
    } as never);
    expect(((await res.json()) as Record<string, unknown>).dirty).toBe(false);
  });
});

describe("pin — missing-assets warning contract", () => {
  it("POST /pin 409s with the missing list; force pins anyway and reports pinnedWithMissing", async () => {
    const { createProject, saveAppFile, recordTurnSnapshot } = await import("@/lib/store");
    const { POST } = await import(
      "../src/app/api/projects/[projectId]/pin/[messageId]/route"
    );

    const { id } = createProject("PinWarn", "")!;
    saveAppFile(id, "index.html", '<html><script src="app.js"></script></html>');
    saveAppFile(id, "styles.css", "body{}");
    recordTurnSnapshot(id, "m-warn", [
      { path: "index.html", content: '<html><script src="app.js"></script></html>' },
      { path: "styles.css", content: "body{}" },
    ]);

    const ctx = { params: Promise.resolve({ projectId: id, messageId: "m-warn" }) } as never;

    // Plain pin → 409 + the missing list.
    // A complete snapshot exists too, so the 409 must offer it.
    recordTurnSnapshot(id, "m-ok", [
      { path: "index.html", content: "<html></html>" },
    ]);
    // Backdate m-warn so m-ok is unambiguously the most recent complete one.
    const fsMod = await import("node:fs");
    const snapPath = path.join(
      process.cwd(),
      "projects-data",
      id,
      "turn-snapshots.json",
    );
    const manifest = JSON.parse(fsMod.readFileSync(snapPath, "utf8"));
    const warnEntry = manifest.snapshots.find(
      (s: { messageId: string }) => s.messageId === "m-warn",
    );
    warnEntry.savedAt = "2026-01-01T00:00:00.000Z";
    fsMod.writeFileSync(snapPath, JSON.stringify(manifest));

    const refused = await POST(makeReq("POST") as never, ctx);
    expect(refused.status).toBe(409);
    const warn = await refused.json();
    expect(warn.missing).toEqual(["app.js"]);
    // One-click alternative: the newest complete snapshot id.
    expect(warn.suggest).toBe("m-ok");

    // force → pins, and still discloses what will 404.
    const forced = await POST(makeReq("POST", { force: true }) as never, ctx);
    expect(forced.status).toBe(200);
    const ok = await forced.json();
    expect(ok.pinnedSnapshot?.messageId).toBe("m-warn");
    expect(ok.pinnedWithMissing).toEqual(["app.js"]);

    // A complete snapshot pins without ceremony.
    recordTurnSnapshot(id, "m-ok", [
      { path: "index.html", content: "<html></html>" },
    ]);
    const plain = await POST(makeReq("POST") as never, {
      params: Promise.resolve({ projectId: id, messageId: "m-ok" }),
    } as never);
    expect(plain.status).toBe(200);
    expect((await plain.json()).pinnedWithMissing).toBeUndefined();
  });
});

describe("publish — pinned-missing refusal contract", () => {
  it("POST /publish 409s while the pinned snapshot lacks assets; ?force=1 publishes and reports pinnedMissing", async () => {
    const { createProject, saveAppFile, recordTurnSnapshot, setPinnedSnapshot } =
      await import("@/lib/store");
    const mod = await import(
      "../src/app/api/projects/[projectId]/publish/route"
    );
    const { POST, GET } = mod;

    const { id } = createProject("PubWarn", "")!;
    saveAppFile(id, "index.html", "<html></html>");
    recordTurnSnapshot(id, "m-incomplete", [
      { path: "index.html", content: '<html><script src="ghost.js"></script></html>' },
    ]);
    setPinnedSnapshot(id, "m-incomplete");

    const ctx = { params: Promise.resolve({ projectId: id }) } as never;

    // A complete snapshot exists, so the refusal must offer the switch.
    recordTurnSnapshot(id, "m-good", [
      { path: "index.html", content: "<html><p>complete</p></html>" },
    ]);
    const refused = await POST(makeReq("POST", {}) as never, ctx);
    expect(refused.status).toBe(409);
    const warn = await refused.json();
    expect(warn.missing).toEqual(["ghost.js"]);
    expect(warn.suggest).toBe("m-good");

    const forced = await POST(
      new Request("http://localhost:3000/api/projects/p1/publish?force=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }) as never,
      ctx,
    );
    expect(forced.status).toBe(200);
    const data = await forced.json();
    expect(data.pinnedFrom).toBe("m-incomplete");
    expect(data.pinnedMissing).toEqual(["ghost.js"]);

    // Status GET mirrors the fields for the client note + switch button.
    const status = await (await GET(makeReq("GET") as never, ctx)).json();
    expect(status.pinnedMissing).toEqual(["ghost.js"]);
    expect(status.suggest).toBe("m-good");
  });
});
