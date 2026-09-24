import { createHash } from "node:crypto";
import type { CustomDomain, ProjectFile } from "../types";

/**
 * Cloudflare deploy engine — Workers static-assets direct upload.
 *
 * Implements the documented three-phase pipeline:
 *   1. POST manifest  → /accounts/:id/workers/scripts/:name/assets-upload-session
 *   2. POST files     → /accounts/:id/workers/assets/upload?base64=true
 *   3. PUT script     → /accounts/:id/workers/scripts/:name  (multipart, implicitly deploys)
 *
 * The generated apps are pure static bundles, so the script is the minimal
 * module Worker that only serves assets — no code of its own.
 * Result: a public https://<name>.<subdomain>.workers.dev URL.
 */

/** Base URL of the Cloudflare API (override with CLOUDFLARE_API_BASE for tests). */
export function cloudflareApiBase(): string {
  return process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4";
}

const CF_API = cloudflareApiBase();

export class DeployError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const WORKER_SCRIPT = `export default { fetch: () => new Response(null, { status: 404 }) };`;

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  messages?: unknown[];
  result: T;
}

async function cfFetch<T>(
  path: string,
  init: RequestInit & { token: string },
): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${CF_API}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(rest.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
  if (!res.ok || !json?.success) {
    const msg =
      json?.errors?.map((e) => e.message).join("; ") ||
      `Cloudflare API returned ${res.status}`;
    throw new DeployError(msg, res.status);
  }
  return json.result;
}

export interface CloudflareCreds {
  accountId: string;
  apiKey: string;
  subdomain?: string;
}

/** Verify credentials and discover the account's workers.dev subdomain. */
export async function verifyCloudflare(
  creds: CloudflareCreds,
): Promise<{ subdomain: string }> {
  const result = await cfFetch<{ subdomain: string }>(
    `/accounts/${creds.accountId}/workers/subdomain`,
    { method: "GET", token: creds.apiKey },
  );
  return { subdomain: result.subdomain };
}

/**
 * Deploy a static file set as a Workers project. `name` must be a valid
 * Worker name (lowercase letters, numbers, dashes — max 58 chars).
 */
export async function deployToCloudflare(
  name: string,
  files: ProjectFile[],
  creds: CloudflareCreds,
): Promise<{ subdomain: string }> {
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(name)) {
    throw new DeployError(
      `Invalid Worker name "${name}" — use lowercase letters, numbers and dashes.`,
    );
  }
  if (files.length === 0) {
    throw new DeployError("Nothing to deploy — no files in the snapshot.");
  }

  // Phase 1: register the manifest. Hash must match what phase 2 uploads
  // (hash of base64 content); size is byte length.
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const f of files) {
    const bytes = Buffer.from(f.content, "utf8");
    manifest[`/${f.path}`] = {
      hash: createHash("sha256")
        .update(bytes.toString("base64"))
        .digest("hex")
        .slice(0, 32),
      size: bytes.length,
    };
  }
  const session = await cfFetch<{ jwt: string }>(
    `/accounts/${creds.accountId}/workers/scripts/${name}/assets-upload-session`,
    {
      method: "POST",
      token: creds.apiKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest }),
    },
  );

  // Phase 2: upload missing files (base64, multipart). The session JWT only
  // lists files the account has never seen — dedup is built into the API.
  const form = new FormData();
  for (const f of files) {
    const b64 = Buffer.from(f.content, "utf8").toString("base64");
    form.append(
      f.path,
      new Blob([b64], { type: contentTypeForDeploy(f.path) }),
      f.path,
    );
  }
  const uploadRes = await fetch(
    `${CF_API}/accounts/${creds.accountId}/workers/assets/upload?base64=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.jwt}`,
      },
      body: form,
    },
  );
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => "");
    throw new DeployError(
      `Asset upload failed (${uploadRes.status}): ${text.slice(0, 300)}`,
      uploadRes.status,
    );
  }
  const uploadJson = (await uploadRes.json().catch(() => null)) as {
    jwt?: string;
    result?: { jwt?: string };
  } | null;
  // The real endpoint returns a bare {jwt}; accept an enveloped result too.
  const completionJwt = uploadJson?.jwt ?? uploadJson?.result?.jwt;

  // Phase 3: deploy the script version (multipart) — this binds the assets
  // and makes the workers.dev URL live.
  const deployForm = new FormData();
  deployForm.append(
    "metadata",
    new Blob([
      JSON.stringify({
        main_module: "worker.js",
        compatibility_date: "2026-01-01",
        ...(completionJwt ? { bindings: [], assets: { jwt: completionJwt } } : {}),
      }),
    ], { type: "application/json" }),
  );
  deployForm.append(
    "worker.js",
    new Blob([WORKER_SCRIPT], { type: "application/javascript+module" }),
  );
  await cfFetch<unknown>(`/accounts/${creds.accountId}/workers/scripts/${name}`, {
    method: "PUT",
    token: creds.apiKey,
    body: deployForm,
  });

  const subdomain = creds.subdomain || (await verifyCloudflare(creds)).subdomain;
  return { subdomain };
}

// ---------------------------------------------------------------------------
// Custom domains
// ---------------------------------------------------------------------------

/** A Cloudflare DNS zone on the user's account. */
export interface ZoneInfo {
  id: string;
  name: string;
}

/** Everything the UI needs to display per-domain DNS instructions. */
export interface CustomDomainResult {
  hostname: string;
  zoneId?: string;
  mode: "managed" | "manual";
  /** Target of the required CNAME when mode is "manual". */
  cnameTarget?: string;
  /** The workers.dev URL this domain fronts. */
  workerUrl: string;
}

/**
 * Look up the zone that would serve `hostname` on this account, if any.
 * Matches the longest suffix (foo.docs.example.com → zone example.com).
 */
export async function findZoneForHost(
  hostname: string,
  creds: CloudflareCreds,
): Promise<ZoneInfo | null> {
  const zones = await cfFetch<ZoneInfo[]>(
    `/zones?per_page=50`,
    { method: "GET", token: creds.apiKey },
  );
  const host = hostname.toLowerCase().replace(/\.$/, "");
  let best: ZoneInfo | null = null;
  for (const z of zones) {
    const zone = z.name.toLowerCase();
    if (host === zone || host.endsWith(`.${zone}`)) {
      if (!best || zone.length > best.name.length) best = z;
    }
  }
  return best;
}

/**
 * Attach a custom hostname to the project's Worker.
 *
 * Two modes:
 * - Zone on this account ("managed"): create a Workers route
 *   `hostname/*` on that zone — Cloudflare handles DNS implicitly; done.
 * - Zone elsewhere ("manual"): the user must add a CNAME themselves;
 *   we return the exact record to create.
 */
export async function attachCustomDomain(
  workerName: string,
  hostname: string,
  creds: CloudflareCreds,
  subdomain: string,
): Promise<CustomDomainResult> {
  if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(hostname) || hostname.length > 253) {
    throw new DeployError(`"${hostname}" is not a valid domain name.`, 400);
  }
  const zone = await findZoneForHost(hostname, creds);
  const workerUrl = `https://${workerName}.${subdomain}.workers.dev`;

  if (zone) {
    await cfFetch<unknown>(
      `/zones/${zone.id}/workers/routes`,
      {
        method: "POST",
        token: creds.apiKey,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: `${hostname}/*`, script: workerName }),
      },
    );
    return { hostname, zoneId: zone.id, mode: "managed", workerUrl };
  }

  return {
    hostname,
    mode: "manual",
    cnameTarget: `${workerName}.${subdomain}.workers.dev`,
    workerUrl,
  };
}

/** Detach a hostname: remove the Workers route if the zone is on-account. */
export async function detachCustomDomain(
  workerName: string,
  domain: CustomDomain,
  creds: CloudflareCreds,
): Promise<void> {
  if (domain.mode !== "managed" || !domain.zoneId) return;
  const routes = await cfFetch<Array<{ id: string; pattern: string; script: string }>>(
    `/zones/${domain.zoneId}/workers/routes`,
    { method: "GET", token: creds.apiKey },
  );
  for (const r of routes) {
    if (r.script === workerName && r.pattern.startsWith(domain.hostname)) {
      await cfFetch<unknown>(
        `/zones/${domain.zoneId}/workers/routes/${r.id}`,
        { method: "DELETE", token: creds.apiKey },
      );
    }
  }
}

function contentTypeForDeploy(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    mjs: "text/javascript",
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
    txt: "text/plain",
    md: "text/markdown",
  };
  return map[ext] ?? "application/octet-stream";
}
