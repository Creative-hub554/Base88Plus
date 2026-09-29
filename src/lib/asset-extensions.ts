/**
 * Extensions treated as binary assets across the app — the single source
 * of truth for the store's disk-encoding kernel, the zip importer, the
 * upload route's allowlist, and the client's picker accept list. Kept in
 * its own module (no node imports) so client bundles can import it too.
 */
export const ASSET_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svgz",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "wav", "ogg", "m4a", "mp4", "webm", "mov",
  "pdf", "zip", "gz", "wasm",
] as const;

const ASSET_EXT_SET = new Set<string>(ASSET_EXTENSIONS);

/** True when the path's extension marks a binary asset. */
export function isAssetPath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return ASSET_EXT_SET.has(ext);
}
