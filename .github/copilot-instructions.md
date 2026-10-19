# Copilot instructions

## Build, test, and lint

- Use Node.js `>=22 <27` (`.nvmrc` pins Node 24).
- `npm run dev` starts the supervised development server; use `npm run dev:plain` for bare `next dev`.
- `npm run build` builds the production app; `npm start` starts it under the production supervisor.
- `npm run typecheck` runs `tsc --noEmit`; `npm run lint` runs ESLint.
- `npm test` runs the Vitest suite. To run one file, use `npm test -- tests/provider-registry.test.ts`; to select one test, add `-t "has unique ids shaped like an env-var suffix"`.
- `npm run check:perf` runs the separate performance gate. `npm run check:node` checks the Node version contract; `npm run check:legs -- --only test --legs 22` runs a single gate on one Node leg. See [CONTRIBUTING.md](../CONTRIBUTING.md) for CI gates and local multi-leg checks.

## Architecture

- This is a Next.js App Router application. Pages and API handlers live under `src/app`; shared server-side behavior belongs in `src/lib`, and the builder interface is centered in `src/components/builder-client.tsx`.
- A builder chat request goes through `src/app/api/chat/route.ts`: it resolves a provider through `src/lib/providers/gateway.ts`, builds context and parses the model's ` ```anybase ` file sections through `src/lib/prompt.ts`, persists generated file updates, and streams typed `data-files` updates to the client. The client displays the files and previews them through the preview API in a sandboxed iframe.
- `src/lib/store.ts` owns project persistence and versioned snapshots in `projects-data/<projectId>/`. That directory is runtime user/generated-app data, not application source. Publishing and Cloudflare deployment use snapshots so the deployed version can differ from the current workspace.
- Providers use the shared OpenAI-compatible AI SDK gateway. `src/lib/providers/registry.ts` is the built-in catalog; model discovery and model facts are centralized in `src/lib/models-catalog.ts` and `src/lib/providers/model-facts.ts`.

## Repository-specific conventions

- Centralize settings persistence and provider resolution in `src/lib/providers/gateway.ts`. Do not read or write `providers.json` elsewhere; use `getSettings()` and `saveSettings()`. Do not access `settings.cloudflare` directly except in the gateway and the deploy-settings route; use the gateway helpers such as `cfCredentials()`, `providerApiKey()`, `cfSubdomain()`, and `redactSettings()`.
- Provider availability and credential rules have one source of truth in gateway predicates. API responses consumed by the UI should use those predicates rather than re-deriving flags; `tests/api-ui-contract.test.ts` pins this contract.
- Add providers through the registry and the generic compatible adapter, not vendor-specific SDK paths. Verify endpoint and model details, then update the related tests and `.env.example`/README documentation as appropriate.
- Binary project assets are base64-encoded at JSON/API boundaries; use the store's byte helpers rather than treating every `ProjectFile.content` as UTF-8.
- Tests are in `tests/`, run in Vitest's jsdom environment, and often import route handlers directly. File-backed route tests use isolated temporary working directories; follow that pattern instead of relying on local project or provider data.
- ESLint includes architecture guards for settings access and a custom rule against unsafe HTML-sanitization `String.replace` patterns. Keep sanitization behavior aligned with the existing sanitizer and its tests.

For project setup, contribution flow, and CI details, see [README.md](../README.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).
