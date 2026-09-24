/**
 * FULL recovery arc, wire to disk — the one-flow recovery the UI stitches
 * together from three routes, exercised here against the real handlers and
 * the real store with only the AI provider mocked (same wire harness as
 * fix-snapshot.test.ts):
 *
 *   1. 🛠 fix   POST /snapshots/:id/fix    → regenerates the missing assets
 *      into the snapshot (workspace untouched); the wire carried the
 *      SNAPSHOT's html + the missing names, never the live workspace.
 *   2. 📌 pin   POST /pin/:id              → plain pin SUCCEEDS (no force,
 *      no 409) — the fix made the snapshot complete, which is the whole
 *      point of the offer.
 *   3. 🚀 pub   POST /publish              → plain publish SUCCEEDS (no
 *      ?force=1) and serves the REPAIRED snapshot: published files carry
 *      the mock's counter app, pinnedMissing is empty, status GET agrees.
 *
 * A negative leg plants the same incomplete snapshot WITHOUT fixing and
 * proves both routes still refuse it (the fix was the necessary step).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 4611; // 4599/4603/4607 are claimed by sibling wire tests
const MOCK_SCRIPT = path.resolve(process.cwd(), "scripts", "mock-provider.js");

const fetchReal = globalThis.fetch.bind(globalThis);
vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const url =
    typeof input === "object" && input !== null && "url" in input
      ? String((input as Request).url)
      : String(input);
  if (url.includes(`:${PORT}`)) {
    if (typeof input === "string" || input instanceof URL) return fetchReal(url, init);
    return fetchReal(input as Request);
  }
  if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) {
    return fetchReal(input as Request);
  }
  throw new Error(`no network in fix-pin-publish e2e: ${url}`);
});

let tmp: string;
let prevCwd: string;
let procs: Array<ReturnType<typeof spawn>> = [];

function seedProviders() {
  fs.writeFileSync(
    path.join(tmp, "providers.json"),
    JSON.stringify({
      activeProviderId: "mock",
      activeModel: "mock-counter-model",
      providers: [
        {
          id: "mock",
          name: "Mock provider",
          kind: "openai-compatible",
          baseURL: `http://localhost:${PORT}/v1`,
          defaultModel: "mock-counter-model",
          apiKey: "mock-key-arc-1234567890",
          configured: true,
        },
      ],
    }),
  );
}

function startMock(port: number) {
  const proc = spawn(process.execPath, [MOCK_SCRIPT, String(port)], {
    env: { ...process.env, MOCK_WHO: "ARC" },
    stdio: "ignore",
  });
  procs.push(proc);
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const probe = setInterval(async () => {
      try {
        const res = await fetchReal(`http://localhost:${port}/v1/models`);
        if (res.ok) { clearInterval(probe); resolve(); }
      } catch {
        if (Date.now() - started > 8000) { clearInterval(probe); reject(new Error(`mock :${port} never came up`)); }
      }
    }, 100);
  });
}

beforeEach(async () => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-arc-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
  seedProviders();
  await startMock(PORT);
});

afterEach(async () => {
  const exits = procs.map((p) => new Promise<void>((r) => p.once("exit", () => r())));
  procs.forEach((p) => p.kill());
  await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 2000))]);
  procs = [];
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.resetModules();
});

const BROKEN_HTML =
  '<html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Ghost</h1><script src="app.js"></script></body></html>';

async function seedBrokenProject(store: typeof import("@/lib/store"), name: string) {
  const project = store.createProject(name, "")!;
  // A live workspace that must never leak into the fix (or the public page
  // while the pin holds): a marker the mock could never echo back.
  store.saveAppFile(project.id, "index.html", "<p>live-workspace-marker</p>");
  store.recordTurnSnapshot(project.id, "m-arc", [
    { path: "index.html", content: BROKEN_HTML },
    { path: "styles.css", content: "body{}" },
  ]);
  expect(store.snapshotMissingAssets(project.id, "m-arc")).toEqual(["app.js"]);
  return project.id;
}

describe("fix → pin → publish — the full recovery arc (mock provider)", () => {
  it(
    "fix repairs the snapshot; plain pin and plain publish then succeed and the public page serves the repaired app",
    { timeout: 25_000 },
    async () => {
      const store = await import("@/lib/store");
      const { POST: fixPOST } = await import(
        "@/app/api/projects/[projectId]/snapshots/[messageId]/fix/route"
      );
      const { POST: pinPOST } = await import(
        "@/app/api/projects/[projectId]/pin/[messageId]/route"
      );
      const { POST: publishPOST, GET: publishGET } = await import(
        "@/app/api/projects/[projectId]/publish/route"
      );

      const projectId = await seedBrokenProject(store, "Arc");
      const fixCtx = {
        params: Promise.resolve({ projectId, messageId: "m-arc" }),
      } as never;

      // ---- 1. 🛠 FIX: the missing assets are generated into the snapshot.
      const fixed = await fixPOST(
        new Request("http://localhost/api/x", { method: "POST" }) as never,
        fixCtx,
      );
      expect(fixed.status).toBe(200);
      const fixData = await fixed.json();
      expect(fixData.fixed).toEqual(["app.js"]);
      expect(fixData.stillMissing).toEqual([]);
      expect(store.snapshotMissingAssets(projectId, "m-arc")).toEqual([]);

      // The wire: instructions showed the SNAPSHOT's html (Ghost) and the
      // missing file name — never the live workspace's marker.
      const wire = JSON.stringify(
        JSON.parse(
          fs.readFileSync(path.join(tmp, `mock-requests-${PORT}.json`), "utf8"),
        )[0],
      );
      expect(wire).toContain("app.js");
      expect(wire).toContain("<h1>Ghost</h1>");
      expect(wire).not.toContain("live-workspace-marker");

      // Workspace untouched by the fix.
      expect(store.listAppFiles(projectId)).toHaveLength(1);
      expect(store.listAppFiles(projectId)[0].content).toContain(
        "live-workspace-marker",
      );

      // ---- 2. 📌 PIN: the repaired snapshot pins PLAINLY — no force, no
      // 409. This is the assertion that makes the whole arc meaningful:
      // before the fix this exact request refused with missing:[app.js].
      const pinned = await pinPOST(
        new Request("http://localhost/api/x", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }) as never,
        { params: Promise.resolve({ projectId, messageId: "m-arc" }) } as never,
      );
      expect(pinned.status).toBe(200);
      const pinData = await pinned.json();
      expect(pinData.pinnedSnapshot?.messageId).toBe("m-arc");
      // No pinnedWithMissing disclosure — nothing is missing anymore.
      expect(pinData.pinnedWithMissing).toBeUndefined();

      // ---- 3. 🚀 PUBLISH: plain publish (NO ?force=1) succeeds and ships
      // the repaired snapshot to the public folder.
      const published = await publishPOST(
        new Request("http://localhost:3000/api/projects/p1/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }) as never,
        { params: Promise.resolve({ projectId }) } as never,
      );
      expect(published.status).toBe(200);
      const pubData = await published.json();
      expect(pubData.published).toBe(true);
      expect(pubData.pinnedFrom).toBe("m-arc");
      expect(pubData.pinnedMissing).toEqual([]);

      // Status GET mirrors the healthy state for the client's notes.
      const status = await (
        await publishGET(
          new Request("http://localhost:3000/api/projects/p1/publish") as never,
          { params: Promise.resolve({ projectId }) } as never,
        )
      ).json();
      expect(status.published).toBe(true);
      expect(status.pinnedFrom).toBe("m-arc");
      expect(status.pinnedMissing).toEqual([]);
      expect(status.suggest).toBeNull();

      // The public folder serves the REPAIRED snapshot — the mock's counter
      // app (its index.html replaced the Ghost page via the fix merge), not
      // the live workspace's marker.
      expect(store.readPublishedFile(projectId, "index.html")).toContain(
        "Counter",
      );
      expect(store.readPublishedFile(projectId, "app.js")).toContain(
        "getElementById",
      );
      expect(store.readPublishedFile(projectId, "index.html")).not.toContain(
        "live-workspace-marker",
      );
    },
  );

  it("without the fix, the same snapshot still refuses pin and publish (the fix was the necessary step)", async () => {
    const store = await import("@/lib/store");
    const { POST: pinPOST } = await import(
      "@/app/api/projects/[projectId]/pin/[messageId]/route"
    );
    const { POST: publishPOST } = await import(
      "@/app/api/projects/[projectId]/publish/route"
    );

    const projectId = await seedBrokenProject(store, "NoArc");

    // Pin → 409 with the missing list; the single snapshot means NO
    // complete alternative to suggest (null) — the state the fix-pinned
    // recovery button exists for.
    const refusedPin = await pinPOST(
      new Request("http://localhost/api/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }) as never,
      { params: Promise.resolve({ projectId, messageId: "m-arc" }) } as never,
    );
    expect(refusedPin.status).toBe(409);
    const pinWarn = await refusedPin.json();
    expect(pinWarn.missing).toEqual(["app.js"]);
    expect(pinWarn.suggest).toBeNull();

    // Publish under such a pin would 409 too — but even before pinning,
    // the pinned-missing refusal is what the arc's publish leg avoids.
    store.setPinnedSnapshot(projectId, "m-arc");
    const refusedPub = await publishPOST(
      new Request("http://localhost:3000/api/projects/p1/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }) as never,
      { params: Promise.resolve({ projectId }) } as never,
    );
    expect(refusedPub.status).toBe(409);
    expect((await refusedPub.json()).missing).toEqual(["app.js"]);
  });
});
