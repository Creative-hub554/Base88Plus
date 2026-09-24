/**
 * Architecture guard: `settings.cloudflare` must only be touched by its
 * owners. Every credential/validity/subdomain question has a gateway
 * helper — `cfCredentials`, `isKeyless`, `cfSubdomain`, `redactSettings`,
 * `providerApiKey` — and routes that reach into the raw field instead are
 * exactly how the mangled-`{account}`-URL and placeholder-key bugs
 * happened. This test scans all of src/ and fails on any `.cloudflare`
 * property access outside the allowlist, so the drift can never silently
 * come back.
 *
 * Pattern notes: `api.cloudflare.com` (hostname) and `.env.cloudflare-edge`
 * (the E2E edge-harness env filename) are excluded by lookahead — they are
 * not settings access. The allowlist is expected to stay at exactly two
 * files: the gateway (owns the definition) and the deploy settings route
 * (owns writing the credentials). Anything else must go through a helper.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** `.cloudflare` property access, minus hostname/env-filename lookalikes. */
const FORBIDDEN = /\.cloudflare\b(?!\.com)(?!-edge)/;

/** Files that legitimately touch the raw settings field, with reasons. */
const ALLOWED = new Map<string, string>([
  [
    "src/lib/providers/gateway.ts",
    "owns the definition (cfCredentials, isKeyless, cfSubdomain, redactSettings)",
  ],
  [
    "src/app/api/deploy/settings/route.ts",
    "the credentials WRITER — connect/verify/subdomain cache",
  ],
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("architecture: settings.cloudflare access is centralized", () => {
  it("only the owner files read or write .cloudflare directly", () => {
    const srcDir = path.join(process.cwd(), "src");
    const files = walk(srcDir);

    // The scan itself must be real: enough files that a pass is not vacuous.
    expect(files.length).toBeGreaterThan(20);
    // The owners must actually exist — otherwise the allowlist guards nothing.
    for (const rel of ALLOWED.keys()) {
      expect(fs.existsSync(path.join(process.cwd(), rel))).toBe(true);
    }

    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
      const text = fs.readFileSync(file, "utf8");
      if (!FORBIDDEN.test(text)) continue;
      if (ALLOWED.has(rel)) continue;
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (FORBIDDEN.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      violations,
      `Raw settings.cloudflare access found. Import the gateway helpers ` +
        `(cfCredentials / isKeyless / cfSubdomain / redactSettings / ` +
        `providerApiKey) instead:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("allowlist entries still match the pattern (no stale exemptions)", () => {
    // If an owner stops touching .cloudflare, the exemption must be removed
    // rather than left wide open for future drift.
    for (const rel of ALLOWED.keys()) {
      const text = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(
        FORBIDDEN.test(text),
        `${rel} is allowlisted but no longer touches .cloudflare — remove it from the allowlist`,
      ).toBe(true);
    }
  });
});
