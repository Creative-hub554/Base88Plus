/**
 * Content types for serving generated app assets. Shared by the preview
 * route and the public publish route.
 */
export const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

export function contentTypeFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
