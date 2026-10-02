// @vitest-environment node
/**
 * Project meta (rename + describe) — the human-edit leg of the metadata
 * lifecycle. Pins the store kernel (THE validator: trim, caps, non-empty
 * name, updatedAt bump, persisted record returned), the route contract
 * (PATCH: 200/400/404, at-least-one-field, type checks, server-normalized
 * value wins), and the full lifecycle round-trip: rename → export → the
 * envelope carries the new identity → import restores it.
 *
 * Hermetic: store re-imported after chdir into a fresh temp cwd. The
 * route is invoked as a plain handler with a real Request (the same
 * pattern as the zip-import round-trip tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-meta-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

async function fresh() {
  const store = await import("../src/lib/store");
  const { PATCH } = await import("../src/app/api/projects/[projectId]/meta/route");
  return { store, PATCH };
}

/** Call the real PATCH handler; body may be a string to force bad JSON. */
async function patch(projectId: string, body: unknown) {
  const { PATCH } = await fresh();
  return PATCH(
    new Request(`http://localhost:3000/api/projects/${projectId}/meta`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ projectId }) } as never,
  );
}

describe("project meta — store kernel (setProjectMeta)", () => {
  it("renames in place: record updated, updatedAt bumped, persisted", async () => {
    const { store } = await fresh();
    const p = store.createProject("Old Name", "old desc");
    const before = p.updatedAt;
    await new Promise((r) => setTimeout(r, 5)); // ensure the timestamp moves

    const updated = store.setProjectMeta(p.id, { name: "  New Name  " });
    expect(updated.name).toBe("New Name"); // trimmed
    expect(updated.description).toBe("old desc"); // untouched
    expect(updated.id).toBe(p.id);
    expect(updated.updatedAt).not.toBe(before);

    // Persisted: a fresh read sees the new name.
    expect(store.getProject(p.id)?.name).toBe("New Name");
    const onDisk = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "projects-data", p.id, "project.json"),
        "utf8",
      ),
    );
    expect(onDisk.name).toBe("New Name");
    expect(onDisk.id).toBe(p.id); // identity never changes
  });

  it("describes in place and normalizes description; empty description allowed", async () => {
    const { store } = await fresh();
    const p = store.createProject("App", "  spaced  ");
    const updated = store.setProjectMeta(p.id, { description: "  new desc  " });
    expect(updated.description).toBe("new desc");
    expect(updated.name).toBe("App");

    const cleared = store.setProjectMeta(p.id, { description: "   " });
    expect(cleared.description).toBe(""); // empty is fine for description
    expect(cleared.name).toBe("App");
  });

  it("tags in place: split, per-tag trim, empties dropped, comma-space join", async () => {
    const { store } = await fresh();
    const p = store.createProject("App", "");
    const before = p.updatedAt;
    await new Promise((r) => setTimeout(r, 5)); // ensure the timestamp moves

    const updated = store.setProjectMeta(p.id, { tags: "  recipes ,  , fast ,, vegan  " });
    expect(updated.tags).toBe("recipes, fast, vegan");
    expect(updated.updatedAt).not.toBe(before); // a tag edit is a meta edit

    // Persisted: a fresh read sees the tags.
    const onDisk = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "projects-data", p.id, "project.json"),
        "utf8",
      ),
    );
    expect(onDisk.tags).toBe("recipes, fast, vegan");
  });

  it("clearing tags removes the field entirely; separators-only tags nothing", async () => {
    const { store } = await fresh();
    const p = store.createProject("App", "");
    store.setProjectMeta(p.id, { tags: "a, b" });
    expect(store.getProject(p.id)?.tags).toBe("a, b");

    // All-separator input normalizes to nothing: the field disappears
    // instead of lingering as an empty string.
    const cleared = store.setProjectMeta(p.id, { tags: " , ,,  " });
    expect(cleared.tags).toBeUndefined();
    expect(JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "projects-data", p.id, "project.json"),
        "utf8",
      ),
    )).not.toHaveProperty("tags");
  });

  it("caps tags at META_TAGS_MAX (server normalization wins over the draft)", async () => {
    const { store } = await fresh();
    const p = store.createProject("App", "");
    const long = store.setProjectMeta(p.id, { tags: `  ${"t".repeat(200)}  ` });
    expect(long.tags!.length).toBe(store.META_TAGS_MAX);
  });

  it("sets a status from the enum; rejects anything else; persists", async () => {
    const { store } = await fresh();
    const p = store.createProject("App", "");
    await new Promise((r) => setTimeout(r, 5)); // ensure the timestamp moves (CI runners are fast)
    const updated = store.setProjectMeta(p.id, { status: "  shipped  " });
    expect(updated.status).toBe("shipped");
    expect(updated.updatedAt).not.toBe(p.updatedAt); // a status edit is a meta edit

    // Persisted: a fresh read sees the status.
    expect(store.getProject(p.id)?.status).toBe("shipped");

    // Every enum value is accepted.
    for (const s of store.PROJECT_STATUSES) {
      expect(store.setProjectMeta(p.id, { status: s }).status).toBe(s);
    }
    // Enum-violations throw (case included — the enum is lowercase).
    // (A padded valid value like " building " does NOT throw: the store
    // trims first, consistent with every other meta field.)
    for (const bad of ["Shipped", "SHIPPED", "done"]) {
      expect(() => store.setProjectMeta(p.id, { status: bad })).toThrow(
        /invalid status/i,
      );
    }
    // Nothing changed by the rejected writes (last accepted = loop's final).
    expect(store.getProject(p.id)?.status).toBe("shipped");

    // The empty string is NOT an enum violation — it CLEARS the status
    // (same contract as tags; the card select's "No status" option is a
    // real destination, and the board renders it as a column).
    const cleared = store.setProjectMeta(p.id, { status: "" });
    expect(cleared.status).toBeUndefined();
    expect(store.getProject(p.id)?.status).toBeUndefined();
    // Re-set after a clear still works.
    expect(store.setProjectMeta(p.id, { status: "idea" }).status).toBe("idea");
    // Whitespace-only counts as empty after the store's trim — clearing,
    // not throwing, consistent with every other meta field.
    expect(store.setProjectMeta(p.id, { status: "   " }).status).toBeUndefined();
  });

  it("rejects an empty name and unknown projects; caps overlong values", async () => {
    const { store } = await fresh();
    const p = store.createProject("App", "");
    expect(() => store.setProjectMeta(p.id, { name: "   " })).toThrow(/empty/i);
    expect(() => store.setProjectMeta(p.id, { name: "" })).toThrow(/empty/i);
    expect(() => store.setProjectMeta("nope-missing", { name: "X" })).toThrow(
      /not found/i,
    );
    // Caps: 100 chars in, META_NAME_MAX out (description likewise).
    const long = store.setProjectMeta(p.id, { name: "x".repeat(100) });
    expect(long.name.length).toBe(store.META_NAME_MAX);
    const longDesc = store.setProjectMeta(p.id, { description: "d".repeat(600) });
    expect(longDesc.description.length).toBe(store.META_DESCRIPTION_MAX);
    // Neither field: a no-op that still persists (and bumps updatedAt).
    await new Promise((r) => setTimeout(r, 5));
    const same = store.setProjectMeta(p.id, {});
    expect(same.name).toBe("x".repeat(store.META_NAME_MAX));
  });

  it("renamed projects stay listable and sortable by updatedAt", async () => {
    const { store } = await fresh();
    const a = store.createProject("A", "");
    const b = store.createProject("B", "");
    await new Promise((r) => setTimeout(r, 5));
    store.setProjectMeta(a.id, { name: "A2" }); // bump A to newest
    const listed = store.listProjects();
    expect(listed[0].id).toBe(a.id);
    expect(listed[0].name).toBe("A2");
    expect(listed.map((x: { id: string }) => x.id)).toContain(b.id);
  });
});

describe("project meta — PATCH route contract", () => {
  it("200: renames and echoes the normalized, persisted record", async () => {
    const { store } = await fresh();
    const p = store.createProject("Old", "");
    const res = await patch(p.id, { name: "  Renamed  " });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project.name).toBe("Renamed");
    expect(data.project.id).toBe(p.id);
    expect(store.getProject(p.id)?.name).toBe("Renamed");
  });

  it("200: description-only update keeps the name", async () => {
    const { store } = await fresh();
    const p = store.createProject("App", "old");
    const res = await patch(p.id, { description: "new" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project.name).toBe("App");
    expect(data.project.description).toBe("new");
    expect(store.getProject(p.id)?.description).toBe("new");
  });

  it("400: bad JSON, empty patch, wrong types, empty name", async () => {
    const { store } = await fresh();
    const p = store.createProject("App", "");
    expect((await patch(p.id, "{not json")).status).toBe(400);
    expect((await patch(p.id, {})).status).toBe(400);
    expect((await patch(p.id, { name: 42 })).status).toBe(400);
    expect((await patch(p.id, { description: true })).status).toBe(400);
    expect((await patch(p.id, { tags: ["a", "b"] })).status).toBe(400);
    expect((await patch(p.id, { status: 7 })).status).toBe(400);
    expect((await patch(p.id, { status: "done" })).status).toBe(400);
    expect((await patch(p.id, { name: "   " })).status).toBe(400);
    // Nothing was written by any of those.
    expect(store.getProject(p.id)?.name).toBe("App");
  });

  it("200: tags-only update keeps the name and stores the normalized string", async () => {
    const { store } = await fresh();
    const p = store.createProject("App", "old");
    const res = await patch(p.id, { tags: " x ,, y " });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project.name).toBe("App");
    expect(data.project.tags).toBe("x, y");
    expect(store.getProject(p.id)?.tags).toBe("x, y");
  });

  it("200: status-only update; unknown projects stay 404", async () => {
    const { store } = await fresh();
    const p = store.createProject("App", "");
    const res = await patch(p.id, { status: "building" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project.status).toBe("building");
    expect(data.project.name).toBe("App");
    expect(store.getProject(p.id)?.status).toBe("building");
    expect((await patch("ghost-project", { status: "idea" })).status).toBe(404);
  });

  it("404: unknown project — and nothing is created by PATCHing it", async () => {
    const res = await patch("ghost-project", { name: "X" });
    expect(res.status).toBe(404);
    const { store } = await fresh();
    expect(fs.existsSync(path.join(process.cwd(), "projects-data", "ghost-project"))).toBe(false);
  });

  it("server normalization wins over the client's draft (cap + trim)", async () => {
    const { store } = await fresh();
    const p = store.createProject("App", "");
    const res = await patch(p.id, { name: `  ${"y".repeat(120)}  ` });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project.name).toBe("y".repeat(store.META_NAME_MAX));
  });
});

describe("project meta — metadata lifecycle round-trip", () => {
  it("rename → export → envelope carries the new identity → import restores it", async () => {
    const { store } = await fresh();
    const { GET } = await import(
      "../src/app/api/projects/[projectId]/download/route"
    );
    const zipImport = await import("../src/lib/zip-import");

    const original = store.createProject("First Draft", "v1 wording");
    store.saveAppFile(original.id, "index.html", "<h1>hello</h1>");

    // Export BEFORE the rename: envelope says "First Draft".
    const res1 = await GET(
      new Request(`http://localhost:3000/api/projects/${original.id}/download`) as never,
      { params: Promise.resolve({ projectId: original.id }) } as never,
    );
    const export1 = Buffer.from(await res1.arrayBuffer());

    // Rename through the REAL route — tags and status ride the same patch.
    const res2 = await patch(original.id, {
      name: "Renamed App",
      description: "v2 wording",
      tags: "pinned, round-trip",
      status: "shipped",
    });
    expect(res2.status).toBe(200);

    // Export AFTER the rename: the envelope carries the NEW identity.
    const res3 = await GET(
      new Request(`http://localhost:3000/api/projects/${original.id}/download`) as never,
      { params: Promise.resolve({ projectId: original.id }) } as never,
    );
    const export2 = Buffer.from(await res3.arrayBuffer());

    const import1 = await zipImport.importProjectFromZip(export1);
    const import2 = await zipImport.importProjectFromZip(export2);
    expect(import1.project.name).toBe("First Draft");
    expect(import1.project.description).toBe("v1 wording");
    expect(import2.project.name).toBe("Renamed App");
    expect(import2.project.description).toBe("v2 wording");
    // Tags + status survive the envelope round-trip in the store's shape.
    expect(import2.project.tags).toBe("pinned, round-trip");
    expect(store.getProject(import2.project.id)?.tags).toBe("pinned, round-trip");
    expect(import2.project.status).toBe("shipped");
    expect(store.getProject(import2.project.id)?.status).toBe("shipped");
    // Fresh ids, original files intact.
    expect(import2.project.id).not.toBe(original.id);
    expect(store.readAppFile(import2.project.id, "index.html")).toContain("hello");
  });
});
