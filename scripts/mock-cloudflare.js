/**
 * Mock Cloudflare API for E2E-testing the deploy engine without real
 * credentials. Validates the documented protocol:
 *   1. POST /accounts/:id/workers/subdomain                → { subdomain }
 *   2. POST /accounts/:id/workers/scripts/:name/assets-upload-session
 *      - body.manifest: { "/path": { hash(32 hex), size } } → { jwt }
 *   3. POST /accounts/:id/workers/assets/upload?base64=true (Bearer = session jwt,
 *      multipart fields named by path, values base64) → { jwt } completion token
 *   4. PUT  /accounts/:id/workers/scripts/:name (multipart: metadata JSON with
 *      assets.jwt + worker.js module) → creates the deployment
 *      → worker live at https://<name>.<subdomain>.workers.dev
 *
 * Usage: node scripts/mock-cloudflare.js [port]   (default 4598)
 */
const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.argv[2] || 4598);
const SUBDOMAIN = "mock-team";

// --- Workers AI (free-tier inference) mock: OpenAI-compatible /ai/v1 ----
const AI_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
];
let aiChatRequests = 0;

const APP_FILES = `=== index.html ===
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Workers AI Counter</title><link rel="stylesheet" href="styles.css"></head>
<body>
  <main class="card"><h1>Counter via Workers AI</h1><p id="value">0</p></main>
  <script src="app.js"></script>
</body>
</html>

=== styles.css ===
body { font-family: system-ui; display: grid; place-items: center; min-height: 100vh; margin: 0; }

=== app.js ===
let count = 0;
const el = document.getElementById("value");
setInterval(() => { count++; el.textContent = count; }, 1000);
`;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function splitIntoChunks(str, size) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}
function authOk(req) {
  const h = req.headers.authorization || "";
  return h === "Bearer cf-test-token-1234567890";
}

/** name → Map<hash, base64Content>; committed via script PUT. */
const uploadedAssets = new Map();
const committedWorkers = new Map();

/** Simulated account state for custom domains. */
const zones = new Map([
  ["zone-onaccount-1", { name: "onaccount.dev" }],
  ["zone-other-1", { name: "other.example" }],
]);
const workerRoutes = new Map(); // zoneId -> [{ id, pattern, script }]
const dnsRecords = new Map(); // hostname -> { type, name, content }
let routeSeq = 0;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function parseMultipart(req, boundary) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const delim = Buffer.from(`--${boundary}`);
      const parts = [];
      let idx = body.indexOf(delim);
      while (idx !== -1) {
        const next = body.indexOf(delim, idx + delim.length);
        if (next === -1) break;
        // part = everything between delim+2 (\r\n) and next delim-2 (\r\n)
        const part = body.subarray(idx + delim.length + 2, next - 2);
        parts.push(part);
        idx = next;
      }
      const fields = {};
      for (const part of parts) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        const headers = part.subarray(0, headerEnd).toString("utf8");
        const value = part.subarray(headerEnd + 4);
        const nameMatch = headers.match(/name="([^"]+)"/);
        const fileMatch = headers.match(/filename="([^"]+)"/);
        const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
        if (!nameMatch) continue;
        const name = fileMatch ? `${nameMatch[1]}` : nameMatch[1];
        fields[name] = {
          filename: fileMatch ? fileMatch[1] : undefined,
          contentType: contentTypeMatch ? contentTypeMatch[1].trim() : undefined,
          value,
        };
      }
      resolve(fields);
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  let m;

  // Envelope helper
  const ok = (result) => json(res, 200, { success: true, errors: [], result });

  if (req.method === "GET" && /^\/accounts\/[^/]+\/workers\/subdomain$/.test(p)) {
    return ok({ subdomain: SUBDOMAIN });
  }

  // ---- Workers AI (free tier): OpenAI-compatible /ai/v1 endpoints ----
  const aiMatch = p.match(/^\/(?:accounts\/[^/]+\/)?ai\/v1\/(models|chat\/completions)$/);
  if (aiMatch && req.method === "GET" && aiMatch[1] === "models") {
    if (!authOk(req)) return json(res, 401, { success: false, errors: [{ code: 10000, message: "bad token" }] });
    return ok({ object: "list", data: AI_MODELS.map((id) => ({ id, object: "model" })) });
  }
  if (aiMatch && req.method === "POST" && aiMatch[1] === "chat/completions") {
    if (!authOk(req)) return json(res, 401, { success: false, errors: [{ code: 10000, message: "bad token" }] });
    aiChatRequests += 1;
    // MOCK_CF_AI_QUOTA=<n>: the (n+1)th request gets a free-tier quota
    // exhaustion error, so the chat route's fallback path can be tested.
    const quotaAfter = Number(process.env.MOCK_CF_AI_QUOTA ?? "0");
    if (quotaAfter > 0 && aiChatRequests > quotaAfter) {
      return json(res, 429, {
        success: false,
        errors: [
          {
            code: 9000,
            message:
              "Workers AI free tier daily neuron quota exceeded. Upgrade or wait for the quota to reset.",
          },
        ],
      });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const who = "workers-ai";
    const chunks = [
      `Hello from ${who} (request ${aiChatRequests}). `,
      "Here is a tiny ",
      "counter app",
      " for you.\n\n",
      "```anybase\n",
      ...splitIntoChunks(APP_FILES, 120),
      "\n```",
      "\nDone! Check the preview.",
    ];
    let i = 0;
    const timer = setInterval(() => {
      if (i >= chunks.length) {
        clearInterval(timer);
        sse(res, { id: "cf-ai", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        res.end();
        return;
      }
      sse(res, {
        id: "cf-ai",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }],
      });
      i++;
    }, 5);
    req.on("close", () => clearInterval(timer));
    return;
  }

  // ---- Custom-domain protocol (zones, routes, DNS) ----
  if (req.method === "GET" && p === "/zones" && url.searchParams.get("per_page")) {
    return ok(
      [...zones.entries()].map(([id, z]) => ({ id, name: z.name })),
    );
  }

  if (
    req.method === "POST" &&
    (m = p.match(/^\/zones\/([^/]+)\/workers\/routes$/))
  ) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json(res, 400, { success: false, errors: [{ code: 1101, message: "bad json" }] });
    }
    if (!zones.has(m[1])) {
      return json(res, 404, { success: false, errors: [{ code: 7003, message: "zone not found" }] });
    }
    if (!body.pattern || typeof body.pattern !== "string" || !body.pattern.endsWith("/*")) {
      return json(res, 400, {
        success: false,
        errors: [{ code: 1102, message: "pattern must be like host/*" }],
      });
    }
    if (!body.script || !/^[a-z0-9][a-z0-9-]*$/.test(body.script)) {
      return json(res, 400, {
        success: false,
        errors: [{ code: 1103, message: "script name missing/invalid" }],
      });
    }
    const list = workerRoutes.get(m[1]) ?? [];
    if (list.some((r) => r.pattern === body.pattern)) {
      return json(res, 409, {
        success: false,
        errors: [{ code: 1104, message: "route pattern already exists" }],
      });
    }
    const route = { id: `route-${++routeSeq}`, pattern: body.pattern, script: body.script };
    list.push(route);
    workerRoutes.set(m[1], list);
    return ok({ id: route.id, pattern: route.pattern, script: route.script });
  }

  if (
    req.method === "GET" &&
    (m = p.match(/^\/zones\/([^/]+)\/workers\/routes$/))
  ) {
    if (!zones.has(m[1])) {
      return json(res, 404, { success: false, errors: [{ code: 7003, message: "zone not found" }] });
    }
    return ok(workerRoutes.get(m[1]) ?? []);
  }

  if (
    req.method === "DELETE" &&
    (m = p.match(/^\/zones\/([^/]+)\/workers\/routes\/([^/]+)$/))
  ) {
    const list = workerRoutes.get(m[1]) ?? [];
    const next = list.filter((r) => r.id !== m[2]);
    if (next.length === list.length) {
      return json(res, 404, { success: false, errors: [{ code: 7003, message: "route not found" }] });
    }
    workerRoutes.set(m[1], next);
    return ok({ id: m[2] });
  }

  // Simulated DNS: any provider. Records are "created" by the test harness
  // via POST; resolution looks the record up by name.
  if (req.method === "POST" && p === "/__mock/dns") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    dnsRecords.set(body.name, { type: body.type, name: body.name, content: body.content });
    return ok(dnsRecords.get(body.name));
  }

  if (req.method === "GET" && p === "/__mock/dns") {
    const name = url.searchParams.get("name");
    return ok(dnsRecords.get(name) ?? null);
  }

  if (
    req.method === "POST" &&
    (m = p.match(/^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/assets-upload-session$/))
  ) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json(res, 400, { success: false, errors: [{ code: 1001, message: "bad json" }] });
    }
    const manifest = body?.manifest;
    if (!manifest || typeof manifest !== "object") {
      return json(res, 400, {
        success: false,
        errors: [{ code: 1002, message: "manifest missing" }],
      });
    }
    // Validate manifest entries: 32-hex hash + numeric size.
    for (const [path, entry] of Object.entries(manifest)) {
      if (!path.startsWith("/")) {
        return json(res, 400, {
          success: false,
          errors: [{ code: 1003, message: `manifest path must start with /: ${path}` }],
        });
      }
      if (!/^[0-9a-f]{32}$/.test(entry?.hash ?? "")) {
        return json(res, 400, {
          success: false,
          errors: [{ code: 1004, message: `bad hash for ${path}` }],
        });
      }
      if (!Number.isInteger(entry?.size)) {
        return json(res, 400, {
          success: false,
          errors: [{ code: 1005, message: `bad size for ${path}` }],
        });
      }
    }
    uploadedAssets.set(m[2], new Map());
    const jwt = crypto.randomBytes(24).toString("base64url");
    return ok({ jwt });
  }

  if (req.method === "POST" && p === "/accounts/x/workers/assets/upload") {
    // unreachable: path contains account id; handled below
  }

  if (
    req.method === "POST" &&
    (m = p.match(/^\/accounts\/([^/]+)\/workers\/assets\/upload$/)) &&
    url.searchParams.get("base64") === "true"
  ) {
    const auth = req.headers["authorization"] ?? "";
    if (!auth.startsWith("Bearer ")) {
      return json(res, 401, {
        success: false,
        errors: [{ code: 2001, message: "missing session jwt" }],
      });
    }
    const boundary = (req.headers["content-type"] ?? "").match(/boundary=([^;]+)/)?.[1];
    if (!boundary) {
      return json(res, 400, {
        success: false,
        errors: [{ code: 2002, message: "expected multipart" }],
      });
    }
    const fields = await parseMultipart(req, boundary);
    // Determine which script this session belongs to: the session JWT maps to
    // the most recent session's script (single-tester simplification).
    const target = [...uploadedAssets.keys()].pop();
    const store = uploadedAssets.get(target);
    for (const [name, field] of Object.entries(fields)) {
      const decoded = Buffer.from(field.value.toString("utf8"), "base64").toString("utf8");
      // Verify the client hashed base64(content) the way the manifest claims:
      const hash = crypto.createHash("sha256").update(field.value.toString("utf8")).digest("hex").slice(0, 32);
      store.set(hash, { path: name, content: decoded });
    }
    if (store.size === 0) {
      return json(res, 400, {
        success: false,
        errors: [{ code: 2003, message: "no files uploaded" }],
      });
    }
    const completionJwt = crypto.randomBytes(24).toString("base64url");
    return ok({ jwt: completionJwt });
  }

  if (
    req.method === "PUT" &&
    (m = p.match(/^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)$/))
  ) {
    const boundary = (req.headers["content-type"] ?? "").match(/boundary=([^;]+)/)?.[1];
    if (!boundary) {
      return json(res, 400, {
        success: false,
        errors: [{ code: 3001, message: "expected multipart" }],
      });
    }
    const fields = await parseMultipart(req, boundary);
    const metadataRaw = fields["metadata"]?.value?.toString("utf8");
    if (!metadataRaw) {
      return json(res, 400, {
        success: false,
        errors: [{ code: 3002, message: "metadata part missing" }],
      });
    }
    let metadata;
    try {
      metadata = JSON.parse(metadataRaw);
    } catch {
      return json(res, 400, {
        success: false,
        errors: [{ code: 3003, message: "metadata not json" }],
      });
    }
    if (!metadata.assets?.jwt) {
      return json(res, 400, {
        success: false,
        errors: [{ code: 3004, message: "metadata.assets.jwt missing" }],
      });
    }
    const name = m[2];
    const assets = uploadedAssets.get(name) ?? new Map();
    committedWorkers.set(name, { metadata, assets });
    return ok({ id: crypto.randomUUID(), assets: { jwt: metadata.assets.jwt } });
  }

  json(res, 404, { success: false, errors: [{ code: 9999, message: `no route ${req.method} ${p}` }] });
});

// Simulated edge serving: https://name.subdomain.workers.dev/index.html
// exposed on the mock via /edge/<name>/<path> for the E2E test.
const server2 = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const m = url.pathname.match(/^\/edge\/([^/]+)\/(.*)$/);
  if (!m) return json(res, 404, { error: "not found" });
  const worker = committedWorkers.get(m[1]);
  if (!worker) return json(res, 404, { error: "worker not deployed" });
  const want = m[2] === "" ? "index.html" : m[2];
  // Assets were stored by base64-of-content hash; match by content instead.
  for (const [, asset] of worker.assets) {
    if (asset.path === want) {
      const types = {
        html: "text/html; charset=utf-8",
        css: "text/css; charset=utf-8",
        js: "text/javascript; charset=utf-8",
      };
      const ext = want.split(".").pop();
      res.writeHead(200, { "Content-Type": types[ext] ?? "application/octet-stream" });
      return res.end(asset.content);
    }
  }
  json(res, 404, { error: `asset not found: ${want}` });
});

server.listen(PORT, () => console.log(`mock cloudflare api on :${PORT}`));
server2.listen(PORT + 1, () => console.log(`mock workers.dev edge on :${PORT + 1}`));
