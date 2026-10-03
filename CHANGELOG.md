# Changelog

All notable changes to Anybase are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org) — patch for fixes, minor for features, major
for breaking changes.

Releases are published automatically when a version bump lands on `main`
and CI goes green — see [CONTRIBUTING.md](CONTRIBUTING.md) for the release
process. Download zips: the
[Releases page](https://github.com/Creative-hub554/Base88Plus/releases/latest).

## [Unreleased]

### Changed
- **The schedule heartbeat no longer calls a late-but-live cron dead.**

  GitHub does not start a scheduled run at its due minute — it queues the run
  at low priority and starts it when a runner frees. The auditor compared the
  most recent due fire time against the runs that had started and flagged the
  difference the moment the minute passed, with no grace at all, despite its
  own header describing a "90 min queue grace" that was never implemented.

  That is wrong by a wide margin in this repo. Both schedules that have ever
  fired came in around eight and a half hours late: CodeQL due
  `2026-09-28T09:23Z` started `17:41Z` (8h18m), and the verifier drill due
  `08:23Z` started `16:48Z` (8h25m). A zero-grace check on an eight-hour lag
  reports healthy schedules as broken. On 2026-10-03 it filed three DEAD
  findings — the CI snapshot cron and two Oct 3 verifier slots, 3h42m, 3h12m
  and 1h52m past due — while every workflow was still `active` and the day's
  19:17Z backstop had not even come due yet.

  The grace is now `SCHEDULE_GRACE_MS`, set to 12 hours: well clear of the
  worst lag measured here, with about 42% headroom. A slot that is due but
  still inside the grace is a note naming the hour it becomes a finding, not
  an alert. Genuinely skipped crons still fail the audit — 12 hours later.
  Pinned in `tests/heartbeat-schedule-grace.test.ts` against the measured lags,
  the exact boundary, and the concrete 2026-10-03 regression.

  The grace note then stopped being silent. Inside the grace, a missing run
  is now classified from the schedule's own history, because a late queue and
  a dying schedule look identical in a run list. A schedule that has fired
  before is quoted its own measured lag, so "one missed slot" has something to
  be measured against; a workflow that has **never** produced a single
  scheduled run is called out as the signature of the 60-day auto-disable,
  which is the case worth being patient about and the case worth not trusting.
  On 2026-10-03 all three late crons landed in the second bucket - none of
  those workflows has ever fired on a schedule - so the note says that plainly
  instead of implying a healthy queue.

- The whole-reply render path now has a deterministic work budget: rendering a
  reply of length n costs at most **461 charged units per 132 characters**,
  whatever the length — counted, not timed.

  That is the claim a user would actually ask for, and it needed three terms
  that nothing was counting: the line split, the block pass, and `safeUrl`.
  The last one is the interesting one. A link's scheme check walks every code
  unit and then lowercases what is left, so a 39-character link unit really did
  cost 65 units of work that no count could see. The many-links cap moved from
  2.2 to 3.7 when that charge site landed, and nothing else in the repo would
  have noticed: a constant factor changes no ratio, in this gate or the timing
  one.

  Coverage is now **29 of the 33 timing-gate probes** deterministically counted,
  up from 8 when the work gate started.

- **The budget found the hole in its own path: `safeLineCount` makes the
  streamed reply quadratic.**

  It reads the whole buffer, from offset zero, once per token. Per call that is
  one pass, which is why it is an ordinary linear entry in the table. Across a
  stream of n tokens it is n passes over a buffer of n, so the whole reply
  costs n-squared to watch arrive: measured at a **ratio of 4.00**, with the
  per-character cost climbing **560 -> 17,610** over the ladder. At the largest
  size measured, rendering one 422,000-character reply a token at a time costs
  about 7.4 billion charged units.

  The block parser is not the culprit and never was. `stats().charsParsed` is
  bounded per TAIL and stays linear, which is precisely why #114's streaming
  work landed and why this sat next to it unnoticed for so long. The two claims
  were never the same claim: one counts the block parser's input, the other
  counts everything the render does with the buffer.

  It is pinned as a measured fact with a test of its own rather than left as a
  comment, because the fix is a change to the streaming parser — resuming
  `safeLineCount` needs the fence state at the resume point, and a boundary
  claimed from the wrong fence state is a boundary the streaming contract
  cannot have. That is a parser change, not an instrument change, and it wants
  its own PR. If the shape ever changes, that test fails and says to replace it
  with a budget.

  Cost of the new charge sites: five extra calls per 132 characters at the
  10.1ns measured in #122, so ~0.5% of the 9.9 microseconds it takes to parse
  that unit. The whole-function A/B reads +4.4% to +5.9% across two interleaved
  runs, which is more than that arithmetic predicts and inside the 7.5%
  run-to-run spread this repo measures on an unchanged build — reported as the
  unresolved measurement it is.

### Changed
- The demo scanners now charge the work counter, taking the work gate from
  eight counted functions to twenty-seven of the timing gate's thirty-three
  probes: `forEachTag`, `forEachTagRun`, `indexOfCloseAnchor`, `textBetween`,
  the link audit, the three demo gates, the sanitiser and its fixed-point
  pass.

  Those are the functions this repo has actually shipped a superlinearity bug
  in, so counting them is what makes the gate mean anything about the code it
  guards. They were also the awkward half: unlike the reply helpers, which
  were single regex passes, these are hand-written loops whose work was
  already visible. The question was not whether to charge but WHICH number to
  charge, and the obvious answer is worthless here.

  **Progress is the wrong number.** Every quadratic scanner this repo has had
  advances one character per `<` while re-reading the remainder, so a count
  taken from how far the walk got reads perfectly linear while the work goes
  quadratic. Charging progress would have installed a gate that passes on
  precisely the bug it exists to catch. What is charged instead is the
  distance each `indexOf` SEARCHED, the whole remainder included when it
  finds nothing.

  Verified by putting the #115 regression back: restoring the one line that
  ends the scan when there is no `>` ahead takes the audit entries to
  **3.87x** work, against this gate's 2.50 limit, while every ratio-only
  instrument in the repo — including the timing gate — reads 2.00x, because a
  ratio cannot see a function that was already quadratic at both ends of the
  ladder. Two more teeth: charging the sanitiser's document a second time
  costs no growth at all and is caught only by the per-character cap, and
  deleting a charge site is caught by the exact counts.

  Nineteen of the new entries carry exact counts, measured rather than
  estimated: `forEachTag` 17n, `forEachTagRun` 5n+5, `textBetween` 44n,
  `visibleText` 49n, `fillerHits` 108n, the sanitiser 60n+25 on a clean page
  and 55n+28 on the unterminated-anchor shape, `demoLooksComplete` 21n+6, and
  `resolveDemoPath` the two input lengths summed.

  **Cost: 10.1ns per charge site, measured directly** over 20 million calls in
  a tight loop (15.6ns armed, which only happens inside a test). The
  whole-function A/B could not resolve it and reported noise in both
  directions across identical runs (-4.7% to +7.2%), consistent with the 7.5%
  this repo measures on an unchanged build; that measurement is reported here
  as the inconclusive thing it is, rather than as a cost.

- `src/lib/demo-link-audit.ts` has one import now, not zero, and `tsconfig`
  permits the `.ts` extension it needs. `scripts/demo-link-audit.mjs` imports
  that file straight into plain node, which does no extension resolution, so
  an extensionless import there breaks `npm run audit:demos`. Found by running
  that command, which is the argument for running it.

### Changed
- `isEmptyFenceOutput` is now an explicit character scan instead of
  `narration.replace(/```[a-zA-Z]*/g, "").trim().length === 0`, which makes it
  work-countable and removes two full-length copies of the reply from a
  per-turn path.

  The old expression answered a yes/no question by building two complete
  copies of the narration. The scan stops at the first character that is
  neither whitespace nor part of a fence marker, so a healthy reply — the
  overwhelmingly common case — is decided in its first few characters.
  Measured A/B in one process, interleaved, min of 11 rounds:

  | narration | old | new | |
  |---|---|---|---|
  | fences then prose (a real reply) | 0.00532 ms | 0.00004 ms | **-99.2%** |
  | prose then a fence | 0.04848 ms | 0.00003 ms | **-99.9%** |
  | stray backticks and 4-runs | 0.08014 ms | 0.00003 ms | **-100%** |
  | every byte a fence marker (degenerate) | 0.02324 ms | 0.01121 ms | **-51.8%** |
  | no fence at all (control) | 0.00013 ms | 0.00013 ms | +0.3% |

  Most of that is the early exit rather than a faster per-character loop, and
  the control is in the table so the case with nothing to win can be seen not
  to have moved.

  It also closed the last *reachable* hole in the work gate. `isEmptyFenceOutput`
  was the worst-reading probe in the superlinearity gate's corpus — the least
  headroom of all 33 — and it could not be counted, because work inside a
  single regex call is not observable from JavaScript. The weakest margin in
  the timing gate belonged to the one function with no deterministic backstop.
  It is now pinned by count, exactly, at `2n` on an all-fence narration, and
  `shouldOfferContinue` is countable through it.

  The whitespace test was the one genuinely new decision: the old code got
  `trim()`'s full definition for free, and a hand-written scan has to spell it
  out. The obvious spelling — a regex per character — measured **+141%** on
  non-ASCII blank padding, because `text[at]` allocates a fresh string for
  every non-ASCII code unit. Switching on the code unit allocates nothing and
  came out 28.8% faster than the regex it replaces.

  Behaviour is unchanged and that is pinned rather than asserted: the old
  regex stays in `tests/refine-loop.test.ts` as a differential oracle, checked
  against 19 hand-picked disagreement cases and 20,000 seeded fuzz strings.
  All three ways found to make the two diverge — dropping a blank from the
  switch, treating a four-backtick run as a marker, letting the tag word cross
  a non-letter — are caught by it.

### Fixed

- The superlinearity gate failing its own re-measurement: a probe that
  CONFIRM rescued could still turn the build red.

  A row of the envelope report recorded the **max** of both readings, on
  the principle that an instrument's diary should never flatter it. The
  report test then asserted that its worst row was inside the limit — so
  the two policies contradicted each other, and the contradiction only
  showed up once a probe was actually noisy enough to need rescuing.

  It showed up on the run that measured this change.
  `prompt / shouldOfferContinue` read **4.86** against the 3.00 limit, was
  re-measured under the limit, passed the gate — and then failed the
  report test at 4.86, with the step summary publishing the exact number
  the gate had just overruled. The gate was right and its own record said
  otherwise, which is worse than either being wrong alone.

  A row now ranks on the reading the verdict rested on and prints the
  rejected one beside it
  (`(re-measured: first reading 4.86)`), so nothing is hidden and nothing
  is counted twice. A rescued probe can no longer fail twice for one
  noisy reading.

### Removed
- `tagText` from `src/lib/demo-link-audit.ts`. It had zero callers in
  `src/`, `tests/` or `scripts/` — re-grepped before deleting, not taken on
  the ledger's word. It existed only as an entry in the perf ledger, filed
  under `UNCALLED`, which is a category for deletion candidates rather than
  an endorsement. A guard that lists dead code as tracked is worse than one
  that misses it: it makes the list look longer than the coverage.

### Added
- The superlinearity gate now also runs on the Node canary leg, as a
  non-blocking measurement, so the engine arrives already measured.

  The CI matrix is computed from the Node release schedule, so node 26 becomes
  a BLOCKING gate on 2026-10-28 with no workflow edit. When that happens the
  superlinearity gate starts gating on 26 that same day — and every number
  behind its configuration was taken on the leg it runs on today. Promotion day
  would have been the first day 26 was ever measured by the instrument about
  to gate on it. #119 already went the other direction and found the same hole
  from the inside: the gate was calibrated on a Node 26 laptop and had only
  ever run on Node 22 in CI, so the first always-report run produced a
  measurement the gate had been missing its entire life.

  The new job gets its own runner rather than a step in the canary job, for
  the reason the blocking one has its own: it measures wall-clock time, and
  folding it in beside the suite would put it on a contended core. Reusing the
  canary job would have been cheaper in wall-clock minutes and worthless as a
  measurement.

  **Non-blocking, permanently.** `continue-on-error`, deliberately absent from
  `ci-ok`'s needs, with `pipefail` so a failed measurement cannot report itself
  as a success through `tee`. Its output is the point: the envelope goes to the
  step summary and is archived as a per-node artifact, so the node-26 envelope
  outlives the log. A measurement that can turn merges red gets muted, and a
  muted measurement is worse than none.

  All four of those properties are pinned by
  `scripts/check-node-contract.js` — it follows the computed canary, stays
  non-blocking, skips itself when there is no canary, and is not wired into the
  required check — with four drift probes in `tests/node-contract.test.ts`
  covering deletion, promotion to blocking, wiring into `ci-ok`, and pinning a
  version instead of following the schedule.
- A deterministic work gate: six hot paths are now pinned by COUNTING the
  characters they scan, not by timing them, which catches a regression the
  timing gate provably cannot see and one it structurally never will.

  The superlinearity gate measures wall-clock time, because that is the only
  thing that generalises across a corpus of functions. But time is a proxy
  for work, and where work is directly observable the proxy has two measured
  costs. A regression to **n^1.5** reads 2.70 against the timing gate's 3.00
  limit and passes — its detection floor is about n^1.65, and lowering the
  limit cannot help because a linear function already measures 2.09-2.16.
  And the *cheapest* functions are the least reliable: `extractFiles` costs
  ~23 microseconds per call and once read 3.22 against that same limit, on a
  function a focused 64x-ladder measurement put at 2.40. It was linear. The
  gate was wrong.

  `src/lib/perf-counter.ts` adds the instrument the repo already had a
  precedent for — `stats().charsParsed` counts characters in the streaming
  parser, which is how the #114 regression was caught — and generalises it.
  Six functions charge their scans: `parseInline` (the #113 shape, where the
  count is *exactly* 4n-1 with the closer memo and n-squared without it),
  `extractFiles`, `extractPartialFiles` on every streamed token,
  `stripCodeBlocks` and `localRefsFromHtml`.

  Counting is better on all three axes that matter:

  - **Sensitivity.** Its floor is n^1.32 (log2 of its 2.5 limit) against the
    timing gate's measured n^1.65, because an integer count has no variance
    to hide in. n^1.5 is caught. The gap is halved, not closed: n^1.25 still
    passes, and a test says so rather than letting the file imply otherwise.
  - **Speed.** 33ms on every `npm test`, against 93s in a separate CI job,
    and it cannot flake because nothing in it is a clock.
  - **A class of regression neither growth measure can see.** A *constant
    factor* is invisible to any ratio: double the work and every ratio stays
    at 2.00. Verified — that mutation is green in both gates. So each entry
    also caps work per input character, which catches it exactly.

  The instrument costs the product nothing measurable. Charging per character
  cost 2ns each and read +6.8% on the `parseInline` hot loop; charging per
  match cost 19ns each and read +10.9% on `localRefsFromHtml`. Both were
  measured against a baseline and restructured to accumulate in a local and
  charge once per call. For scale, measuring the *same build* twice varied by
  7.5% on `stripCodeBlocks` — the noise is larger than the effect.

  Teeth, each verified by deliberately reintroducing it: removing the #113
  closer memo reads 3.96 against the 2.5 limit; a second scan in
  `extractFiles` reads 3.72 units per input character over its 3.6 cap; a
  deleted charge site reads zero and is caught by the exact-count pins.
  `parseInline` on unclosed brackets is pinned to the exact integer 4n-1, so
  the #113 fix is now a fact about arithmetic rather than a timing ratio.

  What it cannot do is written down rather than left to be assumed: work that
  happens inside a single regex call is not observable from JavaScript, so
  `isEmptyFenceOutput`, `shouldOfferContinue` and `isSummaryImitation` stay on
  the timing gate, and a test pins that fact so nobody assumes cover that is
  not there.

- The superlinearity gate now reports its full measured envelope on every run,
  and writes it to the GitHub step summary so each build leaves a durable
  record of what the instrument actually measured.

  Until now the gate revealed its numbers only inside assertion-failure
  messages, so a green run recorded nothing. That quietly produced the worst
  possible state for a measurement instrument: every number behind the shipped
  configuration — the 3.0 limit, the 1.5x calibration floor, the round count,
  the sampling budget — was taken on whatever machine the author happened to be
  on, and CI, which runs this gate on the *oldest* blocking Node leg, never once
  contributed a measurement. The author was on Node 26 (the canary); the gate
  ships on Node 22, so its calibration had never been observed on the engine it
  runs on. The next run produces that missing measurement for free.

  Adding the report immediately paid for itself by exposing a real flake the
  summary output had been hiding: `prompt / extractFiles` read **3.22** against
  the 3.00 limit, but a focused measurement over a 64x ladder (100 to 6400
  files, 5 of 5 trials) put its worst step at **2.40** — clearly linear. The
  function was fine and the gate was wrong.

  The cause is cross-probe interference, not the probe. `extractFiles` is one
  of the cheapest in the corpus (~23 microseconds per call at the smallest
  size), so its ratio is mostly timing jitter, and it runs 22nd of 33 — after
  earlier probes have allocated enough to change when a GC lands inside its
  sample. Measured alone in a quiet process it reads a clean ~2.0. Fast probes
  are the flake-prone ones, and no threshold change fixes that without
  weakening the gate for every probe at once.

  So an over-limit reading now buys a **re-measurement** rather than a red
  build. A genuine quadratic is over the limit on every measurement — that is
  what makes it quadratic — so it still fails, quoting both readings. Noise is
  by definition not reproducible, which is the property this exploits:
  reintroducing the #115 quadratic still fails on both readings (4.11 / 4.09),
  while a healthy run passes at no extra cost.
- The superlinearity gate now states, as measured fact, exactly what it can
  and cannot see. Driving synthetic probes of known exponent through the
  harness (cost exactly `n^p`) gives the whole envelope in one run:

  | exponent | measured worst ratio | at the 3.0 limit |
  |---|---|---|
  | n^1.00 | 2.09 | passes (correct — it *is* linear) |
  | n^1.50 | 2.70 | passes (**invisible**) |
  | n^1.58 | 2.93 | passes (just under) |
  | n^1.65 | 3.62 | **flagged** |
  | n^2.00 | 3.93 | **flagged** |

  Two conclusions. The 3.0 threshold sits 49.5% of the way between a measured
  linear 2.09 and a measured quadratic 3.93 — the midpoint, which is where a
  symmetric-noise instrument wants it — and the measured detection floor
  (n^1.65) lands within 4% of the theoretical one (log2 3 = 1.585). The
  instrument is performing near the best a time-doubling ratio can do.

  And the honest part: **a regression to n^1.5 is invisible to this gate.** It
  reads 2.70 and passes. That is not fixable by lowering the limit — catching
  2.70 would need a limit near 2.5, and a linear function already measures
  2.09-2.16, so the margin would sit inside the noise the harness exists to
  tolerate. Chasing n^1.5 would buy a sub-quadratic regression at the cost of
  a gate that flakes, which is the one thing this gate refuses to be. The gap
  is recorded rather than papered over; if a mild sub-quadratic regression ever
  appears, the answer is work-counting on that function, as
  `stats().charsParsed` does in `markdown.ts`.

  The calibration also got stronger as a side effect of measuring this. It now
  asserts that its quadratic reading is at least 1.5x its own linear reading —
  both measured in the same test, on the same machine, so the comparison is
  immune to how fast the box is. That catches the failure that actually
  threatens the gate, a runner or Node version too noisy to tell the two
  apart, which would otherwise show up only as real regressions slipping
  through unnoticed. Verified to fail when the floor is raised past what the
  instrument can reach.
- The superlinearity gate's tracked surface is now itself tracked. A gate is
  only as good as its list, and a curated list has one failure mode no amount
  of measurement catches: somebody exports a new function from a hot-path
  module, it lands on a latency path, and it simply is not in the list. Nothing
  fails, and the gate keeps reporting green while covering less and less of the
  surface it claims to cover.

  Every exported function in the pure, input-proportional modules (`markdown`,
  `prompt`, `demo-link-audit`, `demo-gates`) must now either be probed by the
  gate or carry a ledger entry saying which of four reasons applies:
  **COUNTED** (something deterministic already pins the work, which is a
  stronger claim than a timing ratio), **REACHED** (it sits in the inner loop of
  something already probed), **NOT INPUT-PROPORTIONAL**, or **UNCALLED**.
  Stale entries fail too, because a ledger that accumulates dead entries stops
  being read.

  Running it immediately found six exported hot-path functions with no coverage
  at all, now probed: `demoNavIsWired` and `resolveDemoPath` (both called per
  link by the demo audit), `relativePathList`, and the three per-turn
  predicates `isEmptyFenceOutput`, `shouldOfferContinue` and
  `isSummaryImitation`.

  It also found two of its own author's mistakes, which is the argument for
  writing it. The streaming markdown parser is *not* timing-probed, because
  `tests/markdown-streaming.test.tsx` already pins its work by counting
  characters parsed — and an earlier draft of this ledger claimed
  `createStreamingMarkdownParser` was unguarded when it was covered by
  something stronger. And the first version of the guard was satisfied by an
  unused *import*, so it went green with six probes missing; it now strips
  import statements and matches only real usage. All three failure directions
  were verified by deliberate mutation before this shipped: a new export, a
  stale ledger entry, and a deleted probe each turn it red.
- A CI gate that fails the build when a tracked hot path's parse time grows
  superlinearly with its input. The three quadratic bugs this parser has
  already had — the reply closer scan (#113), the streaming re-parse
  (#114), and five HTML scanners, one of them cubic (#115) — were each
  invisible to every existing test, because "returns the right answer"
  and "returns the right answer in linear time" are different properties
  and only the first was pinned. This pins the second for a tracked
  corpus: the markdown parser, the demo link audit and gates, the
  anybase block parser, and the slug helper.

  It measures the time-doubling ratio across a doubling size ladder
  rather than an absolute millisecond bound, because a runner is several
  times slower than a laptop and an absolute bound is a coin flip on
  load — whereas a ratio between two sizes measured back to back on the
  same box is largely independent of how fast the box is. Linear work
  reads ~2.0, quadratic work ~4.0, and the threshold is 3.0.

  Three things keep it from being a check that simply passes. It
  **calibrates itself every run** against a deliberately quadratic and a
  deliberately linear function, so a box too noisy to tell them apart
  reports a calibration failure instead of a pass — a gate that cannot
  demonstrate it catches quadratic growth is not evidence of anything.
  Every probe **asserts its own input grows only linearly**, after a
  draft probe that scaled pages *and* links read as a 4.36x regression
  that did not exist. And every probe **asserts it is still doing work**,
  so one whose regex quietly stopped matching fails loudly instead of
  getting faster and guarding nothing.

  Reintroducing the #115 quadratic `forEachTag` was verified to turn the
  gate red (4.12x and 4.22x readings) before this shipped. It runs as
  its own CI job on its own runner, because a wall-clock gate sharing a
  core with the rest of the suite is a coin flip, and coin flips get
  muted; it is aggregated into the required `ci-ok` check, so no
  branch-protection change is needed. `npm run check:perf` runs it
  locally.
- Assistant replies render as real Markdown. The chat panel used to
  understand exactly one construct — `**bold**` — so every heading,
  bullet list, code fence, link and block quote a model wrote printed as
  literal `#`, `-` and backticks. Headings, paragraphs, hard line
  breaks, fenced code (``` and ~~~), bullet and ordered lists, block
  quotes, and the inline set (`code`, **bold**, *italic*, ~~strike~~,
  links, autolinks) now render as elements.

  The safety property is structural rather than filtered: the parser
  emits a plain-data tree whose `Inline` type is a closed union of the
  node kinds this module knows how to produce, and the renderer maps
  that tree onto React elements. There is no HTML string anywhere on the
  path and no `dangerouslySetInnerHTML`, so there is nothing for an
  injection to escape into and no sanitizer allowlist to drift out of
  date — a tag the model wrote stays a text node because no node kind
  means "tag". Link hrefs are the one place a model string reaches a URL,
  so `safeUrl` is the gate: http, https, mailto and site-relative paths
  only, with `javascript:`/`data:`/`vbscript:`/protocol-relative rejected
  however they are spelled or padded, and an unsafe URL degrading to
  plain text rather than vanishing.

  User messages stay verbatim — the user typed the asterisks.

  The parser contains no `String.replace` at all, so it satisfies
  `anybase/no-markup-sanitiser-replace` (the lint rule from #104) by
  construction rather than by exemption.

- Status board view on the dashboard — `/?view=board` swaps the grid for
  three status columns (idea / building / shipped), each with a live
  count and the shared status dot. The Grid/Board toggle is a link (the
  URL is the state, same as the filters) and preserves an active
  tag/status filter; unstatused projects keep a home in a trailing
  "No status" column; and a status save on a board card soft-refreshes
  the page so the card re-sorts into its new column. The card markup
  moved into one shared `ProjectCard` with `grid` and `board` layouts —
  the grid renders identically.
- A lint rule that makes the CodeQL sanitiser finding impossible to
  re-earn: `anybase/no-markup-sanitiser-replace` fails any
  `String.replace`/`replaceAll` in `src/` whose pattern looks like markup
  handling — a tag, an HTML attribute, an escaped quote inside a tag, an
  HTML entity. CodeQL's `js/incomplete-multi-character-sanitization` reads
  every such call as a sanitiser sink and has now flagged this codebase
  three separate times (#96, then twice inside #100), each time fixed by
  rewriting the same one-liner as a manual `exec` loop and each time
  reintroduced by the next change. The alert did not fail anything, so
  nothing stopped the regression; this rule fails at the line that
  introduces it, inside the blocking `gates` job. It is pattern-shaped on
  purpose (a name check like "is the receiver called html" is defeated by
  naming a variable `out`), and it leaves the repo's legitimate replaces
  alone — slug normalisation, `.html`/separator stripping, code-fence
  trimming, whitespace collapsing, even the quote-trimming of git ref
  paths. The fix the message names is the one that already exists in
  `stripBrokenPass`: assemble output from slices, or use a real parser. Three
  rounds of CodeQL feedback shaped the rule itself — the first cut tripped
  the inefficient-regex query three times on three different shapes (an
  unbounded wildcard between two literals; an unbounded `+` wrapping an
  alternation containing `*`; a plain `\s*=` after a literal alternation),
  and each rewrite exposed the next. So the shape detectors are now linear
  string scans with no quantifier anywhere in the file, and a pin rejects a
  reintroduced one outright rather than trusting the next reviewer to spot
  it. A rule whose whole job is to keep a scanner green should not be what
  turns it red.

### Changed

- Refactor of the board-view internals, behavior-preserving: the column
  grouping moved into a pure, unit-tested `groupByStatus` helper
  (`src/lib/board.ts`) instead of triple-filtering with the case-agnostic
  `statusMatches` per column; the view toggle builds its hrefs with
  `URLSearchParams` instead of hand-rolled string concatenation; publish
  state is resolved once per render into a map instead of a disk read per
  card; and the board column headers are real `h3` elements. The shared
  "No status" label is now one constant used by the card select and the
  board column alike.

### Fixed

- The HTML scanners over generated demo files are linear now. Five were
  quadratic and one was cubic, all from the same mistake: a regex of the
  form `/<[a-zA-Z][^>]*>/` used to walk a document. `[^>]*` cannot cross a
  `>`, so a `<` with no `>` after it made the engine scan the rest of the
  file looking for one, fail, and try again at the next `<`.

  That is not a hypothetical shape for model output — a truncated response
  ends mid-tag — and the demo gates run over whatever the model wrote.
  Measured on adversarial input, every one of these grew 4x per doubling:
  the link audit's tag walk (12.4ms for a 3200-character page), the
  label extraction inside it, the `visibleText` gate (4.4ms for 6400
  characters), and the sanitiser's quote repair, which sat inside a
  fixed-point loop and so paid the cost twice per file. The sanitiser's
  tag alternation was worse than quadratic — `[^>]*` on both sides of a
  required literal backtracks through every position twice — and took
  730ms for 800 unterminated anchors, growing about 8x per doubling.

  Two more were quadratic for a different reason: a page's labels were
  resolved by re-scanning and re-slugging the whole page list once per
  link (and once per file, which is just as bad when a demo has about as
  many files as pages), and each anchor lowercased the entire document to
  find its `</a>`.

  Output is unchanged, which is the part worth checking: the rewritten
  walk is pinned against the original regexes on a corpus of awkward
  markup, and the demo link audit still reports the same 71 links, 0
  inert and 6 dead across the six cached demos.
- A long assistant reply no longer freezes the chat panel while it streams.
  The panel re-renders on every token and every assistant message in it,
  so a reply of length n was parsed n times over — about 415ms of
  main-thread work for a 27000-character answer, and it degrades from
  there. Reply rendering is now incremental: about 61ms for the same
  stream, and linear rather than quadratic in the length of the reply.

  The parser is resumable. Almost none of a streaming buffer can still
  change, so the block parser now records where each block begins and a
  per-message parser commits the blocks that are settled, re-running only
  from the first one that is not. Total parsing across a stream dropped to
  2.7x the length of the reply; re-parsing everything costs about 200x.

  Finding where it is safe to resume was the interesting part, and the
  obvious answer is wrong. A blank line is not automatically a boundary:
  the list parser continues a list ACROSS one when the next line is
  another bullet, so `- a\n\n- b` is a single list. Worse, a line that has
  not finished arriving can change what it IS — `2.` parses as a paragraph,
  and one character later `2. ` is a list marker that merges *backwards*
  into the list before it, so a block that was final a moment ago stopped
  being final. A boundary is therefore only claimed behind a line that is
  both settled and not a bullet.

  Rendering benefits from the same fact rather than from a second
  mechanism: a committed block is the same object on every later render,
  so blocks are rendered through a memoised component and a paragraph the
  model finished a second ago is not re-rendered at all. Output is
  unchanged — a streamed reply renders exactly the DOM the finished reply
  would, which is pinned.
- The Markdown reply parser no longer goes quadratic on the length of
  the message. Two checks asked a question whose answer cost
  O(remaining) and then asked it once per character, so both are now
  linear; the builder re-parses the whole streaming buffer on every
  token, so this was paid repeatedly on a growing string.

  An unmatched `[` scanned to the end of the message looking for a
  `]`, and every further `[` did the same again. The scan is
  position-independent, so one failed scan now proves there is no
  closer left and answers later questions in constant time.
  `"[a".repeat(n)` went from 27ms at 3200 characters to 0.2ms.

  The autolink check was worse: it took the whole remainder of the
  message and lowercased all of it to test three scheme prefixes, at
  every `(`-preceded position. `"[a(".repeat(n)` took 592ms at 76800
  characters — over 100x its cost now. It reads one character to
  reject ordinary prose (`h` or `m` can begin an allowed scheme), then
  makes bounded checks.

  One deliberate behaviour change falls out of the bound: the
  authority of a bare URL is now examined for at most 253 characters
  (the DNS name limit), so a "host" longer than any real one is no
  longer autolinked. Link labels, hrefs and the `safeUrl` allowlist
  are unchanged.

- Template demos stopped shipping unstyled markup. The gallery's
  "emit exactly the files the brief describes" rule was read literally:
  no brief names a stylesheet, so the model dropped `styles.css` and four
  of six demos rendered as raw browser-default HTML. The rule now governs
  pages only, and a real stylesheet plus `app.js` are required on every
  demo, linked from every page.
- The blog template generates again. Its brief asked for four pages plus a
  shared data file in one generation, which does not fit — every attempt
  overflowed before closing the code fence and the demo was rejected as
  incomplete. The newsletter page is gone; the tagline follows.
- A truncated generation can no longer be cached as a ready demo. Output
  that ends before `<body>` (the model emitted a 5 KB inline base64
  `og:image` and stopped) was served as a working template whose preview
  rendered blank. Generation is retried unless the html has a body and a
  styling source, and base64 raster blobs are called out as forbidden.
- Clearing a project status actually works: the card select's "No
  status" option used to save the empty string to the meta route, which
  the store rejected as an enum violation — a status could be set but
  never unset. The empty string now clears the status (the same
  contract as the tags field), and only non-empty unknown values are
  rejected with the 400 value list.
- Template demo pages have working navigation. Every page the model emitted
  still carried `href="#"` for its own nav links, so a promoted SaaS
  project had four real pages — index, pricing, about, contact — and a
  navbar that went nowhere. Placeholder anchors are now relinked to the
  emitted page whose slug matches the link's label text (`Home` ->
  `index.html`, `Pricing` -> `pricing.html`); other attributes survive, and
  an ambiguous or unmatched label is left dead rather than guessed at.
- JSON-escaped quotes no longer leak as visible text. When the model wrote
  an HTML attribute containing `\"` (a data-URI `<link rel="icon">` is the
  usual trigger) the parser closed the attribute at the first backslash and
  spilled the rest of the tag into the page as body text. Escaped quotes
  inside tags are rewritten to single quotes, which are legal inside a
  double-quoted attribute and keep the embedded markup intact.
- `**bold**` in a chat message renders as bold. The assistant's opening
  message on a promoted project showed its literal asterisks; assistant
  text now renders inline bold (user messages stay verbatim).
- Promoting a template repairs historical demos. The sanitiser now also
  runs on the cached demo files as they are copied into the new project, so
  every template generated before these fixes comes out repaired rather
  than needing a regeneration.
- An audit that cannot fail is not an audit. The link check that shipped with
  the template work asked "does every href resolve to an emitted file?" and
  reported zero dead links on a SaaS demo whose entire navbar was `href="#"`
  — "#" is a legal target, so a resolved link is not a working link. The new
  `auditDemoLinks` adds the class that check could not see: an **inert**
  link, a placeholder href whose label names a page the demo actually
  emitted. Such a link is always wrong — the target is knowable — and it now
  gates generation, so a demo with an unwired navbar is retried instead of
  cached. The same page also resolves `#fragment` links against the ids a
  page really has, which is how the landing demo's five dead footer links
  (`#terms`, `#privacy`, …) became visible. `npm run audit:demos` reports
  both totals over the cached demos; a dead link is reported but not fatal,
  because failing a generation over an ordinary footer link would throw away
  a good demo rather than improve it.
- The cached demos are repaired at startup, not only on promote. A demo
  generated before a repair rule existed kept its unrepaired bytes in the
  library project forever, so the gallery iframe — which renders straight
  from the cache — kept showing the broken original long after the promote
  path had been fixed. The warm pass now re-runs the sanitiser over the
  cache and writes back only what changed.
- Template demos are checked for whether they contain anything. Every guard
  so far was satisfiable by a page that was technically present and
  completely empty, and all six shipped demos were exactly that while
  passing every check — a walk of all nine demo pages found a SaaS pricing
  page rendering a heading and a blank void (its own table hidden at load
  with no toggle on the page), a contact form that never attached a handler
  so "Send" put the message in the URL, a blog that shipped one of the three
  pages its brief named, and body copy reading "Feature 1", "Project 3",
  "Sponsor 1". Three structural gates now reject that: every file the brief
  names must be emitted; every id a linked script selects must exist on the
  page linking it (or be guarded); and numbered placeholder copy is refused.
  Deliberately no character-count floor — a demo that cannot reach a quota
  is lost from the gallery rather than shown as thin.
- Template generation asks for substance, because it was asking for
  brevity. "100–200 lines per page … a clean section flow beat raw length"
  read as an instruction to be short, and five of six demos came back as
  145–380 characters of visible text inside a competent header and footer.
  The brief now requires real content per section and names the filler it
  has to reject; because one `app.js` is shared by every page, it also has
  to say that shared scripts must be null-safe, must not hide a shared
  element on load, and must use future dates.

## [0.10.0] — 2026-10-01

Fifteenth release: project status — the fourth inline metadata surface,
shipped by applying the freshly distilled recipe to itself.

### Added

- Project status — the fourth inline metadata surface and the first
  application of playbooks recipe 7: set `idea` / `building` / `shipped`
  from a select on the dashboard card (colored-dot badge once set),
  validated by the same meta store as every other field, carried by the
  export/import envelope, and filterable — the dashboard bar now ANDs
  `/?status=` with `/?tag=`.

## [0.9.0] — 2026-10-01

Fourteenth release: tags earn their keep — the dashboard doubles as the
tag filter, and the metadata pattern gets its playbook.

### Added

- Tag filtering on the dashboard — tags earn their keep: every tag on a
  card is now a link to `/?tag=<tag>`, and the dashboard narrows the grid
  server-side to projects carrying that tag (case-insensitive exact
  match). The URL is the state — filters are deep-linkable and the back
  button undoes them — with a filter bar (count + clear) and a
  filtered-empty state. The pencil remains the tags-edit affordance once
  tags exist; the whole-area click-to-edit stays for the empty state.

## [0.8.0] — 2026-10-01

Thirteenth release: project tags — a third inline metadata editor on the
dashboard cards, shipped as a thin shell over the shared meta-edit layer
so the extraction from #84 pays for itself — and the shared layer itself
now covers every inline editor.

### Added

- Project tags: a third inline metadata editor on the dashboard cards —
  one comma-separated string, stored normalized (per-tag trim, empties
  dropped) by the same meta route and store validator as name and
  description, and carried by the export/import envelope so tags
  survive a round-trip. Built as a thin shell over the shared
  `useInlineMetaEdit` layer, so the new surface shares the wire
  contract, server-wins normalization, and failure handling with the
  name and description editors.

### Changed

- The builder-header name editor and the dashboard card description
  editor share one inline meta-edit state machine (wire contract,
  server-wins normalization, failure handling) instead of two copies;
  the header editor is now covered by tests.

## [0.7.0] — 2026-09-30

Twelfth release: metadata editing reaches the list view, and the
automation-hardening work gets its publish — every cron chain now has a
day-after witness and a weekly heartbeat.

### Added

- **Description editing on dashboard project cards** — the metadata
  lifecycle now reaches the list view: click a card's description to edit
  it in place (save, cancel, or clear it back to "No description"),
  backed by the same server-validated PATCH as the builder header.

- **Monitoring stack** — three year-round/one-shot layers under the
  cron-day verifiers so a silently skipped schedule is caught within
  days, not on its next cron day: a day-after sentinel for the Oct 3
  chain (Oct 4 01:00 UTC cron; requires a scheduled oct3-verify attempt
  and a `PASS_*` verdict on #18, trips with a `SENTINEL_*` comment
  otherwise), the same for the Oct 28 promotion chain (Oct 29 cron,
  with a distinct "awaiting dispatch" reminder state), and a weekly
  schedule heartbeat (Mondays 07:53 UTC) that audits every scheduled
  workflow's API state, cron syntax, satisfiability, and last due fire
  vs actual runs — self-auditing, zero dependencies.

### Fixed

- The Oct 29 sentinel ignores premature #18 closures (only a closure
  dated on/after promotion day counts as done), after its own smoke
  drill found the issue closed a month before promotion day.

## [0.6.0] - 2026-09-30

Eleventh release: projects are no longer frozen with the name they were
born with — rename and describe them in place, from the builder header.

### Added

- Rename + describe projects in place: the builder header now shows the
  project's name (`anybase / <name>`) with a pencil — click to edit,
  Enter/blur commits, Escape cancels. `PATCH /api/projects/[id]/meta`
  is the human-edit leg of the metadata lifecycle: the store validates
  (trim, 80/500 caps, non-empty name), bumps `updatedAt`, and returns
  the persisted record; the server-normalized value always wins.
  Ids never change, so dashboard links, snapshots, and the published
  slug stay valid, and the new identity flows through export/import
  via the metadata envelope (round-trip tested through the real
  download route).

## [0.5.0] - 2026-09-29

Tenth release: assets now enter projects as easily as files do — drop
them on the file panel.

### Added

- Drag-and-drop asset upload in the builder file panel: click "+" or drop
  images/fonts onto the file list to add them to a project directly — no
  zip round-trip, no chat detour. The server re-validates everything
  (extension allowlist, 2 MB per-asset cap, basename-only filenames,
  duplicates rejected with an explicit error — replace via zip import).
  The extension allowlist now lives in one isomorphic module shared by
  the store's disk kernel, the importer, the upload route, and the
  picker's accept list.

## [0.4.0] - 2026-09-29

Ninth release and the arc's capstone: projects can carry real images and
fonts — through export, import, publish, restore, and deploy — byte-exact.

### Added

- Binary asset support — projects can now contain real images and fonts.
  Binary assets (png/jpg/webp/gif/ico/woff/woff2/ttf/otf/mp3/mp4/webm/pdf/
  wasm/zip/…) ride the file layer as base64 (`encoding: "base64"`) and are
  written to disk as raw bytes, so they survive export → import
  byte-exact, publish, restore, fork, deploy versions, and Cloudflare
  deploys (hashed and uploaded as true bytes). Serving routes (preview,
  public /p page, template gallery, version history) emit the raw bytes
  with proper content types; the code editor shows a size summary instead
  of a base64 wall; the generation prompt lists binary assets by name
  instead of inlining their contents into the model's context.

## [0.3.1] - 2026-09-29

Eighth release, second of the portability arc: an export now carries its
identity back in, and a clobber hazard on foreign project.json is closed.

### Added

- Metadata-aware imports: exports now embed the project record (anybase
  marker + name/description) as the zip's root project.json, and importing
  an Anybase export restores the app's original name and description. The
  uploaded filename is only a fallback hint for foreign zips — explicit
  name overrides still win, and the envelope's old id/timestamps never
  leak into the fresh project.

### Fixed

- A foreign zip's root project.json is no longer silently dropped: it is
  skipped with an explicit "reserved by Anybase" reason (case-insensitive,
  since writing PROJECT.JSON would clobber the project record on Windows).
  Nested project.json files remain ordinary files — though the store
  excludes that basename from workspace listings at any depth.

## [0.3.0] - 2026-09-29

Seventh release and the first feature drop of the portability arc:
projects can come back in, not just out.

### Added

- Project import — the return leg of the portability story: "Import zip" on
  the dashboard accepts an Anybase export (or any static-site zip), creates
  a fresh project from the sanitized entries, and lands you in the builder.
  Per-entry skip reasons are surfaced (traversal paths, macOS/Windows junk,
  binary assets, size outliers), so one poison file never blocks the rest
  of the bundle.

## [0.2.9] — 2026-09-29

Sixth release of the day: promotion day gets the same autonomous treatment
as Oct 3, and a rehearsal of the verifier's never-taken path caught a dead
alarm before it could matter. No application behavior changes.

### Added

- **Oct 28 promotion-day verifier workflow** — `oct28-verify.yml` runs
  `scripts/verify-oct28.ps1` for real on promotion day (four Oct-28-only
  crons: 07:23 / 09:33 / 13:33 / 19:33 UTC) and posts the verdict on issue
  #18. Firing the promotion dispatch and closing #18 stay deliberate
  operator acts (`NO_DISPATCH_RUN` is exit 0 by design; `CLOSE=1` is never
  set by the workflow). The date-aware smoke mode expects
  `SMOKE_FAIL_NOT_PROMOTED` before promotion — the verifier is supposed to
  say so while 26 is still a canary (#58)
- **One-command promotion-day check** — `npm run check:oct28` answers
  CONFIRMED_PASS / ATTENTION / NOT_YET from the scheduled runs and the #18
  verdicts, routing `NO_DISPATCH_RUN` to the exact dispatch curl (#58)

### Fixed

- **Oct 28 provenance alarm could never fire** — `ConvertFrom-Json` yields
  `_fetchedAt` as a String, and PowerShell's `string -lt [datetime]`
  coerces the datetime to a string, so `2026-09-xx` compared *greater* than
  `2026-10-03` lexicographically (`'9' > '1'`); the "Oct 3 refresh never
  landed" tripwire was dead code. Both sides now cast to `[datetime]`, the
  alarm is date-guarded to on/after Oct 3, and a new `VERIFY_GNOMON` env
  makes the date-dependent branches deterministically rehearsable (#59)

## [0.2.8] — 2026-09-29

Fifth release of the day, and an infrastructure-ops one: the monthly
snapshot-refresh path went from silently broken to self-healing. It started
with a test-fire that caught a dead deploy-key push (the grant-revocation
pass had removed the key and the ruleset bypass actor), and ended with the
repo auditing its own credentials on every CI run. No application behavior
changes.

### Added

- **Deploy-key preflight on every CI run** — `npm run check:deploy-key`
  audits the three legs the monthly snapshot push rides on (a write-enabled
  deploy key, the main-protection ruleset's DeployKey bypass actor, and the
  `DEPLOY_KEY_PEM` secret). A silent revocation now turns CI red within
  days instead of surfacing only on cron day. Uses the `PREFLIGHT_TOKEN`
  secret because `administration: read` is a GitHub App–only permission no
  `GITHUB_TOKEN` can hold; fork PRs auto-SKIP; offline `--self-test` covers
  the verdict matrix (#53)
- **Rotation re-mints the cron deploy key** — `npm run rotate` now re-mints
  the full deploy-key path after every token swap: new keypair, write-enabled
  registration, additive ruleset rebind, sealed `DEPLOY_KEY_PEM`, sealed
  `PREFLIGHT_TOKEN`, strict preflight, and only then old-key deletion. New
  flags: `--deploy-key-only`, `--skip-deploy-key`, `--keep-old-keys` (#54)
- **Pure-Node libsodium sealed box** — `scripts/rotation/sealed-box.mjs`
  (tweetnacl + blakejs) implements `crypto_box_seal` exactly, nonce =
  BLAKE2b-192(ephPub ‖ recipientPub), KAT-verified against stdlib
  `hashlib.blake2b(digest_size=24)` and proven by GitHub accepting its
  secrets; ten offline tests pin the construction (#54)
- **Cron-day Oct 3 verifier workflow** — `oct3-verify.yml` runs
  `scripts/verify-oct3.ps1` for real on Oct 3 (07:47 / 09:07 / 19:17 UTC)
  and posts the verdict on issue #18; a dispatch smoke mode proves the
  plumbing any day (`SMOKE_PASS_UNCHANGED` proven live on Sep 29) (#55)
- **One-command cron-day check** — `npm run check:oct3` answers
  CONFIRMED_PASS / ATTENTION / NOT_YET from the scheduled runs and the #18
  verdicts, with exit codes for scripting (#56)

### Fixed

- **The Oct 3 snapshot push path itself** — the Sep 29 test-fire failed with
  `Permission denied (publickey)` because the repo had zero deploy keys and
  the ruleset had lost its DeployKey bypass actor; re-minted key v3, resealed
  the secret, rebound the actor, and re-fired to `snapshot-push-ok` with a
  bot commit on main (#53 groundwork)

## [0.2.7] — 2026-09-29

Fourth release of the day: the id-drift defect class gets closed at both
ends — the builder can no longer quietly query ids that don't exist, and CI
can no longer quietly accept a pin that does. No application behavior
changes.

### Added

- **Builder prompt: never query nonexistent ids** — a new rule in the
  "Interactive apps: state and timers" section requires cross-checking every
  id/class queried in `app.js` against the HTML shipped in the same reply.
  One wrong id throws on load and kills the app — three of three audited
  generated apps had at least one such defect (#51)
- **Strict-selector mode in the generated-app verifier** —
  `verify:generated -- --strict` (now the CI default) fails any pin whose
  app queries `#id`/`.class` selectors its assertions never seeded, with
  named `STRICT` warnings; previously the auto-creating stubs silently
  satisfied such queries, hiding load-time crashes (#51)

### Changed

- **Pomodoro pin suite aligned with its app** — the suite now seeds exactly
  the selectors `app.js` queries, so the pin passes strict mode with zero
  warnings; the strict sweep over all pins is what surfaced the mismatch
  (#51)

## [0.2.6] — 2026-09-29

Third release of the day: the generated-app quality loop gets a clear-before-
refill rule, two more regression pins, and a one-command pin helper. No
application behavior changes — everything here is prompt, tooling, and CI.

### Added

- **Third CI pin: to-do list with storage** — `tests/generated/todo/` pins
  add/toggle/remove flows, remaining-count semantics, localStorage
  persistence (including a simulated reload), and a pinned quirk. Its
  generation also surfaced the id-drift defect class (three id mismatches
  against its own HTML, fixed before pinning) (#49)
- **One-command pinning** — `npm run new:pin -- <projectId-or-dir>
  <assertions.cjs>` resolves the project, validates the assertions up
  front, copies the app verbatim, runs the full pin set, and rolls the new
  pin back automatically if anything fails (#48)
- **Harness fidelity upgrades** — `textContent` stringifies on assignment
  like the real DOM, `className` syncs with `classList`, `el.dispatch(type)`
  fires submit/keydown listeners, synthetic events carry
  `preventDefault`/`stopPropagation`, and assertions files can require the
  harness back (for reload-style tests) without circular-require surprises
  (#49)

### Changed

- **Builder prompt: clear-before-refill** — handlers that rebuild a dynamic
  list (summaries, results, logs) must clear the container first and rebuild
  fresh; appending on every click stacks duplicate output forever. Pinned by
  the regenerated wizard's refresh-not-append suite (#47)

## [0.2.5] — 2026-09-29

Closing the loop on the generated-app pipeline: how apps get created, how
they run in previews, and how their quality is enforced. Two behavior
changes to the builder flow (#41, #42); the rest is generation-prompt
guardrails, verification tooling, and CI (#43–#45).

### Added

- **Kickoff auto-generate** — creating an app from the `/new` gallery now
  starts the first generation from the typed brief automatically (fires
  once, only when the project has no messages yet, and survives React
  Strict Mode's dev double-mount) (#41)
- **Builder prompt guardrails against mode clobbering** — a new
  "Interactive apps: state and timers" section in the builder system
  prompt: a mode/UI-state function is the single writer and is called
  exactly once per user action, auto-start blocks only start the timer,
  and phase changes belong in the tick expiry branch where counters also
  update (#44)
- **Headless generated-app verifier** — `npm run verify:app` runs any
  generated app in a `vm` sandbox with stubbed DOM/storage and a
  manually-driven interval clock against a small per-app assertions file
  (`setup`/`run` contract); exit 0 = `LOGIC_PASS`, matching the repo
  verifier convention (#44)
- **CI pins for generated apps** — apps pinned under
  `tests/generated/<app>/` (verbatim `app.js` + `assertions.cjs`) are
  re-verified on every push and PR in BOTH the blocking gates and the
  canary via the shared gate steps, so a regeneration that reintroduces a
  pinned bug fails CI instead of shipping silently. First pin: the
  Pomodoro suite, whose mode-clobber guards were proven by mutant testing
  (#45)
- **One-command token rotation** — `npm run rotate` performs the full
  CredMan credential rotation: preflight fingerprint read, supervised
  GitHub device flow (long-runway code minting that survives flow
  errors), swap with read-back verification and auto-rollback, then the
  automated credential battery; operator runbook in `docs/rotation.md`
  (#43)

### Fixed

- **Generated apps using localStorage no longer crash in previews** — the
  preview runtime now installs a storage shim for sandboxed windows whose
  storage accessors throw before any script runs (#42)

## [0.2.4] — 2026-09-27

CI-hardening release: the monthly snapshot bot push went from silently
broken to tripwired, and the promotion-day verifiers now get exercised
every week instead of only on their dates. No application behavior
changes — everything here is workflow, tooling, and docs.

### Added

- **Snapshot push tripwired from three angles** — the deploy-key bot
  push used to be able to die invisibly behind a green run. The monthly
  refresh now exports its push outcome as a `snapshot-push-ok` /
  `-failed` / `-skipped` run artifact (#32), a freshness check in the
  CI matrix job fails the run when the committed snapshot is more than
  30 days stale, so the outage fallback alarms instead of quietly
  rotting (#27), and both runbook verifiers read that artifact FIRST
  when judging a cron run, so a dead push can no longer masquerade as a
  graceful no-op (#34)
- **Weekly verifier drill** — a new `verifier-drill` workflow runs every
  Monday 08:23 UTC (+ on-demand dispatch), fires nothing, and needs no
  secrets: it picks the latest successful CI run on `main` and
  smoke-runs BOTH promotion-day verifiers against it
  (`VERIFY_FORCE=1 DRY_RUN=1 SMOKE_RUN_ID`), with date-aware verdict
  assertions so the pre-promotion canary state is a pass, not a false
  alarm. Verifier logs are embedded in the run summary; any failure
  drops a reminder comment on the promotion-day issue (#34–#36)
- **Promotion-day verifiers are tracked code now** —
  `scripts/verify-oct3.ps1` and `scripts/verify-oct28.ps1` moved out of
  local scratch into the repo, with a `VERIFY_TOKEN` override so they
  run on CI; the Windows Credential Manager path stays the default
  locally (#34)
- **Manual dispatch for CI** — `ci.yml` gained a `workflow_dispatch`
  trigger with an opt-in `force_snapshot_refresh` input (pinned to the
  default branch), so promotion-day verification can be fired by hand
  without waiting for the monthly cron or pushing an empty commit (#28)

### Fixed

- **The monthly snapshot push actually works** — two-stage repair after
  the cron rehearsal exposed a push that died before authenticating:
  the runner now pins the `ssh.github.com:443` host key via
  `ssh-keyscan` (TOFU backstop) (#29), and the deploy key was rotated to
  a URL-commented key so `webfactory/ssh-agent` writes the per-host SSH
  config itself — the bot push goes out over `git@github.com:22` with no
  hand-maintained config. The old key was deleted only after the new
  one was proven end-to-end on a real push (#30)
- **Runbook updated** — the ops notes now carry the full
  host-key/deploy-key/tripwire arc, the verifier smoke harness gotchas,
  and the token-rotation state (#33)

## [0.2.3] — 2026-09-26

Onboarding-release: everything here came out of a fresh-clone newcomer
audit that followed the README and CONTRIBUTING literally.

### Fixed

- **`.env.example` is actually in the repo now** — both README and
  CONTRIBUTING told newcomers to copy it, but the file had never been
  committed (the `.env*` ignore rule swallowed it and the real copy only
  existed in an old workspace). It is tracked via an ignore-rule negation
  (`!.env.example`); real `.env*` files stay ignored (#24)
- **`.gitattributes` added** — CONTRIBUTING asked Windows contributors to
  keep things "`.gitattributes`-friendly" while the file itself was missing.
  LF policy for text files plus binary exemptions, via `text=auto`;
  deliberately no renormalization commit, so existing history is untouched
  (#24)
- **Local gate list matches CI** — CONTRIBUTING claimed its command list was
  "exactly what CI runs" but ordered it differently; it now mirrors the CI
  composite action (`check:node` → `typecheck` → `lint` → `test`) (#24)
- **Release-checklist template includes `check:node`** — the gate CI itself
  runs was missing from the template used to verify releases (#24)

## [0.2.2] — 2026-09-26

Maintenance release — the first cut where every change landed through PRs
gated by the `main-protection` ruleset and was scanned by CodeQL from the
first commit. No application behavior changes beyond the sanitizer
hardening.

### Added

- **CodeQL code scanning** — advanced setup in our own workflow file
  (`.github/workflows/codeql.yml`): `github/codeql-action` pinned to the
  v4.38.2 commit SHA, weekly javascript-typescript analysis of `main`, and a
  new-alerts check on every PR. The Security tab now shows **Code scanning**
  alongside the Dependabot alerts (#14)
- **Node 26 promotion day pre-verified** — the 2026-10-28 zero-touch
  promotion was confirmed by simulating the date (matrix `[22, 24, 26]`, the
  version-contract guard holds, `ci-ok` keeps its identity), and the failure
  edges were probed: the post-EOL engines-floor alarm (2027-05-01), the
  snapshot-staleness backstop (~2026-11-24, refusal reasons stack), and an
  upstream outage on promotion day itself. Tracked in the promotion-day
  checklist issue and the babel 8 migration issue (#17, #20)

### Fixed

- **Demo-sanitizer splice holes** — CodeQL's first scan flagged
  `js/incomplete-multi-character-sanitization` in `sanitizeDemoFiles`: the
  chained one-shot replaces could leave a broken tag behind when an earlier
  deletion spliced the surrounding text into a new well-formed tag. The
  sanitizer is now ONE alternation replace over all three tag shapes
  (img/script/link), iterated to a fixed point, with both splice shapes
  pinned by tests (#15, #16). The residual "`<script` may remain" finding
  was dismissed as a false positive by design: generated apps legitimately
  run their own emitted scripts, and the real splice holes are closed and
  test-pinned

## [0.2.1] — 2026-09-26

Maintenance release: the first cut with the `main-protection` branch ruleset
guarding `main` — every change below landed as a PR gated on green `ci-ok`.

### Changed

- **Dependency refresh** via Dependabot (all merged with head checks green):
  `next` ^16.3.6, `@ai-sdk/react` ^4.0.114, `jsdom` ^30.1.1 plus lockfile
  refreshes (#8, grouped minor/patch); CI tooling updated in place —
  `actions/setup-node` re-pinned to the v7.0.0 SHA (#1) and
  `actions/checkout` to the v7.0.1 SHA (#2), keeping the supply-chain pin
  policy intact
- **Dependabot queue triaged to zero** — the expected-red babel 8 major bumps
  (#4, #5) and the `@types/node` 26 bump (#6, conflicts with
  `engines: ">=22 <27"` until the Node 26 canary promotes on 2026-10-28)
  were closed with explanations; Dependabot re-opens equivalents when the
  underlying migrations happen

### Fixed

- **UTC-midnight-proof fallback-age assertion** — the schedule-fallback test
  pinned the committed snapshot's age as a literal `0d ago`, which is only
  true on the UTC day the snapshot was committed; CI went red the morning of
  2026-09-26 while same-tree local runs hours earlier had passed. The
  assertion now checks the message shape (`fetched <date>, <n>d ago`) instead
  of the literal (#10). Caught by the new branch ruleset on its first day: a
  red `ci-ok` refused the merge exactly as designed

### Added

- **`main-protection` ruleset** (repository setting, not code) — `main` now
  requires the `ci-ok` status check, blocks branch deletion and history
  rewrites, and lets changes land only through PRs (0 approvals, solo
  friendly). Verified both ways: a direct push is refused (GH013) and a
  red-PR merge is refused (405) (#10)

## [0.2.0] — 2026-09-25

First published release, and the first produced by the automated
tag-and-zip pipeline: tagged by the Release workflow at the commit CI
validated, with `anybase-v0.2.0.zip` attached to the
[GitHub Release](https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.0).

The release ships the complete application — the Next.js 16 app builder with
streaming multi-provider generation, live preview, and the fix → pin → publish
recovery flows — together with the full CI hardening arc. 28 test files /
207 tests green; TypeScript strict and ESLint clean.

### Added

- **App builder core** — describe an app in chat; the model streams files into
  a sandboxed live preview; refine by chatting; download or publish when done
  (`465569e`)
- **Pluggable AI engine** — one gateway normalizes OpenAI, Anthropic, Gemini,
  Groq, Mistral, DeepSeek, OpenRouter, Together, Fireworks, xAI, plus local
  Ollama / LM Studio / vLLM and any OpenAI-compatible endpoint; BYOK, keys
  stay local (`465569e`)
- **Fix → pin → publish recovery flows** — one-click AI repair of broken
  generations, pinning of known-good builds, force-guarded publishing with
  the dirty-state badge; real end-to-end test runs the actual route handlers
  with only the provider mocked (`465569e`)
- **CI as the schedule-driven contract** — the Node matrix is computed at run
  time from the official release schedule: blocking gates for every LTS major
  (22, 24), a non-blocking canary for the next one (26, auto-promotes on its
  LTS date 2026-10-28), and `ci-ok` as the single stable required check
  (`fc6b3b6`)
- **Node-range enforcement** — `engines: ">=22 <27"`, engine-strict npm, a
  `.nvmrc` pin (24), and `npm run check:node` as a drift guard proving
  `.nvmrc`, `engines`, and the CI matrix agree; post-EOL floor bumps are
  forced to be explicit (`a29d229`)
- **Outage-proof schedule fallback** — a committed snapshot used when
  nodejs.org is unreachable, refused (never silently stale) when too old,
  when a transition has passed, or when a released even major lacks its LTS
  date (`6ade908`)
- **Monthly self-check with bot-maintained snapshot** — cron `17 7 3 * *`
  re-classifies the schedule with zero pushes and refreshes the committed
  snapshot as a `github-actions[bot]` commit; both steps degrade gracefully
  if branch protection blocks the push, aging toward a loud 60-day refusal
  that names the fix (`1e4d4b0`, `5de09ea`)
- **Automated releases** — `workflow_run` trigger on CI success publishes a
  tag + source zip per `package.json` version; one tag per version, no
  manual steps, asset uploads via the correct host (`7c5921b`, `5de09ea`)
- **Dependabot version updates** — weekly npm and github-actions PRs, grouped
  minor/patch; SHA-pinned actions updated together with their `# vX.Y.Z`
  comments (`31b1123`)
- **Security alerting** — Dependabot vulnerability alerts with automated
  security fixes, secret scanning, and push protection enabled on the
  repository (`b7f400e`)
- **Docs & contributor surface** — README with CI/Release/Node/license badges
  and a CI design section, MIT license, CONTRIBUTING.md, a reusable
  release-checklist issue template with chooser config, and this changelog

### Changed

- CI actions pinned to verified commit SHAs (supply-chain hardening) with a
  Node 22/24 matrix instead of a single-version gate (`b94c01e`)

## [0.1.0] — 2026-09-25

Internal bootstrap version: the initial application commit carried 0.1.0 and
was superseded by the 0.2.0 bump before anything was ever published. No
artifacts exist for this version; it is recorded here so the semver story
stays honest.

[0.10.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.10.0
[0.9.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.9.0
[0.8.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.8.0
[0.7.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.7.0
[0.6.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.6.0
[0.5.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.5.0
[0.4.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.4.0
[0.3.1]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.3.1
[0.3.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.3.0
[0.2.9]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.9
[0.2.8]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.8
[0.2.7]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.7
[0.2.6]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.6
[0.2.5]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.5
[0.2.4]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.4
[0.2.3]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.3
[0.2.2]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.2
[0.2.1]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.1
[0.2.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.0
[0.1.0]: https://github.com/Creative-hub554/Base88Plus/commits/465569e
