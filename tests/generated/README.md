# Generated-app regression pins

Each subdirectory pins one **generated** app's behavior for CI:

```
tests/generated/<app-name>/
  app.js          # the generated app's JavaScript, copied verbatim
  assertions.cjs  # its regression suite (harness contract: see scripts/verify-generated-app.js)
```

`npm run verify:app -- --all` runs every pin; the step lives in
`.github/actions/gates-steps` so both the blocking gates job and the canary
run it on every push and PR.

Why pins exist: the live generated workspaces under `projects-data/` are
**gitignored runtime data**, so CI cannot see them. A pin is the regression
snapshot — copy the generated `app.js` next to its assertions and commit
both. Re-generating the same brief later that behaves differently will fail
CI here, which is the point.

## Adding a pin

The fast path (resolves the project, validates the assertions up front,
copies both files, and runs the full pin set — rolling the new pin back if
anything fails):

```bash
npm run new:pin -- projects-data/<id> <assertions.cjs>
npm run new:pin -- projects-data/<id> <assertions.cjs> --name my-name --force
```

Manual equivalent:

1. Generate the app (or pick an existing one) and verify it with the harness:
   `npm run verify:app -- projects-data/<id> <assertions.cjs>`
2. `mkdir tests/generated/<app-name>` and copy the workspace `app.js` in
   verbatim, plus the assertions file as `assertions.cjs`.
3. Run `npm run verify:app -- --all` — it must pass before committing.

## What belongs in assertions

- The **bug guards**: whatever defect motivated the pin (e.g. the Pomodoro
  suite's T2 mode-clobber checks — reintroducing the bug must fail the suite;
  that was proven by mutant testing).
- The **single-writer invariants** from the builder prompt's "Interactive
  apps: state and timers" section: mode/visual state written exactly once per
  action, no re-apply in auto-start blocks, phase changes only in tick expiry
  branches.
- Behavior boundaries and leak checks (`h.pendingIntervals()`).
- **Pinned quirks** are welcome — label them `X1, X2, …` with a comment so a
  future regeneration that "fixes" the quirk reads as an improvement, not a
  regression to chase.

## Harness

The runner and the assertions contract (`setup`/`run`, `h.el`, `h.elAll`,
`h.ticks`, `h.fireDocument`, `h.check`, …) are documented in the header of
[scripts/verify-generated-app.js](../../scripts/verify-generated-app.js).
If an app needs a new stub, extend the harness deliberately — never widen it
silently to make one suite pass.
