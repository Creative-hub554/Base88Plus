---
name: Release checklist
about: Track a versioned release end to end — green CI, tag, zip, publication
title: "Release vX.Y.Z"
labels: []
assignees: []
---

<!-- How to use: replace vX.Y.Z everywhere with the version from package.json
     (the release workflow tags exactly that), and <sha> with the commit the
     green CI run gated. Delete any section that doesn't apply — e.g. §4 is
     one-time per repo. The concrete worked example lives in
     docs/issues/v0.2.0-release-checklist.md (v0.2.0, the first release). -->

Release of **vX.Y.Z** from commit `<sha>` on `main`.

## 1. Version bump is on main

- [ ] `package.json` (and lockfile) bumped to `X.Y.Z` — the release workflow
      reads the version from `package.json`; nothing else is edited by hand
- [ ] The bump commit is the tip of `main` and this issue's `<sha>` matches it
- [ ] Local gates green before pushing: `npm test`, `npm run typecheck`, `npm run lint`

## 2. CI green on the release commit

- [ ] Actions shows the CI run for `<sha>` — all green
- [ ] `matrix` job log shows the expected legs (blocking) and canary; the
      matrix is computed from the Node release schedule, so check rather
      than assume (e.g. after an LTS/EOL transition)
- [ ] Every blocking `gates (node X)` leg ✅
- [ ] `canary (node Y)` green, or ⚠ absorbed (non-blocking by design — but
      note persistent canary failures here; they become blocking on the
      version's LTS date)
- [ ] `ci-ok` ✅

## 3. Release workflow fired

- [ ] A **Release** run follows the green CI run automatically
      (`workflow_run` on CI success, `main` only)
- [ ] Annotated tag `vX.Y.Z` created at `<sha>` and pushed
- [ ] GitHub Release published with asset `anybase-vX.Y.Z.zip`
- [ ] Re-running the Release workflow no-ops (tag-exists guard → strictly
      one tag per version)

## 4. One-time: branch protection ruleset

- [ ] Ruleset `protect main` targets `main`, enforcement **Active**
- [ ] Requires status check **`ci-ok` only** (never per-leg names — they
      change on promotion day; never the canary)
- [ ] Bypass: **`github-actions[bot]`**, mode **Always** (monthly
      snapshot-refresh commit needs direct push)
- [ ] Verified: PR shows `ci-ok` required; direct push rejected with `GH006`

## 5. Post-release verification

- [ ] Release page renders; notes name the gated commit
- [ ] `anybase-vX.Y.Z.zip` downloads and `npm install && npm run build`
      succeeds from the unzipped tree (the artifact is a real working copy,
      not just bytes)
- [ ] README CI badge green on `main`

## 6. Notes

- Future releases are exactly: bump version → land on `main` → green CI →
  tag + zip appear. No manual tagging.
- Milestones that affect the matrix (zero-touch promotion on LTS dates,
  EOL demotions going red until the engines floor is bumped) are documented
  in the README CI section.
