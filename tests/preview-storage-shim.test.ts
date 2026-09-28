/**
 * Preview storage shim: the sandbox CSP (no allow-same-origin) strips
 * localStorage/sessionStorage from generated-app documents, killing any
 * app that touches storage at its first statement. The shim module owns
 * both the injected script and the injector; these tests pin the script's
 * install behavior (evaluated against a plain object window — the same
 * defineProperty-on-window move the shim makes inside a sandboxed
 * document) and the injector's targeting rules.
 */
import { describe, expect, it } from "vitest";
import { STORAGE_SHIM, injectStorageShim } from "../src/lib/preview-storage-shim";

function runShimOnFakeWindow() {
  const win: Record<string, unknown> = {};
  const self = win as unknown as Window;
  // The shim only references `window`; evaluate its body in that shape.
  const body = STORAGE_SHIM.replace(/^<script>/, "").replace(/<\/script>$/, "");
  new Function("window", body)(self);
  return win;
}

describe("STORAGE_SHIM script", () => {
  it("installs a working localStorage on a bare window", () => {
    const win = runShimOnFakeWindow();
    const ls = win.localStorage as Storage;
    expect(ls).toBeDefined();
    ls.setItem("counter", "2");
    expect(ls.getItem("counter")).toBe("2");
    expect(ls.length).toBe(1);
    expect(ls.key(0)).toBe("counter");
    ls.removeItem("counter");
    expect(ls.getItem("counter")).toBeNull();
  });

  it("keeps localStorage and sessionStorage independent (browser semantics)", () => {
    const win = runShimOnFakeWindow();
    const ls = win.localStorage as Storage;
    const ss = win.sessionStorage as Storage;
    ls.setItem("k", "v");
    expect(ss.getItem("k")).toBeNull();
    ss.setItem("s", "only-session");
    expect(ls.getItem("s")).toBeNull();
    expect(ls.getItem("k")).toBe("v");
  });

  it("clear() empties the store", () => {
    const win = runShimOnFakeWindow();
    const ls = win.localStorage as Storage;
    ls.setItem("a", "1");
    ls.setItem("b", "2");
    ls.clear();
    expect(ls.length).toBe(0);
    expect(ls.getItem("a")).toBeNull();
  });

  it("ALWAYS redefines the storage hooks (a poisoned getter must not survive)", () => {
    // In a real sandboxed window the pre-existing property is an accessor
    // whose getter THROWS, so any bail-out would leave it in place. The
    // shim must replace whatever it finds with a working value store.
    const body = STORAGE_SHIM.replace(/^<script>/, "").replace(/<\/script>$/, "");
    const poisoned = { get localStorage() { throw new Error("SecurityError"); } };
    const win = Object.create(poisoned);
    new Function("window", body)(win as unknown as Window);
    const ls = win.localStorage as Storage;
    expect(typeof ls).toBe("object");
    ls.setItem("k", "v");
    expect(ls.getItem("k")).toBe("v");
  });

  it("installs an indexedDB no-op that rejects open()", async () => {
    const win = runShimOnFakeWindow();
    const idb = win.indexedDB as { open: () => Promise<unknown> };
    expect(idb).toBeDefined();
    await expect(idb.open()).rejects.toThrow(/sandboxed preview/);
  });
});

describe("injectStorageShim", () => {
  it("injects right after <head> so app scripts run after the shim", () => {
    const html = "<!doctype html><html><head><title>t</title></head><body><script src=\"app.js\"></script></body></html>";
    const out = injectStorageShim(html);
    expect(out).toContain("<head><script>");
    expect(out.indexOf("STORAGE") === -1).toBe(true);
    expect(out.indexOf("</head>")).toBeGreaterThan(out.indexOf("<head><script>"));
  });

  it("is idempotent", () => {
    const html = "<html><head></head><body></body></html>";
    expect(injectStorageShim(injectStorageShim(html))).toBe(injectStorageShim(html));
  });

  it("leaves documents without a <head> untouched", () => {
    const fragment = "<div>no head here</div>";
    expect(injectStorageShim(fragment)).toBe(fragment);
  });

  it("handles a missing doctype and case variants", () => {
    const html = "<HTML><HEAD><meta charset=\"utf-8\"></HEAD></HTML>";
    const out = injectStorageShim(html);
    expect(out.toLowerCase().indexOf("<script>")).toBeGreaterThan(-1);
  });
});
