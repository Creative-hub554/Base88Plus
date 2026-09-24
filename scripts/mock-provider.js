// Tiny mock OpenAI-compatible provider used to E2E-test the gateway.
// Simulates a "14th provider" streaming chat.completions chunks.
//
// MODES (env):
//   MOCK_DEGENERATE=1     FIRST request returns an unclosed fence after
//                         emitting a COMPLETE poisoned index.html + CSS
//                         section — reproducing the progressive-streaming
//                         failure mode where a truncated attempt leaves
//                         partial files on disk before it dies.
//   MOCK_QUOTA_MODE=      FIRST request simulates a free-tier quota error:
//     partial-then-429      stream a COMPLETE index.html section first
//                           (partial files on disk mid-stream), then emit
//                           an in-stream rate-limit error and close — the
//                           wire shape of a provider dying mid-generation.
//     immediate             respond HTTP 429 with a quota body, no stream.
//   MOCK_POISON=juicy-id  Marker the retry must NOT see: if the retry
//                         request's instructions contain the marker, the
//                         mock answers with app.js containing MOCK_SAW_
//                         <marker> so the test can assert isolation
//                         failed. Clean retry gets a normal counter app.
//   MOCK_WHO=A            Provider label in the narration.
//
// The mock RECORDS every chat request body to mock-requests-<port>.json in
// its cwd (per-port so two instances can run side by side) so tests can
// assert what the server actually sent.
const http = require("node:http");
const fs = require("node:fs");

const APP_FILES = `=== index.html ===
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Counter</title><link rel="stylesheet" href="styles.css"></head>
<body>
  <main class="card">
    <h1>Counter</h1>
    <p id="value">0</p>
    <div class="row">
      <button id="dec">-</button>
      <button id="inc">+</button>
    </div>
  </main>
  <script src="app.js"></script>
</body>
</html>

=== styles.css ===
body { font-family: system-ui; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f4f4f5; }
.card { background: white; padding: 2rem 3rem; border-radius: 1rem; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,.08); }
p#value { font-size: 3rem; margin: .5rem 0; }
.row { display: flex; gap: .5rem; justify-content: center; }
button { font-size: 1.25rem; width: 3rem; height: 3rem; border-radius: .75rem; border: 1px solid #e4e4e7; cursor: pointer; }

=== app.js ===
let count = 0;
const el = document.getElementById("value");
document.getElementById("inc").onclick = () => { count++; el.textContent = count; };
document.getElementById("dec").onclick = () => { count--; el.textContent = count; };
`;

// The degenerate FIRST attempt: complete index.html (with the poison
// marker as a hallucinated element id) + complete styles.css, then a
// partial app.js and NO closing fence — exactly the truncation shape
// that progressive streaming persists to the workspace.
const POISON_DRAFT = (marker) => `Building your app...

\`\`\`anybase
=== index.html ===
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Counter</title><link rel="stylesheet" href="styles.css"></head>
<body>
  <main class="card">
    <h1>Counter</h1>
    <p id="value">0</p>
    <div id="${marker}"></div>
    <div class="row">
      <button id="dec">-</button>
      <button id="inc">+</button>
    </div>
  </main>
  <script src="app.js"></script>
</body>
</html>

=== styles.css ===
body { font-family: system-ui; margin: 0; }
#${marker} { color: red; }

=== app.js ===
const el = document.getElementById("${marker}");
`;

// A minimal but complete index.html section PLUS a partial styles.css for
// the quota attempt: the completed index.html hits disk (progressive
// emission persists a section the moment its next boundary appears), then
// the stream dies mid-styles.css — the exact shape of a real quota death.
const QUOTA_PARTIAL = (marker) => `Building your app...

\`\`\`anybase
=== index.html ===
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Counter</title><link rel="stylesheet" href="styles.css"></head>
<body>
  <main class="card">
    <h1>Counter</h1>
    <p id="value">0</p>
    <div id="${marker}"></div>
    <div class="row">
      <button id="dec">-</button>
      <button id="inc">+</button>
    </div>
  </main>
  <script src="app.js"></script>
</body>
</html>

=== styles.css ===
body { color: #${marker.slice(0, 6)}; }
`;

const QUOTA_ERROR_BODY = {
  error: {
    message: "Rate limit exceeded: daily free-tier neurons quota exhausted (429). Usage resets in 6h.",
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
  },
};

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

let chatRequests = 0;

const server = http.createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-counter-model", object: "model" }] }));
    return;
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const port = server.address().port;
      const logFile = `mock-requests-${port}.json`;
      try {
        const log = fs.existsSync(logFile)
          ? JSON.parse(fs.readFileSync(logFile, "utf8"))
          : [];
        log.push(JSON.parse(body || "{}"));
        fs.writeFileSync(logFile, JSON.stringify(log));
      } catch {
        /* logging is best-effort */
      }

      chatRequests += 1;
      const poison = process.env.MOCK_POISON || "";
      const degenerate = process.env.MOCK_DEGENERATE === "1" && chatRequests === 1;
      const quotaMode =
        process.env.MOCK_QUOTA_MODE && chatRequests === 1
          ? process.env.MOCK_QUOTA_MODE
          : null;
      const who = String(process.env.MOCK_WHO ?? "A");

      // Quota simulation takes precedence: the provider is "out of capacity"
      // on its first request this test run.
      if (quotaMode === "immediate") {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify(QUOTA_ERROR_BODY));
        return;
      }

      // Retry-poison tripwire: a retry whose instructions still carry the
      // failed attempt's draft marker gets an unmissable token in the
      // reply, so the test can assert isolation actually held.
      const retrySawPoison =
        chatRequests > 1 && poison && body.includes(poison);

      const chunks = quotaMode === "partial-then-429"
        ? [
            ...splitIntoChunks(QUOTA_PARTIAL(poison || "quota-partial-id"), 90),
            JSON.stringify(QUOTA_ERROR_BODY), // in-stream error chunk (wire shape)
          ]
        : degenerate
        ? splitIntoChunks(POISON_DRAFT(poison || "draft-only-id"), 90)
        : retrySawPoison
        ? [
            "Retried, but the instructions still contained the draft:\n\n",
            "```anybase\n",
            `=== app.js ===\nconst POISON = "MOCK_SAW_${poison}";\n`,
            "\n```",
          ]
        : [
            `Hello from provider ${who}. `,
            "Here is a tiny ",
            "counter app",
            " for you.\n\n",
            "```anybase\n",
            ...splitIntoChunks(APP_FILES, 120),
            "\n```",
            "\nDone! Check the preview.",
          ].flat();

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      let i = 0;
      const timer = setInterval(() => {
        if (i >= chunks.length) {
          clearInterval(timer);
          if (quotaMode === "partial-then-429") {
            // In-stream quota error: the AI SDK surfaces the error object
            // from the stream and aborts; no finish chunk for this attempt.
            res.write(`data: ${chunks[chunks.length - 1]}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          sse(res, { id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          // OpenAI-compatible clients end streams on [DONE]; without it the
          // AI SDK treats the response as incomplete and RETRIES the whole
          // request (its default maxRetries), which both slows tests and
          // pollutes the request log.
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        sse(res, {
          id: "mock",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }],
        });
        i++;
      }, 5);
      // Abort streaming when the CLIENT disconnects. NOTE: this must be the
      // response's "close", not the request's — since Node 18 the request
      // fires "close" as soon as its BODY is consumed, which would kill the
      // timer before the first chunk and reset the socket (ECONNRESET).
      res.on("close", () => clearInterval(timer));
    });
    return;
  }
  res.writeHead(404).end();
});

function splitIntoChunks(str, size) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

const port = Number(process.argv[2] ?? 4599);
server.listen(port, () => console.log(`mock provider on :${port}`));
