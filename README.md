# Anybase

[![CI](https://github.com/theow/anybase/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/theow/anybase/actions/workflows/ci.yml)
[![Node ≥22 <27](https://img.shields.io/badge/node-%E2%89%A522%20%3C27-brightgreen?logo=nodedotjs&logoColor=white)](https://github.com/theow/anybase/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/theow/anybase/blob/main/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://makeapullrequest.com)

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

## CI

Gates run on every push and PR to `main`. The Node version matrix isn't
hardcoded — it's **computed at run time** from the official Node.js release
schedule ([nodejs/Release `schedule.json`](https://github.com/nodejs/Release/blob/main/schedule.json)):

- **Blocking gates** — every released Node major that is currently LTS
  (today: 22 and 24). All of them must pass; the run is red otherwise.
- **Canary** — the newest released major that is scheduled for LTS but hasn't
  gotten there yet (today: 26). It runs the *identical* gate sequence, but
  non-blocking: a canary failure is a yellow warning, never a red run. On its
  LTS date (26 graduates **2026-10-28**) it promotes into the gates matrix
  automatically — no workflow edit, no PR, no drift.
- **`ci-ok`** — a single stable check that is green only when every blocking
  gate passed. Branch protection should require **`ci-ok` and nothing else**:
  per-leg check names change on promotion day, and the canary is intentionally
  allowed to fail.
- **Engines are a contract** — `package.json` engines (`>=22 <27`) must cover
  every blocking leg, and `.nvmrc` must pin one of them. `npm run check:node`
  enforces this locally and in CI, and fails loudly when the schedule says the
  floor needs a *manual* bump (e.g. after Node 22 EOL on 2027-04-30).
- **Monthly self-check** — at 07:17 UTC on the 3rd of each month, CI re-runs
  on the default branch with the schedule re-classified, so promotions and
  EOL demotions surface even with zero pushes. The same run refreshes the
  committed release-schedule snapshot (used when nodejs.org is unreachable)
  and pushes it as a `github-actions[bot]` commit when it changed.

For contributors: open a PR and make `ci-ok` green. A persistent canary
warning is an early signal worth fixing before that Node version becomes a
required gate.

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
- `npm run test` — Vitest suite (CI gates on it)
- `npm run lint` — ESLint
- `npm run check:node` — verify `.nvmrc`, `engines`, and the CI matrix agree
