# Anybase

**An open, Base44-style AI app builder that works with ANY AI provider.**

Describe an app in chat → the AI writes the files → you see it running in a live
preview. Refine by chatting. Download or publish when done.

The core difference from Base44: **the AI engine is pluggable**. Bring your own
key for OpenAI, Anthropic, Google Gemini, Groq, Mistral, DeepSeek, OpenRouter,
Together, Fireworks, xAI — or run fully local with Ollama, LM Studio, or any
vLLM/llama.cpp server. One unified gateway (`src/lib/providers/gateway.ts`)
normalizes them all through the [Vercel AI SDK](https://ai-sdk.dev)'s
OpenAI-compatible adapter, so adding a new vendor is a one-line catalog entry —
no vendor SDKs, no code changes.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000 → **Settings → AI Providers** → add a key (or point
at a local Ollama server, which needs no key) → **New app** → describe what you
want → watch the files stream in and the preview boot up.

API keys are stored locally in `providers.json` (gitignored) — BYOK, nothing
phones home. Alternatively set env vars per provider (see `.env.example`).

## Architecture

```
src/
  app/
    page.tsx                        # project list
    new/page.tsx                    # create app
    app/[projectId]/page.tsx        # builder workspace (chat + code + preview)
    settings/page.tsx               # provider settings
    api/
      chat/route.ts                 # streaming generation endpoint (AI SDK 7)
      settings/route.ts             # provider CRUD + active selection
      projects/route.ts             # project CRUD
      projects/[projectId]/files    # generated files API
      projects/[projectId]/messages # chat history
      projects/[projectId]/download # zip export
      preview/[projectId]/[...path] # serves generated files to the sandbox
  lib/
    providers/registry.ts           # provider catalog (add vendors here)
    providers/gateway.ts            # unified model resolution for ALL providers
    prompt.ts                       # app-generation system prompt + parser
    store.ts                        # file-based persistence (projects-data/)
    types.ts                        # shared types
  components/builder-client.tsx     # workspace UI
```

## How generation works

1. Chat messages are converted with `convertToModelMessages` and sent to the
   configured provider via `streamText` — through one gateway, whatever vendor
   you picked.
2. The model answers with a fenced ` ```anybase ` block containing
   `=== path ===` sections for each file.
3. The server parses complete blocks as they stream, persists files under
   `projects-data/<projectId>/`, and emits typed `data-files` parts to the UI.
4. Narration text (everything outside code blocks) streams live into chat.
5. The workspace renders files in an editor panel and boots the app in a
   sandboxed iframe pointed at `/api/preview/...`.

## Adding a new provider

Either use **Settings → Custom OpenAI-compatible** (base URL + key + model —
works for Azure OpenAI, Perplexity, Cerebras, NovelAI, anything), or add a row
to `DEFAULT_PROVIDERS` in `src/lib/providers/registry.ts`.

## Roadmap ideas

- Project templates & import/export
- Streaming file diffs with accept/reject per file
- Multi-file awareness in prompt context (currently full contents for context)
- Sandboxed Node runtime for generated backends (Bun/Cloudflare Workers)
- Team workspaces & hosted deployments

## Scripts

- `npm run dev` — start dev server
- `npm run build` — production build
- `npm run typecheck` — TypeScript check
