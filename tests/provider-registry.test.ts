/**
 * Provider catalog contract.
 *
 * The registry is data, not code — which means nothing in `tsc` or the
 * route tests can catch a malformed entry. Every failure mode pinned here
 * is one a user would only discover by adding a key and watching
 * generation fail:
 *
 *   - an id that isn't `${ID}_API_KEY`-shaped silently disables the env
 *     fallback (`applyEnvKeyFallback` derives the name from the id);
 *   - `.env.example` drifting from those ids documents an env var the
 *     gateway never reads (it did exactly that for Google);
 *   - a `kind` outside the two `resolveModel` accepts throws at chat time;
 *   - the `{account}` template is only expanded for `cloudflare-ai`, so
 *     templating any other entry would ship a URL that can never resolve;
 *   - a localhost endpoint that isn't keyless demands an API key from a
 *     server that has none;
 *   - a placeholder host without a note leaves the user nothing to edit.
 *
 * The 18 hosted entries added for "integrate all the AI providers" are
 * pinned by exact base URL + default model: each was probed on 2026-10-08
 * (unauthenticated POST to `/chat/completions` must reach auth, not 404)
 * and the model id taken from the vendor's own docs or a live `/models`
 * response. A regression here is a wrong endpoint shipped as working.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_PROVIDERS } from "../src/lib/providers/registry";
import { isKeyless } from "../src/lib/providers/gateway";
import { fetchModels } from "../src/lib/models-catalog";

/** Hosted endpoints verified by probe + vendor docs on 2026-10-08. */
const RESEARCHED: Record<string, { baseURL: string; defaultModel: string }> = {
  azure: {
    baseURL: "https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1",
    defaultModel: "gpt-4.1",
  },
  bedrock: {
    baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
    defaultModel: "openai.gpt-oss-120b-1:0",
  },
  cohere: {
    baseURL: "https://api.cohere.ai/compatibility/v1",
    defaultModel: "command-a-plus-05-2026",
  },
  perplexity: {
    baseURL: "https://api.perplexity.ai",
    defaultModel: "sonar",
  },
  cerebras: {
    baseURL: "https://api.cerebras.ai/v1",
    defaultModel: "llama-3.3-70b",
  },
  sambanova: {
    baseURL: "https://api.sambanova.ai/v1",
    defaultModel: "DeepSeek-V3.1",
  },
  nvidia: {
    baseURL: "https://integrate.api.nvidia.com/v1",
    defaultModel: "deepseek-ai/deepseek-v4.1-flash",
  },
  deepinfra: {
    baseURL: "https://api.deepinfra.com/v1/openai",
    defaultModel: "deepseek-ai/DeepSeek-V4-Pro",
  },
  siliconflow: {
    baseURL: "https://api.siliconflow.com/v1",
    defaultModel: "Qwen/Qwen3-32B",
  },
  qwen: {
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3-max",
  },
  moonshot: {
    baseURL: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k3",
  },
  zai: {
    baseURL: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-5.3",
  },
  minimax: {
    baseURL: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M3",
  },
  huggingface: {
    baseURL: "https://router.huggingface.co/v1",
    defaultModel: "deepseek-ai/DeepSeek-V4-Pro",
  },
  novita: {
    baseURL: "https://api.novita.ai/v3/openai",
    defaultModel: "zai-org/glm-5.3-flash",
  },
  nebius: {
    baseURL: "https://api.studio.nebius.com/v1",
    defaultModel: "Qwen/Qwen3-235B-A22B",
  },
  upstage: {
    baseURL: "https://api.upstage.ai/v1",
    defaultModel: "solar-pro4",
  },
  ai21: {
    baseURL: "https://api.ai21.com/studio/v1",
    defaultModel: "jamba-1.5-large",
  },
};

const byId = new Map(DEFAULT_PROVIDERS.map((p) => [p.id, p] as const));

describe("provider registry — structural contract", () => {
  it("has unique ids shaped like an env-var suffix", () => {
    const ids = DEFAULT_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      // applyEnvKeyFallback derives `${ID}_API_KEY`; a digit-led or
      // underscored id would document a var the gateway never reads.
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("never ships credentials — configured is false and no key is baked in", () => {
    for (const p of DEFAULT_PROVIDERS) {
      expect(p.configured, `${p.id} must ship unconfigured`).toBe(false);
      expect(p.apiKey, `${p.id} must not carry a key`).toBeUndefined();
    }
  });

  it("uses only the kinds resolveModel accepts", () => {
    for (const p of DEFAULT_PROVIDERS) {
      expect(["openai", "openai-compatible"]).toContain(p.kind);
    }
  });

  it("has an absolute base URL everywhere except the catch-all", () => {
    for (const p of DEFAULT_PROVIDERS) {
      if (p.id === "custom") {
        expect(p.baseURL).toBe("");
        continue;
      }
      // Absolute http(s) URL; the path may be empty (Perplexity's host
      // serves /chat/completions at the root, and the adapter appends it).
      expect(p.baseURL, `${p.id} base URL`).toMatch(
        /^https?:\/\/[^/\s]+(\/\S*)?$/,
      );
      // Plain http is only ever correct against a server on this machine.
      if (p.baseURL.startsWith("http://")) {
        expect(p.baseURL).toMatch(
          /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//,
        );
      }
    }
  });

  it("has a default model for every entry but the catch-all", () => {
    for (const p of DEFAULT_PROVIDERS) {
      if (p.id === "custom") continue;
      expect(p.defaultModel, `${p.id} default model`).toBeTruthy();
    }
  });

  it("keeps custom last — it is the fallback, not a peer", () => {
    expect(DEFAULT_PROVIDERS.at(-1)?.id).toBe("custom");
  });

  it("templates {account} only for cloudflare-ai, the one entry the gateway expands", () => {
    for (const p of DEFAULT_PROVIDERS) {
      if (p.baseURL.includes("{account}")) {
        expect(p.id, "only Workers AI substitutes a template").toBe(
          "cloudflare-ai",
        );
      }
    }
    expect(byId.get("cloudflare-ai")?.baseURL).toContain("{account}");
  });

  it("explains every placeholder host in a note the user can act on", () => {
    for (const p of DEFAULT_PROVIDERS) {
      if (!/YOUR-|<[^>]+>/.test(p.baseURL)) continue;
      expect(p.note, `${p.id} ships a placeholder URL — document it`).toMatch(
        /replace|settings/i,
      );
    }
  });

  it("treats local endpoints as keyless — no API key exists to ask for", () => {
    for (const p of DEFAULT_PROVIDERS) {
      if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(p.baseURL)) continue;
      expect(isKeyless({ id: p.id }), `${p.id} is local but demands a key`).toBe(
        true,
      );
    }
  });
});

describe("provider registry — documented env keys match the gateway's derivation", () => {
  // applyEnvKeyFallback reads exactly `${ID.toUpperCase()}_API_KEY`. If the
  // example file lists anything else, copying it configures nothing — which
  // is precisely what happened to GOOGLE_GENERATIVE_AI_API_KEY.
  //
  // `needsOwnEnvKey` exempts two structural cases and nothing else:
  //   - the local servers + custom catch-all are keyless (isKeyless);
  //   - Workers AI authenticates with the Cloudflare deploy token through
  //     providerApiKey, never an env var — and its derived name,
  //     "CLOUDFLARE-AI_API_KEY", contains a hyphen no shell can set, so a
  //     hyphenated id could never be env-configured anyway.
  // isKeyless is NOT consulted for cloudflare-ai here: with no settings
  // argument it reads machine state (settings.cloudflare), which would make
  // this contract depend on whether the test machine happens to hold a
  // deploy token.
  function needsOwnEnvKey(p: { id: string }): boolean {
    if (p.id === "cloudflare-ai") return false;
    return !isKeyless({ id: p.id });
  }

  it("exempts exactly the keyless entries and Workers AI", () => {
    const exempt = DEFAULT_PROVIDERS.filter((p) => !needsOwnEnvKey(p))
      .map((p) => p.id)
      .sort();
    expect(exempt).toEqual([
      "cloudflare-ai",
      "custom",
      "lmstudio",
      "ollama",
      "vllm",
    ]);
  });

  const example = fs.readFileSync(
    path.join(process.cwd(), ".env.example"),
    "utf8",
  );
  const documented = new Set(
    example
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Z0-9_]+=$/.test(line))
      .map((line) => line.slice(0, -1)),
  );

  it("documents one env var per credentialed provider", () => {
    const missing = DEFAULT_PROVIDERS.filter(
      (p) => needsOwnEnvKey(p) && !documented.has(`${p.id.toUpperCase()}_API_KEY`),
    ).map((p) => `${p.id.toUpperCase()}_API_KEY`);
    expect(missing, "env vars the gateway reads but .env.example omits").toEqual(
      [],
    );
  });

  it("documents no env var the gateway would not read", () => {
    const derivable = new Set(
      DEFAULT_PROVIDERS.map((p) => `${p.id.toUpperCase()}_API_KEY`),
    );
    const orphans = [...documented].filter((name) => !derivable.has(name));
    expect(orphans, "documented keys the gateway never reads").toEqual([]);
  });
});

describe("provider registry — the README's claims match the catalog", () => {
  const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");

  it("states the hosted-provider count the registry actually has", () => {
    // The count in prose drifts silently: #133's changelog shipped "63 pins"
    // for a file that held 64, because a number written once is never
    // re-read. The registry is the source of truth, so read it from there.
    const LOCAL_OR_CATCHALL = ["ollama", "lmstudio", "vllm", "custom"];
    const hosted = DEFAULT_PROVIDERS.filter(
      (p) => !LOCAL_OR_CATCHALL.includes(p.id),
    ).length;
    const claimed = readme.match(/\*\*(\d+) hosted providers\*\*/);
    expect(claimed, "README should state the hosted-provider count").not.toBeNull();
    expect(Number(claimed![1])).toBe(hosted);
  });
});

describe("provider registry — the researched endpoint set", () => {
  it("pins every probed base URL and default model", () => {
    expect(Object.keys(RESEARCHED).length).toBe(18);
    for (const [id, expected] of Object.entries(RESEARCHED)) {
      const p = byId.get(id);
      expect(p, `${id} missing from the catalog`).toBeDefined();
      expect(p!.baseURL, `${id} base URL drifted from the probed endpoint`).toBe(
        expected.baseURL,
      );
      expect(p!.defaultModel, `${id} default model`).toBe(expected.defaultModel);
    }
  });

  it("keeps every probed provider hosted on its own vendor host", () => {
    // Guards the entry against being silently repointed at a proxy or an
    // aggregator — the note and the key would both then lie.
    const hosts: Record<string, string> = {
      azure: "openai.azure.com",
      bedrock: "amazonaws.com",
      cohere: "cohere.ai",
      perplexity: "perplexity.ai",
      cerebras: "cerebras.ai",
      sambanova: "sambanova.ai",
      nvidia: "nvidia.com",
      deepinfra: "deepinfra.com",
      siliconflow: "siliconflow.com",
      qwen: "aliyuncs.com",
      moonshot: "moonshot.ai",
      zai: "z.ai",
      minimax: "minimax.io",
      huggingface: "huggingface.co",
      novita: "novita.ai",
      nebius: "nebius.com",
      upstage: "upstage.ai",
      ai21: "ai21.com",
    };
    for (const [id, host] of Object.entries(hosts)) {
      expect(byId.get(id)!.baseURL, `${id} host`).toContain(host);
    }
  });
});

describe("fetchModels — no catalog is not the same as a dead provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  function respond(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  }

  it("returns an empty catalog when the host has no GET /models route", async () => {
    // Amazon Bedrock documents this; AI21 answers with an empty list.
    // Labeling either "unreachable" would report a healthy provider as down.
    respond(404, { error: "UnknownOperationException" });
    await expect(fetchModels("https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1")).resolves.toEqual([]);
    respond(405, { error: "method not allowed" });
    await expect(fetchModels("https://example.test/v1")).resolves.toEqual([]);
  });

  it("still reports real failures as failures", async () => {
    respond(401, { error: "nope" });
    await expect(fetchModels("https://example.test/v1")).rejects.toThrow(
      "HTTP 401",
    );
  });

  it("sorts and filters the canonical list shape", async () => {
    respond(200, {
      data: [{ id: "zeta" }, { id: "alpha" }, { id: "" }, { id: null }],
    });
    await expect(fetchModels("https://example.test/v1")).resolves.toEqual([
      "alpha",
      "zeta",
    ]);
  });
});
