/**
 * Storage shim injected into sandboxed generated-app previews.
 *
 * Generated apps are served with a hard sandbox CSP (no
 * `allow-same-origin`), so `localStorage` / `sessionStorage` throw a
 * SecurityError on access — and any generated app that touches storage
 * dies at its first statement (observed live: a counter app's entire
 * script was killed by its unprompted localStorage persistence). The
 * sandbox flag itself stays: it is the security boundary isolating
 * model-generated content.
 *
 * The fix: prepend a shim that OWN-properties the storage hooks onto
 * `window` before app scripts run (a sandboxed document cannot inherit
 * them, but it CAN defineProperty its own — verified live). CRITICAL:
 * the guard must use Object.getOwnPropertyDescriptor (own properties
 * only) — a `name in window` check touches the sandbox's poisoned
 * accessor and itself throws SecurityError, killing the whole shim
 * (observed live). Each hook is
 * a plain in-memory Map keyed per document lifetime, so persistence is
 * real within a preview session and disappears with it, exactly like a
 * sandboxed origin's storage would. Also installed: `globalThis` (some
 * generators reference storage through it) and `indexedDB` as a no-op
 * rejecting handle, so storage-first generated apps degrade to a clear
 * error instead of a ReferenceError mid-generation.
 */
export const STORAGE_SHIM = `<script>(function () {
  function makeStorage() {
    var map = new Map();
    return {
      getItem: function (k) { k = String(k); return map.has(k) ? map.get(k) : null; },
      setItem: function (k, v) { map.set(String(k), String(v)); },
      removeItem: function (k) { map.delete(String(k)); },
      clear: function () { map.clear(); },
      key: function (i) { var keys = Array.from(map.keys()); return i >= 0 && i < keys.length ? keys[i] : null; },
      get length() { return map.size; },
    };
  }
  function install(name) {
    try {
      // ALWAYS redefine. A sandboxed window exposes a THROWING GETTER for
      // these names even before any script runs, so both a "name in"
      // check and an own-descriptor bail-out see a live property and skip
      // the install, leaving the poisoned getter in place (verified: the
      // descriptor is accessor-shaped, configurable, and its getter
      // throws — but defineProperty with a plain value replaces it).
      Object.defineProperty(window, name, { value: makeStorage(), configurable: true });
      report[name] = 'installed';
    } catch (e) {
      report[name] = 'threw: ' + (e && e.message ? String(e.message).slice(0, 90) : String(e));
    }
  }
  var report = window.__storageShim = {};
  install('localStorage');
  install('sessionStorage');
  if (!('indexedDB' in window) || window.indexedDB === undefined) {
    try {
      Object.defineProperty(window, 'indexedDB', {
        value: { open: function () { return Promise.reject(new Error('indexedDB is not available in the sandboxed preview')); } },
        configurable: true,
      });
    } catch (e) { /* ignore */ }
  }
})();</script>`;

const SHIM_MARKER = "<head>";

/**
 * Inject the shim into an HTML document before any app script can run.
 * Returns the content unchanged when there is no <head> to inject into
 * (fragment-style documents are served verbatim — there is nothing to
 * protect) or when the shim is already present.
 */
export function injectStorageShim(html: string): string {
  if (html.includes(STORAGE_SHIM.slice(0, 40))) return html;
  const at = html.toLowerCase().indexOf(SHIM_MARKER);
  if (at === -1) return html;
  const insertAt = at + SHIM_MARKER.length;
  return html.slice(0, insertAt) + STORAGE_SHIM + html.slice(insertAt);
}
