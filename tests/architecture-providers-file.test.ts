/**
 * Architecture guard #2: the settings file (`providers.json`) must only be
 * read or written by the gateway. `getSettings()`/`saveSettings()` own the
 * merge-with-defaults, env-key fallback, and placeholder rules — a route
 * that deserializes the file directly silently bypasses all of them (this
 * is exactly how stale-catalog and placeholder-key bugs shipped before).
 *
 * The scan covers src/ and scripts/ (dev mocks must never touch real
 * settings; they take explicit paths). Tests are excluded — the hermetic
 * regression suites legitimately seed providers.json in isolated temp cwds.
 *
 * Allowlist policy (mirrors tests/architecture-cloudflare-access.test.ts):
 *  - gateway.ts: the owner (fs reads + writes).
 *  - builder-client.tsx: the filename appears in UI *prose* only. To keep
 *    that exemption from becoming a hole, this file must never import any
 *    fs module — asserted below.
 * A second case fails when an allowlisted file stops matching, so stale
 * exemptions get removed instead of lingering.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SETTINGS_PATTERN = /providers\.json/i;

/** FS-module imports that would turn a prose mention into real access. */
const FS_IMPORT = /from\s+["']node:fs(?:\/promises)?["']|require\(\s*["']node:fs(?:\/promises)?["']|from\s+["']fs(?:\/promises)?["']/;

/** Files allowed to mention/read the settings file, with reasons. */
const ALLOWED = new Map<string, string>([
  ["src/lib/providers/gateway.ts", "owns the settings file (getSettings/saveSettings)"],
  ["src/components/builder-client.tsx", "UI prose mentions the filename — must stay fs-free"],
]);

/** Files that may never import fs at all (prose-only allowlist entries). */
const FS_FREE = new Set(["src/components/builder-client.tsx"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("architecture: providers.json access is centralized", () => {
  it("only allowlisted files touch or mention the settings file", () => {
    const scanned = [
      ...walk(path.join(process.cwd(), "src")),
      ...walk(path.join(process.cwd(), "scripts")),
    ];

    // The scan must be real: enough files that a pass is not vacuous.
    expect(scanned.length).toBeGreaterThan(20);
    // Owners must exist, or the allowlist guards nothing.
    for (const rel of ALLOWED.keys()) {
      expect(fs.existsSync(path.join(process.cwd(), rel))).toBe(true);
    }

    const violations: string[] = [];
    for (const file of scanned) {
      const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
      const text = fs.readFileSync(file, "utf8");
      if (!SETTINGS_PATTERN.test(text)) continue;
      if (ALLOWED.has(rel)) continue;
      text.split("\n").forEach((line, i) => {
        if (SETTINGS_PATTERN.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      violations,
      `Direct providers.json access/mention outside the gateway. Use ` +
        `getSettings()/saveSettings() from @/lib/providers/gateway instead ` +
        `(or, for scripts, take the path as an explicit argument):\n` +
        violations.join("\n"),
    ).toEqual([]);
  });

  it("prose-only allowlist entries never import fs modules", () => {
    for (const rel of FS_FREE) {
      const text = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(
        FS_IMPORT.test(text),
        `${rel} is allowlisted as prose-only but imports an fs module — move the access into the gateway or drop the exemption`,
      ).toBe(false);
    }
  });

  it("allowlist entries still match the pattern (no stale exemptions)", () => {
    for (const rel of ALLOWED.keys()) {
      const text = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(
        SETTINGS_PATTERN.test(text),
        `${rel} is allowlisted but no longer references providers.json — remove it from the allowlist`,
      ).toBe(true);
    }
  });
});
