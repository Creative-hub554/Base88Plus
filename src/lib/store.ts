import fs from "node:fs";
import path from "node:path";
import type {
  BuilderUIMessage,
  CustomDomain,
  DeployInfo,
  DeployVersion,
  Project,
  ProjectFile,
  PublishManifest,
} from "./types";

const ROOT = path.join(process.cwd(), "projects-data");

function safeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export function projectDir(id: string): string {
  if (!safeId(id)) throw new Error("Invalid project id");
  return path.join(ROOT, id);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function createProject(
  name: string,
  description: string,
  meta?: { template?: Project["template"]; id?: string },
): Project {
  // Template-library projects use fixed ids (tpl-<template>); user apps get
  // a timestamp-based id.
  const id = meta?.id ?? Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  ensureDir(projectDir(id));
  const project: Project = {
    id,
    name,
    description,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (meta?.template) project.template = meta.template;
  fs.writeFileSync(
    path.join(projectDir(id), "project.json"),
    JSON.stringify(project, null, 2),
  );
  return project;
}

/** Persist a project record (create or update). */
export function saveProject(project: Project): Project {
  ensureDir(projectDir(project.id));
  fs.writeFileSync(
    path.join(projectDir(project.id), "project.json"),
    JSON.stringify(project, null, 2),
  );
  return project;
}

export function getProject(id: string): Project | null {
  try {
    const raw = fs.readFileSync(
      path.join(projectDir(id), "project.json"),
      "utf8",
    );
    return JSON.parse(raw) as Project;
  } catch {
    return null;
  }
}

export function touchProject(id: string) {
  const p = getProject(id);
  if (!p) return;
  p.updatedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(projectDir(id), "project.json"),
    JSON.stringify(p, null, 2),
  );
}

export function listProjects(): Project[] {
  if (!fs.existsSync(ROOT)) return [];
  return fs
    .readdirSync(ROOT)
    .filter((d) => safeId(d) && fs.existsSync(path.join(ROOT, d, "project.json")))
    .map((d) => getProject(d)!)
    .filter((p) => !p.template) // template-library projects are not user apps
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteProject(id: string) {
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Publishing — one-click public URL (Base44-style snapshot semantics)
// ---------------------------------------------------------------------------

const PUBLISH_DIR = "published";
const MANIFEST = "publish.json";

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || "app";
}

function isPublished(projectDirName: string, slug: string): boolean {
  try {
    const m = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, projectDirName, PUBLISH_DIR, MANIFEST),
        "utf8",
      ),
    ) as PublishManifest;
    return m?.slug === slug;
  } catch {
    return false;
  }
}

/** True if `slug` is in use by a different project. */
export function slugTakenByOther(slug: string, projectId: string): boolean {
  if (!fs.existsSync(ROOT)) return false;
  for (const d of fs.readdirSync(ROOT)) {
    if (!safeId(d) || d === projectId) continue;
    if (isPublished(d, slug)) return true;
  }
  return false;
}

/**
 * Slug collision policy: generated slugs auto-suffix (-2, -3…);
 * explicitly-requested custom slugs are refused with 409 by the API.
 */
export function autoSlug(base: string, projectId: string): string {
  if (!slugTakenByOther(base, projectId)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!slugTakenByOther(candidate, projectId)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function publishedDir(projectId: string): string {
  return path.join(projectDir(projectId), PUBLISH_DIR);
}

export function getPublishManifest(projectId: string): PublishManifest | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(publishedDir(projectId), MANIFEST), "utf8"),
    ) as PublishManifest;
  } catch {
    return null;
  }
}

function writeManifest(projectId: string, manifest: PublishManifest) {
  ensureDir(publishedDir(projectId));
  fs.writeFileSync(
    path.join(publishedDir(projectId), MANIFEST),
    JSON.stringify(manifest, null, 2),
  );
}

/**
 * Snapshot the project's app files into published/ and record the
 * manifest. When the project has a PINNED best version (a turn snapshot),
 * the public page ships THAT snapshot's files — independent of the live
 * workspace — and the manifest records `pinnedFrom`. Later workspace edits
 * don't go live until the next publish either way.
 */
export function publishProject(
  projectId: string,
  slug: string,
): PublishManifest {
  const dir = publishedDir(projectId);
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const pin = getProject(projectId)?.pinnedSnapshot;
  let source: ProjectFile[] | null = null;
  if (pin?.messageId) {
    source = turnSnapshotFilesById(projectId, pin.messageId);
  }
  let files: string[] = [];
  for (const f of source ?? listAppFiles(projectId)) {
    const abs = path.resolve(dir, f.path);
    if (!abs.startsWith(path.resolve(dir))) continue;
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, f.content, "utf8");
    files.push(f.path);
  }
  const manifest: PublishManifest = {
    slug,
    publishedAt: new Date().toISOString(),
    files,
    ...(source ? { pinnedFrom: pin!.messageId } : {}),
  };
  writeManifest(projectId, manifest);
  return manifest;
}

export function unpublishProject(projectId: string) {
  fs.rmSync(publishedDir(projectId), { recursive: true, force: true });
}

/** Record/refresh the last Cloudflare deploy info on a project. */
export function setProjectDeployment(projectId: string, deployment: DeployInfo) {
  const p = getProject(projectId);
  if (!p) return;
  p.deployment = deployment;
  fs.writeFileSync(
    path.join(projectDir(projectId), "project.json"),
    JSON.stringify(p, null, 2),
  );
}

/**
 * Per-project model pin. `undefined` clears the override so the project
 * uses the global default again.
 */
export function setProjectModelOverride(
  projectId: string,
  override: { providerId: string; modelId: string } | undefined,
) {
  const p = getProject(projectId);
  if (!p) throw new Error("Project not found");
  if (override) p.modelOverride = override;
  else delete p.modelOverride;
  fs.writeFileSync(
    path.join(projectDir(projectId), "project.json"),
    JSON.stringify(p, null, 2),
  );
}

/** Replace the project's custom-domain list. */
export function setProjectCustomDomains(
  projectId: string,
  domains: CustomDomain[],
) {
  const p = getProject(projectId);
  if (!p) throw new Error("Project not found");
  p.customDomains = domains.length > 0 ? domains : undefined;
  fs.writeFileSync(
    path.join(projectDir(projectId), "project.json"),
    JSON.stringify(p, null, 2),
  );
}

/** Mark a project as a template-library build (or clear with undefined). */
export function setProjectTemplate(
  projectId: string,
  template: Project["template"],
) {
  const p = getProject(projectId);
  if (!p) throw new Error("Project not found");
  if (template) p.template = template;
  else delete p.template;
  fs.writeFileSync(
    path.join(projectDir(projectId), "project.json"),
    JSON.stringify(p, null, 2),
  );
}

/** Record that a project was created by promoting a cached template demo. */
export function setProjectFromTemplate(
  projectId: string,
  from: Project["fromTemplate"],
) {
  const p = getProject(projectId);
  if (!p) throw new Error("Project not found");
  if (from) p.fromTemplate = from;
  else delete p.fromTemplate;
  fs.writeFileSync(
    path.join(projectDir(projectId), "project.json"),
    JSON.stringify(p, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Deploy versioning — last N Cloudflare deploys, viewable and restorable
// ---------------------------------------------------------------------------

const DEPLOYMENTS_FILE = "deployments.json";
const DEPLOY_VERSIONS_DIR = "deploy-versions";
export const DEPLOY_VERSION_CAP = 5;

interface StoredDeployVersion extends DeployVersion {
  /** Folder under deploy-versions/ holding this version's file copies. */
  dir: string;
}

interface DeploymentsFile {
  nextVersion: number;
  versions: StoredDeployVersion[];
}

function deploymentsPath(projectId: string): string {
  return path.join(projectDir(projectId), DEPLOYMENTS_FILE);
}

function readDeployments(projectId: string): DeploymentsFile {
  try {
    const raw = JSON.parse(
      fs.readFileSync(deploymentsPath(projectId), "utf8"),
    ) as (DeploymentsFile & { versions: StoredDeployVersion[] });
    if (!Array.isArray(raw.versions)) throw new Error("bad shape");
    return { nextVersion: raw.nextVersion ?? 1, versions: raw.versions };
  } catch {
    return { nextVersion: 1, versions: [] };
  }
}

function writeDeployments(projectId: string, data: DeploymentsFile) {
  ensureDir(projectDir(projectId));
  fs.writeFileSync(deploymentsPath(projectId), JSON.stringify(data, null, 2));
}

function deployVersionsDir(projectId: string): string {
  return path.join(projectDir(projectId), DEPLOY_VERSIONS_DIR);
}

function versionDir(projectId: string, version: number): string {
  return path.join(deployVersionsDir(projectId), String(version));
}

// ---------------------------------------------------------------------------
// Turn snapshots — per-generation workspace undo (Base44-style time machine)
// ---------------------------------------------------------------------------

const TURN_SNAPSHOTS_DIR = "turn-snapshots";
export const TURN_SNAPSHOT_CAP = 10;

/**
 * What restoring this snapshot would change vs the live workspace
 * (hover diff on the Restore buttons).
 */
export interface TurnSnapshotDiff {
  messageId: string;
  added: string[];
  removed: string[];
  modified: string[];
}

export interface TurnSnapshot {
  /** Assistant message id of the turn that produced this state. */
  messageId: string;
  savedAt: string;
  files: string[];
}

interface TurnSnapshotEntry extends TurnSnapshot {
  dir: string;
}

interface TurnSnapshotsFile {
  snapshots: TurnSnapshotEntry[];
}

function turnSnapshotsDir(projectId: string): string {
  return path.join(projectDir(projectId), TURN_SNAPSHOTS_DIR);
}

function readTurnSnapshots(projectId: string): TurnSnapshotEntry[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(projectDir(projectId), "turn-snapshots.json"),
        "utf8",
      ),
    ) as TurnSnapshotsFile;
    if (!Array.isArray(raw.snapshots)) throw new Error("bad shape");
    return raw.snapshots;
  } catch {
    return [];
  }
}

function writeTurnSnapshots(projectId: string, entries: TurnSnapshotEntry[]) {
  ensureDir(projectDir(projectId));
  fs.writeFileSync(
    path.join(projectDir(projectId), "turn-snapshots.json"),
    JSON.stringify({ snapshots: entries } satisfies TurnSnapshotsFile, null, 2),
  );
}

/**
 * Persist the workspace state produced by a generation turn. Called from
 * the chat route's onEnd AFTER the turn's files are final; powers the
 * per-turn Restore button in the chat.
 */
export function recordTurnSnapshot(
  projectId: string,
  messageId: string,
  files: ProjectFile[],
): TurnSnapshot {
  const dir = path.join(turnSnapshotsDir(projectId), messageId);
  ensureDir(dir);
  for (const f of files) {
    const abs = path.resolve(dir, f.path);
    if (!abs.startsWith(path.resolve(dir))) continue;
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, f.content, "utf8");
  }
  const entry: TurnSnapshotEntry = {
    messageId,
    savedAt: new Date().toISOString(),
    files: files.map((f) => f.path),
    dir: messageId,
  };
  // Newest first, deduped by messageId (a Continue/regenerate replaces its
  // predecessor's snapshot), pruned beyond the cap.
  const rest = readTurnSnapshots(projectId).filter(
    (e) => e.messageId !== messageId,
  );
  const combined = [entry, ...rest];
  const kept = combined.slice(0, TURN_SNAPSHOT_CAP);
  // Prune from the combined list's tail: exactly the entries that fall
  // outside the cap. (The old loop sliced a re-read of the manifest —
  // which never exceeds the cap — so its body was dead code and evicted
  // snapshot directories leaked on disk forever.)
  for (const old of combined.slice(TURN_SNAPSHOT_CAP)) {
    fs.rmSync(path.join(turnSnapshotsDir(projectId), old.dir), {
      recursive: true,
      force: true,
    });
  }
  // Disk↔manifest reconciliation: sweep orphan snapshot dirs the manifest
  // doesn't list (a crash between the dir write and the manifest write, or
  // residue from the dead-prune era) — the manifest-driven prune can never
  // remove what the manifest doesn't know about.
  const keptIds = new Set(kept.map((k) => k.messageId));
  const snapshotsRoot = turnSnapshotsDir(projectId);
  if (fs.existsSync(snapshotsRoot)) {
    for (const name of fs.readdirSync(snapshotsRoot)) {
      if (!keptIds.has(name)) {
        fs.rmSync(path.join(snapshotsRoot, name), {
          recursive: true,
          force: true,
        });
      }
    }
  }
  writeTurnSnapshots(projectId, kept);
  const { dir: _drop, ...pub } = entry;
  return pub;
}

/** Snapshot summaries for the UI, newest first (no dir internals). */
export function listTurnSnapshots(projectId: string): TurnSnapshot[] {
  return readTurnSnapshots(projectId).map(({ dir: _drop, ...rest }) => rest);
}

/**
 * Restore the workspace to a turn's snapshot. Returns null when the
 * snapshot (or its folder) no longer exists. Current files NOT in the
 * snapshot are removed — this is a true point-in-time restore.
 */
/** Read all files in a snapshot folder, paths relative to the snapshot root. */
function readSnapshotDirFiles(dir: string): ProjectFile[] {
  const files: ProjectFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else
        files.push({
          path: path.relative(dir, full).split(path.sep).join("/"),
          content: fs.readFileSync(full, "utf8"),
        });
    }
  };
  walk(dir);
  return files;
}

export function restoreTurnSnapshot(
  projectId: string,
  messageId: string,
): TurnSnapshot | null {
  const entry = readTurnSnapshots(projectId).find(
    (e) => e.messageId === messageId,
  );
  if (!entry) return null;
  const dir = path.join(turnSnapshotsDir(projectId), entry.dir);
  if (!fs.existsSync(dir)) return null;
  restoreWorkspace(projectId, readSnapshotDirFiles(dir));
  // Workspace now equals this snapshot — a pin on it is moot; drop it so
  // "published version" and "live workspace" agree again.
  if (getProject(projectId)?.pinnedSnapshot?.messageId === messageId) {
    clearPinnedSnapshot(projectId);
  }
  const { dir: _drop, ...pub } = entry;
  return pub;
}

/**
 * Mark a turn snapshot as the project's PINNED best version: publishing
 * ships that snapshot's files (independent of the live workspace) until
 * the pin is cleared. Returns the updated project, or null when the
 * snapshot doesn't exist. Restoring the pinned version into the workspace
 * clears the pin (workspace and public page agree again).
 */
export function setPinnedSnapshot(
  projectId: string,
  messageId: string,
): Project | null {
  const project = getProject(projectId);
  if (!project) return null;
  if (!turnSnapshotFilesById(projectId, messageId)) return null;
  project.pinnedSnapshot = { messageId, pinnedAt: new Date().toISOString() };
  return saveProject(project);
}

/** Remove the pinned-version marker; publishing returns to the live workspace. */
export function clearPinnedSnapshot(projectId: string): Project | null {
  const project = getProject(projectId);
  if (!project) return null;
  if (!project.pinnedSnapshot) return project;
  delete project.pinnedSnapshot;
  return saveProject(project);
}

/**
 * Read one file from a turn snapshot (serves the history panel's live
 * thumbnails). Traversal-safe; null when the snapshot or file is gone.
 */
export function readTurnSnapshotFile(
  projectId: string,
  messageId: string,
  filePath: string,
): string | null {
  const entry = readTurnSnapshots(projectId).find(
    (e) => e.messageId === messageId,
  );
  if (!entry) return null;
  const dir = path.join(turnSnapshotsDir(projectId), entry.dir);
  const normalized = path.normalize(filePath).replace(/^([/\\])+/, "");
  const abs = path.resolve(dir, normalized);
  if (!abs.startsWith(path.resolve(dir) + path.sep)) return null;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read all files of a turn snapshot by message id, or null when the
 * snapshot is gone (unknown id or pruned).
 */
function turnSnapshotFilesById(
  projectId: string,
  messageId: string,
): ProjectFile[] | null {
  const entry = readTurnSnapshots(projectId).find(
    (e) => e.messageId === messageId,
  );
  if (!entry) return null;
  const dir = path.join(turnSnapshotsDir(projectId), entry.dir);
  if (!fs.existsSync(dir)) return null;
  return readSnapshotDirFiles(dir);
}

/**
 * Fork a turn snapshot into a NEW project ("restore as copy"): the source
 * project, its workspace, and its history stay untouched; the fork starts
 * life with the snapshot's files as its workspace. Returns the new
 * project, or null when the snapshot no longer exists.
 */
export function forkTurnSnapshot(
  projectId: string,
  messageId: string,
  name?: string,
): Project | null {
  const entry = readTurnSnapshots(projectId).find(
    (e) => e.messageId === messageId,
  );
  if (!entry) return null;
  const dir = path.join(turnSnapshotsDir(projectId), entry.dir);
  if (!fs.existsSync(dir)) return null;
  const files = readSnapshotDirFiles(dir);
  const source = getProject(projectId);
  const fork = createProject(
    name ?? (source ? `${source.name} (copy)` : "Forked app"),
    `Forked from ${projectId} · turn ${messageId}`,
  );
  for (const f of files) {
    saveAppFile(fork.id, f.path, f.content);
  }
  return fork;
}

/**
 * What restoring this snapshot would change vs the CURRENT workspace: files
 * the restore would ADD (exist in snapshot only), REMOVE (exist in the
 * workspace only), or MODIFY (exist in both with different content).
 * Powers the hover diff summary on the chat's Restore buttons.
 */
export function turnSnapshotDiff(
  projectId: string,
  messageId: string,
): TurnSnapshotDiff | null {
  const entry = readTurnSnapshots(projectId).find(
    (e) => e.messageId === messageId,
  );
  if (!entry) return null;
  const dir = path.join(turnSnapshotsDir(projectId), entry.dir);
  if (!fs.existsSync(dir)) return null;
  const snap = readSnapshotDirFiles(dir);
  const current = listAppFiles(projectId);
  const snapPaths = new Set(snap.map((f) => f.path));
  const currentByPath = new Map(current.map((f) => [f.path, f.content]));
  const added: string[] = [];
  const modified: string[] = [];
  for (const f of snap) {
    const c = currentByPath.get(f.path);
    if (c === undefined) added.push(f.path);
    else if (c !== f.content) modified.push(f.path);
  }
  const removed = current
    .map((f) => f.path)
    .filter((p) => !snapPaths.has(p));
  const sort = (a: string[]) => [...a].sort();
  return { messageId, added: sort(added), removed: sort(removed), modified: sort(modified) };
}

/**
 * Assets a snapshot references but doesn't contain (e.g. the known
 * small-model quirk of emitting an <app.js> script tag without the
 * file). Sources: HTML src/href attributes AND CSS @import / url()
 * references — a snapshot whose stylesheet @imports a missing fonts.css
 * is just as broken on the public page. Absolute/external URLs,
 * data: URIs, and fragments are ignored. Empty when the snapshot is
 * gone or fully self-contained.
 */
export function snapshotMissingAssets(projectId: string, messageId: string): string[] {
  const files = turnSnapshotFilesById(projectId, messageId);
  if (!files) return [];
  return missingAssetPaths(scanAssetRefs(files), files.map((f) => f.path));
}

/** A local asset reference found in workspace/snapshot files. */
export interface AssetRef {
  /** Normalized path as it would exist in the project root. */
  path: string;
  /** The file the reference appears in. */
  from: string;
  /** 1-based line number in `from` (for code-view highlights). */
  line: number;
}

/** 1-based line number of a character index within `content`. */
function lineOfIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Scan files for local asset references (HTML src/href, CSS @import and
 * url()). Scans whole-file content with match indexes (not per-line) so
 * the regexes behave identically however the content is laid out, and
 * derives the line number from each match index.
 */
function scanAssetRefs(files: ProjectFile[]): AssetRef[] {
  const refs: AssetRef[] = [];
  const seen = new Set<string>();
  const push = (raw: string, from: string, line: number) => {
    let p = raw.trim().replace(/^["']|["']$/g, "");
    if (
      !p ||
      p.startsWith("#") ||
      p.startsWith("//") ||
      /^(https?:|data:|mailto:|tel:|blob:)/i.test(p)
    ) {
      return;
    }
    p = p.replace(/^\.?\//, "");
    // CSS url() captures keep query strings (logo.png?v=2) — strip them so
    // presence checks compare bare paths, matching the HTML regex.
    p = p.split(/[?#]/)[0];
    if (!p) return;
    const key = `${from}\n${line}\n${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ path: p, from, line });
  };

  for (const f of files) {
    const patterns: RegExp[] = [];
    if (f.path.endsWith(".html")) {
      patterns.push(/(?:src|href)\s*=\s*["']([^"'#?]+)(?:[?#][^"']*)?["']/gi);
    } else if (f.path.endsWith(".css")) {
      // @import "file.css" / @import url(file.css) / @import url("file.css")
      patterns.push(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi);
      // url(foo.png) / url('foo.png') / url("foo.png") — images and fonts.
      patterns.push(/url\(\s*["']?([^"')]+)/gi);
    }
    for (const re of patterns) {
      for (const m of f.content.matchAll(re)) {
        push(m[1], f.path, lineOfIndex(f.content, m.index ?? 0));
      }
    }
  }
  return refs;
}

function missingAssetPaths(refs: AssetRef[], presentPaths: string[]): string[] {
  const present = new Set(presentPaths);
  return [...new Set(refs.map((r) => r.path))]
    .filter((p) => !present.has(p))
    .sort();
}

/**
 * Missing-asset references in the LIVE workspace, with file + line — the
 * data the code view needs to highlight exactly which lines reference
 * files that don't exist (the known small-model quirk: HTML referencing
 * a script it never emitted). Sorted by file, then line.
 */
export function workspaceMissingRefs(projectId: string): AssetRef[] {
  const files = listAppFiles(projectId);
  const present = new Set(files.map((f) => f.path));
  return scanAssetRefs(files)
    .filter((r) => !present.has(r.path))
    .sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.line - b.line ||
        a.path.localeCompare(b.path),
    );
}

/**
 * The most recent snapshot that is self-contained (no missing assets) —
 * offered as the one-click "switch instead" target when a pin or publish
 * is refused because the requested snapshot would ship 404s. Newest first
 * by savedAt; null when no complete snapshot exists.
 */
export function mostRecentCompleteSnapshot(projectId: string): string | null {
  const complete = readTurnSnapshots(projectId)
    .filter((s) => snapshotMissingAssets(projectId, s.messageId).length === 0)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return complete[0]?.messageId ?? null;
}

/**
 * Record a successful deploy as a new version: copy the exact files that
 * were pushed, prune beyond the cap (oldest first), return the version.
 */
export function recordDeployVersion(
  projectId: string,
  files: ProjectFile[],
  meta: { url: string; slug: string; deployedAt: string },
): DeployVersion {
  const data = readDeployments(projectId);
  const version = data.nextVersion;
  const dir = versionDir(projectId, version);
  ensureDir(dir);
  for (const f of files) {
    const abs = path.resolve(dir, f.path);
    if (!abs.startsWith(path.resolve(dir))) continue;
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, f.content, "utf8");
  }
  const entry: StoredDeployVersion = {
    version,
    deployedAt: meta.deployedAt,
    files: files.map((f) => f.path),
    url: meta.url,
    slug: meta.slug,
    dir: path.basename(dir),
  };
  const combined = [entry, ...data.versions];
  const kept = combined.slice(0, DEPLOY_VERSION_CAP);
  // Disk↔manifest reconciliation: delete every numeric version dir the
  // kept manifest doesn't list — evicted versions AND orphans from a crash
  // between the version-dir write and the manifest write (the same leak
  // class the turn-snapshot prune had: manifest-driven deletion can never
  // remove a dir the manifest doesn't know about).
  const keptDirs = new Set(kept.map((v) => v.dir));
  const versionsRoot = deployVersionsDir(projectId);
  if (fs.existsSync(versionsRoot)) {
    for (const name of fs.readdirSync(versionsRoot)) {
      if (/^\d+$/.test(name) && !keptDirs.has(name)) {
        fs.rmSync(path.join(versionsRoot, name), {
          recursive: true,
          force: true,
        });
      }
    }
  }
  writeDeployments(projectId, {
    nextVersion: version + 1,
    versions: kept,
  });
  const { dir: _drop, ...publicEntry } = entry;
  return publicEntry;
}

/** Version summaries for the UI (no dir internals), newest first. */
export function listDeployVersions(projectId: string): DeployVersion[] {
  return readDeployments(projectId).versions.map(
    ({ dir: _drop, ...rest }) => rest,
  );
}

export function getDeployVersion(
  projectId: string,
  version: number,
): DeployVersion | null {
  const found = readDeployments(projectId).versions.find(
    (v) => v.version === version,
  );
  if (!found) return null;
  const { dir: _drop, ...rest } = found;
  return rest;
}

/** Read a file from a stored deploy version. Path traversal-safe. */
export function readDeployVersionFile(
  projectId: string,
  version: number,
  filePath: string,
): string | null {
  const normalized = path.normalize(filePath).replace(/^([/\\])+/, "");
  const base = path.resolve(versionDir(projectId, version));
  const abs = path.resolve(base, normalized);
  if (!abs.startsWith(base)) return null;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * Roll back to a past version: its files replace the workspace (extraneous
 * files are removed), then the publish snapshot is re-cut from them.
 * Returns the restored file set for the caller to redeploy.
 */
export function restoreDeployVersion(
  projectId: string,
  version: number,
): { files: ProjectFile[]; version: DeployVersion } | null {
  const stored = readDeployments(projectId).versions.find(
    (v) => v.version === version,
  );
  if (!stored) return null;
  const files: ProjectFile[] = [];
  for (const p of stored.files) {
    const content = readDeployVersionFile(projectId, version, p);
    if (content !== null) files.push({ path: p, content });
  }
  if (files.length === 0) return null;

  // Workspace ← version state (remove files that aren't part of it).
  const keep = new Set(files.map((f) => f.path));
  for (const current of listAppFiles(projectId)) {
    if (!keep.has(current.path)) deleteAppFile(projectId, current.path);
  }
  for (const f of files) {
    saveAppFile(projectId, f.path, f.content);
  }
  // Re-cut the public snapshot from the restored workspace.
  publishProject(projectId, stored.slug);
  return { files, version: stored };
}

/** Look up a published project by its public slug. */
export function findPublishedProject(slug: string): {
  projectId: string;
  manifest: PublishManifest;
} | null {
  if (!fs.existsSync(ROOT)) return null;
  for (const d of fs.readdirSync(ROOT)) {
    if (!safeId(d)) continue;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(ROOT, d, PUBLISH_DIR, MANIFEST), "utf8"),
      ) as PublishManifest;
      if (manifest?.slug === slug) return { projectId: d, manifest };
    } catch {
      // not published
    }
  }
  return null;
}

/**
 * Read a file from a project's published snapshot. Path traversal-safe.
 */
export function readPublishedFile(
  projectId: string,
  filePath: string,
): string | null {
  const normalized = path.normalize(filePath).replace(/^([/\\])+/, "");
  const abs = path.resolve(publishedDir(projectId), normalized);
  if (!abs.startsWith(path.resolve(publishedDir(projectId)))) return null;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generated app files
// ---------------------------------------------------------------------------

function appFilePath(projectId: string, filePath: string): string {
  const normalized = path.normalize(filePath).replace(/^([/\\])+/, "");
  const abs = path.resolve(projectDir(projectId), normalized);
  if (!abs.startsWith(path.resolve(projectDir(projectId)))) {
    throw new Error("Invalid file path");
  }
  return abs;
}

export function saveAppFile(projectId: string, filePath: string, content: string) {
  const abs = appFilePath(projectId, filePath);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, content, "utf8");
}

export function deleteAppFile(projectId: string, filePath: string) {
  try {
    fs.rmSync(appFilePath(projectId, filePath));
  } catch {
    // ignore
  }
}

export function readAppFile(projectId: string, filePath: string): string | null {
  try {
    return fs.readFileSync(appFilePath(projectId, filePath), "utf8");
  } catch {
    return null;
  }
}

/**
 * Snapshot/rollback for the degenerate-retry isolation: a truncated
 * generation can leave PARTIAL files in the workspace (progressive
 * streaming persists each section the moment it completes), and retrying
 * with that half-written state in context teaches the model to bind its
 * output to a draft's hallucinated IDs. Callers snapshot before the first
 * attempt and roll back before building the retry's instructions.
 */
export function snapshotWorkspace(projectId: string): ProjectFile[] {
  return listAppFiles(projectId);
}

export function restoreWorkspace(
  projectId: string,
  snapshot: ProjectFile[],
) {
  const before = new Set(snapshot.map((f) => f.path));
  // Files created or modified by the failed attempt are reverted. Removals
  // must NOT touch internal state (project.json, chat.json, published/,
  // deploy versions) — listAppFiles already excludes those from snapshots,
  // so anything on disk outside the snapshot set is by definition attempt
  // output. Nested dirs the attempt created are removed with their files.
  for (const f of listAppFiles(projectId)) {
    if (!before.has(f.path)) deleteAppFile(projectId, f.path);
  }
  for (const f of snapshot) saveAppFile(projectId, f.path, f.content);
}

export function listAppFiles(projectId: string): ProjectFile[] {
  const base = projectDir(projectId);
  if (!fs.existsSync(base)) return [];
  const out: ProjectFile[] = [];
  const INTERNAL = new Set([
    "project.json",
    "chat.json",
    DEPLOYMENTS_FILE,
    "turn-snapshots.json",
  ]);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Output artifacts, not workspace files — exclude from listings,
        // model context, ZIP export and nested snapshots.
        if (
          full === publishedDir(projectId) ||
          full === deployVersionsDir(projectId) ||
          full === turnSnapshotsDir(projectId)
        ) {
          continue;
        }
        walk(full);
      } else if (entry.isFile() && !INTERNAL.has(entry.name)) {
        out.push({
          path: path.relative(base, full).split(path.sep).join("/"),
          content: fs.readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(base);
  return out;
}

// ---------------------------------------------------------------------------
// Chat history
// ---------------------------------------------------------------------------

export interface GenerationHealth {
  /** Completed generation turns (assistant messages). */
  turns: number;
  /** Turns that wrote at least one file. */
  okTurns: number;
  /** Turns where the automatic degenerate retry fired. */
  retriedTurns: number;
  /** Turns that ended with no files despite everything (continue banner). */
  degenerateTurns: number;
  /** okTurns / turns, 0..1. */
  successRate: number;
  /** retriedTurns / turns — how often the auto-retry had to fire. */
  avgRetries: number;
}

/**
 * Generation health for one project, derived from its stored chat turns'
 * finish metadata (fileCount / retried / degenerate). Only REAL generation
 * turns count — each carries modelUsed/providerUsed; the template-promote
 * seed message has neither and would otherwise skew a project that has
 * never generated. null when there are no completed generations yet —
 * callers show nothing rather than a meaningless 0%.
 */
export function getGenerationHealth(
  projectId: string,
): GenerationHealth | null {
  const turns = loadMessages(projectId).filter((m) => {
    if (m.role !== "assistant") return false;
    const meta = (m.metadata ?? {}) as { modelUsed?: string };
    return Boolean(meta.modelUsed);
  });
  if (turns.length === 0) return null;
  const metas = turns.map(
    (m) =>
      (m.metadata ?? {}) as {
        fileCount?: number;
        retried?: boolean;
        degenerate?: boolean;
      },
  );
  const okTurns = metas.filter((x) => (x.fileCount ?? 0) > 0).length;
  const retriedTurns = metas.filter((x) => Boolean(x.retried)).length;
  const degenerateTurns = metas.filter((x) => Boolean(x.degenerate)).length;
  return {
    turns: turns.length,
    okTurns,
    retriedTurns,
    degenerateTurns,
    successRate: okTurns / turns.length,
    avgRetries: retriedTurns / turns.length,
  };
}

export function loadMessages(projectId: string): BuilderUIMessage[] {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectDir(projectId), "chat.json"), "utf8"),
    ) as BuilderUIMessage[];
  } catch {
    return [];
  }
}

export function saveMessages(projectId: string, messages: BuilderUIMessage[]) {
  ensureDir(projectDir(projectId));
  fs.writeFileSync(
    path.join(projectDir(projectId), "chat.json"),
    JSON.stringify(messages),
  );
}

/**
 * Append incoming messages to stored history WITHOUT duplicating turns.
 *
 * The AI SDK v5 transport sends the FULL conversation on every request, but
 * the stream's onEnd also persists the response message — so a naive
 * `[...existing, ...incoming]` stores every earlier turn twice after the
 * second chat turn (observed: `[u1, a1, u1, a1]` after one refine).
 *
 * Rule: a message whose id was already placed updates the earlier copy in
 * place (the later copy is fresher — e.g. finish metadata arrives only at
 * onEnd) instead of appending a duplicate. This collapses duplicates that
 * already exist in storage too, repairing polluted chat.json files. Messages
 * with no id are always appended (defensive; transport always sends ids).
 */
export function appendMessages(
  projectId: string,
  incoming: BuilderUIMessage[],
): BuilderUIMessage[] {
  const byId = new Map<string, number>();
  const merged: BuilderUIMessage[] = [];
  const place = (m: BuilderUIMessage) => {
    const idx = typeof m.id === "string" ? byId.get(m.id) : undefined;
    if (idx === undefined) {
      if (typeof m.id === "string") byId.set(m.id, merged.length);
      merged.push(m);
    } else {
      merged[idx] = m; // fresher copy wins, original position kept
    }
  };
  for (const m of loadMessages(projectId)) place(m);
  for (const m of incoming) place(m);
  saveMessages(projectId, merged);
  return merged;
}
