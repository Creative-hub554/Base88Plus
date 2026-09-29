/**
 * Import-from-zip: the return leg of the portability story.
 *
 * Anybase ships export (GET /api/projects/[id]/download via jszip) but
 * until now nothing could come back in. `importProjectFromZip` accepts a
 * zip — an Anybase export or any static-site bundle — reuses
 * createProject's own id generator for fresh ids, and copies sanitized
 * entries into the new project's workspace. A project.json at the zip
 * root of an Anybase export is metadata only — never an app file.
 *
 * Sanitization (each skip carries its reason; the API surfaces them as a
 * "skipped with reason" list, so one poison entry never 400s the other
 * 40 files):
 *   • path traversal / absolute / drive-letter / backslash paths — skipped
 *   • macOS junk (__MACOSX), Windows dir entries, `.`-prefixed and system
 *     files (Thumbs.db, desktop.ini) — skipped
 *   • binary entries (asset extensions, NUL sniffing, decode-recode
 *     round-trip) — skipped; Anybase apps are text
 *   • directories, empty files, size outliers — skipped
 *   • duplicate paths (case-folded on win32) — first wins
 *   • a root project.json — RESERVED: the store record owns that name and
 *     importing it would clobber the fresh project's record. When it
 *     carries the anybase marker it is CONSUMED as the export's metadata
 *     envelope (name/description restored); otherwise it is skipped with
 *     the reserved reason. Nested project.json files are ordinary files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";
import { createProject, saveAppFile } from "./store";
import type { Project, ProjectFile } from "./types";

/** Key of the metadata envelope inside an anybase export zip. */
export const EXPORT_META_FILENAME = "project.json";

/** Case-insensitive reserved-name check: on case-insensitive filesystems
 * (Windows/macOS default) writing PROJECT.JSON would clobber the record. */
function isReservedRootName(cleanPath: string): boolean {
  return cleanPath.toLowerCase() === EXPORT_META_FILENAME;
}

export const SKIP_REASONS = {
  DIR: "directory entry",
  MACOS_JUNK: "macOS resource-fork directory",
  DOT_OR_SYSTEM: "hidden or system file",
  TRAVERSAL: "unsafe path (traversal, absolute, or drive letter)",
  BINARY: "binary file (not text)",
  EMPTY: "empty file",
  TOO_LARGE: "file exceeds the import size limit",
  DUPLICATE: "duplicate path (first occurrence wins)",
  RESERVED: "reserved by Anybase (the project record)",
} as const;

export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS];

export interface ImportSkipped {
  path: string;
  reason: SkipReason;
}

export interface ImportResult {
  project: Project;
  imported: ProjectFile[];
  skipped: ImportSkipped[];
}

/** Hard cap per file: generated apps are tiny; imports stay in that world. */
export const IMPORT_MAX_FILE_BYTES = 1_000_000;
/** Total bytes accepted across all entries. */
export const IMPORT_MAX_TOTAL_BYTES = 20_000_000;

const MACOS_DIR_RE = /(^|\/)__MACOSX(\/|$)/;
const DOT_OR_SYSTEM_RE = /(^|\/)(\.[^/]*|Thumbs\.db|desktop\.ini)$/;

/** Extensions we treat as binary assets rather than text app files. */
const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|avif|bmp|ico|svgz|woff2?|ttf|otf|eot|mp3|wav|ogg|m4a|mp4|webm|mov|avi|mkv|pdf|docx?|xlsx?|pptx?|wasm|bin|exe|dll|so|dylib|zip|gz|tar|br)$/i;

/**
 * A "text" file must survive decode→recode unchanged. Catches UTF-16 and
 * most binary blobs regardless of extension.
 */
function decodesAsText(content: string): boolean {
  return Buffer.from(content, "utf8").toString("utf8") === content;
}

export interface ZipEntryLike {
  name: string;
  /** Declared uncompressed size; undefined when unknown (data descriptor). */
  size?: number;
  /** Entry payload. */
  async: (type: "string") => Promise<string>;
}

/**
 * Shared path-level sanitization. Directory entries and macOS junk return
 * silent skips (standard zip noise callers drop without ceremony); every
 * other skip is user-facing. Returns the cleaned path or the reason.
 */
export function classifyZipEntry(
  entry: Pick<ZipEntryLike, "name" | "size">,
  maxFileBytes: number,
): { path: string; reason?: SkipReason } {
  const rawName = String(entry.name ?? "");

  if (rawName.endsWith("/")) return { path: rawName, reason: SKIP_REASONS.DIR };
  if (MACOS_DIR_RE.test(rawName)) {
    return { path: rawName, reason: SKIP_REASONS.MACOS_JUNK };
  }
  // A backslash is a path separator only in the attacker's mind; raw
  // backslashes are rejected, not rewritten.
  if (rawName.includes("\\")) {
    return { path: rawName, reason: SKIP_REASONS.TRAVERSAL };
  }

  const normalized = path.posix.normalize(rawName.replace(/^\.\//, ""));

  // A bare "site/" (Windows-style dir entry with dir:false), "./" and
  // "." all collapse to nothing importable — treated as zip noise.
  if (!normalized || normalized === "." || /^[^/]+\/$/.test(rawName)) {
    return { path: rawName, reason: SKIP_REASONS.DIR };
  }
  if (DOT_OR_SYSTEM_RE.test(normalized)) {
    return { path: rawName, reason: SKIP_REASONS.DOT_OR_SYSTEM };
  }
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..") ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    return { path: rawName, reason: SKIP_REASONS.TRAVERSAL };
  }

  const declared = entry.size ?? 0;
  if (declared > maxFileBytes) {
    return { path: rawName, reason: SKIP_REASONS.TOO_LARGE };
  }
  return { path: normalized };
}

export interface ImportOptions {
  /** Explicit caller override — beats everything, including export metadata. */
  name?: string;
  description?: string;
  /**
   * Weak hint (e.g. derived from the uploaded filename) — loses to export
   * metadata so an anybase export restores its original app name.
   */
  fallbackName?: string;
  /** Per-entry limit override (tests). */
  maxFileBytes?: number;
  /** Aggregate limit override (tests). */
  maxTotalBytes?: number;
}

/**
 * The metadata envelope anybase exports write at the zip root. Only the
 * metadata-bearing fields are honored on import — the envelope carries
 * the OLD project's id and timestamps, which must never leak into the
 * fresh project (fresh ids are a hard invariant of the import).
 */
export interface ExportMeta {
  name?: string;
  description?: string;
  /** Marker of an anybase export envelope (as opposed to an app file). */
  anybase?: unknown;
}

/**
 * Scan for the export metadata envelope at the zip root. The envelope is
 * root project.json carrying the anybase marker (what the download route
 * writes); only then is it consumed as metadata. Returns null otherwise
 * — a foreign app's own project.json (even valid JSON with its own
 * `name`) is store-reserved on import (skipped, never written to the
 * workspace) and must never hijack the imported name.
 */
export async function readExportMeta(
  files: ZipEntryLike[],
): Promise<ExportMeta | null> {
  const root = files.find(
    (f) =>
      String(f.name ?? "").replace(/^\.\//, "").toLowerCase() ===
      EXPORT_META_FILENAME,
  );
  if (!root) return null;
  try {
    const parsed = JSON.parse(await root.async("string")) as ExportMeta;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.anybase === undefined) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Entries-level core, split from buffer loading so the sanitizer can be
 * exercised against SYNTHETIC entry lists — the JSZip writer normalizes
 * `..` segments and dedupes same-path entries at write time, so
 * adversarial shapes are only realizable in hand-crafted zips.
 * Throws when nothing importable survives — the caller maps that to its
 * 4xx of choice.
 */
export async function importFromEntries(
  files: ZipEntryLike[],
  options: ImportOptions = {},
): Promise<ImportResult> {
  const maxFileBytes = options.maxFileBytes ?? IMPORT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? IMPORT_MAX_TOTAL_BYTES;

  const meta = await readExportMeta(files);
  const project = createProject(
    options.name?.trim() ||
      (typeof meta?.name === "string" && meta.name.trim()) ||
      options.fallbackName?.trim() ||
      "Imported app",
    options.description?.trim() ||
      (typeof meta?.description === "string" ? meta.description : "") ||
      "",
  );
  const imported: ProjectFile[] = [];
  const skipped: ImportSkipped[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let acceptedAny = false;

  for (const file of files) {
    const verdict = classifyZipEntry(file, maxFileBytes);
    if (verdict.reason) {
      // Directory entries and macOS junk are zip noise; everything else
      // is worth telling the user about.
      if (
        verdict.reason !== SKIP_REASONS.DIR &&
        verdict.reason !== SKIP_REASONS.MACOS_JUNK
      ) {
        skipped.push({ path: verdict.path, reason: verdict.reason });
      }
      continue;
    }
    const cleanPath = verdict.path;

    // Root project.json is store-reserved: consumed as the anybase
    // envelope when it carries the marker, skipped as reserved otherwise
    // (case-insensitive — on Windows PROJECT.JSON would clobber the
    // record). Nested project.json files are ordinary files.
    if (isReservedRootName(cleanPath)) {
      if (meta !== null) continue;
      skipped.push({ path: cleanPath, reason: SKIP_REASONS.RESERVED });
      continue;
    }

    const dupeKey = process.platform === "win32" ? cleanPath.toLowerCase() : cleanPath;
    if (seen.has(dupeKey)) {
      skipped.push({ path: cleanPath, reason: SKIP_REASONS.DUPLICATE });
      continue;
    }
    seen.add(dupeKey);

    if (BINARY_EXT_RE.test(cleanPath)) {
      skipped.push({ path: cleanPath, reason: SKIP_REASONS.BINARY });
      continue;
    }

    const content = await file.async("string");
    if (content.length === 0) {
      skipped.push({ path: cleanPath, reason: SKIP_REASONS.EMPTY });
      continue;
    }
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > maxFileBytes || totalBytes + byteLength > maxTotalBytes) {
      skipped.push({ path: cleanPath, reason: SKIP_REASONS.TOO_LARGE });
      continue;
    }
    if (content.includes("\0") || !decodesAsText(content)) {
      skipped.push({ path: cleanPath, reason: SKIP_REASONS.BINARY });
      continue;
    }

    saveAppFile(project.id, cleanPath, content);
    imported.push({ path: cleanPath, content });
    totalBytes += byteLength;
    acceptedAny = true;
  }

  if (!acceptedAny) {
    fs.rmSync(path.join(process.cwd(), "projects-data", project.id), {
      recursive: true,
      force: true,
    });
    throw new Error("No importable files found in the zip");
  }

  return { project, imported, skipped };
}

/**
 * Create a project from a zip buffer: sanitize every entry, copy the
 * accepted ones into the fresh workspace, report per-entry skips.
 * Throws on a zip that yields nothing importable — the caller maps that
 * to its 4xx of choice.
 */
export async function importProjectFromZip(
  data: Buffer | Uint8Array | ArrayBuffer,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(data);
  const files = Object.values(zip.files).filter((f) => !f.dir);
  return importFromEntries(files, options);
}
