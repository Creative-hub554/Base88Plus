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

### Added
- **The swap watch includes the app-side reason in its alert, not only the door's finding.**

  A page previously carried only the front door's finding even though the watch had already read the app's
  own output and attached its classification to the per-swap report. Both PagerDuty's `payload.custom_details`
  and a generic webhook's JSON now carry `appSide: [{ client, reading }]`, so the person woken can see whether
  the app answered (including a non-2xx status), never finished, had no line, or could not be read whole. The
  generic webhook's visible `text` includes the same concise reading. Raw request lines are deliberately not
  forwarded — they may contain private URL/query data — and the door's finding, delivery behavior, verdict,
  and exit code are unchanged. When a lost client has no app-side reading, the alert carries a concise
  `NOT CLASSIFIED` reason; it carries an empty list when the swap has no named lost client.

  Pinned in `tests/soak-supervisor.test.ts`: both alert formats include the per-client reason, the generic
  text shows it, no raw request line is sent, and an app-log-backed watch delivers its classified `ANSWERED
  (503)` reason to the alert alongside the unchanged door verdict.

- **The swap watch keeps the app's output across rotation and truncation, so a replaced log is never
  misread as a request the app never saw.**

  The watch read `--server-log` as a path, not as a file somebody else owns: a deploy that rotates
  `server.log` to `server.log.1` (or truncates it in place) left the watch looking at a file that no longer
  contained what the app wrote, and a client the app had ANSWERED was reported as `NO LINE AT ALL` — the
  words for a request cut off at the door, which is a different failure and not this one. The watch now reads
  through a view that keeps what it has read (`startAppLogView`): growth is appended as the delta, the lines
  written between the last look and a rename rotation are recovered from `<server.log>.1`, a file cut back or
  replaced without a recoverable tail is recorded as a gap, and the copy is capped (`appLogKeepChars`, 2MB)
  with the lines the cap drops recorded as a gap too. Each loss is looked up in everything kept, so an
  ordinary rotation costs no reading at all; when the log cannot vouch for its own history, a client it does
  not name is classified `unseen` (a fifth shape, `UNSEEN: …` on the live line) rather than `absent` — the
  absence is the LOG's, and it says so. The gaps ride in `spent[].app.gaps` into the per-swap object, the
  daemon log and the account, and `soak:diagnose` reads them there, so the timeline prints the same `UNSEEN`
  rather than calling the absence the app's after the fact. A file that was missing at the start and appears
  later is announced once and used from then on, instead of the start-up line standing as the last word.

  Pinned in `tests/soak-supervisor.test.ts` against real files: a log answered before a rename rotation is
  still `ANSWERED` after it (the client's line found in the kept copy and the `.1` tail), a truncation with
  no recoverable tail and a file that goes missing produce `UNSEEN` rather than `NO LINE AT ALL`, and the
  cap's `dropped` gap is said the same way; the end-to-end case rotates the file under a live watch. The
  outcome vocabulary (`LOG_SHAPES`) is now five words, and the playbooks' swap-watch note names the
  rotation, the `.1` recovery and `UNSEEN`.

- **The swap watch classifies a lost client from the deploy's own output as the loss lands, so the live line
  says WHY it looks the way it does.**

  The watch named the client a swap cost and stopped there — the reading that says whether the app finished the
  request or was cut off under it was only made afterwards, out of a downloaded account. Now the watch reads the
  deploy's own output at the moment the loss lands (`--server-log <path>`, default `server.log` beside
  `--history`, which is where a soak writes it) and puts the same classification on the line it prints, in the
  same sentence: "the app's own log (server.log) names this client on 1 line(s): GET /?_client=63 503 in 4ms (…) —
  ANSWERED (503): … the loss is the status it got (503), not a silence". The shapes and the wording do not exist
  twice: `classifyLogLines`, `clientLogLines` and `describeAppLines` moved into `scripts/soak-supervisor.mjs`,
  where the file's name already lives, and `soak:diagnose` re-exports them — the live line and the downloaded
  account are one function apart, not two implementations that must be kept in step. The reading also rides in
  the per-swap JSON object and the daemon log (`spent[].app`: the lines, the shape, the statuses and the reason),
  so a pipeline reads what the person watching read.

  A client the output does not name is given one short second look (`appLogGraceMs`, 500ms) before the silence is
  called the app's: the app's lines reach the file through the deploy's pipe while the loss is read from a record
  a different process wrote, and "not written yet" and "never written" are that far apart. Nothing else is
  retried. A watch of a deploy whose output nobody captured is unchanged except that it now says once, at the
  start, that a lost client will be named and not classified. `--server-log` is refused with a soak by name: a
  soak writes `server.log` beside its own account and has nowhere else to look.

  Pinned in `tests/soak-supervisor.test.ts` at both ends: the sentence the watch puts on the line for an ANSWERED
  client with a failed status, for a client the app named and never answered, and for one the output never
  named (the same `describeAppLines` the timeline uses), through `watchDeploy` for the reading at the loss and
  the grace before a silence is called, and end to end on a real deploy whose captured output is the only place
  the app's words exist — the loss the fixture spends is classified `NO ANSWER` on the live line, quoting the
  fixture's own notice, and the ordinal in that quote is the account's `spent[].client`. README, the
  `--server-log` usage and the playbooks' swap-watch note name the flag and the four shapes.

- **`soak:diagnose` classifies a lost client's own lines, so the report says WHY the loss looks the
  way it does instead of only quoting what the app wrote.**

  Following a lost client into `server.log` named the client and printed its lines, and stopped there: the
  reader was left to decide what the quote meant, and one quote covers three different failures. A client
  the app ANSWERED was finished on the app's side, so what the swap cost is that answer on its way back
  through the door — or, where the status is not 2xx, the status the door counted rather than a silence. One
  the app named and never answered was handed over and never finished: the connection ended under it, which
  is what a client cut off at the swap leaves behind. One the log never names never became a line at all,
  so it was cut off at the door BEFORE the app was handed it. Those are not one finding, and the report now
  says which it is:

  ```
  the app's own log (server.log) names this client on 2 line(s): GET /?_client=63 503 in 4ms (…) | GET /?_client=63&page=2 200 in 5ms (…) — ANSWERED (503/200): the client got an answer on every line it has here, so nothing was cut off on the app's side — the loss is the status it got (503), not a silence
  ```

  The shapes are declared once (`LOG_SHAPES`): `answered`, `unanswered`, `mixed` (a client the log has both
  kinds of line for — a retry, a request it later wrote about — read as both rather than as one), and
  `absent`. The reading is made over EVERY line the log has for the client, including the ones kept out of
  the quote by the three-line cap, so a client named four times is not classified by the three that were
  printed. A status is a token of its own in the 1xx–5xx range, which is what keeps the request's own query
  out of it (`?page=200` is a page, not an answer) as well as a `3ms` duration, a port and an instant. The
  one line the account cannot classify is a loss with no ordinal — unchanged, it says it names none — and an
  account with no `server.log` still gets the run-level note rather than a shape invented from nothing.

  Pinned in `tests/soak-diagnose.test.ts` as a case of its own: the three shapes and the mixed one as
  `classifyLogLines` reads them, the query/duration/port boundaries, the exact sentences the timeline prints
  for an ANSWERED client with a failed status, a MIXED one, and a client the log never saw. The real-loss
  soak in `tests/soak-supervisor.test.ts` pins the fixture's own notice — a line that names the client with
  no status — as `NO ANSWER` in the printed report, which is the classification a person reading a lost
  client's line would otherwise have to make themselves. README, `docs/playbooks.md` (SWAP EVIDENCE) and the
  `soak:diagnose` usage name the four shapes.

- **A red run follows a lost client into the app's own log: the soak saves `server.log` beside the account, and
  `soak:diagnose` prints that client's own lines under the loss.**

  Naming a loss by the ordinal the client was handed to the door at only pays off if the log that ordinal is
  keyed in travels with the report — and it did not. The soak's `--dir` held the history, the trend line and the
  sentinel, the CI job uploaded the summary beside them, and the app's request log (` GET /?_client=17 200 in
  3ms (next.js: …)`, the lines the supervisor was already streaming through untouched) was the one artifact a
  person had to go and find. So the soak now writes it: everything the supervisor streams from the app goes into
  `<dir>/server.log` as it arrives, whole rather than filtered to request lines, because a line that fails a
  pattern is exactly the line nobody predicted and the app's stderr is where a page that threw says so. The
  filename is one exported constant (`SERVER_LOG`), used by the writer and the reader rather than spelled twice.

  `soak:diagnose` reads it as a fourth file of the account (optional: an account downloaded before the soak
  saved one is read exactly as it was, and its header says `server.log … not there`). Under each loss, AT the
  swap, it prints the app's own lines that carry that client's ordinal:

  ```
  the swap cost 1 client(s): the 12th client handed to the door (`_client=12` in the app's own request log) — …
  the app's own log (server.log) names this client on 1 line(s): [fake] run 2 cost a client its answer — /?_client=12 closed with no reply
  ```

  The match is on the whole ordinal — `_client=6` must not quote client 63's line, nor client 630's, which a
  substring match would — and it is a regex over the query rather than `grep -F` for that reason. A client the
  log names several times keeps three lines and counts the rest (`and N more`) rather than turning one loss into
  a page. A client the log never saw is SAID: "the app's own log … carries no line for this client — the run
  wrote no answer for it, which is what a client cut off at the swap looks like from the app's side" — which is a
  different fact from a log the reader was not given, and the two are kept apart. The loss itself is unchanged;
  this is the sentence after it.

  `server.log` is uploaded with the rest of the `soak-account` artifact, and the README, the `soak:diagnose`
  usage (`--log`, refused with accounts compared, like the other file flags) and the playbooks' SWAP EVIDENCE
  note say so. Pinned in `tests/soak-diagnose.test.ts`: the exact ordinal boundary (6 against 63 against 630),
  the three-line cap with its count, the null cases (no log, no ordinal), the loss followed by the client's own
  line at the loss's own instant, and the log that has no line for it saying so. The writer is pinned end to end
  in `tests/soak-supervisor.test.ts` on the real loss soak: `server.log` is in `--dir`, exactly one line in it
  carries the handle the printed report named, that line is the fixture's own notice for the client it cost, and
  `soak:diagnose`'s stdout carries it under the loss. The boundary pin was falsified by loosening the regex to a
  substring match (it then quoted two of the neighbour's lines), and restored.

- **A red run's timeline — and the swap watch's live line — names the client a swap cost by the handle the app's
  own log keys it by, so the account and the log are joined without opening the JSON.**

  `swapsAtTheDoor[].spent[].client` carries WHICH client a loss was, and the timeline `soak:diagnose` prints already
  said where that client was (`describeSpent`) — its place in the clients the swap had at the door and in the clients
  the run it went to was handed — while the ordinal itself stayed in the evidence block. So correlating a downloaded
  account with the app's own request log meant opening the JSON for the number, and the reader the timeline exists for
  is somebody who did not write the soak. The loss line now names the client first, in the terms the log is keyed by:

  ```
  the swap cost 1 client(s): the 63rd client handed to the door (`_client=63` in the app's own request log) — the 2nd of the 5 client(s) the swap had at the door — the 1st of the 3 client(s) the run this swap retired (port 4123) was handed
  ```

  The ordinal is not re-derived and nothing new is measured — `clientHandle` in `scripts/soak-supervisor.mjs` prints
  the field the account already carries, spelled the way the soak's own traffic carries it into the app (`_client=`
  on the request the client asks with, see `asked`), which is why the same number is what a log line is grepped for.
  `ordinal` was already there rather than spelled twice, so the places and the name are said in one voice — and so
  is every reader: `nameSpent` (handle, then places) is exported from the same file and used by BOTH the timeline
  and the watch's per-swap line (`describeSwap`, through `spentClause`), so a swap read as it lands says the same
  words about the same client as the same swap read out of a downloaded account afterwards. `describeSpent` itself
  still recites the two places and nothing else, and the reason stands (a reader acting on a finding acts on where
  the client was): the handle is said one level up, by the function that builds the sentence, not inside the clause
  about where the client sat.

  The watch's line, live, is therefore the same sentence with the summary's second place absent by design — it
  judges one swap and cannot say which client of a run it was (`handed` is `null`, see `handedRun`), so the handle
  is what it has to offer, and it offers it:

  ```
  swap 1: replaced, closed by traffic, window 1200ms — 6 client(s) at the door, 2 in flight across the change, 2 lost (the 63rd client handed to the door (`_client=63` in the app's own request log) — the 5th of the 6 client(s) the swap had at the door); …
  ```

  The absence is a fact too, and it is spoken: an account whose clients were not the soak's own traffic carries
  `client: null` for a loss by design, and its line says in words that it names no `_client=` ordinal for that
  loss, instead of printing the places with the handle silently missing — a reader who greps for nothing would
  otherwise not be told that the account, rather than the grep, was the problem.  Pinned in `tests/soak-diagnose.test.ts`: the
  ordinal and the marker are asserted out of the printed line (unit), and the same test file pins the null case and
  the count-only case beside it. `tests/soak-supervisor.test.ts` pins the watch's half on its own: a judged swap
  that cost a client carries the handle on its live line, in the same sentence `nameSpent` builds for the timeline,
  and a loss with no ordinal says so there too rather than printing places with the handle missing. Measured end to
  end on a real soak in `tests/soak-supervisor.test.ts` — the loss
  knob at the third client — where the handle is read out of the REPORT (not the summary), compared with
  `spent[].client`, and then used to find the client in the run's own per-client request log: exactly one line
  carries that ordinal, and it is the line marked `(cost)`, which is the client the run spent. Both halves were
  verified to fail against a shifted ordinal (the unit pin on the spelling, the end-to-end pin on the number), so
  neither is an assertion nothing reads.

- **The client a loss is about is the SAME client the fixture's count spends — one handle, carried by both.**

  The two ends of a loss count each had their own reading of "the Nth client". The fixture names the client its shapes
  spend as the Nth client request the named run is HANDED (`FAKE_AFTER_CLIENTS`), counted in the order the run receives
  them, while the account names a run's clients off the door's own accepts — the accept instants, tie-broken by the
  ordinal the traffic driver handed a client over at — so "the 3rd client" was a place in one order on one side and a
  place in another order on the other, and the two could only be *trusted* to agree. They now carry the same handle:
  **`swapsAtTheDoor[].spent[].client`** is the ordinal the lost client was handed to the door at; the traffic driver
  stamps that same ordinal on the request the client asks with (**`_client=`** appended to the path, beside the
  `_warm=1` marker this tooling already used for its own traffic, so no route and no query a path already had is
  disturbed); and the run the door hands the client to can therefore name which client it spent in the account's own
  terms. Nothing else moved: the finding's sentence is unchanged, and an account whose clients were not the driver's
  (a hand-made one) carries `client: null`, the same absence `handed` takes when the account does not name both ends
  of a run's tenure — while the timeline `soak:diagnose` prints names the ordinal, and says that same absence in
  words where there is one (see the entry above).

  The ordinal itself is now taken where it means what it says: at the instant a client's connection is ESTABLISHED —
  the kernel queues the connection and answers the SYN as one step, so that is the moment the door's queue received it
  — rather than when the request was fired. Measured through the front door, the fire order is only a proxy for the
  door's order and a wrong one where several clients are handed over inside one tick: 2 of one run's 127 clients
  arrived in the reverse of the order they were fired, while the order their connections were established in was the
  order they arrived. The tie-break the account reads and the order the run receives its clients are therefore one
  order, which is what makes "the Nth" one client instead of two that share a number.

  Measured end to end, on real accounts rather than argued: one soak with the loss knob at the THIRD client of the
  replacement run, and the fixture's own per-client request log as the second witness (one line per client it was
  handed, the one it spent marked `(cost)`, the way the standing shape's client is marked when it is left standing).
  The account named the client handed over 63rd, and its place as the 3rd of the 127 clients that run was handed; the
  run's own log had that same 63rd client as its 3rd, and counted 127 clients of that run — one client, one set, one
  order, read out of both witnesses at once.

  Two edges are stated rather than hidden, because both were seen. The account reads a run's tenure off the instant
  the port changed hands, which is a millisecond, so a client the door took inside that millisecond can be counted to
  one run and piped to the other. And the PLACES are places in each side's own count of that run's clients: the run's
  is the order it RECEIVED them in, the account's the order the door took them in, and the two are one order for a
  soak that hands a client over at a time, while a burst can separate them — the door opens a TCP connection of its
  own per client, and two of those handshakes can complete either way round (one run of six at six clients a tick
  received the client handed over 77th before the one handed over 73rd). The client itself is named by the ordinal on
  both sides whatever order it arrived in, which is the agreement that does not depend on traffic.
- **A downloaded soak account says WHICH client a swap spent, not only how many were lost.**

  `swapsAtTheDoor[].lost` is a count, and a count does not say which client it was of the ones a swap is
  answerable for — the difference between "a client was lost" and "the second client this swap took was lost",
  which is what whoever has to act on a red run asks. Each swap's evidence now carries **`spent`**: one entry per
  client it cost, in the order the door accepted them, with the two places a loss can be named by. `atTheDoor` is
  its place among the clients the swap had open around the port change, which is the set the loss is a RATE of (the
  band is wider than the instant, so a client answered inside the window but after the port changed hands was at
  the door and never in flight); `handed` is its place among the clients of the **run it went to** — the replacement
  the swap points at, or the run the swap retired — counted from the swap instants alone, with `handedAt` naming
  when the run the swap retires was handed the port (`null` for the first swap, since a soak's account begins with
  the traffic its first run was handed). The two are never mixed: a rate is taken over the door's clients and an
  ordinal over the run's, and `handed` is **`null`** rather than a number read off some other set when the caller
  names only one swap — which is what the swap watch does, judging each swap as it lands, while the soak names the
  line of swaps a run's tenure is read between.

  Read where it belongs. The door's own finding on a lost client names it ("a client in flight across the port
  change was answered 503 — the 2nd of the 3 client(s) the swap had at the door — the 2nd of the 2 client(s) the
  run this swap retired (port 4000) was handed — the front door holds the port and never closes it, so a swap may
  not cost a client its answer"), the watch's own line carries the same clause after its count, and
  `npm run soak:diagnose` puts it on the account's timeline at the instant the port changed hands ("the swap cost
  1 client(s): …"), matched to its reload by the instant the port changed hands — the same instant the summary and
  the record both take from one record, so a list of swaps written in another order cannot put one reload's lost
  client against another reload's reload. Two silences stay two facts: a swap that lost nothing carries the empty
  list it has and gets no line, an evidence block written before the field existed carries the count alone and the
  timeline says so in words ("the swap cost 2 client(s), and which client each one was is not in this account …"),
  and a summary with no per-swap evidence at all says nothing rather than inventing a swap.

  Measured end to end through the fixture, both halves of the door's claim at once and each on its own side of the
  reading: the client a swap costs of the run it HANDS is named as a client of that run, in that run's port, and the
  client a retirement costs of the run it RETIRES is named as a client of the run it retired — asserted off the real
  accounts and then read back through `soak:diagnose` itself, the way a person reads a downloaded artifact. The
  placements are unit-pinned as well, for the loss the account cannot place at all ("a client the account names no
  place for") and for the absent reading a one-swap caller gets by design.

  A place is a place in the order the **door took its clients**, and that is pinned rather than assumed: the answers
  are recorded in the order their sockets ENDED, so a burst of concurrent clients can come back in the reverse of the
  order the door accepted them — the first client the door takes can be the last whose page arrives, and a reader
  counting the array would name the third client for a loss the first one paid. The accept instants are what the
  order is read from, and where a burst accepts clients in the same millisecond they cannot separate them — so the
  ordinal the traffic driver stamps a client with as it hands it to the door (`opened`) is the tie-break: the order
  the door's queue receives them, and the only tie-break that is about the door rather than about the answers (where
  that ordinal is taken, and why it is taken there, is the entry above). An account that carries no such ordinal keeps
  the order it was given.
  Pinned three ways, on top of the end-to-end pair above: a sequence whose answers settle in the reverse of the
  accept order (the loss is named as the 1st of the 3, not the 3rd), a burst that shares ONE accept instant (the
  same three answers without ordinals name a different client, and that test was verified to FAIL against the
  comparator before the ordinal was added to it), and a real burst of twelve concurrent clients through a real server, where the account's order is asserted equal
  to the door's own accept order client for client, its instants monotone, one distinct ordinal per client, and the
  connections provably open at the same time.
- **The fixture's two loss shapes are counted rather than timed — the Nth client a run is handed — so neither depends on an arm landing inside a window.**

  `FAKE_LOSE_RUNS` and `FAKE_STALL_RUNS` were armed with a delay (`FAKE_FAULT_AFTER_MS`, a few hundred
  milliseconds after the run listened), which is a promise about WHICH client a shape spends dressed as a promise
  about WHEN one arrives. Two ways it could be wrong, neither of them about the door: which client got spent
  depended on whether a request arrived before the arm or after it, so on traffic that is not steady the client
  cost its answer was not necessarily the one the door was being judged on; and the shape that names the run being
  RETIRED had to have its arm land before the swap at all, which for the first run was a few hundred milliseconds
  of luck the fixture had to state as a requirement rather than assume. (What the delay never changed is the narrow
  band a swap is judged over: on `--phases trickle` the first client a replacement is handed arrives seconds after
  the swap, so the loss is in the mix and cannot be attributed to that swap — measured again with the count, `a
  client at 0 of them ... 0 lost` — and that is the band's business rather than the arm's.) What both shapes ARE
  about is a CLIENT, so they count one: `FAKE_AFTER_CLIENTS` (the first, unless it says otherwise) is the Nth
  client request the named run is handed, and the delay is gone from them — it still drives shapes 5 and 6, which
  are about when a run goes bad rather than about which client pays.

  A check is not a client, and that is now one rule instead of an assumption: the soak's own readiness probe
  carries the marker the supervisor puts on its requests (`SELF_MARKER` in `scripts/supervise.mjs`, which exports
  it and `selfUrl` with it, so the two spell a self-request the same way), so the request the soak uses to ask
  whether the port answers is not the first client a run is handed and cannot be spent by a shape. That request
  has a clock of its own now too (`readyAttemptMs`): it was the one request this file made that could hang the
  loop its own 30s deadline exists to end, which is exactly what a door holding a connection open — the stall
  shape — would have done.

  Both facts are pinned on the fixture alone in `tests/soak-supervisor.test.ts`: a marked request is answered and
  does not advance the count, the second client of a two-client run is the one cost its answer while the first is
  served, the Nth client of the stall shape is left standing with its connection open (nothing written into it and
  nothing ending it), and the client after it is served. Each assertion was verified to FAIL against a broken
  fixture — one with the count ignored, one with the marker ignored — and the soak-level case now runs both shapes
  with the count at its default, which is also what proves the readiness probe is not the client it spends.
- **A loss IN FLIGHT across a swap can be exercised on purpose — the fixture can leave one request the run being retired was already serving unanswered.**

  The loss count had one knob, and it only ever moved it in one place: `FAKE_LOSE_RUNS` names the run a swap
  HANDS its clients and closes one client's request with no reply, which is a client lost AT the port change.
  The other half of the same count — a client that was already PIPED to the run being retired, whose request
  outlives the drain — was reasoned about and never measured. The fixture's eighth shape is `FAKE_STALL_RUNS`:
  the run it names comes up healthy, passes every check the supervisor makes straight at it, and leaves exactly
  ONE client's request standing — no reply, no close, nothing written and nothing arming a clock against it —
  so the only thing that can end it is the process being stopped. Naming the run a reload RETIRES (run 1 is the
  run the first reload retires, where `FAKE_LOSE_RUNS` names run 2, the replacement that swap swaps in) is what
  makes the loss the retirement's, and the client it spends is the first one that run is handed
  (`FAKE_AFTER_CLIENTS`), which is long before the swap, so the connection is already piped to it when the port
  changes hands. The door keeps piping it there, gives it the drain to come back in, and stops the run at the end of it
  — a client cut off mid-request, which `swapProblems` reads as `inFlight: 1` rather than `0` for the first time
  and names in its own words (`a client in flight across the port change`).

  `tests/soak-supervisor.test.ts` runs the same two-reload soak a third time, with this knob on the run the
  first reload retires, and asserts what only this shape can: ONE finding and the in-flight wording, the client
  counted at the swap that retired the run it was piped to (with nothing lost at the other), the door's count
  of the run it stopped holding one more connection than the green run's retirement did, and the same `clients
  lost` movement read off the pair's real artifacts through `soak:diagnose`.
- **The soak's loss count can be exercised on purpose — the fixture can cost the door one client its answer, at the swap of your choosing.**

  `swapsAtTheDoor[].lost` is the count `soak:diagnose` reads as `clients lost`, and a soak through
  `tests/fixtures/prod-death-server.mjs` never lost a client, so nothing in the suite ever made it non-zero: the
  rate, the allowance it is judged by and the door's own finding were pinned as units, against summaries a test
  wrote, and never on a real artifact. The fixture's seventh shape is `FAKE_LOSE_RUNS`: the run it names comes up
  healthy, passes every check the supervisor makes straight at it, and closes exactly ONE client's request with no
  reply. The client is always a client of the SWAP: before the door points at that run, every connection the door
  takes is still piped to the run it is replacing, so the first client it is handed is one the swap handed it —
  that swap's own client, with no arm and no delay to land.
  The supervisor's requests are never the ones dropped: they carry `_warm=1` (`SELF_MARKER` in
  `scripts/supervise.mjs`), so the run stays healthy, nothing is rolled back and nothing is restarted, and the only
  finding left is the door's.

  `tests/soak-supervisor.test.ts` runs one two-reload soak twice — once as it always runs, once with the knob —
  and reads the second account the way a downloaded artifact is read: the verdict FAIL, the ONE problem naming the
  reload the client was lost at, `lost: 1` at that swap and 0 at the other, one request fewer than the door's total
  on `200`, and the same loss on the trend line the run outlives. It then runs `soak:diagnose` over the two accounts
  and asserts the `clients lost` line — the movement and the allowance it was judged by, both computed from the two
  real artifacts rather than written into the test, so the loss rate is exercised end to end on what a person
  downloads.
- **A downloaded `soak-account` reads as ONE incident timeline — `npm run soak:diagnose <dir>`.**

  The artifact is three files because three questions have three answers: the summary is what the run FOUND, the
  history is what each reload DID, and the trend line is what the run COST. Reading them together was left to a
  person — three clock shapes (an ISO instant in one file, a duration in another, a `T+` relation worked out by
  hand), reload N in one matched against reload N in the next — and the person doing it is usually somebody who
  did not write the soak. `soak:diagnose` reads the ACCOUNT instead: every reload on the run's own clock (whose
  zero is the earliest instant the account names, which is usually the connection the soak held being accepted —
  it opens the hold before it asks for the reload), oldest first, with what the door did to that connection, the
  instant the count it reports was read (the swap plus the window, which is the record's own arithmetic), how the
  connection ended, how the reload concluded, and what the soak looked for afterwards. The problems of the
  account sit at the reload they are about, on the same clock as the facts behind them — which is the point, since
  a door claim names one reload and is read against that reload's swap, its hold and its count.

  No vocabulary is restated and nothing is measured twice: the history goes through the deploy gate's own
  `parseReloadHistory`, the outcome words come from `verdictFor` — the declaration the settings page colours its
  rows with — and the trend line is judged by `judgeSoakTrend`, so this command cannot disagree with
  `check:soak-trend` about what the run cost or about what a red line's held connections were.

  A file that is not there is reported rather than fatal, and the account is read from the rest: a soak that could
  not be run writes no summary and no trend line either, and the run's own problems and notes are then read from
  the trend line, which carries them. A file that IS there and cannot be parsed is `exit 2`, because half an
  incident read as a whole one is how a wrong diagnosis gets made — while a line of the history that is JSON but
  not a record this reader can use is named with its line number and does not hide the rest of the file. Exit 0 is
  an account with nothing wrong in it, 1 is one that carries a problem, 2 is one that could not be read.

  Pinned in `tests/soak-diagnose.test.ts`, which builds every account through the writers (a summary shaped the
  way `--json` writes one, `trendRecord`, `base88.reload/1` records) and reads it back through the real process —
  including the answers placed at their own instants, a hold that was refused where the refusal happened, and a
  record written before the instants existed, which falls back to the swap's own line.
- **Two `soak-account`s can be compared — `npm run soak:diagnose <green> <red>` prints only what changed.**

  After a red run the question is almost never what the account said but what is DIFFERENT from the run that
  passed, and reading two timelines side by side is how that gets answered wrongly: the two runs are on two
  clocks and two ports, so the eye matches the wrong reloads and the numbers that agree are as loud as the ones
  that do not. Naming a second account makes the comparison the report: each run's verdict, profile, file set,
  problems and notes, and every reload's phase, outcome, how its window ended and the connection it held across
  the swap — and NOTHING else, so a fact that is the same in both is never printed at all.

  The comparison is by FACT rather than by text, and the facts it excludes are excluded BY NAME and said so at
  the foot of the report: instants, ports, window durations, descriptor counts and how many connections each run
  happened to serve are the identity of ONE run, so comparing them would put a change in every comparison and
  bury the ones that matter. That last exclusion is MEASURED rather than argued — two real three-reload soaks of
  one build, compared through the first version, differed by exactly one fact (reload 1 serving 8 connections
  against 7) — and what the traffic MEANT is the run's `problems`, which is compared, so no leak verdict is lost
  with the raw count. The held connection is compared field by field — its shape marker included, so two accounts
  in different shapes are compared with that visible rather than one of them reading as a quiet hold — and its
  answers' own instants are not compared, because WHAT was said to it is the comparable fact.

  What a run **COST** is compared too, which is the half a diff needed before it could name a regression at all:
  each phase's median reload and the run's total come off the trend line (the file whose job is to carry what a
  run cost, and where `check:soak-trend` reads the same two numbers from) and are held to that gate's OWN
  allowances — a quarter of a phase's median or 2s, a fifth of the run's total or 10s — so a run that got slower
  is a difference instead of two accounts reading as `SAME` because they happened to carry the same problems. A
  movement inside the allowance is silent (two readings of one duration never match, and a line per noise is how a
  diff stops being read), a run that came out faster is reported too because a difference is a difference, and a
  pair that ran on different profiles is reported as **not compared** rather than diffed — two machines are not two
  measurements of one thing, which is the same reason the gate refuses it. The machine line gains
  `cost=<±Nms|?>`, so how much more (or less) the second run cost in total is readable without the prose.

  Exit **0** when both accounts were compared and **2** when one could not be read: `DIFFERENT` is the answer
  rather than a failure, because a diff command that failed whenever its two inputs differed would be one no
  pipeline could use, and only `SAME` says the two runs agreed about everything comparable. `--summary`,
  `--history` and `--trend` name a file of ONE account and are refused with two rather than silently applied to
  one of them. Pinned in `tests/soak-diagnose.test.ts`, which builds a green and a red account from the writers,
  asserts that only the differing facts are printed, that a run with only its ports, clock, window, descriptor
  readings and served connections moved reads as `SAME`, that a reload only one account has and a hold in an
  unknown shape are both reported as what they are, that one unreadable account is exit 2 with the lines
  marked one-sided, and that the cost side reports a phase median or a run total moving past the gate's allowance
  (in either direction) while a movement inside it stays silent and a pair from two profiles is not compared at all.
- **Three or more `soak-account`s compare as a regression SERIES — `npm run soak:diagnose <r1> <r2> <r3>…` names the run each fact first changed in.**

  A pair answers "these two runs differ", which is not the question a regression asks: the question is WHICH run
  introduced the difference, and holding three or four artifacts in the head as pairs is how that gets answered
  wrongly — every fact has to be traced across the comparisons by eye. Naming three or more makes the series the
  report. The runs are the order they are named and never re-sorted (an account's own instants may be missing — a
  run that died early leaves no summary and no trend line — while the command line is always there), and the header
  names every one of them, so a series handed over out of order is visible. The comparison itself is the
  CONSECUTIVE PAIRS, each read exactly as a pair is, merged so that a fact which moved is one line carrying the run
  it FIRST moved in.

  A fact that moves twice is two differences, and one that moves back and forth between two values is one
  difference naming every run it happened at — the alternative is a series that reads as flat when it is not. Each
  step is judged against the run BEFORE it rather than against the first run, which is what "first changed" means
  and is also how `check:soak-trend` reads a run against the runs before it: a series whose numbers crept up a
  little at every step is a regression even though no single run is far from the first. A run nobody could read is
  named before anything found at a step into or out of it is believed, and the exit code stays about the READ — 0
  when every account was read, 2 when one was not.

  Two facts that are simply ABSENT now say so instead of saying which side is missing: a reload one of the runs
  never performed, and a phase whose median one of them does not name, are `changed` facts whose absent side
  prints as `(none)` — so one fact reads one way in a pair and in a series, and the same is true of a held block
  that is not there. The machine line generalises with it — `accounts=N … reloads=N/… cost=<±Nms|?>` — and `cost`
  is now the LAST run against the FIRST, the drift over the whole series. Every difference in the `--json` output
  carries `run` and `runs`, so a consumer can bisect a regression without reading the prose.

  Pinned in `tests/soak-diagnose.test.ts`: a series where the door claim first appears in run 3 and a second
  problem only exists from run 4 (each named at its own run), a verdict that moves and moves back, the same change
  happening twice (one difference, both runs named), a cost movement named at the run it started in, an unreadable
  run named before its steps, and the JSON shape a consumer reads.
- **Two `soak-account`s are compared on what their DOOR did, as rates rather than as counts.**

  The comparison already read what each run FOUND (its problems), what each reload DID, and what the run COST — but
  not what its front door was ANSWERED, which is the fourth thing a green run and a red one differ in. How much
  traffic arrived cannot be part of that comparison, and the reason is measured rather than argued: three soaks of
  one build through the same fixture counted 61, 59 and 62 requests and served 61, 59 and 62 of them 200, so the
  raw count moves by three between runs of the SAME build while the mix does not move at all. So the door is
  compared in the only form two runs of different traffic can be: each status's SHARE of the requests the door was
  offered, its `timeouts` and its `connection errors` as shares of the same, the clients in flight per swap that
  had one, and the clients a swap LOST as a share of the clients those swaps had AT THE DOOR — each line printing
  the counts it was divided from, so a reader sees the sample a percentage came from instead of trusting the
  percentage.

  The allowance is that measurement too: five percentage points of mix (three requests in sixty, which is the
  wobble the traffic itself has) for the rates measured over the traffic, and half a client for the two measured in
  clients — the mean in flight, since a client is the unit that can move at a swap, and the loss, since a client is
  also the unit the door's own promise is made in ("a swap may not cost a client its answer"). A movement inside it stays silent — two stray answers in forty are the load, not the door — while a
  share that appears where the run before it had none (three 503s in a run that answered everything 200) is
  reported as the zero it is, because the door counts every answer it gives. A run whose record names no traffic is
  REPORTED as not compared rather than read as a door with nothing behind it, and a mean with no denominator (a run
  whose swaps had no client at the door) is `(none)`, which is a different fact from a mean of zero.

  A lost client is a rate rather than a restatement of the run's problem, and its denominator is the clients each
  swap had at the door rather than the ones in flight: the soak counts a loss among the clients that were there for
  the port change — its own per-swap line says "N client(s) at the door ... L lost" — and the band is wider than
  the instant, so a client answered inside the window but after the port changed hands was at the door and never in
  flight. Dividing losses by the in-flight count would read a loss off a sample that never held it, and with a
  client genuinely in flight could read one as more than all of the clients that mean was over. What the rate adds
  is the magnitude of a finding the run group already carries — the reload a client was lost at is its fact, and a
  run that lost one did not pass — which is the half of it two problem sentences cannot be compared on. That half a
  client is taken of whichever run had MORE clients at the door, because that is where one client moves the rate by
  the LEAST: half of that step sits under every single client either run can lose, so a client the door cost an
  answer is a movement at ANY sample size — a fixed five points would have been a floor that got looser as the
  sample grew, and the loss such a floor hides is exactly the one worth showing (three clients among a hundred and
  twenty is 2.5 points, against the 0.4 that half a client of that sample comes to). Half a client of the run with
  FEWER clients was the alternative, and it is rejected for the same reason the larger sample is taken: a loss
  among forty (2.5 points) beside a run of three would have had to clear 16.7 points and would have read as nothing
  at all. To read it off an account, the trend line's `door` block gains
  `clientsAtTheDoor`, the way it already carried `lost`; a summary is summed from the swaps it carries instead, so
  a record that names the per-swap detail reads the same rate without the projection.

  The report gains a `the door` group after `the run's cost`, the foot names both the rates that ARE compared and
  the raw counts that are not, the `--json` differences carry the same field names (`status 503`, `timeouts`,
  `connection errors`, `clients in flight`, `clients lost`), and a series names the run each rate first moved in like any other
  fact. Pinned in `tests/soak-diagnose.test.ts` with a `door` override on the summary fixture: two runs whose
  traffic differs by 3 in 60 and whose mix does not read as `SAME`, a 200 share falling seven and a half points and
  a 503 share appearing where there was none, the failures the soak counts under its own `!` keys rated once each
  rather than as statuses too, the mean in flight per swap with a client and the `(none)` a run with no such swap
  gives, a series naming the run the mix moved in, an account that names no traffic skipped by name, the reading of
  a run whose trend line never arrived (the summary carries the same counters, being where they are measured), and
  the group as a unit and in the JSON a consumer reads. The loss rate is pinned beside them: a swap that cost one
  of the three clients at its door against a run that lost none, the same three losses read as 3 of the 6 clients
  at the door while the in-flight mean is 0.00 (the band the loss is counted among, against the instant the mean
  is), a door block written before the loss was carried in it read as NOT THERE rather than as none, a summary's
  losses summed from the swaps it carries, and three clients lost among a hundred and twenty at the door called a
  movement against half a client of that sample (0.4 points) where the traffic's own five would have swallowed it —
  with the run group naming that client either way, since the rate is the magnitude of the run's problem rather
  than the problem.
- **ONE `soak-account` can say how far it drifted — `npm run soak:diagnose <account> --baseline <soak-trend.jsonl>`.**

  A downloaded artifact had no way to answer the question a person actually arrives with, because there was nothing
  to compare it against: the run's own trend line is one record, and the gate's across-runs half needs three earlier
  runs. `--baseline` names a STORED trend line — the file a soak appends one line per run to, which is exactly what
  a person keeps — and the run is then read against the runs BEFORE it, which is the comparison one artifact cannot
  otherwise make.

  The numbers are the gate's numbers rather than a second reading of them, which is what keeps the two readers from
  disagreeing: each phase's median reload and the run's total, against the **median** of the baseline records' own
  per-phase medians and totals, held to the allowances the across-runs half uses (a quarter of the baseline's median
  or 2s on a phase, a fifth of the total or 10s). What counts as a baseline is the gate's decision too, not this
  command's: an earlier run on ANOTHER profile is not one (two machines are not two measurements of one thing), a
  run that did not PASS is not one (a run that leaked must not become what normal looks like, and the numbers of a
  run that stopped read as the numbers of a fast one) — and the run's OWN LINE is not one either, because a trend
  file kept across runs is the very file the run just appended itself to. That line is recognised by its instant and
  named, so a reader sees that the file they pointed at is that file rather than quietly reading a diluted baseline.
  Every record left out is counted and its reason said, one line each.

  Two things are READ rather than refused, with the caveat named instead of the number withheld: a baseline thinner
  than the gate's three runs (a lone artifact is exactly when a person wants the number — the report says the gate
  would not judge a trend on it, because a median of two runs is a coin toss), and a run that did NOT pass
  (`check:soak-trend` judges only a run that passed, since a stopped run's numbers read as a fast one's — but here
  the artifact in hand is the red run being diagnosed, and a red run that got slower is precisely the finding
  somebody came for). The report gains a `BASELINE` section naming the file, what of it was a baseline and why the
  rest was not, and the cost facts that moved past the allowance, with the direction said once because a lone
  account has no `first`/`second` to read a `->` against. The machine line is
  `SOAK_DRIFT=DRIFTED|WITHIN|NOT_COMPARED records=N compared=N differences=N cost=<±Nms|?>`, and `--json` carries the
  same reading under `drift` (`null` when no baseline was named, which is not the same answer as a comparison that
  found nothing). The exit code stays about the READ: a baseline that reads and holds nothing of this profile is
  `NOT_COMPARED` with the account's own code standing, while a file that cannot be read at all is `exit 2`, because
  the comparison that was asked for could not be made. `--baseline` needs ONE account and is refused with accounts
  compared, where the accounts themselves are the comparison.

  Pinned in `tests/soak-diagnose.test.ts`: a slow phase drifting past the allowance from a three-run baseline, a run
  within it, a kept file whose own line is excluded and named, a baseline holding a line from another profile, a
  failing run and a line that is not a record (each counted and said), a baseline thinner than the gate's floor, an
  unreadable file (exit 2 with the account still printed whole), a red run measured with its caveat named, and the
  JSON shape a consumer reads.
- **Every reload's held connection is now part of the soak's account — in the summary the `soak` job uploads AND in the trend line — so a red door claim is diagnosed from the artifact rather than from a re-run.**

  The soak keeps one connection open across every swap, and the claims the door is held to are about THAT
  connection: it may not be answered while the run it was piped to is serving, it may not be closed by a swap,
  the run the door retires must still report it (`leftoverConnections`), and it may not be handed to the
  replacement afterwards. The run's problems name the reload, but the facts behind the claim were only in the
  line a person had to re-run the soak to see: which of the four failed, and why. They are now carried per
  reload, and for EVERY reload including one whose connection the door never accepted — that case used to leave
  `held: null`, so the account said "no connection" and nothing about the refusal that explained it.

  Each reload's `held` block now says whether the door accepted the connection at all and, if not, why it ended
  (`ECONNREFUSED` and friends); WHEN it was accepted; what the door or the run said to it while it was held, as one
  object per answer carrying its status and its instant (plus how many there were, which the list's length is);
  whether any of it came BEFORE the port changed hands (an answer before the swap is the door costing a client its
  answer; the door's own retry-503 for a connection whose run is gone is the ordinary discharge); when it ended;
  whether that ending came before the count the door took, which is the fact that decides whether that count could
  be evidence about this connection at all; and the count itself.

  Those instants are there so the connection can be PLACED rather than only classified. `acceptedAt` is when the
  door took it, and each answer is one object of its own — `{ status, at }` in `answered`, so the status and the
  instant are facts of the same answer and there is no count to keep in step (the list's length is the count, and
  two lists beside each other are two lists that can drift). Whether an answer is a FINDING stays the aggregate
  fact the verdict turns on (`answeredBeforeSwap`), because a trend line names a reload by its held connection and
  carries no swap instant to compare one against — while `npm run soak:diagnose`, which reads the summary and with
  it the swap, reads each answer against the instant the port changed hands and puts it where it arrived.

  Two places carry it, because one of them outlives the run. The summary `--json` writes has it in
  `reloadsDetail[].held` — that is the file the CI job uploads as `soak-summary.json`. And `trendRecord`
  projects it into the trend line as `held`, one entry per reload in the order they happened, with the reload's
  own identity and the port of the run the count was about: a trend file accumulates one line per run and is
  what gets downloaded later, so it has to answer a door claim on its own. Deliberately not grouped by phase
  the way a timing is — a claim names ONE reload, and that is the entry it is read against.

  The reader names them, too. A run that did not pass is judged by nothing (`check-soak-trend` exits 2), which
  left the reader with a problem string and no facts; a failing record's NOT-JUDGED lines now carry the shape
  of what it held and name the reloads whose hold is not the ordinary shape — never accepted (with the reason),
  answered, given up on by the run, ended before the count, or still open when the door reported a count below
  it. A red run whose holds are all ordinary says so in one line, which is a diagnosis in itself: the problem
  is then not the connection the soak held.

  Pinned in `tests/soak-supervisor.test.ts` (the fixture soak asserts each reload's block, and that the trend
  line's `held` entries carry the same counts and ports in the run's own order) and in
  `tests/soak-trend.test.ts` (the projection, the reader's lines for each shape, and the NOT-JUDGED output
  through the real process).
- **A reload's `held` block names its own SHAPE, so an artifact's version is knowable instead of guessed.**

  The block now carries one object per answer (`answered`) where it used to carry a count with two parallel lists
  beside it, and a reader can tell those apart only by which fields happen to be there — an old block has `answered`
  as a NUMBER where the new one has a list, and a list that is empty means "answered nothing" while an absent one
  means "no facts". So every block now writes `shape: "anybase-held/2"` (declared once, as `HELD_SHAPE` in
  `scripts/soak-supervisor.mjs`), and the two readers (`check-soak-trend.mjs` and `soak-diagnose.mjs`) read answers
  ONLY out of a block that names that shape — through the one shared `answersOf`, which returns the answers of the
  shape it knows and `null` for anything else.

  The absence of the marker is information too, which is the point. A block with no `shape` is the older shape (it
  was written before the marker existed), and a block naming a shape this reader does not know is neither read nor
  called quiet: it is a hold this reader cannot place, and `soak:diagnose` says so BY NAME ("it is in
  \"anybase-held/9\", a shape this reader does not know; this reader reads answers from anybase-held/2") rather
  than reporting the hold as one nothing was ever said to. `trendRecord` copies the block whole, so the marker
  travels to the trend line with the facts it describes and the two files cannot be read as two shapes.

  Pinned in `tests/soak-supervisor.test.ts` (a real soak's block and its trend entries both name the shape),
  `tests/soak-trend.test.ts` (an `answered` list is read from a block in this shape and from no other, so a block
  that does not name it is not counted as an answer where nothing may answer) and `tests/soak-diagnose.test.ts`
  (an unknown shape is named, and an account with no marker at all reads as the older shape rather than as a
  quiet hold).
- **The supervisor soak is a CI gate now — the `soak` job reloads a REAL build twelve times on every PR, and `ci-ok` waits on it.**

  `npm test` already soaks the supervisor end to end (five reloads through all three traffic phases, every leak
  check judged), but against `tests/fixtures/prod-death-server.mjs`, because a suite cannot demand that somebody
  ran `npm run build` first. So the tool's own default — the real `next start` over `.next`, which is the surface
  `npm start` actually supervises — was exercised by hand on a maintainer's machine and by nothing else: green
  until the day it was needed, which is the shape of a check that rots.

  The job is that run, with a bound. It is also the **only CI step that builds the app at all**: the gate sequence
  installs, checks the two contracts, typechecks, lints and tests the source without ever running `next build`, so
  a build break was something that could merge green. (Checked from a fresh-checkout shape rather than assumed:
  `providers.json` and `projects-data/` are gitignored and the build does not need either.)

  **Twelve reloads, and the number is not a round one.** The descriptor floor is judged per phase, and a phase
  needs four readings before a floor can be read from it — so at three reloads every phase has one and the check
  reports itself as NOT JUDGED, which is a soak that runs and checks less while looking green. Measured, against
  this repository's own build: three reloads end with
  `notes: ["the descriptor trend is not judged for busy (1 reading(s)), …"]`, twelve end with `notes: []` — every
  phase judged — and no phase was ever left unjudged across three runs of the job's exact command: 12/12 records,
  twelve swaps at 95.6s, 96.0s and 100.7s, one verdict read per phase each time. Twelve is the smallest count that
  judges all three, and it is the count the `--handle-slack` default of 8 was measured against. Everything else is
  the soak's own
  default, deliberately: `--window-ms` 6000 is the soak's ceiling rather than an operator's 90s, and
  `--busy-rate` 8 / `--max-in-flight` 4 are the "evidence, not a load test" values, so a runner that is merely
  slow cannot turn a reload into an overload and fail it for a reason that is not a leak.

  It is **blocking**, gated through `ci-ok` like the rehearsals — a leak is a verdict, and a gate nobody has to
  pass is the local habit it replaced — and it costs the merge no wall time: the job runs in PARALLEL with the
  gates matrix, which stays the long pole by minutes. Measured here, twelve reloads of the real build take
  **~1m40s** of swaps (three take 28s), plus the first boot, one install and one build. It runs on the oldest
  blocking leg, for the same
  reason the perf gate pins there (the oldest Node in the support window is the one users run), and it uploads
  the run's summary and the reload history as an artifact, so a red soak is diagnosable without a re-run. The
  summary is written by `--json` on stdout alone (the narrative goes to stderr), which is what makes it a file
  worth keeping.

  **Two of those three runs passed and one did not, and the one that did not is the check most likely to be
  doubted.** It was the descriptor floor, not the summary: `the quiet phase's lowest descriptor count rose from
  287 to 302 across 4 reload(s)`. Every reading in that run sits on one of two levels (~288 and ~302, and the
  second level is also a busy window's own load), and its second half happened to land on the high one; the other
  two runs show the same two levels with the +15 as a SINGLE reading (287, 289, 302, 310 spikes), which is what the
  halves comparison exists to absorb. On Windows that number comes from a 400ms PowerShell watcher sampling
  `HandleCount`, and the tool's own header documents readings of a clean supervisor differing by up to 13 handles
  there — the failure is that instrument under load, so a red descriptor floor on a Windows box is re-run before it
  is believed. The CI job is pinned to Linux, where the same number is a live `/proc/<pid>/fd` count read at the
  instant of the check: the sampler and the noise it contributes are not in that path. **Verified on Windows only,
  and only the descriptor check was red**: the Linux reading was not re-measured from here.

  Pinned in `tests/workflow-contract.test.ts` — that the job exists, that `ci-ok` fails when it did not pass,
  that it builds before it soaks, that it runs exactly twelve reloads, that it is pinned to the resolved oldest
  leg, and that it uploads its account. Deleting the job, or quietly shrinking the count, fails a test instead of
  narrowing the gate in silence.

- **The soak's numbers are recorded per run, and getting slower is a gate — `npm run check:soak-trend`.**

  The soak's verdict is about LEAKS in one run: a port still held, a descriptor floor that rose, a reload that
  did not land, a client that lost its answer. What each reload COST and what each phase's floor read were
  printed and thrown away, so the question those numbers answer had no reader — and cost is what a leak moves
  first, before it moves any count.

  Every run now appends one **trend line** of its own (`--trend`, default `<dir>/soak-trend.jsonl`) — a
  projection of the summary `--json` already writes, so nothing is measured twice: each reload's own cell
  (asked → landed: the replacement's boot, the window it keeps open, the stop of the run it replaced) grouped by
  phase and in order, the window each reload used, the floor each phase read, how the reloads ended, the door's
  counts, and the PROFILE it was read on (`platform/arch/node-major`). Records are only ever compared within one
  profile, and never at all while a record is missing one: timings from a laptop and from a shared runner are
  not two measurements of one thing.

  `scripts/check-soak-trend.mjs` reads a file of them and judges the newest run two ways. Against **itself**:
  each phase's median reload in the second half of its reloads against the first, four readings a phase — the
  same halves rule the descriptor check is declared by — so a run whose reloads degrade as the soak goes on is
  caught on the FIRST run, with no history at all. And against the **runs before it**, when the file has three
  earlier passing runs of that profile: the same medians plus the floor each phase read, because a floor that
  rises *across* runs is something being kept between them. Exit 0 within, 1 outside, 2 could not judge — and
  every half it skipped is printed with its reason rather than passed quietly: fewer than three earlier runs of
  that profile, or a descriptor floor on a platform whose reading is sampled (Windows) rather than live
  (`/proc`), whose noise was measured at 15 handles under load, which is most of a floor's signal.

  **A run that did not pass is recorded and judged by nothing at all** — not as a baseline, and not as the run
  under judgment. That is measured rather than tidy: a run that failed is usually a run that STOPPED, and a
  stopped run's numbers read as a fast one's. The run that found this performed 12 reloads with four of them
  missing a usable clock and came out at 48080ms against three passing runs' 73558ms — a 35% "speed-up" a
  total-cost check would have called fine.

  Budgets are measured, not asserted: 25% or 2s on a phase's median reload, and 20% or 10s on the run's cost.
  Twelve-reload soaks of this build on one machine put the per-phase medians 304–462ms apart between runs and
  the run's cost at 70881ms / 73558ms / 75223ms (6% apart), so the allowances are 3–6x the noise that was
  measured, while the 14.7s the cost allowance works out to is +1.2s on every reload. A reload's own cell is
  2.9–3.4s in the busy phase and 7.4–7.7s in trickle and quiet, on the real build.

  In CI the `soak` job runs the gate on the trend its own run just wrote — a build whose reloads cost more as
  the soak goes on fails the PR — and the line travels in the `soak-account` artifact. The across-runs half is
  `NOT JUDGED` there by design (one artifact is one record; download a few and name them and the comparison has
  a baseline), and the step fails on exit 2 as well: at `--reloads 12` every phase has the four readings this
  reads, so "could not judge" there means the trend file is missing — and it is also where a shortened soak is
  heard, since three reloads pass the soak's own checks while checking less than they claim.

  Pinned in `tests/soak-trend.test.ts` (the projection, the judgment, and all three exit codes through the
  process), end to end in `tests/soak-supervisor.test.ts` (two fixture soaks into one file, and the gate
  refusing a series too thin to judge), and in `tests/workflow-contract.test.ts` (the CI steps and the
  artifact that carries the line forward).

- **`npm run check:legs` — the gate CI blocks a merge on, run locally on every blocking Node leg, so a green run here means what a green gate means.**

  `npm test` runs on your Node, and the version a maintainer is most likely to have is the **canary** — the one
  leg CI deliberately lets fail (`continue-on-error`). So the local run that felt like the gate was evidence about
  the engine least likely to gate anyone, and the failure mode was the quiet one: a suite that passes on 26 and
  fails on 22 is a red PR nobody saw coming, from a machine that reported success.

  The legs are **computed, never listed**: the same `scripts/node-schedule.js` classification CI's matrix job
  consumes, so a promotion or an EOL demotion changes what runs on the day it happens, and a schedule that
  classifies to zero legs is refused the way `scripts/ci-compute-matrix.js` refuses it. The steps are **read out of
  CI's own composite action** (`.github/actions/gates-steps/action.yml`) — install, node contract, workflow
  contract, typecheck, lint, tests, generated-app pins, in that order — because a tool that transcribes a sequence
  is a tool that reports on last month's sequence. A step carrying shell syntax this tool cannot execute as written
  is a **refusal** (exit 2), never a skip: an unrun check inside a green verdict is the one failure a verification
  tool must not have. The superlinearity gate is the exception that is pinned rather than parsed — CI runs it as its
  own job on the **oldest** blocking leg, so that is where it runs here, and the job is re-read on every run so a
  step added there is a refusal instead of a quietly unmeasured check.

  No version manager is required, because requiring one makes the tool useless on the machine that needs it. Each
  leg's newest released patch is resolved from nodejs.org's own release index, the official archive for this
  platform is downloaded into a gitignored cache (`.node-legs/`), and it is **checksum-verified against the
  published SHASUMS256.txt before anything is extracted or executed** — a runtime with no published digest is
  refused rather than run, and a mismatch deletes the download instead of caching it. The extracted binary is then
  asked its own version, which must be the version that was resolved, so "the node 22 leg" is a fact about the
  process that ran the tests rather than a label on a directory — and each step runs with that runtime first on
  PATH, so the `node` a test spawns is the leg's. The limit of that chain is named rather than implied: the digest
  is fetched over TLS from nodejs.org, so it is transport-trusted, not GPG-signed by this tool. `--node-bin
  <major>=<dir>` uses an install you already have instead (nvm, fnm, volta), with the major asserted.

  Exit **0** every selected check passed on every leg, **1** a check failed — the leg, the step and the lines that
  say so are printed, and the OTHER legs still ran (the gates matrix's `fail-fast: false`, so a version-specific
  difference is visible) — and **2** it could not be run at all, which is a different answer from a pass. What it
  does *not* cover is said in its output rather than left to be assumed: the rehearsals and rehearsal-parity are a
  PowerShell **engine** axis (7.x vs 5.1), not a Node one, and `--canary` is advisory because a canary is.

  One environment a leg is given is deliberately NOT the one this tool was launched with. A parent npm exports its
  own config as `npm_config_*` into everything it spawns, and a NESTED npm reads one of those — `allow-scripts`,
  added in npm 11.19 — as a project-scoped flag it then refuses outright: `npm error code EALLOWSCRIPTS
  --allow-scripts is not allowed in project-scoped installs`. Measured here, that is what happened on the node 24
  leg while the node 22 leg (npm 10, which does not know the setting) installed fine — from an environment CI
  cannot have, because a runner has a `node` and an `npm`, never an npm inside an npm. They are dropped for the
  leg's steps, the names are PRINTED rather than dropped quietly, and `--keep-npm-env` names them back for a
  machine that needs one (an internal registry, a proxy). `.npmrc` is untouched: this is about inherited
  variables, not about the project's own configuration.

  Pinned in `tests/check-legs.test.ts`: the gate sequence is asserted against what the composite action says today,
  so a workflow edit lands as a failing test rather than as a local runner reporting on an older gate; the blocking
  set is classified from a fixture schedule **twice, with a different answer the second time**, so a hardcoded
  [22, 24] anywhere fails; a step with shell syntax and a non-npm step are refused; `--only list` succeeds with a
  schedule that classifies to zero blocking legs (itself a refusal), which is what proves naming the steps never
  asks the schedule anything; a download served from a stub is verified, unpacked by this platform's own tool and
  reported cached on the second call, while a digest mismatch leaves NOTHING behind; and a real step's PATH is
  asserted to carry the leg's runtime ahead of a decoy, with a failing step's own code (3) becoming the leg's
  verdict and the steps after it reported as not run.

### Fixed
- **The front door can no longer drop a live connection out of its per-run count when the next client arrives, so a reload's `leftoverConnections` is the count that was true rather than one the door lost.**

  The door books every connection it accepts under the port it piped that connection to, which is how a reload can say
  how many were still on the run it retired. ONE connection is forgotten TWICE — its client's socket and the upstream
  socket behind the door end at different moments, each with its own close handler — and the second call deleted the map
  entry for that port because the set IT had installed was by then empty. A set is only ever installed for a port that
  has none, so a connection accepted in between the two closes has installed its own, and the second call took that live
  connection out of the count. Measured on this repository's own build with both halves of the door's bookkeeping
  logged: a client that arrived **3ms** after another client's first close — the connection a swap was about to be
  judged against — left `leftoverConnections` at **0** for the next retirement, and the soak, whose own connection was
  still open at that instant because it really was, reported `the door reported 0 connection(s) still on the run it
  retired, while a client was holding one that had been piped to it`. Once it was hunted it appeared in **3 of the 8**
  short all-busy runs it was hunted through (one reload each, of six) and in none of the passing ones, which is the
  shape of it: the window is the couple of milliseconds between one connection's two closes, and it needs a client to
  arrive inside it.

  `forget` now runs ONCE per connection and removes only the entry IT installed (`this.live.get(target) === pipes`),
  never whatever set the port holds by then. Nothing else about a swap changes, and nothing else had to: the count is
  only ever REPORTED — `usesFor` and `arrivalsFor`, which decide how long a way back is kept open, are separate
  counters and were never wrong — so the defect was a verdict about the door rather than a behaviour of it.

  Pinned in `tests/dev-supervisor.test.ts`: a client that keeps its half of a connection after the run behind the door
  has finished with it (`allowHalfOpen`, which is what puts real time between the two closes), a second connection
  accepted through the door in that gap, and the first client's half closed last — with the second connection still
  counted afterwards. Against the body before the fix the same test reads `expected +0 to be 1`.
- **A connection held across a swap can no longer be ended by the clock that ends an idle connection a run has FINISHED with, so an ending inside the window is the door's to answer for — and the one run-authored ending announces itself.**

  The soak opened a connection through the front door before asking for a reload and then re-asked the run behind it
  every 2s (`--rearm-ms`) so that the run's own keep-alive clock had something to reset. That clock is armed when a
  response FINISHES — measured here, with the production fixture behind this repository's own front door and nothing
  else touching it, an ANSWERED connection through that door ends **6020ms** after its last answer, whatever the
  client does next — so the hold survived only while the re-arm stayed shorter than a clock nothing told it about. A
  run with a tighter keep-alive, a stalled event loop, or a `--rearm-ms` longer than that clock ended the connection
  the soak was holding to judge the door with: the instrument failing for exactly the reason it exists, and the door
  reported for it.

  The connection is now held as **the head of a request whose terminating empty line never arrives**, and it is
  written ONCE: nothing is written into it after that head, because there is nothing left for a re-arm to do
  (`--rearm-ms` went with it, and is refused by name in both modes now rather than accepted and ignored). The door
  accepts the connection and pipes it to a run on accept — which is what makes it countable, the door counting a
  connection when it takes it rather than when it is asked for something — and the run behind that door can neither
  dispatch the request (there is nothing to dispatch), nor answer it (there is nothing to answer), nor reach it with
  the clock that ends a connection it is FINISHED with: no response of this connection's ever finishes, so that clock
  is never armed at all. Measured on real pieces, through this repository's own front door: a connection held this
  way outlived a run whose keep-alive clock was turned down to 300ms, while that same run closed an ANSWERED
  connection nobody was using (in ~1.3s — that clock's own shape) — and the hold was still that run's: finishing the
  head was answered **200**.

  It is not immune to every clock a run has, and this entry does not pretend otherwise: the run's **header** clock
  reaches a request head it never received the end of — and, measured here, a connection it was never asked anything
  on at all, so no shape is immune to it. Measured against one real run with that clock turned down to 300ms and a
  100ms check interval: an unfinished head was given up on with `HTTP/1.1 408 Request Timeout` at **323–335ms**, and
  a connection with nothing written on it at all at **329–340ms** — silence buys nothing, which is why the hold is the
  head and not a bare connection (the head is the shape `stop` can finish into a real question) — and the same head
  **re-armed every 100ms** lasted no longer than one written once (**315–408ms** against **329–339ms**: the same 408
  either way, which is what makes the re-arm pointless rather than load-bearing). That clock is why the hold has to be
  YOUNGER than it for as long as it is judged, which it is by an order of magnitude: a held connection lives one
  reload (~10–20s) against **~90s** of holding against Node's defaults (a 60s clock, checked every 30s, measured
  through this repository's own front door) and proportionally sooner for an app that sets a tighter one. What that
  clock does NOT do is end the connection quietly: it announces itself, in a 408 — and that is what lets the verdict
  lay an UNANNOUNCED ending inside the window at the door's feet with nothing hedged around it (see the entry below).

  The one question the connection ever asks is asked once, by `stop`: it finishes the head then, in full, and the
  answer — the run it stayed piped to, the door's 503, or the socket simply ending with the retired run — is the
  `final` the verdict is judged against. Nothing the door writes unprompted is dropped either: an answer arriving on
  a connection whose request was never finished is recorded and judged, with the door's own retry-503 accepted **from
  the instant the port changes hands** (the same discharge the ending is already allowed to be, and the shape a run's death takes
  at the door when its upstream errors before a byte was written) and a refusal before that still the door costing a
  client its answer. The line a swap reports says "a request in flight, never answered" where it used to say
  "0 answer(s)".

  Pinned in `tests/soak-supervisor.test.ts`: end to end against one real run behind the real door, with its keep-alive
  clock turned down to 300ms — a client that run has ANSWERED and that nobody is using is closed by that clock, while
  the connection the soak holds is still open 1.5s later, still that run's, and still answers when the head is finally
  finished; a run's header clock on the unfinished head is measured against a real run too (a 408 announcing it, then
  the close), and the verdict leaves that ending with the run while the SAME ending with no such answer on it is still
  the door's; a held connection is never answered while it is held, and still ends with the run it was piped to rather
  than being answered by the replacement; the door's retry-503 is accepted from the swap and refused before it, in the
  same test that already refused an answer the run never gave; and the boundary that IS a run's right — a client answered once and then left alone is closed by that
  run's idle clock — is measured too, with the client that ends that way being a client of its own rather than the
  connection the soak holds, since the soak's is precisely the shape that clock never arms for.
- **The swap checks no longer read the door's count for a connection that was already gone, and no longer hedge around a quarter second either.**

  Three instants are involved in judging a held connection against a swap, and all three are in the record: the swap
  (`swappedAt`), the moment the door took the `leftoverConnections` count it reports (`swappedAt + windowUsedMs` — the
  count is read when the reload's verdict lands, before the drain and the audited stop that follow it, so the record's
  own arithmetic names the instant its count was true; see `leftoverCountInstant`), and the moment the client's socket
  ended. The count is evidence about this connection only while the connection was still open at that instant: a
  connection that had already ended leaves the retired run legitimately holding nothing, so the `0` it reports is what
  that count is FOR — the check used to read it anyway and call it "the held connection was moved off that run, or
  dropped, at the swap". That was the intermittent failure the end-to-end watch test was red on under load.

  What is read for a connection that ended before the count is the ending itself, and the boundary between the two is
  the count instant exactly: the run behind the door is serving the connection until then, no clock of that run's ends
  the connection the soak holds for being idle (see the entry above), and the one clock of that run's which does reach
  it says so itself, in a 408 — so an ending before that instant that the run did not announce has one author left,
  and is reported as the door having closed it. The quarter-second band that used to claim a connection ending just before
  the count "in neither direction" is gone, because what it hedged against no longer exists: a connection that ends
  while the run it was piped to was still serving it is a client the swap cost its connection, whether it ended a
  second before the count or a millisecond before it, and one that ended before the port even changed hands is still
  reported the same way. A connection still open at the count with a `0` is still the finding it always was, on the
  door's own number. What the swap REPORT carries is unchanged, in both places a reader sees: the per-swap object
  carries `held.endedBeforeCount` (whether the connection had already ended when the count was taken — the boundary
  the verdict was made on, in the record a pipeline reads) and the line says "ended before the run it was piped to was
  retired" for that ending instead of claiming it "ended with the run it was piped to", which was not true of it.
  Pinned in `tests/soak-supervisor.test.ts`: a connection that ended before the count — one that ended before the
  swap, and one that ended a millisecond before the count — is the door's, with the count not read against it; one
  still open at the count (and one that ended after it) with a `0` still is; a swap whose connection ended before its
  run was retired reports `endedBeforeCount: true` and says so in the line, and that ending is a finding; and
  `leftoverCountInstant` places the count at `swappedAt + windowUsedMs`.
- **The alert-delivery test no longer races its own sink with a timer.**

  `posts it to a real endpoint, and only asks again when asking again could help` answered the first POST of
  its retry case with a 500 and flipped its sink to 202 after a 20ms timer, which asked the machine to deliver
  a request inside 20ms — on a loaded machine the first POST arrived after the flip, the watch correctly made
  no retry, and the test reported "expected the retry to have happened" about a run in which there was nothing
  to retry. It was the suite's most reliable red under load (2 of 3 full-file runs, while every swap the same
  files performed passed). The sink now answers 500 and then 202 from an ordered queue of its own, so the
  sequence is the sink's bookkeeping rather than the clock's, and the assertion it was always making (one ask,
  one retry, two requests seen) is unchanged.
- **A reload that never swapped the port is no longer a failure for the swap watch.**

  `npm run watch:swaps` judges a swap on what the front door did to the clients at it, and its own contract says
  the deploy's outcome is not a finding — a rollback is a legitimate thing for a deploy to do. One outcome had
  escaped that: `kept`, a reload whose replacement never came up, leaves `swappedAt: null` because no window was
  ever open. The watch read the missing instant as unreadable evidence and failed the reload with "the record
  names no instant the port changed hands" — so a deploy that reloaded, changed nothing and kept serving was
  marked down for it, in a watch whose subject is the door and nothing else. It is now reported the way a swap
  that happened before the watch attached is: **NOT JUDGED**, with the reason, and no problem against the
  deploy. A watch that saw nothing but those exits as `NOTHING_JUDGED` (exit **2**, nothing to judge) rather
  than as a failure, and its summary says which of the two it was (no reload landed at all, or reloads landed
  and none of them swapped). The line is drawn on the writer's own vocabulary: `swappedAt: null` is an ABSENT
  swap and is not judged, while an instant that is there and cannot be read is unreadable evidence, which this
  watch still refuses to pass — a check that cannot place its evidence does not pass it. What fails the watch
  is now only the door: a client that had the port in its hands while it changed hands and was handed a 503 or
  a refused connection, or a connection held across the swap that was not the retired run's. Pinned in
  `tests/soak-supervisor.test.ts` both as a unit (a `kept` record and an unreadable instant, which now differ)
  and against this repository's own supervisor: a real deploy whose second replacement never comes up (the
  muted fixture run) is reported as `swap 2: NOT JUDGED — the reload never swapped the port (kept)`, the watch
  keeps going, and the run ends `SWAP_VERDICT=PASS swaps=2/3 watched=3 in_flight=0 lost=0 problems=0` with exit
  **0** instead of the failure it reported before.

### Added
- **`--alert pagerduty|URL` — the swap watch pages somebody when the front door costs a client an answer, instead of only writing it to a log.**

  `npm run watch:swaps` already knew when a deploy hurt a client — a client that had the port in its hands while
  it changed hands and was handed a 503 or a refused connection, a held connection that was not the retired
  run's, a swap with no client at the door, evidence it could not place — and told nobody: the finding landed on
  stderr and in the daemon log, which is read by whoever happens to be looking. `--alert pagerduty` posts a
  [PagerDuty Events API v2](https://docs.pagerduty.com/developer/send-alert-event) trigger the **moment the
  finding lands**, not when the deploy ends, so the page does not wait for a rollback window or a `--wait` that
  has not run out yet. `--alert <url>` posts the same account as JSON to any http(s) endpoint (a chat webhook,
  an automation, an alert relay), leading with `text` — the field a chat webhook renders — and carrying the
  structure beside it, so the two destinations cannot say different things any more than the daemon log and
  `--json` can. The routing key is the whole credential and it is read from `PAGERDUTY_ROUTING_KEY` and nowhere
  else: not an argument (a process listing), not a log line (a file somebody else can read), and a
  `--alert pagerduty` with no key refuses to start (exit **2**) rather than starting a watch that could never
  page.

  Three properties were as much the feature as the POST is. **Only the door pages**: a deploy's own outcome (a
  rollback is legitimate), a reload that changed nothing, a swap that happened before the watch attached, and
  `--require-swap`'s nothing-to-judge are all reported and none of them wakes anybody — the first three are
  not findings at all and the fourth is a fact about the watch's coverage, whose reader is the pipeline that
  asked for it. **One incident per deploy**: every finding shares one `dedup_key` derived from the watch's own
  identity (`anybase-swap-watch:<port>:<history>`), so the three bad swaps of one bad deploy collapse into one
  incident with three trigger entries rather than three pages, a later run of the same watch attaches to that
  incident instead of opening a second one, and a run that judged swaps and found nothing at the door sends a
  PagerDuty `resolve` — only a verdict can close an incident, never a watch that judged nothing. And **the page
  cannot change the answer**: delivery is retried once when asking again could help (a 429 throttle or a 5xx)
  and reported when it could not (any other 4xx, a dead URL, a network error), but the outcome is a line on
  stderr plus `alert.sent` / `alert.failed` / `alert.error` in the summary — the verdict and the exit code stay
  the door's, because failing one run twice for one problem only misleads whoever reads it. It is a watch's flag
  and is refused by name in soak mode, the way `--daemon` is: a soak performs its own reloads, and the person
  reading a soak's output is already running it.

  Pinned in `tests/soak-supervisor.test.ts`: the command line (PagerDuty or an http(s) URL, anything else
  refused, refused in soak mode, off by default); the two body shapes, including that the routing key is in the
  body it must be in and in no other part of the alert; delivery against a real sink on the wire (202 delivered,
  500-then-202 retried, 400 not retried and reported, nothing listening reported rather than thrown); an
  in-process watch that pages the moment a swap with nothing held across it is judged (endpoint, trigger body,
  routing key from the environment, `alert` in the summary, exit code unchanged) and an in-process watch that
  does NOT page for a `--require-swap` failure with nothing to judge; the missing-routing-key refusal as the
  real command line; and the whole thing end to end — the real script, as a process, watching a real front door
  that is told to hold nothing behind it, with a real sink receiving the page and the summary accounting for it.
- **`--require-swap` — the swap watch can be told to demand proof of a swap, instead of tolerating "nothing to judge".**

  By default a watch that judged no swap is an abstention: `NOTHING_JUDGED`, exit **2**, and it is the right
  report for a person watching a deploy, because the door was never put to the test and nothing is claimed
  either way. It is the wrong answer for a pipeline whose question is different — *did this deploy actually
  swap the port under load?* — and a watch that judged nothing cannot say yes. So `--require-swap` reads that
  one case as a failure: the run ends `SWAP_VERDICT=FAIL`, exit **1**, with a problem naming what was demanded
  and what was seen (how many reloads landed and that none of them changed the port, or that no reload landed
  while the watch was up), and `requireSwap: true` in the summary so a reader of the daemon log knows why a
  FAIL arrived with nothing at the door in it. It applies to the two exit-2 cases that are a VERDICT (no reload
  landed while the watch was up, or reloads landed and none of them swapped), and not to a watch that never got
  as far as one (nothing serving on that port, a daemon log that cannot be written), which is still a 2 — there
  the check could not be run rather than ran and answered no. It is raised only when there was no finding at
  the door already — a watch that caught the door costing a client an answer does not need saying twice — and
  it changes nothing about what a judged swap has to have done: a reload that never swapped is still reported as NOT JUDGED, and
  the flag is about the watch's verdict rather than about the deploy's reload. It is the watch's flag and is
  refused in soak mode by name (`a soak performs its own reloads and judges their records`), the way `--daemon`
  is: a soak whose own reload changed nothing is already a failure of its records, so there is nothing left for
  a watch-style demand to catch there. Pinned in `tests/soak-supervisor.test.ts` — the command line (accepted
  with `--attach`, refused without it, off by default), an in-process watch against a fake door that gains one
  `kept` record (exit **1**, `SWAP_VERDICT=FAIL swaps=0/1 watched=1 problems=1`, the summary in the daemon log
  carrying `requireSwap: true`), and the live watch against this repository's own supervisor on an idle deploy,
  where the same argv without the flag exits **2** and with it exits **1**.
- **`npm run watch:swaps -- <port> --history <path>` — watch a deploy somebody else is running and report what each swap does to the clients at its front door, while it is happening.**

  The soak owns its supervisor: it starts one, drives it, stops it, and every number it reads is one it made.
  That is the wrong instrument for the thing an operator actually has — a deploy in flight, on a port
  somebody else chose, performing swaps nobody asked this script for. So the same file runs a second way:
  `--attach <port> --history <path>` holds load against that front door, keeps one connection open through it,
  and reads the deploy's OWN reload history as it grows — the only thing that says a swap happened, since the
  port never closes. **Each swap is reported as it lands**, within a poll of the record that describes it: a
  line on stderr a person reads, and with `--json` one object per swap on stdout, the last line being the
  summary, so a pipeline can follow a deploy rather than wait for it.

  The claim is the one the soak makes about a swap: no client that had the port in its hands while it changed
  hands may be handed a 503 or a refused connection, and the connection held open across it must be the
  retired run's — answered by that run while it served, still on it when the door stopped it
  (`leftoverConnections`), and ended WITH it rather than handed to the replacement. What is different is that
  the reloads are the deploy's, and three things follow. A swap that happened before the watch attached is
  reported as **NOT JUDGED** rather than judged on evidence nothing was watching for — and attaching
  mid-reload is exactly what an operator does, so this is a case that actually happens. A swap with no client
  at the door is a finding for every swap, because the load is always on (in the soak it is only the busy
  phase that has to show one). And the deploy's own outcome is reported and never a finding: a rollback is a
  legitimate thing for a deploy to do, and only the door is on trial here.

  It is explicitly NOT the soak, and says so: there are no descendants to count (it is not the supervisor's
  parent), no ports to bind after a retirement (it does not know when that is until the record lands), nothing
  to stop at the end, and no way to know what the deploy was configured with. Those checks need the supervisor
  this script started and owns. Its load does reach the deploy as real traffic — a front door counts the
  connections it hands a replacement — so a deploy watched under load closes its rollback window earlier than
  one watched by nobody, which is worth knowing before the numbers are read.

  Exit codes: **0** every judged swap kept the claim, **1** any of them did not, **2** nothing could be
  judged (nothing serving on that port, no reload landed while the watch was up, or every reload it saw changed
  nothing — see *Fixed* below). `--swaps N` stops after N
  judged swaps, `--wait MS` after a duration; everything that only means something when this script is the one
  asking for reloads is refused by name with `--attach`, so a caller cannot believe it asked for a soak.

  **Measured against this repository's own supervisor** (the production fixture behind a real front door, swapped
  twice while the watch was up): both swaps reported live, before the deploy performed the second one, `186
  requests` through the door and every one of them a 200, `leftoverConnections: 1` at both retirements, and the
  connection held across each swap — nine answers on the first, four on the second — ending with the run it was
  piped to and never answered by the replacement. `SWAP_VERDICT=PASS swaps=2/2 watched=2 in_flight=0 lost=0`.

  **And against a real deploy — this repository's own `next start` over `.next`, watched the way the README
  spells it** (`npm run watch:swaps -- 57552 --history ./reloads.jsonl --swaps 2`): two swaps reported as they
  landed, `280 request(s), statuses {"200":280}, 0 timeout(s), 0 connection error(s)`,
  `SWAP_VERDICT=PASS swaps=2/2 watched=2 in_flight=4 lost=0` — and the one after that is the case the mode
  exists for: the deploy's own health check timed out under the watch's load (`no answer within 5000ms`), the
  deploy rolled the swap back, and the watch reported a swap that cost clients their answers — `6 client(s) at
  the door, 2 in flight across the change, 2 lost`, five hung requests in a 46-request window,
  `SWAP_VERDICT=FAIL` and exit **1**, with the per-swap object on stdout under `--json`. The door did nothing
  that could be fixed for it (it tore the client's socket down when the doomed run's upstream closed — the run
  itself took connections and never answered, which is why its health check failed too); what the watch did was
  say so while it was happening, with the count, rather than at the end of a soak. And the supervisor bug the
  entry above fixes was found the same way, on an earlier run of this watch against a real build: a reload
  asked for while the door had no target took the port down with it, which is a finding no soak of a
  supervisor this script owns could have produced — a soak holds load with its own driver, but only a watch
  holds it at the door of a deploy nobody here started.
- **`--daemon <log>` — the swap watch as a long-lived daemon that appends a verdict per swap to a file, because a deploy step can follow a file and cannot follow a pipe.**

  The watch already reported each swap as it landed, but only to a stream it owned: a pipe to the step that
  started it. A deploy is longer than one step, and a pipe that ends when a step is restarted is a pipe that
  loses every swap that happened while it was down — which for a watched deploy is exactly the interesting
  window. So the same watch runs as a daemon: **one JSON line per swap, appended to the file the moment the
  verdict is reached**, and the summary appended as the last line when it stops, so a reader that follows the
  log (`tail -F ./swaps.jsonl`) sees each verdict as it happens while a reader that arrives later still gets
  the whole account. The lines are the same objects `--json` prints, so the log and the stream cannot say
  different things about a swap, and the file is appended to rather than truncated: a watch redeployed onto a
  running deploy continues the account instead of starting it again.

  A daemon has no stopping count, so `--swaps` is refused with it rather than quietly ignored — a watch that
  exits after five swaps exits while the deploy it was watching is still going — and it ends on SIGINT or
  SIGTERM (a service manager's signal, and now handled by the watch at all), or on `--wait` when a bounded
  daemon is what was asked for. Its exit code is the verdict it always was (0 every judged swap kept the
  claim, 1 any of them did not, 2 nothing was judged), reported for the swaps it did judge when a signal is
  what ended it. A log it cannot write to is refused before it attaches, with the reason, rather than taken as
  a crash on the first swap of the deploy it was started to watch. Pinned in `tests/soak-supervisor.test.ts`
  against the production fixture behind a real front door: the marker line written before the daemon started is
  still first when it exits, the two swap verdicts are in the file while the daemon is STILL RUNNING after
  judging both (that is the count it does not have), and the file ends with the `PASS` summary — four lines,
  in order, nothing truncated.
- **`npm run soak:supervisor` — reload the production server many times back to back and check what each one left behind, because that is the one thing a single reload cannot show.**

  Every other check of the supervisor looks at ONE reload: a swap that never closed the port, a rollback that
  took it back, a window the app's traffic decided. What none of them can see is whether a hundred reloads
  leave the machine the way a single one did — a warm run whose stop missed, a port a retired server kept, a
  socket the door forgot to tear down, a record written twice or not at all. Each is invisible in one reload
  and obvious in thirty. `scripts/soak-supervisor.mjs` asks for a reload, waits for its record, checks, and
  does it again — touching the sentinel **only after the previous record has landed**, so `--reloads 30` is
  30 reloads rather than however many the queue happened to coalesce. It supervises the real `next start`
  over `.next`, so it needs `npm run build` first; `--server '<command>'` soaks something else instead, which
  is how the test suite runs it against the fixture.

  The traffic **cycles through three phases**, one per reload, because the window the way back is kept is
  decided by the rate the app is using the replacement at: `busy` puts a real request rate through the door,
  so the app's own connections reach the replacement — and close the window themselves (`traffic`) when the
  app's health checks are quick, which on a real build they are not always, so what the phase is held to is
  that the connections ARRIVED and the replacement stayed healthy through them; `trickle` puts one connection
  every few seconds through it, too few to prove anything, so the clock closes a window whose length the
  observed rate decided; `quiet` sends nothing at all, so the window has no evidence in it and runs to the
  ceiling. All
  three end with the run that was replaced retired, so all three are paths through the same stop, the same
  audit and the same record — and each reload is then held to its own phase's expectation, so a soak that
  quietly measured the wrong thing (a driver that stopped sending, a phase that never took effect) fails
  instead of passing.

  **Four leaks, measured rather than argued about.** *Processes*: the supervisor's own audit is read back out
  of its log — a retirement that reported a survivor, or a force kill that left one holding the port, is a
  finding, and so is a retirement with no audit line at all — and, where the platform can answer cheaply, the
  soak counts the supervisor's descendants after every reload and takes the LOWEST count it has ever seen as
  the floor a later count may not rise above (`/proc` on Linux, a persistent PowerShell watcher on Windows,
  because reading that table costs seconds per read there). *Ports*: the retired run's port is bound after
  every reload — a run that still holds its port IS a leaked warm process, caught without needing to see the
  process — and every port the records name, plus the public one, is checked again once the supervisor has
  been stopped.  *Sockets*: the front door must have answered every request with the app's own answer for the
  whole soak (a hung piped connection shows up as a timeout, and a 503 or a refusal is a client that paid for
  somebody's reload), and the supervisor's own descriptor count is watched for a floor that rises — the one
  instrument noisier than the leak it looks for, **measured at up to 13 handles of churn between consecutive
  readings of a clean supervisor**, which is why each reading is the lowest of several and why what is
  compared is a phase's floor in its second half against its first, never one phase against another. A phase
  with fewer than four reloads is not judged at all and says so, rather than reporting a pass it did not
  earn. *Records*: exactly one record per reload, in order, every one of them readable by the gate's own
  parser (`src/lib/deploy/reload-history.ts`), every one of them `replaced`, all carrying the fields the
  verdict rests on.

  The soak's own traffic is **evidence, not a load test**, and that is measured too: forty requests a second
  of this repository's own SSR page saturates the app on one machine — and so does a mere handful of
  CONCURRENT ones — after which every answer times out, the replacement cannot pass its health check inside
  the window, and the supervisor correctly rolls back for a reason that has nothing to do with a leak. The
  driver therefore defaults to eight requests a second with at most **four in flight** (`--busy-rate`,
  `--max-in-flight`), honours the rate exactly rather than rounding it to one per tick, and treats a timeout
  as what it is: a client the door took and never answered.

  **Measured against this repository's own build**: thirty reloads back to back, ten of each phase, in 297
  seconds. Every reload landed — thirty records, all of them `replaced`, and the whole file read back by the
  deploy gate as `RELOAD_VERDICT=LANDED records=30 landed=30 failed=0`. The phases really did decide
  different windows: busy 1533–1717ms, `trickle` 6041–6168ms and `quiet` 6047–6124ms against the soak's own
  6000ms ceiling, `closed_by` `traffic` nine times and `clock` twenty-one. Through the front door: **513
  requests, every one of them a 200, no timeout and no connection error**. One descendant process after every
  one of the thirty reloads, the retired run's port free after every one of them, and the descriptor floors
  flat — busy 297→297, `trickle` 297→297, `quiet` 296→297 across ten readings each, against a slack of 8.

  The swap claim, measured on the same build: six reloads, **131 requests through the door, every one of them
  a 200**, no timeout and no connection error; three of the six swaps had a client at the door (the busy ones,
  which is exactly the claim — a quiet window has nobody at it and says so), and one of those clients was
  caught **in flight across the port change** and answered after it by the run it was piped to, none lost. The
  held connection ended with the run it was piped to at every one of the six reloads (its one question is asked
  after that run is gone, by design — see the held-connection entry above), and the door's own
  `leftoverConnections` was 1 at every retirement: the run it stopped was still holding the client's connection
  when it stopped it.

  **What the door does at a swap is checked too, because a swap is the moment the door exists for.** Every
  answer is timed when it is asked for, so the clients that had the port in their hands while it changed hands
  are known — a request whose connection was accepted before the change and answered after it is one the door
  carried across the move — and none of them may be a 503 or a refused connection: the port belongs to the
  door and never closes, so a swap may not cost a client its answer. A busy reload that had no client at its
  swap says so instead of passing on nothing. The same claim is tested from the other side by a connection
  the soak **holds open across the swap**: opened before the reload is even asked for, held as the unfinished
  head of a request so that no clock of the run behind it ends it for being idle, and nothing written into it
  afterwards (there is nothing to re-arm — see the held-connection entry above), and then judged on three
  things — the run it was piped to never answered it while that run was serving, the door's own account of the
  retirement says the run it stopped was still holding it (`leftoverConnections`), and once that run is gone the
  connection **ends with it** instead of being answered by the replacement. That last one is the difference between piping per
  connection and a door that quietly re-points an established client at whatever is serving now.

  It exits **0** for a clean soak, **1** for a leak or a reload that did not behave as its phase says it
  should, **2** when it could not be run at all (no build, a bad option, a supervisor that never came up) —
  and `--json` writes the whole account to stdout as one object (per-reload evidence, the descriptor series,
  every problem, what each swap had at the door) so a pipeline can read it rather than a person. Pinned by
  thirty tests over those verdicts (what a history has to look like, what each phase is allowed to have done,
  what the supervisor's kill audit has to say, how a descriptor floor is read, which client a swap is
  answerable for, and — against a real `FrontDoor` and a backend that answers 404 — that a connection held
  across a swap is never answered by the replacement) plus an end-to-end soak of five reloads through all
  three phases against the fixture, asserting the exit code, the JSON verdict, the swap evidence and the
  history it left.
- **Every reload `npm start` performs is written down for a machine, not only for whoever is reading the log.**

  A reload is a decision about a live server — the replacement is serving, or it was rolled back, or nothing
  changed at all — and until now the only account of that decision was a sentence in the supervisor's own
  output. Name `PROD_RELOAD_HISTORY` and each performed reload appends **one JSON object per line** (JSONL:
  appended, one small write per record, so the file stays readable while it is being written and a reader
  can tail it) to that path, carrying: the schema (`base88.reload/1`, so a change to what a line MEANS
  cannot be mistaken for a change to the numbers in it); the three moments — when the supervisor began
  acting on the request, when the port changed hands, when the verdict landed; why the reload was asked for
  (the sentinel file's path, or `SIGHUP`); the **outcome**, which is what a pipeline branches on
  (`replaced`, `rolled-back`, `kept`, `no-fallback`, `stopped`); **what closed the window** (`traffic` — the
  app's own connections proved it, `clock`, `check`, `exit`, `shutdown`, `no-port`, or `null` when no window
  was ever open); `rolledBack` restated as a boolean for an alarm; and the evidence: the real connections
  the app put through the replacement, the health checks it passed across them, the window it was allowed
  and the window it actually took, the connections still open on the run this reload stopped when it stopped
  it, and the ports the door moved between.

  The record is written from the **same verdict the log is written from** — one object decides both, so the
  history and the log cannot disagree — and a record that cannot be written is reported (`could not be
  written to <path> … carrying on without it`) and **never fatal**, because an audit trail able to take the
  server down would be worse than one that admits a gap in itself. No path, no file: this is off unless an
  operator names one.

  Pinned as a unit (the three moments and every field, a rollback's shape, a window that never opened being
  `null` rather than a zero, two records landing as two parseable lines, and a write that fails being
  reported rather than thrown), and end to end in the production supervisor's own suite: the window the app
  closed early, the window the clock closed, both rollback shapes (a failed check and an exit), the reload
  where the way back was already gone, and the reload that never produced a server all assert on the file a
  deploy pipeline reads — the traffic case cross-checking the record's own `served` and `checks` against the
  numbers the log printed, so the two accounts are provably one verdict.
- **A deploy can gate on that history rather than read it: `npm run check:reload-history` answers with an exit code.**

  The record was written for a machine; this is the machine. `scripts/check-reload-history.mjs` reads the
  JSONL file `PROD_RELOAD_HISTORY` names and judges a reload, and because a deploy step branches on an exit
  code rather than on prose, there are exactly three: **0** the reload landed (`replaced`, or `stopped` — a
  shutdown ended the reload with the replacement already in place, which is a reload that happened and is
  printed with its detail rather than reported as one that did not); **1** it did not — `rolled-back` (the
  port went back to the run it replaced), `kept` (nothing changed: the replacement never came up, or the
  supervisor was already stopping), or `no-fallback` (a replacement that failed with no run left to go back
  to, which is a deploy that landed **broken** and is the worst of the three to hand a pipeline as green);
  **2** it could not be judged: no history named or no such file, no record in scope, a line that is not a
  `base88.reload/1` record, or an outcome this reader has never heard of. A gate that cannot read its
  evidence does not pass.

  The load-bearing case is the record that is **older than the reload being checked**. A reload that never
  happened writes nothing at all — the supervisor not running, the sentinel not watched, the history
  misnamed — so an unconditional "judge the last line" reader would report the PREVIOUS deploy's green
  reload as this one's, which is precisely the false pass a gate exists to refuse. A record therefore only
  counts if it landed recently enough to be this deploy's: `--since` (`-5m` by default; an ISO timestamp,
  epoch milliseconds, or `-30s`/`-5m`/`-2h`/`-1d`), with a record outside it reported as an **absence**
  rather than a pass. `--wait <ms>` is the same idea from the other side: it insists on a record that
  landed AFTER the command started, which is what makes asking for a reload and checking it one step —
  `touch "$PROD_RELOAD_FILE" && npm run check:reload-history -- --wait 60000` — and a wait that times out is
  "no record to judge" (`2`), never a pass on the record that was already in the file. `--all` judges every
  record in scope instead of the newest (any one of them failing fails the command), and `--json` writes
  the judged record to stdout and the prose to stderr, so a pipeline can attach the record to its own log.

  The vocabulary is the supervisor's, not a copy of it: the five outcomes are pinned against the verdict
  blocks in `scripts/supervise.mjs`, and `base88.reload/1` is imported from that file — a sixth outcome the
  supervisor could write fails the reader's own test instead of being judged as a pass by an older reader
  that has never heard of it. Pinned as a unit with the clock, the file and the streams
  injected (every outcome's exit code, an empty and a missing and an unreadable file, an unreadable line
  behind a good record, an unknown outcome, the stale record refused and then judged deliberately with
  `--since`, `--all`, `--json` routing, and a wait that both succeeds and times out) and end to end through
  the real process and a real `--wait`, because that is the interface a deploy runs. The fixtures are built
  by `reloadRecord`, the code that writes a line, so the reader is pinned against the writer's own output
  shape rather than against a literal copied out of a log.
- **The reloads `npm start` performs are visible in the app: `/settings` shows the last ten, with the same verdicts the deploy gate uses.**

  The history was written for a machine and the gate reads it for a pipeline, but a reload happens while
  nobody is watching: the supervisor runs under a process manager, on a machine that is not the operator's
  desk. The settings page now carries a **Reloads** panel, fed by `GET /api/deploy/reloads` — which reads
  `PROD_RELOAD_HISTORY` on the server, per request (`force-dynamic` and `no-store`, because the whole point
  is a line that has not been written yet) — showing the newest ten with the outcome, the moment, the reason
  it matters, the window that was allowed and the window it took, what closed it, what the app actually did
  through the replacement, and the supervisor's own detail when it had one. Set `PROD_RELOAD_HISTORY` in the
  environment `npm start` runs in: the supervisor and the server it starts share it, so one variable feeds
  both the file and this page.

  The words are the GATE's words, from a single declaration. `src/lib/deploy/reload-history.ts` holds the
  outcome vocabulary, the reader and the evidence line, and all three surfaces take it from there: the gate
  (a plain `node` script importing that `.ts` through this Node's own type stripping — the arrangement
  `scripts/demo-link-audit.mjs` already has with `src/lib/demo-link-audit.ts`), the route, and the panel. A
  test scans all three for a second copy of the vocabulary, because the bug this class of code ships is a
  page calling a rollback fine while the gate fails the deploy over it. It is ONE reader with one argument
  between the two policies: the gate passes the writer's schema constant and refuses a record from a
  supervisor it does not know, while the page passes nothing, keeps such a record, and labels it "an outcome
  this build does not know" rather than folding it into something it is not.

  The panel degrades in sentences instead of in render errors: no history configured (naming the variable to
  set), no file yet, no reload yet, a request that failed, a file that could not be read, and lines that could
  not be parsed — counted, named by line, and shown beside the records that could be read. The response
  carries no raw file text and no credential, only reasons and the parsed records, because the file is server
  state and this route is reachable from the page.

  Verified live on this machine, in front of a real `next start` under the real supervisor over this repo's
  own build: a real reload registered as **REPLACED** (window 4127ms of 4000ms, closed by clock, 4 real
  connections from the app, 3 health checks); a real rollback — `.next/server/app/page.js` moved aside —
  registered as **ROLLED BACK** with `closedBy: check` and its own detail, "the replacement failed its health
  check (it answered HTTP 500)"; the Refresh button issued a second live read with nothing on the console;
  and a server started without the variable showed the "no reload history is configured" panel and a 200 with
  `configured: false`. Pinned as the real route handler against temp files (newest first by `at` rather than
  by file position, a ten-record cap that keeps the total, missing told apart from unreadable, unreadable
  lines beside the readable ones, and the raw text of a line never echoed back) and as a component (every
  empty state, the ten-of-thirty count, an unknown outcome shown verbatim, a failed request leaving the rest
  of the page up, Refresh re-reading) — with fixtures built by `reloadRecord` and read by the same parser the
  route uses, so the panel is pinned against what it is actually handed.
- **A reload that produces a server which then fails undoes itself — and how long the way back is kept is decided by what the app is actually doing, not by a clock.**

  Swapping in a server that answered the probe is not the same as swapping in one that works — a build can
  boot and then fail every request, and until now the reload that installed it had already retired the
  server that was fine. The run a reload replaces is therefore not stopped at the swap: it goes on running
  on the port of its own, out of the way, while the replacement serves and is health-checked on `/`. A run
  that has exited, or that answers 5xx, has failed — a redirect, a 404 or a refusal to serve the thing are
  all a server that is working, and only the app failing to serve is what a rollback is for. On a failure
  the front door is pointed back at the run it replaced (a pointer move, like the swap) and the
  replacement is stopped through the same audited tree stop. There is no rollback after a CRASH — a run
  that died lost its port by definition, so there is nothing warm to go back to — and when the run that
  was kept warm is itself gone by the time the replacement fails, the log says there is nothing to fall
  back to and the replacement stays, because the alternative is pointing the port at a dead one.

  The window that stays open for that is the app's to decide, and only its bounds are the operator's. The
  front door counts the real connections it hands each run AND remembers when they arrived — a connection it
  accepted is a client's by construction, because the health checks
  are made straight at the run's own port and never through the door, and because there is nothing else to
  read: measured on this machine, `next start` on Next 16.3.6 prints no request lines at all, however many
  requests it serves — and the window's LENGTH falls out of those instants. Once the app has put
  `PROD_ROLLBACK_CONNECTIONS` (3) of them through the replacement, with health checks passed across them,
  the way back has nothing left to be held for and the run it replaced is retired then, early; short of that
  proof the window lasts as long as the observed rate needs to produce it — the last connection, plus the
  connections still missing times the mean gap between the arrivals it has. Anchored to that LAST
  CONNECTION rather than to now, deliberately: a deadline that re-measured its own idleness would push its
  own end out for as long as it stayed open, and every window would run to its ceiling.

  The bounds are the operator's, and the traffic only ever decides inside them. `PROD_ROLLBACK_MIN_MS` (2s)
  is the floor — a burst arrives with gaps far too small to pass the health checks a proof rests on, so the
  floor is what keeps evidence in front of the decision — and `PROD_ROLLBACK_MS` (90s, up from the 30s a
  fixed window used, because it is now the length of the window NOBODY has arrived in: the one window that
  needs the most time before it becomes evidence either way) is the ceiling. Nothing arriving at all, or a
  single connection — not two instants to read a rate from — leaves the ceiling to decide, so a quiet
  deploy's window is far LONGER than a busy one's rather than equal to it, which is the whole point of
  asking the traffic at all. `PROD_ROLLBACK_MS=0` retires the replaced server at the swap with no way back
  at all; `PROD_ROLLBACK_CONNECTIONS=0` leaves the window a clock at its ceiling, however much traffic
  arrives.

  Verified live against the real thing on this machine — `node scripts/start.mjs`, the production entry,
  in front of a real `next start` over this repo's real production build, driven by `curl` through the
  public port, one connection per invocation, which is exactly what the door counts and what the window is
  sized from. **Busy, so the window closed in seconds**: under a client asking over and over — 220 answers
  across one reload, a shorter burst across another — the windows closed after **2430ms** and **2753ms** of
  the 90s they were allowed — `the replacement has taken 3 real connection(s) from the app and passed 2
  health check(s) — retiring the run it replaced early` — with every one of those 220 answers a 200: no
  refused connection and no 503. **A trickle, so the rate decided the length**: two real
  connections 4.2s apart, and nothing after them, closed the window after **10394ms** — `the replacement
  stayed healthy for 10s — 2 real connection(s) through it, one every 4.2s, and at that rate the 1 more a
  proof needs is 4.2s — retiring the run it replaced at the end of the window` — a length no fixed number
  would have produced. **Quiet, so the ceiling was the answer**: with nobody using the app at all the
  window ran the whole **90249ms** — `the replacement stayed healthy for 1m 30s — the app sent it nothing,
  and a window with no traffic in it runs to the 1m 30s it is allowed` — and that reload's record did not
  exist 12s in, because a record is written when the reload CONCLUDES. **Broken, so it was undone**: with
  `.next/server/app/page.js` moved aside, the replacement booted and answered **HTTP 500** — to the probe
  too, which accepts any status, and that is exactly why the health check exists — the window closed after
  **1043ms** and the port went back to the run it replaced. Read back through the gate over those five
  records: `window 2753ms of 90000ms, closed by traffic` for a reload that landed (**exit 0**), and
  `NOT_LANDED records=5 landed=4 failed=1` with the rollback in scope (**exit 1**); the same five on
  `/settings` through `GET /api/deploy/reloads`, which is the panel's own payload — 2430ms/2753ms of 90000ms
  closed by traffic, 10394ms and 90249ms closed by clock, and the rollback at 1043ms closed by check.

  In CI the fixture can be asked for a run that comes up healthy and only then fails — answering 500 from
  `FAKE_SICK_RUNS`, or exiting outright from `FAKE_DYING_RUNS` — so both rollback shapes are pinned end to
  end, together with the window the app closed (asserted on the clock as well as on the log: a 20s ceiling,
  retired in about two seconds, and never before the two health checks the proof stands on), the window a
  trickle of traffic sized (two real connections seconds apart closing a 20s ceiling in about five, with
  the record's own `windowUsedMs` between the floor and the ceiling), the window nothing arrived in (which
  runs to its ceiling, with `served: 0` and the log naming the absence of traffic as the reason it was that
  long), the window a burst was not allowed to close sooner than the floor (2s, with the log naming the
  floor), the window the app never touched (one real request through the door is deliberately not proof),
  the window with early retirement switched off, the no-way-back case, and `PROD_ROLLBACK_MS=0` retiring at
  the swap. The window's arithmetic is pinned as a unit, hand-computed: the floor for an app sending twenty
  connections a second, the ceiling for nothing, for one connection and for early retirement switched off,
  the rate arithmetic for two slow cases, the ceiling when the rate asks for longer than it is allowed, the
  floor when a floor is put above the ceiling, no window at all for `PROD_ROLLBACK_MS=0`, and a rate read
  from instants (and none from one instant) formatted at the precision a rate needs. The health
  check's criterion is pinned as a unit — 5xx fails, 200/301/404 pass, a silent port fails, a run that has
  ended is never asked, and one check spans several attempts so that a busy server gets the window to
  answer in — and so is the door's own counting, including that a connection the door answered itself, or
  one already piped to another run, is not traffic the replacement was given, that it keeps WHEN the last
  few arrived, and that a run the door is pointed at starts at zero however much traffic its port served
  before.
- **`npm start` can replace the running server without the port ever closing — and a reload that cannot produce a server never takes down the one that works.**

  Restarting a server means closing its port and opening it again, and a request that lands in that window
  gets a refused connection. A port belongs to one process at a time, so the only way out is for something
  else to hold it: `npm start` now runs behind a **front door** — the supervisor takes the public port and
  pipes each connection straight through, byte for byte, to the run behind it, which is told a port of its
  own through `PORT`. It is raw TCP rather than an HTTP proxy, so keep-alive, a streaming response, a
  WebSocket upgrade and a TLS socket behind it all work without the front door knowing what any of them
  are, and a connection that arrives while nothing answers behind it — a boot, or the gap after a crash —
  gets a 503 from the front door itself, with a retry, rather than a connection that opens and closes for
  no stated reason. `PROD_FRONT=0` gives the port back to the server and runs as before.

  A **reload** is what that buys, and bare `next start` had no way to do it at all: under a container
  runtime the alternative was a second process and a load balancer. `kill -HUP <pid>` — or, on Windows and
  anywhere a signal is awkward to send, touching the file `PROD_RELOAD_FILE` names, which is removed as it
  is read so one touch is one reload — starts a replacement BESIDE the server that is serving, waits for  it to answer, points the front door at it (a pointer move, not a close and a bind), and only then retires
  the run it replaced through the same audited tree stop every restart uses — after a warm window in which
  the retirement can still be undone, which the entry above added; `PROD_ROLLBACK_MS=0` retires at the
  swap, which is the way the lines quoted below were measured. A reload that cannot produce
  a server changes nothing: the replacement is stopped, the log says why, and the server that was already
  up keeps serving, because a failed reload must not cost you the one that works. Reload requests that
  arrive while the loop is busy are remembered rather than lost, and ten touches are one reload, not ten.

  Verified live against the real thing on this machine — the production entry (`node scripts/start.mjs`,
  which is what `npm start` runs) supervising a real `next start` over a real production build: the front
  door took the port (port `52232`), the real production server answered through it, and a reload produced
  `back up — http://127.0.0.1:52287 answered HTTP 200`, `the replacement is serving — retiring the run it
  replaced (1 connection(s) still on it)` and `tree gone — 1 process(es), no survivors`, with every one of
  36 requests made across the swap answered `200`. Forcing the run dead instead is the other half of the
  same evidence: the port answered `503` for the 44 requests that landed in the gap — not one refused or
  silently closed connection — and `200` again once the replacement was up, on the same port.

  In CI the swap is MEASURED rather than asserted from the log: a client requests the public port on a
  connection of its own throughout the reload, and every answer it gets is the app's 200 — no refused
  connection, no front-door 503 — while the fixture's own request log shows the answers coming from BOTH
  runs, so the port really did change hands underneath it. Also pinned: a reload whose replacement never
  listens leaves the serving run serving, spends no restart budget, and the request after it is answered
  by the run that was already there; the 503 in the gap after a run dies; a held port stopping the
  supervisor before it starts a server at all; `PROD_FRONT=0` restarting as before; the front door's swap
  and its own 503 and the port it gives back; the reload queue that coalesces; the sentinel that is
  removed as it is read; and a run given a port of its own. `-H` is honored on both sides of the door, so
  `npm start -H 127.0.0.1` does not become public by being supervised, and the front door is NOT in the
  development entry: a front door in front of a dev server would be a second thing to debug while compiling.
- **A production `next start` that dies is brought back instead of going dark — `npm start` now runs it under the same supervisor as the dev server.**

  `next start` had nothing in front of it. When Node exited — an unhandled rejection, a native crash,
  the platform killing the process under memory pressure — the app was dark until somebody noticed:
  under a process manager after whatever interval the manager happened to have, and under `npm start`
  in a terminal not at all, because that terminal belongs to a window somebody has since closed.
  `npm start` now runs `scripts/start.mjs`, which supervises the server with the loop the dev entry
  already had: the port is learned from the server's own banner and probed until it answers, a run that
  ends is killed as a whole tree and that kill is audited, and the next run starts with the same backoff
  and per-run restart budget. A clean exit is respected, so Ctrl+C, `docker stop` and systemd's SIGTERM
  end the supervisor with that status instead of restarting a server you asked to stop. Verified live
  against the real production build on this machine: killing `next start` produced
  `the server exited with code 1 after 1m 1s`, `restart 1/5 in 1000ms`, `back up — HTTP 200`, with a
  fresh server answering again.

  Two things are deliberately different in production, and the first is a safety property rather than an
  omission: there is no pool-death signature to scan for, because a production log carries request
  lines — a URL containing that phrase could otherwise make the supervisor kill and restart a healthy
  server — and nothing is replayed, because the dev warm pass exists for an empty Turbopack compile
  cache and re-requesting a live server's pages is not a decision a supervisor should make. What
  production gains is a second fatal startup error: no build to serve. `next start` without a build
  exits, a manager restarts it, and the operator gets a flap loop instead of the one line that says
  `npm run build`, so that line — like a port somebody else holds — stops the loop and exits 1 (also
  verified live, against the real binary and Next's own message). The mechanism moved out of the dev
  entry's file into `scripts/supervise.mjs` — the loop, the probe, the tree kill, the audit, the backoff,
  the budget — and it now DEMANDS the policy rather than defaulting to development's: `supervise()` called
  without a `classify`, a banner, a giving-up hint, a log or a warm flag throws, naming every missing
  input. So neither entry imports the other, and a production supervisor cannot quietly inherit the dev
  judgement (a pool-death line, a warm pass, `DEV_PORT`) by omission — a fix to the probe, the kill or the
  audit lands on both or neither. `npm run start:plain` is still the bare `next start`, and both policies
  live in tests — `tests/start-supervisor.test.ts` for production, `tests/dev-supervisor.test.ts` for
  development, and `tests/supervise-module.test.ts` for the split itself.
- **The dev supervisor now audits the kill it performs instead of trusting it, and reports what it found.**

  "The tree is gone" was an assumption the restart depended on. A process-group SIGKILL can be ignored,
  and a worker that lost its parent to adoption is no longer reachable by the tree that was killed while
  still holding memory — and the port, if the thing that outlived the kill is the server itself. Each
  restart therefore ends with an audit, and each platform answers with the evidence it already has:
  on POSIX the subtree is read from `/proc` before the root is removed and once again afterwards (both
  reads free, and the before-read has to come first, because a table stops pointing at a subtree the
  moment its parent is gone); on Windows the enumeration and the verdict both come from `taskkill`'s own
  report — `SUCCESS: The process with PID … has been terminated` names every process in the tree, and its
  error lines name the ones it could not end. That last part is the reason Windows does not read the
  table at all: doing so means PowerShell, measured at 8–9 seconds for the whole table on a loaded
  machine and still 6.5–7.7 seconds even filtered to `Name='node.exe'` with command lines (3.3 seconds
  for pids alone, which is no command line — nothing to match a reused pid against); `tasklist` measured
  8–60 seconds under load, and this machine has no `wmic`. That is more than this audit is worth on
  every restart, and it buys nothing the kill report does not already say.
  It matters that both halves of that report are captured — successes arrive on stdout and errors on
  stderr (measured), so a parse of either alone is half an audit.

  A survivor is named in the log (`tree gone — 4 process(es), but 1 survived: 26404 (…pool_entry….js) —
  killing them`), force-killed one pid at a time — never `/t`, since a leftover may have been adopted by
  something innocent — and the result is checked again rather than assumed: `the leftovers are gone`, or
  `still alive after a force kill: … — the port may still be held`. Where a platform cannot answer, the
  audit stays silent rather than reporting a tree nobody inspected: a run that died by itself is not
  audited, because nothing was killed and a server that outlived it announces itself as EADDRINUSE on
  the next start. Verified live against the real Turbopack tree: a kill driven by the pool-death line
  enumerated `next dev`, its `start-server.js` and a live `pool_entry-[turbopack-node]_
  transforms_postcss_ts` worker, and the audit closed it — `tree gone — 4 process(es), no survivors`,
  the count matching that enumeration, every one of those pids gone afterwards and the port free — and
  an end-to-end test kills a fixture that has a real worker child of its own, so a kill that missed it
  would be reported rather than pass.
- **A restarted dev server no longer makes you wait for the pages you were already using — it re-requests them as soon as it is back.**

  Restarting the process is only half a recovery: a fresh process has an empty compile cache, so the pages
  you had open cold-compiled all over again on your next click, and the fix looked complete while the app
  still felt broken. The supervisor now learns which pages are in use from the dev server's own request
  log (` GET /settings/ 200 in 1631ms (next.js: …)`) and, once the port answers again, replays them —
  most recent first, bounded by `DEV_WARM_LIMIT` (6 by default), one at a time, because the pool that just
  died is the one most likely to die again under load. `DEV_WARM=0` turns it off; `DEV_WARM_TIMEOUT_MS`
  caps a page that never answers, and a page that hangs costs its own timeout rather than the pass.

  Two rules keep the list honest. Only pages are replayed — never a route handler under `/api/`, because
  although a GET is supposed to be safe, re-sending a request the user never made is not a judgement a
  dev-server supervisor should be making. And the supervisor's own traffic is excluded: its recovery probe
  and each replay are read back from that same request log, so without a marker the list would record the
  supervisor talking to itself — the probe would enter it, every replay would re-enter at the front, and
  the "pages in use" order would be rewritten by the thing meant to be observing it. ANSI colour is
  stripped for the same reason it matters: with `FORCE_COLOR` set, Next wraps the status code in escapes
  (` GET /settings/ <esc>[32m200<esc>[39m`), which would otherwise stop every request line — and the
  pool-death line — from being recognised at all. Verified live against the real dev server with colour
  forced: it crashed, came back, and recompiled exactly the pages that had been in use, while the probe's
  own marked request stayed out of the list; tests pin the marker, the `/api/` exclusion and the recency
  order.
- **A dead Turbopack transform worker pool no longer means noticing the 500s and restarting the dev server by hand — `npm run dev` supervises the server and brings it back itself.**

  When Turbopack's transform pool gives up, the dev server does not exit. The parent prints one line
  — `Jest worker encountered 2 child process exceptions, exceeding retry limit` — and the process
  keeps serving every route whose chunks are already built. The app therefore looks healthy on the
  pages you happened to visit and returns 500 for everything that still needs a compile, which is
  how it cost a whole debugging session recently, on a change that had nothing to do with it. The
  pool is per-process, so a fresh `next dev` always has a healthy one: the only fix was a restart,
  and until now that was manual — notice the 500s, find the line, kill the tree, start again.

  `npm run dev` now runs the server under `scripts/dev.mjs`, which streams the server's output
  untouched (Ctrl+C, `next dev`'s own shortcuts and the log all behave exactly as before), watches
  for that one line, kills the whole server tree, and starts a fresh server on the same port — then
  waits for the port to answer HTTP before calling it recovered. Killing the tree is the load-bearing
  part: `child.kill()` signals only the CLI process and leaves Next's own `start-server` child and its
  transform workers alive and holding the port, so Windows gets `taskkill /t /f` and POSIX gets the
  process group the server was spawned in. A server that dies on its own is restarted the same way;
  a clean exit, and the two errors a new process cannot fix (a second dev server for this directory,
  a port held by something else), stop the loop instead of spinning on it. The restart budget is per
  healthy run rather than per session — a run that stays up refills it, so an all-day session
  recovers indefinitely, while a server that dies during startup still gives up after
  `DEV_MAX_RESTARTS` and says so. `npm run dev:plain` is still the bare `next dev`.

  Detection is the pool's own death line, and that limitation is deliberate rather than an
  oversight: with the already-compiled routes still answering 200, a probe cannot tell a healthy
  server from a half-dead one without knowing which routes need a fresh compile. So the signature is
  pinned by tests taken from the line this repo's own dev log carried — next to the ordinary compile
  errors and 500s that must *not* trigger a restart — and an end-to-end test runs the real supervisor
  against a fake server that prints that exact line and holds a real port, which means a restart that
  left the old process behind would fail to listen instead of passing quietly.
- **Every model row in the pickers now shows the published context window and price — the facts are visible while choosing, not only on hover.**

  A native `<select>` shows text and nothing else, so the published facts had been reachable only
  through each option's tooltip: real, but invisible until you hovered, which is no help when the
  question is which of 458 models to pick. Each row now carries a compact badge —
  `llama-3.3-70b-versatile — 128k ctx · $0.59/$0.79` — so the two numbers a choice actually turns on
  are on screen in the open list and in the closed select, before anything is opened. The dataset
  attribution travels inside the badge (`via models.dev`) rather than only in the tooltip: a price
  you can see must say whose number it is, and the vendor's own figure and a curated third party's
  are different claims.

  The badge is deliberately short, and the reason is structural rather than cosmetic: an option's
  text *is* its accessible name, so everything put in the row is also what a screen reader
  announces for every entry. It therefore carries only what the choice turns on — context window,
  price, attribution — and leaves the provider's own label for the model, the output budget, tools
  and modalities on the option's `title`, the full line one hover away. A one-sided price still
  reads `$3/$?` rather than filling in the side nobody published, `1,048,576` still renders as
  `1.05M` rather than a rounder number than the one supplied, and a provider that published nothing
  produces no badge and no dangling separator — the row is exactly the model id, never a
  placeholder.

  The rule is pinned by component tests, including one assertion made on the real `<select>`'s own
  displayed option text so the closed control is covered rather than a lookalike span; emptying the
  badge fails five of them (verified by mutating it).
- **The settings cards now show the provider's own catalogue with each model's published facts, sortable by price or context window.**

  Every card had a free-text model field, which is all an unconfigured provider needs and no help at
  all for choosing among 458. Now the card shows the facts of the model it currently points at, and
  a `Browse N models` disclosure holding the provider's own list — one row per model with whatever
  was published about it, attributed (`via models.dev`) exactly as the pickers do. The rows order
  by catalogue, cheapest input price, or largest context window, and picking one only fills the
  card's model field: the card's per-provider diff-save remains the only thing that writes, so
  browsing cannot change a setting by accident. In both directions a model nobody published a
  number for sorts LAST — an unpublished price is not a cheap one and an unpublished window is not
  a small one — and that rule is pinned by a test that fails when it is flipped (verified by
  flipping it).

  A provider with no catalogue renders nothing: no disclosure, no facts line. That covers the
  unconfigured, the unreachable (LM Studio and vLLM in a live check, whose endpoints are down) and
  the not-yet-listed, and it means a shapeless `/api/models` response costs a convenience rather
  than the page. The card reads the same `/api/models` the pickers read — cached server-side, and
  free of the model list's own fetching cost — so a settings page load adds no provider requests it
  would not already make, and a provider the dataset table leaves out triggers no dataset download
  at all: verified in the browser, where the network log shows the settings and models calls and no
  models.dev request.
- **Providers that publish nothing about their models now show a context window and a price anyway — from the models.dev dataset, with the mapping declared rather than guessed and every such row attributed.**

  Reading each provider's own `GET /models` was the end of the road for the 22 of our 33
  providers that answer with bare ids: OpenAI, Anthropic, Gemini, Groq and the rest say nothing
  about a model's window or its price, so the picker showed an id and stopped. The second
  producer is the [models.dev](https://models.dev) document (MIT, keyless, no key and no user data
  in the request), reduced to a DECLARED mapping: one dataset provider key per one of ours, and
  then the model id has to match exactly. No normalisation, no suffix stripping, no case folding,
  and never a scan of the dataset's 226 providers for something that looks close — a confidently
  displayed wrong price is worse than an empty line, so an undeclared id stays factless. The table
  is pinned whole in `tests/model-facts.test.ts`, alongside a check that every key is a provider id
  the registry actually ships: a live probe caught the table keyed `z-ai` while the registry says
  `zai`, which looked perfectly reasonable and delivered 18 rows of nothing.

  Provenance is part of the value. `ModelMetadata` gained `source`; the shared rules moved into
  `modelMetadataFrom` so both producers are held to the same ones; and the picker prints
  `via models.dev` on a row that is not the vendor's own. A row never mixes the two — the
  provider's facts win outright for a model it publishes, and the dataset fills only what it said
  nothing about — because per-field provenance is not something this interface can show. Those
  shared rules do real work on this dataset: it carries `limit: {context: 0}` and no `cost` on
  models it has no window or price for (every OpenAI image model, for one), which have to read as
  "not published" rather than as a zero-token, free model, and a name with no fact behind it is
  not kept at all — a line offering a name plus an attribution has nothing to say. Token counts
  stopped rounding too: 1,048,576 renders as `1.05M`, not `1M`.

  The load is warm-only and never awaited, because the document is multi-megabyte (5.4 MB
  measured, 4.1 MB minutes earlier — the CDN's copy moves) and a picker must not wait on it: the
  first open after a cold start shows ids and the next one shows the facts. After that a
  day-long window serves it, concurrent opens share one download, a failure is remembered for ten
  minutes, and a catalog with no gap never triggers a download at all — an OpenRouter-only setup,
  where every model already carries its provider's own facts, never fetches the document (pinned).
  Measured against the live dataset and the real route: 226 providers and 8,456 models reduced to
  759 rows and 162 KB, 16 of the registry's 32 default models connected, and the numbers agreeing
  with independently published prices (Groq's Llama 3.3 70B at $0.59/$0.79 per Mtok with a
  32,768-token output cap, GPT-4.1 at $2/$8, Gemini 2.5 Pro at $1.25/$10).
- **The model picker asks each provider once per window instead of once per open, and shows the numbers the provider itself published.**

  Every catalog request used to be a fresh `GET /models` per configured provider, and the builder
  header carries two pickers (the global active-model select and the per-project pin), each firing
  on mount and again on every `refreshKey` — so one page view cost one request per provider.
  OpenRouter's catalog alone answers in 764 KB. `readModelCatalog` (`src/lib/models-catalog.ts`) is
  now the single path both catalog routes take, holding four rules: a five-minute fresh window
  serves without a request, concurrent opens share one request (single-flight — the two pickers
  mount in the same tick), a failure is remembered for 30 s so a dead endpoint is not re-probed on
  every open, and a refresh that fails KEEPS the last good catalog — marked `stale`, with `error`
  still saying why — for up to an hour, because a blip must not blank a dropdown that was working.
  Past the hour the failure stands on its own rather than dressing a day-old list as current.
  Measured through the real route against the real catalog: 721 ms cold, 5 ms warm.

  The catalog now carries what the provider publishes about each model, and nothing invented.
  Context window, price per million tokens, max completion tokens, input modalities beyond text,
  and whether the provider lists tool support all come from the very response that lists the ids —
  verified live rather than remembered: all 458 OpenRouter entries publish all of it. A provider
  that publishes nothing yields no row of its own, so "not published" stays distinct from "zero"
  (a free model's $0 is a fact; a missing price is not), and the picker renders exactly what
  arrived — the facts hover on the option
  (`Anthropic: Claude Sonnet 4.6 · 1M ctx · max 128k out · $3/$15 per Mtok · tools · image+file`)
  and sit under the select for the current selection, while a model with no facts gets no title
  and no line instead of zeros. Prices convert from what OpenRouter sends (USD per token, as
  strings) to USD per million here, and the unit is in the field name so no caller can guess it
  wrong. (The paragraph above the next entry showed this list as the whole story; it is not — the
  models.dev producer fills the providers that publish nothing.)

  The gates did not move, and the cache is not a second usability rule: unconfigured providers are
  still skipped with the same "No API key configured" note, un-expanded `{account}` URLs are still
  refused before any request, and 404/405 still means "this host has no catalog" rather than
  "down". Two spans the feature needed. Both catalog routes carry `metadata` now, and the contract
  pin in `tests/api-ui-contract.test.ts` compares it per provider against the gateway's own value.
  And a provider edit clears the cache, because a key pasted a second ago must not sit behind a
  remembered failure — which is also why a response that arrives after a clear is discarded rather
  than stored (a generation counter, pinned in `tests/model-catalog.test.ts` along with the fresh
  window, single-flight, failure memory, the stale window and the timeout label).
- **The sentinel rehearsal runs in ONE PowerShell and ONE node child instead of fifty, and its report is byte-identical to the baseline it had before.**

  A scenario's command has always been the same three statements —
  `. $env:REHEARSAL_STUB; & $env:REHEARSAL_SENTINEL; Write-Output ("REHEARSAL_EXIT=" + $LASTEXITCODE)` —
  and `scripts/rehearse-sentinels.ps1` used to hand that text to a fresh interpreter per
  request: 25 process starts for 16 scenarios, two for every scenario that files a record
  (the world, then the world with the recovered record on it). A PowerShell boot is ~1.2 s and
  the command it ran is usually shorter than that, so ~36 s of a ~40 s rehearsal was
  interpreter starts. `scripts/rehearse-sentinel-host.ps1` is now that interpreter, started
  once and asked to run the command again and again: one line in per request (base64 of the
  environment to set and the names to clear), one framed line out
  (`RUN <base64 of the captured output>`), and the exit code read from the same
  `REHEARSAL_EXIT=` marker the harness always parsed.

  What did NOT change is the point. The command, the environment, the marker line and the exit
  code are what they were; the environment now travels as data rather than being inherited,
  because a reused session does not get a fresh environment the way a fresh process does —
  including `VERIFY_FORCE`, which bypasses the date gate, and which no scenario may inherit
  from however the operator's shell was set up. The worlds are the same story one step earlier:
  24 `node ... materialize` boots (one per scenario, plus one per scenario that files a record —
  the world with the recovered record on it) became ONE child answering on one wire, and that
  child is now the **same** child the scenarios' REST calls go to — `scripts/rehearse-world.mjs`
  `session --endpoint <path>`, kept by `scripts/rehearse-world-session.ps1` and owned by the
  harness that drives the run. Both roles are `scripts/rehearse-world.mjs`, and both paths build
  a world through the same function — so "the same world" is a property of the code rather than a
  promise made twice.

  The child LISTENS on a local endpoint rather than answering on its own stdin, and that is what
  removed the last relay from the design. A pipe belongs to the process that STARTED the child,
  and the questions come from two different processes — this harness building the run's 24
  worlds, and the transport inside the host asking for routes — so while the wire was a pipe one
  of them had to ask the other to ask: the host answered a `materialize` request on the harness's
  behalf, once per world, through a process whose only job in that exchange was to hold a handle.
  The endpoint is a named pipe on Windows and a Unix socket in the run's own `0700` directory
  everywhere else — no IP socket is opened and nothing leaves the machine — so both ask the child
  directly, each on a connection of its own, reused for every question a process asks. What
  belongs to the owner is now only the LIFETIME: it holds the child's stdin, and closing it stops
  the child (the session unlinks its socket on the way out), so a rehearsal that dies still
  cannot leave one behind. Nothing relays anything: the host's protocol is `RUN` and `HOST_ERROR`
  and no world kind at all, the harness asks the child it started, and every process the run
  starts inherits the endpoint and connects as a client — one environment variable decides which
  of the two a process is. `tests/sentinel-rehearsal.test.ts` pins both halves (no relay left in
  the host, one child for both roles) and answers a live session on its endpoint from the test
  itself, with a second connection asking the same child after the first closed.

  What made one child enough is what a request carries. Two roles used to be two children of
  one file — a router started per WORLD (the world was an argument the child was started with,
  and this rehearsal walks seventeen of them) and a materialiser beside it running the same
  file for the same run. Neither the world nor the fixture is an argument now: both travel in
  the request, so nothing has to be keyed, restarted or duplicated, and a run that walks two
  chains is still one process. The wire is one line in and one line out, both base64 of UTF-8
  JSON, with the request kind naming which of the two questions it is (`route` or
  `materialize`); a frame neither reader can use comes back phrased for both — a refusal
  envelope for the transport, which throws on its status, and an error text for the harness's
  host. And loading the session is idempotent on purpose: the host dot-sources the stub — and
  through it that file — once per REQUEST, in a scope it discards, so a load that re-ran its
  state forgot the child mid-run and started another one, which was one node boot per scenario
  and a leaked process per scenario (found by counting the children rather than by reading).

  The evidence is the run's own children and the baseline, not the argument. The sentinels leg,
  measured on this machine across this work: **36.8 s / 34.5 s** with every child started per
  request → **9.4 s / 8.2 s** with one host → **7.4 s / 6.3 s** with the materialiser kept alive
  too → **5.0 s** (pwsh 7.6.5) with the one child, 5.6 s on Windows PowerShell 5.1. Only the
  same-round A/Bs mean anything, since the machine is shared: each step's two shapes were
  measured back to back and their reports compared, identical every time. The endpoint step is
  not another rung on that ladder and is not quoted as one: it removes a middleman rather than
  work, and the legs stayed in the band they were — sentinels **8.2 s / 6.8 s**, lifecycle
  **9.3 s / 7.7 s**, transports **3.2 s / 2.8 s** (pwsh 7.6.5 / Windows PowerShell 5.1, npm's own
  startup included), measured once each on this shared machine. What does not depend on load
  held again: the run still keeps **exactly one node child, one PID, for its whole length**
  (`peak=1 distinct_pids=1`, watched from outside), against a materialiser plus a router boot
  per world before. `npm run check:rehearsal-parity` matches every committed baseline
  (`rehearsal-sentinels.txt`, `rehearsal-lifecycle.txt`, `rehearsal-transports.txt`) byte for
  byte, on **both** engines — and with two engines uploaded it compares them with each other
  too, which is the check that matters here: 5.1.26100.9549 and 7.6.5 agree byte for byte on all
  three suites and both match the repository. And the worlds are the ones a one-boot-per-world
  run produces: `tests/sentinel-rehearsal.test.ts` builds a scenario's world, its echo (the same
  scenario with the recovered record on it) and both chains' worlds through the endpoint child
  and compares each with the per-boot CLI's, byte for byte on disk — the claim that matters most
  here, since every assertion in that rehearsal is an assertion about a world.

  The last number this step rests on is the one no report can show, so it is a gate rather than a
  paragraph. `npm run check:rehearse-children` (`scripts/check-rehearsal-children.mjs`) watches a
  leg from OUTSIDE — the process table, never the run's own word about itself — and fails when the
  run uses more than one world child at once (`peak`) or more than one at all (`distinct_pids`),
  reporting both because either can be the only visible half: a boot per request can be gone before
  the next sample, and a boot per world is many processes even when no two overlap. Only node
  processes naming the world script count, and the `rehearsals` job runs it on both engine lines.
  It is not decoration: with the ownership rule broken so that every process starts a child of its
  own, all 16 scenarios stayed **green** and every baseline still matched, while the run held two
  children at once — a regression nothing else in this repository can see. Its own failing
  direction is rehearsed too (`--command` with a command that keeps two world children, pinned in
  `tests/sentinel-rehearsal.test.ts`). And it paid for itself on the first run: the LIFECYCLE leg
  was reported as `peak=1 distinct_pids=4` — the endpoint had reached the sentinel's host but not
  the lifecycle's per-step PowerShell, so one record's life (four tools, eight steps) was answered
  by four children of the same file. Its harness owns the run's child now and publishes the
  endpoint to the steps it starts, so that leg is `peak=1 distinct_pids=1`, with a report
  byte-identical to the one it had before (both engines, against the committed baseline).

  Running those legs on the fallback engine is what found the one defect this step had: the
  named-pipe client took the pipe's NAME from `Split-Path -Leaf '\\.\pipe\<name>'`, and Windows
  PowerShell 5.1 answers that with an EMPTY string, so the client failed to construct
  (`pipeName cannot be an empty string`) for every request. On 5.1 every scenario came back
  `REHEARSAL_ROUTER_UNAVAILABLE` — a fallback engine that could not reach the run's child at all,
  which reading the file would never have shown. The prefix is stripped by hand now, and
  `tests/transport-rehearsal.test.ts` pins that it may not go back to `Split-Path`: no engine's
  idea of a path may decide whether a run can reach its own world.

  Three things the design rests on, each measured rather than assumed. `exit N` inside a script
  invoked with `&` ends THAT script and leaves the code in `$LASTEXITCODE` — it does not take
  the host down, which is the whole idea (verified on both engine lines before anything was
  rewritten). Nothing may reach the host's stdout except a response line, so the command's
  other streams are folded into the capture (`*>&1`, exactly what the caller's `2>&1` on the
  old child did), progress records are silenced (they render to the host, and here the host is
  a pipe, so there is nowhere for them to land but the frame), a stray console write in a
  rehearsed script is a FAILED rehearsal (`REHEARSAL_HOST_PROTOCOL`) rather than a shifted
  frame read as the next scenario's verdict, and `tests/sentinel-rehearsal.test.ts` pins that
  the rehearsed scripts do not write there. And base64 is what keeps the wire ASCII: a path or a
  comment body crosses it as the bytes it was written as, instead of whatever the two ends'
  codepages happen to agree on, and the request's JSON is read through `ConvertFrom-VerdictJson`
  so a `2026-10-29` gnomon stays the string the fixture wrote instead of arriving as a
  `[DateTime]` whose culture string would slide the sentinel's date gate by the machine's UTC
  offset.
- **The two transports of the simulated GitHub are asked the same questions now, and compared — by a real CI leg, not by a comment.**

  `scripts/rehearse-world.mjs` is one interpreter with two transports: the cron
  tools reach it through `scripts/rehearse-sentinel-stub.ps1`, the Node tools
  through `installFetchShim()`. The claim written on that arrangement — a fact
  about the world cannot mean two things depending on which language asked — had
  never been rehearsed: the sentinel rehearsal drove one transport, the lifecycle
  drove the other, and **both were green**, which is what "green on each, and
  disagreeing with each other" looks like. `npm run rehearse:transports`
  (`scripts/rehearse-transports.mjs`) reads `scripts/transport-rehearsal.json`:
  ten cases — an object, a multi-element array, a one-element array (which
  PowerShell unrolls into a single object with no `.Count`, the Hazard the
  scripts' `@(...)` wraps exist to survive), an empty array, a nested list, a
  refused write with its 403 body, an accepted one, a route the world does not
  describe, a raw file, and an **artifact download** — asked through **both**
  transports, with one observation from each side compared as canonicalised JSON.
  Each side reads its own world file, so a mutation on one cannot be read as
  agreement on the other. The download is the one case that compares what each side
  CAN do instead of two answers: an artifact is bytes, only the Node transport has a
  reader for it (the case unzips it with the recovery pass's own `unzipEntry`,
  against the log the world put there), and PowerShell must refuse them rather than
  answer `@{ Content = $null; StatusCode = 200 }`. That refusal is new: the stub's
  `Invoke-WebRequest` now throws `REHEARSAL_BINARY_UNSUPPORTED` for a body it cannot
  carry, because a successful download of nothing is a rehearsal of the wrong thing
  — the same silence, in the other transport, that the raw-file case had just found
  in the shim.
  The ten cases go to **one** PowerShell session (each answer names its case, so they
  are paired by name — a case whose answer goes missing is a failed case, not a
  comparison shifted by one), and the stub every cron rehearsal runs against reaches
  **one node child per process** instead of booting node per request: the same router,
  the same envelope, and — since the last step of this work — the same child the
  sentinel rehearsal's worlds are built by (`scripts/rehearse-world-session.ps1`), with
  the world travelling in each request rather than baked into the process, and that
  connection in global scope (those functions are called from scripts invoked with `&`, whose
  script scope is not where the stub was dot-sourced). The stub does not start or own that
  child: the process that does publishes its endpoint in the run's environment, the stub
  connects to it for its routes, and the harness asks the same child for the worlds — two
  clients of one child, with nothing in the middle. Measured locally: the transports
  leg ~4.1 s → ~1.8 s, the sentinel rehearsal ~40.0 s → ~35.9 s, the lifecycle ~9.0 s →
  ~8.1 s — with every rehearsal's report, and every committed baseline, byte-identical.

  It found one real difference the day it was written: the fetch shim's `text()`
  returned a JSON string *quoting* a raw file where the stub returned the file, so
  the same request meant two things — invisible until something asked both. The
  leg runs on both engine lines of the `rehearsals` job, uploads
  `rehearsal-transports.txt`, and the blocking `rehearsal-parity` job compares it
  against `scripts/rehearsal-golden/rehearsal-transports.txt`.

  That is also what makes the parity harness's own paths real rather than
  fixture-only: a declared report marker (`TRANSPORT`), a projection into a
  committed baseline, and a suite that fails loudly when its baseline is missing
  or its report grammar undeclared. `tests/rehearsal-parity.test.ts` now reads the
  suite list out of the workflow's legs rather than listing it, so a **fourth**
  rehearsal cannot slip in without a marker, an npm script and a baseline.

- **A record's whole life now runs in ONE simulated issue: a verifier computes it, the workflow files it, the day-after sentinel and the weekly auditor find it missing, the recovery pass re-posts it from the run's own artifact, and the world retires it — eight steps, four tools, one world.**

  Four tools keep this repo honest about a verdict and they are a *chain*, not
  four islands: a verifier posts a record on its cron day, the weekly heartbeat
  asks whether a run that owed a record recorded it, the day-after sentinel trips
  when a day's receipt never landed, and the recovery pass re-posts a lost record
  out of the run's artifact before it expires. Each of them had a rehearsal and
  each rehearsal built a little world of its own — so the thing that actually
  breaks in production, a **handoff** between two of them, had nowhere to be
  exercised: does the pass read the artifact the workflow wrote? does the auditor
  credit a comment the pass posted, and refuse to credit its own complaint? does
  the sentinel recognise a record the pass rebuilt?

  `scripts/rehearse-lifecycle.mjs` answers all three with the shipped code, against
  `scripts/rehearsal-lifecycle.json`: `verify-oct3.ps1` derives `PASS_REFRESHED` on
  the cron day and its POST is refused (`403`, the real `issues: write` omission);
  the harness plays the workflow's own upload step and asks the recovery pass's
  `parseRecordLog`/`buildRecoveredBody` whether the artifact is recoverable; the
  Oct 4 sentinel files the gap it exists to file; the heartbeat reports *two*
  findings — the verdict never recorded, the trip standing; the recovery pass
  re-posts the record and its second run finds nothing left; and finally the
  auditor reports the receipt landed (naming the very comment the pass posted) and
  the trip **stale**, while the sentinel stands down on the same record. The run
  ends by printing the #18 comment trail it left behind, which is the clearest
  statement of what was rehearsed: a trip, a complaint, and one recovered record.

  **There is only one interpreter of a world now.** `scripts/rehearse-world.mjs`
  is a router over a JSON world file — runs, jobs, artifacts, comments, contents,
  pulls — reached from PowerShell by `scripts/rehearse-sentinel-stub.ps1` (which
  marshals `Invoke-RestMethod` into it and can only throw for anything the world
  does not describe) and from Node by a fetch shim (`node --import
  scripts/rehearse-world.mjs`). The sentinel rehearsal now materialises a world
  file per scenario and the timestamps move with it, so a fact about the world
  cannot mean one thing to a `.ps1` and another to a `.mjs`. An unrouted request
  is an error in both languages, and the token every rehearsal passes is fake, so
  a mis-wired run fails at the far end rather than filing a false record.

  **A rehearsal of a day has to be able to say which day it is.** The faked-clock
  seam is now one shared policy on each side: `simulatedNow` in
  `scripts/verdict-contract.mjs` (read by the heartbeat as `HEARTBEAT_GNOMON` and
  by the recovery pass as `RECOVER_GNOMON`) and `Test-VerdictSimulatedTransport`
  in `scripts/verdict-contract.ps1`, which the four PowerShell scripts consult
  before forcing `DRY_RUN`. A faked clock is honoured **only while the only
  transport is a rehearsal's world** — the false `SENTINEL_NO_SCHEDULED_RUN`
  filed on #18 on 2026-09-30 is why — so the rehearsal can exercise the POST and
  `COMMENT_FAILED` for the first time, into a world that is not GitHub. The
  recovery pass's `since` cutoff is date-derived too: without the seam, a
  rehearsal pinned to the days a real chain fired would fall out of its own
  90-day retention window once the wall clock passed it.

  **It found a live defect on its first run, in the pass the day it was written
  for.** The Oct 3 chain fired three times and derived one day's verdict three
  times. `recover-verdicts.mjs` selected every unreceipted run from a comment list
  fetched *before* it posted anything, so each retry was judged against a list
  that predated the record already covering it — and the recovery posted the same
  comment three times, the exact duplicate-record failure the receipt contract's
  own prose promises to prevent ("that is what stops a retry chain from producing
  three duplicate comments for one day's verdict"). The pass now re-checks each
  run against the comments as they stand, including the ones it has just posted,
  and keeps the world's view of each accepted comment. The lifecycle's `recovered`
  step failed with `3 comment(s) landed on #18, expected 1` before the fix and
  passes with it.

  The rehearsal was mutation-verified **5/5** with every file restored
  byte-identical: a pass that rebuilds a record from the log instead of the body
  the script printed; a receipt credited from prose that quotes the marker (both
  of `isReceipted`'s guards removed); the retry-chain re-check removed; the world
  refusing the token that files the trip; and the auditor ignoring its faked
  clock. Two of those made the harness say something worth keeping: the receipt
  assertions were **vacuously true** for the Node actors (a chain the world has no
  runs for — the fixture must now name one, and the rehearsal fails loudly if a
  chain has no runs to judge), and the auditor's complaint is rejected by *two*
  independent rules, so only removing both is a mutation at all.

  `tests/rehearsal-lifecycle.test.ts` — **17 pins** on the part that could rot
  silently (three of them on the CI wiring, added when the rehearsal became a
  merge blocker): every phase in order, every record identity equal to what the
  declaration renders, the world shaped like the API's, every workflow the
  recovery pass enumerates registered (it walks the *contract's* list, so a
  missing one 404s a run query and reads as "nothing to recover"), every declared
  schedule given a run for its most recent due slot at every audit clock (  the auditor grades slots, not runs, so a drifted clock would rehearse a dead cron
  instead of a lost record), and every step's clock at or after the last.
  `npm run rehearse:lifecycle` is the executable half, run by the `rehearsals`
  job in ci.yml on ubuntu-latest — where the cron's own `pwsh` lives (see the
  entry below) — so it blocks a merge instead of waiting for a maintainer.
  Not rehearsed, deliberately: the world registers the five workflows these
  tools can name, not the repo's whole scheduled fleet, and its timeline is the
  real one *compressed* — the verdict really was recovered six days later, by
  hand, which is why the pass exists; the handoff is what is being exercised, not
  the six days.

- **Both day-after sentinels now have a rehearsal mode: their trip and clear paths run today, against a simulated promotion day, instead of first executing on the day they matter.**

  `oct29-sentinel` is the alarm for the Oct 28 promotion chain, and that chain
  does not exist yet — so every answer it can give has been exercised exactly
  once: the live dry run that reports `SENTINEL_NO_SCHEDULED_RUN` because none of
  the four crons has ever fired. Its *clear* path, whose whole job is to stay
  silent when a `PASS_PROMOTED` lands, has never run at all, and neither has the
  state that matters most the day after a promotion: the chain fired, the day
  ended, and the operator dispatch never happened (`SENTINEL_AWAITING_DISPATCH`).
  A clear path that has never executed is a clear path nobody has tested, and
  these alarms are the only thing watching for a schedule GitHub skips silently.

  `scripts/rehearse-sentinels.ps1` runs each scenario in a child PowerShell with
  `scripts/rehearse-sentinel-stub.ps1` dot-sourced, so `Invoke-RestMethod` *is*
  the world — the run list, the issue and its comments, materialised from
  `scripts/sentinel-rehearsal.json` by `scripts/rehearse-world.mjs`, the one
  interpreter every rehearsal reads (see the entry above) — while the sentinel
  runs its own code unchanged: date gate, run
  filtering, the `@(...)` counting that a single comment would otherwise break,
  latest-verdict classification, header rendering and the `ALREADY_RECORDED`
  guard. `VERIFY_GNOMON` makes each script force its own `DRY_RUN`, so a
  rehearsal ends at the printed body: it cannot post, read #18, or spend a token.
  That guard is not weakened to make the rehearsal more complete — it exists
  because a gnomon rehearsal filed a false `SENTINEL_NO_SCHEDULED_RUN` on #18 on
  2026-09-30 — and `Invoke-WebRequest` is shadowed to *throw*, so a script that
  ever grows a second way out fails the rehearsal instead of reaching GitHub.

  All 16 scenarios assert the sentinel's exit code, its verdict token (or that
  it filed none), whether it reached the would-post path, whether it recognised a
  record it had already filed, and that the printed body *starts with* the record
  identity the contract renders for that day — the string the recovery pass
  searches for and the heartbeat audits against. Beyond the fixture, each run is
  checked against the stub's request ledger: the run list it asked for must be
  bounded by the declaration's window, the verdict scan must use the *witness's*
  declared `since`, and the already-recorded search must start from the
  sentinel's own record day. A sentinel that reads a window it does not own fails
  here. The scenario matrix covers both trip states of each sentinel, both clear
  paths (a PASS, and an operator-closed #18), attempts still running, a late FAIL
  that outranks an earlier PASS, a `PASS_PROMOTED` recorded *before* promotion day
  that must not clear it, an issue closed before the chain ran, the dedupe guard,
  and the date-gate refusal.

  **The rehearsal found a live bug on its first run.** `oct29-sentinel`'s
  `SENTINEL_RUN_NO_PASS` branch was the one trip path that printed no `VERDICT=`
  line. `recover-verdicts.mjs` reads that line as the difference between "no
  verdict was computed" and "a verdict was computed and LOST": without it, a
  trip whose comment failed to post would be reported NOT RECOVERABLE and needed a
  human, on the path that fires when the promotion was *not* verified. Fixed, and
  the rehearsal now requires that line on every filing path.

  **The rehearsal also reads its own records back.** A sentinel's stdout *is* the
  artifact its workflow uploads, and `recover-verdicts.mjs` re-posts a record out
  of that artifact when the POST failed — so each half had a rehearsal and nothing
  joined them. Now every scenario that composes a record hands its captured log to
  the recovery pass's own parser and builder (`scripts/rehearse-roundtrip.mjs`
  imports `parseRecordLog` and `buildRecoveredBody`; it reimplements neither), and
  the comment the pass says it would post has to be the text the sentinel printed,
  character for character — identity line included, because that is the string the
  sentinel greps for when it asks whether it already posted. Then the recovered
  comment is put on the simulated issue and the scenario is run *again*: the
  sentinel has to report `ALREADY_RECORDED`. A record the pass rebuilds
  differently, or one the sentinel cannot see, is a lost verdict that returns as a
  stranger — or as a duplicate. **10 logs round-trip; 8 come back recognised.**

  The Oct 3/4 scenarios use the real run ids, the real Oct 3 runs and the real
  recovered verdict comment `6073315277`, because that chain has already happened
  and its states are the ones the sentinel has to keep judging correctly; the 99x
  ids in the promotion scenarios are fabricated and labelled as such.

  `tests/sentinel-rehearsal.test.ts` — **17 pins** on the part that could rot
  silently (two of them on the CI wiring): every `SENTINEL_*` verdict either script can emit is exercised by a
  scenario (so a new trip state cannot ship without a rehearsal of it), every
  scenario's expected record identity equals what the *declaration* renders for
  that day (the same check the PowerShell side makes, in the other language), the
  fixture's world carries the fields the scripts read, neither sentinel is left
  without a clear path, and the round trip goes through the shipped recovery pass
  rather than through a copy of it. `npm run rehearse:sentinels` is the executable
  half. Mutation-verified **4/4**: the missing `VERDICT=` line, a guard reading the
  wrong day, a run query on the wrong window, and a renamed record header in the
  declaration — the last failing in the other language, as `body starts with
  'post-Oct-3 sentinels …', expected 'post-Oct-3 sentinel …'`, with the dedupe
  scenario then reporting `would have posted a comment`. That is the duplicate
  record this repo has already filed once, reproduced in a rehearsal instead of
  on issue #18.

  The round trip is mutation-verified **4/4** in its own right: a sentinel header
  that grew a `{run}` segment (caught by the rehearsal *and* by the pins, in both
  languages), a builder that stopped using the composed body, a parser that kept
  only the identity line, and a transport that stopped serving the comment the
  harness hands back — each killed, each with the file restored byte-identical.

  Not rehearsed here, deliberately: the POST itself and `COMMENT_FAILED`. A
  sentinel's rehearsal ends at the printed body, so the log the round trip reads
  ends the way the dry path ends it (the restatement and the workflow's `exit=`
  line) rather than the way a failed POST ends it — the record's head, the
  identity the sentinel searches for and the body it composed, is the same text
  either way, and that is what is joined here.  Both *are* exercised, into the
  simulated world rather than GitHub, by the lifecycle rehearsal above. The live
  `check:oct*` scripts stay operator tools (they want the Windows Credential
  Manager token path), but the rehearsals are not: `npm run rehearse:sentinels`
  and `npm run rehearse:lifecycle` run in CI, on ubuntu-latest, under the same
  `pwsh` the cron workflows invoke — see the entry below.

### Changed
- **What counts as a verdict record is now declared once, and the eight consumers that write, recover and audit one all read the declaration.**

  Three consumers in two languages were answering the same question — *did this
  workflow record its verdict?* — from their own copies of the answer. Six
  PowerShell scripts restated the record issue (`18`), the marker each one posts,
  the window it scans, the verdict regex, and the artifact and `.log` names that
  hold the evidence; `heartbeat-audit.mjs` and `recover-verdicts.mjs` restated
  their own. Copies drift, and these had. `verify-oct3.ps1` and
  `verify-oct28.ps1` searched prior comments for `verifier run <id>` while
  writing `post-Oct-3 verifier (run <id>, <day>)`, so `ALREADY_RECORDED` could
  never match: a re-run posted a second copy of a record it already owned.
  Rehearsed on PowerShell 5.1 before the fix — both scripts re-posted, and
  `ALREADY_RECORDED` was dead code in both.

  `scripts/verdict-contract.json` now owns every fact of that shape — repo,
  issue, auditor marker, run-log grammar, and per workflow its script, kind,
  marker, header template, scan window, day it records, record shape, satisfied
  shape, and artifact. Two loaders read it, and nothing else parses it:
  `verdict-contract.mjs` (whose `RECEIPTS` and `TRIPPERS` views the two JS
  consumers import, which is why `heartbeat-audit.mjs` no longer exports a table
  of its own) and `verdict-contract.ps1`, the door for PowerShell. A fact is now
  derived, not restated: a sentinel *inherits* its witness's window and marker, a
  script resolves its own entry from `$PSCommandPath`, and the record's identity —
  the text that is written into a comment and the text searched for before
  writing it — is rendered by one function on each side from the same `header`
  template. That is what closes the duplicate: `ALREADY_RECORDED` now looks for
  the string the script just spent the run composing.

  Two phrasings the declaration carries because the scripts really write them:
  the Oct 28 verifier's `NO_DISPATCH_RUN` record has **no run segment at all**
  (`post-Oct-28 verifier (2026-10-09)`), and a sentinel records `checked <day>`
  rather than a run. Normalising those to one tidier template would have changed
  the identity of a comment that is already on #18.

  All six schedulable scripts were run dry before and after, and the output is
  **byte-identical except where it was meant to move**: `oct3-verify`,
  `oct28-verify`, `oct3-check` and `oct28-check` identical; the two sentinels
  differ only in a diagnostic line and one sentence of the verdict body, where a
  hand-written `oct3-verify` / `oct28-verify` and a hand-written
  `2026-10-03..2026-10-04` were replaced by the derived ones — and the derived
  window renders the same two dates, which is the point. Live, the recovery pass
  against #18 reports `recovered=0 unrecoverable=0` — no record is missing, and
  the Oct 4 trip that stood over the recovered Oct 3 verdict is retired by the
  auditor's own clearance rule (`gradeTripClearance`), which is pinned by tests
  rather than by a live run: the auditor refuses to run without a token, and a
  live filing can post to #18, so it is left to its schedule.

  `tests/verdict-contract.test.ts` — **15 pins** holding all three consumers to
  the declaration: every declared workflow has a script that dot-sources the
  loader and resolves its own entry; the three derived views agree by
  construction; a sentinel declares no window of its own; and no script restates
  a marker, a `-like` pattern, a window, the issue, the repo slug, the log
  grammar — or a workflow file name, which is a declaration key. The last of
  those caught `oct3-check`/`oct28-check` spelling out the workflow they query in
  a URL, and the sentinels spelling out their witness.

  Deliberately **not** declared: the verdict vocabularies themselves. Which verbs
  a chain may emit, and what each one means, stay in the script that decides them
  — a global verdict regex is the exact shape that once called oct28's legitimate
  `NO_DISPATCH_RUN` a missing record. Also not declared: the cron grid, which
  lives in the workflow YAML, and the prose in a verdict body, which names dates
  and schedules on purpose because a human reads it.

### Added
- **Every AI provider worth naming is now built in — 33 catalog entries, up from 15.**

  Eighteen new hosted entries: Azure OpenAI, Amazon Bedrock, Cohere, Perplexity,
  Cerebras, SambaNova, NVIDIA NIM, DeepInfra, SiliconFlow, Alibaba DashScope (Qwen),
  Moonshot (Kimi), Z.ai (GLM), MiniMax, Hugging Face, Novita, Nebius, Upstage and
  AI21. They join OpenAI, Anthropic, Google, Groq, Mistral, DeepSeek, OpenRouter,
  Together, Fireworks, xAI, free-tier Cloudflare Workers AI, the local
  Ollama / LM Studio / vLLM servers and the custom catch-all — **29 hosted,
  up from 11**.

  Every new base URL was **probed, not remembered**: an unauthenticated POST to
  `/chat/completions` must reach auth (401/403 = the route exists; 404 = do not
  ship), and each `defaultModel` comes from the vendor's own docs or a live
  `/models` response. GitHub Models was researched and then dropped — it was
  retired on 2026-07-30, so there is nothing left to integrate.

  Two entries say in their `note` what the user must edit (Azure ships a
  placeholder host, Bedrock a region), and Bedrock and AI21 have no usable
  `GET /models` — so `fetchModels` now treats 404/405 as "empty catalog, fall
  back to the default model" instead of "provider down". Without that a
  perfectly healthy Bedrock would have been reported unreachable on first open.

  `.env.example` now documents one `<ID>_API_KEY` per credentialed provider,
  which exposed that it had been documenting `GOOGLE_GENERATIVE_AI_API_KEY` all
  along — a variable the gateway has never read, because the fallback is derived
  from the id (`GOOGLE_API_KEY`). Copying the old file configured nothing for
  Google.

  `tests/provider-registry.test.ts` — **18 pins**. Structural: unique ids shaped
  like an env var, no baked credentials, only the kinds `resolveModel` accepts,
  `custom` last, `{account}` templated only for Workers AI, placeholder hosts
  documented, local endpoints keyless. Literal: every probed base URL and default
  model, each on its own vendor host. Contract: the `.env.example` ↔ gateway
  derivation in both directions, and the README's provider count against the
  registry itself — the class of stale number this file shipped once already.
  Mutation-verified **14/14**.

### Added
- **A lost verdict is now recovered automatically, while its evidence still exists.**

  On 2026-10-03 the Oct 3 verifier derived `PASS_REFRESHED` three times and
  recorded it zero times. The verdict survived only in a run artifact that
  expires after 90 days, and it was recovered by hand six days later - a recovery
  that introduced its own error, transcribing the artifact's `SNAPSHOT ... age=1d`
  as "0 days old".

  `scripts/recover-verdicts.mjs` (`npm run recover:verdicts`; weekly via
  `.github/workflows/recover-verdicts.yml`) is that recovery on a clock. It
  covers all four workflows that promise a durable record on #18 - the two
  verifiers and the two sentinels - by listing their runs inside the retention
  window, skipping any whose record already landed, and re-posting the rest
  **from the run's own artifact** (`oct3-verify-log`, `oct4-sentinel-log`, ...),
  quoting that artifact in full rather than paraphrasing it. Paraphrasing is
  exactly the mistake this exists to make impossible: an earlier draft filtered
  the log to a whitelist of "interesting" lines, and the oct4 sentinel's two most
  useful lines match no such prefix, so the recovery would have quoted a record
  with its evidence missing. It never fabricates one either - a run whose
  artifact carries no `VERDICT=` line (the date gate refusing, an in-progress
  attempt) is reported, not guessed at.

  The verifiers and the sentinels do not owe the same thing, and the pass does
  not conflate them. A verifier posts a verdict every time it derives one, so any
  completed run without a comment is a lost record. A sentinel posts **only when
  it trips**, so a green run is silent by design: judging one like a verifier
  would turn every satisfied sentinel into an invented finding. And a recovered
  sentinel is marked as what it is - a historical report from a named run and
  day, expressly not a new alert, with re-running the sentinel named as the way
  to clear it. Its header also reproduces the sentinel's own sentence exactly,
  because each script dedupes on its own header text and a run id tucked inside
  those parentheses would put the recovered comment outside the string the
  sender greps for (a pin caught precisely that).

  All four record-keepers now also print their composed comment body into the log
  they upload (`--- VERDICT BODY ---`), so a future loss is re-posted byte for
  byte rather than reconstructed. Reading an artifact needs a zip reader and these
  audit scripts are deliberately dependency-free, so the recovery carries a
  short central-directory reader over `node:zlib` instead of an npm package.

  The receipt test is strict on purpose: a comment counts as a verdict only if it
  carries the marker **and a verdict shape** (`**PASS_...**`, `**ATTENTION_...**`,
  `**FAIL_...**`, `**CRON_...**`). Without that, the 2026-10-05 heartbeat comment
  - which quotes `post-Oct-3 verifier` while reporting that the verdict was never
  recorded - is credited as the Oct 3 receipt. A prophylactic that can be
  satisfied by a description of the condition it prevents is not a prophylactic.

  A receipt recorded *after* a run covers that run, so a retry chain cannot
  produce three duplicate comments for one day's verdict - the Oct 3 chain
  declares three attempts, and one landed verdict is the whole ask.

  `tests/recover-verdicts.test.ts` - **31 pins**, built on the real artifact bytes
  (`oct3-verify-log`, `oct4-sentinel-log`) and the real #18 comment bodies,
  including that false positive by name and the sentinel/PASS shape disjointness.
  A further pin derives the sentinel verdicts from the scripts themselves, so a
  verdict the shape test cannot see fails the suite instead of quietly making
  recovery re-post over a record that already exists. Mutation-verified **12/12**.

### Fixed
- **A reload asked for while the front door had nothing behind it killed the supervisor — and with it every client at the port that is supposed to never close.**

  A reload whose door has no target reads its way back off the run it is serving with: the port the
  probe never pointed at is the one the run was given, and `previousPort: null` in the record is that
  case named. That fallback was `serving.port()` — and `port()` was never on a RUN. `beginRun` returns
  the accessor BESIDE the run (`{ run, probed, port }`) while every caller destructures the run and
  hands that around, so the `??` short-circuit hid the missing method for as long as the door was
  pointing somewhere and the one window that takes the fallback — a reload asked for before the first
  run answered, or in the gap after a run died, where the door is deliberately cleared so it can never
  end up pointing at whatever holds that port next — threw `serving.port is not a function`. The
  supervisor exited; the door went with it; the port refused every client from then on, which is the
  opposite of what the door is for. The accessor now hangs off the run itself as well as the pair
  (`Object.assign(run, { port })`), because a run is what a caller is handed and the port a run is
  reached on is part of the run: banner-learned, or the one it was given. **Found by the swap watch on a
  real build**, where a reload asked for in that window took the port down mid-soak, and pinned in
  `tests/start-supervisor.test.ts` ("reloads while the door has nothing behind it, instead of taking the
  door down with it"): on the unfixed code the test fails with `[start] serving.port is not a function`
  and no swap, and with the fix the muted first run is replaced, the record carries `previousPort: null`
  with the replacement's port, and the client that knocked after the swap is answered by the
  replacement — 200, not a refused connection.
- **Both rehearsals now run in CI, on two lines of the engine the cron actually uses (`pwsh`) — and their first run there caught the contract loader handing the API a culture-formatted `[DateTime]` where the declaration holds an ISO instant.**

  The rehearsals ran only by hand, on a maintainer's Windows box, where the only
  engine tended to be Windows PowerShell 5.1 — while the cron workflows fire on
  ubuntu-latest under PowerShell 7 (`oct3-verify.yml`: `pwsh -NoProfile -File
  scripts/verify-oct3.ps1`). A rehearsal that only runs on the author's box
  rehearses the author's engine, which is how a gate becomes a local habit.
  `ci.yml` now has a `rehearsals` job — blocking, reached through `ci-ok` — whose
  matrix runs both rehearsals on **7.4 (the LTS line) and 7.6 (the newest stable
  line)**, installing the series it claims from PowerShell's release feed rather
  than trusting the image's single engine, and each leg asserts the line it
  resolved. `npm run rehearse:which` is its first step, so a runner with no
  PowerShell fails with `REHEARSE_PWSH_MISSING` (exit 2) instead of leaving a green
  job that rehearsed nothing. The engine is chosen in one place,
  `scripts/rehearse-pwsh.mjs` (pwsh first; Windows PowerShell only as the fallback
  for a box that has no 7), and both the lifecycle harness and the sentinel
  harness spawn their children through that choice rather than a second copy of
  the engine name.

  **The matrix was not decoration; it failed immediately, and twice for two
  different reasons.** The underlying defect is older than CI: `ConvertFrom-Json`
  turns `"2026-10-28T00:00:00Z"` into a `[DateTime]` on **every PowerShell 7**
  (measured: 7.4.20 and 7.6.x, `Kind` Utc for a `Z` instant and Local for an
  offset one) — 7.0–7.4 with no way to opt out at all, and 7.5+ only because
  `-DateKind String` exists. Windows PowerShell 5.1, the engine every rehearsal to
  date had run on, does not convert. A `[DateTime]` interpolated into a URL is a
  CULTURE string, so `oct29-sentinel`'s verdict scan went out as
  `/issues/18/comments?since=10/28/2026 00:00:00`: the `Z` is gone, the API (and
  the simulated world) reads the instant as **local** time, and the window slides
  by the machine's UTC offset. On this box (+07:00) that pulled a comment from
  `2026-10-27T22:00:00Z` into a window declared to start `2026-10-28T00:00:00Z`, and
  the sentinel classified a `PASS` recorded the day **before** promotion day as
  promotion day's own record and stood down — the exact false clearance the
  scenario was written to catch, from the loader rather than from a script. The
  first fix used `-DateKind String` where available; the 7.4 leg rejected it,
  because 7.4 coerces *and* offers no parameter, so the loader now asks a reader
  that cannot coerce at all: on PowerShell 7 the parse is `System.Text.Json`
  (verbatim for `Z`, fractional and offset instants alike), and on 5.1 — which has
  no `System.Text.Json` — `ConvertFrom-Json`, measured verbatim for every shape in
  play. `Test-VerdictVerbatimJson` asks that question by resolving the type
  literal, not with `[type]::GetType`, which searches only already-loaded
  assemblies and answers `$null` on 7.4 and 7.6 alike — the helper's own first
  version used it, and quietly fell back to the coercing parser on the very engine
  it was written for.

  The same rule is used at every other JSON door that reads a declaration or a
  world — the rehearsal transport `scripts/rehearse-sentinel-stub.ps1` (whose
  envelopes the matching Node transport never coerced, so the two transports now
  agree about the same world), the sentinel fixture, and the two verifiers'
  snapshot reads. Two scenarios failed before the fix on 7.4 and on 7.6 alike; all
  16 pass after it, with the lifecycle's 8 steps green, and the counts are
  **identical on every engine tried — pwsh 7.4.20, pwsh 7.6.x and Windows
  PowerShell 5.1: `roundtrip=10 recognised=8`** — which is what makes the two
  parses and the 5.1 fallback measured rather than assumed.

  **And the legs are now compared to each other, so a version matrix cannot become
  two rehearsals that never agree about anything.** Each leg records its output
  (`| tee`, with `pipefail`, so a failed rehearsal cannot upload itself as a
  successful one), uploads it as `rehearsal-output-<version>`, and a blocking
  `rehearsal-parity` job — dependency-free, blocked through `ci-ok` — diffs the
  files with `scripts/rehearsal-parity.mjs`. It fails on a difference *and* on a
  single input: a comparison that cannot fail reads like one that passed, which is
  the same failure mode as a rehearsal that only ever ran on the author's engine.
  Exactly three things are normalised, all of them properties of the capture rather
  than of the engine — a pipe's line endings (Windows PowerShell re-emits a child's
  stdout as CRLF; `pwsh` on Linux does not, and the first local three-engine
  comparison reported a 'difference' on the harness's first line that was nothing
  but a `\r`), the directory a FAILING run names as its evidence, and the directory
  of a `fixture=` path (added with the committed baseline below, which is read on a
  machine nobody chose; the FILE name is kept, so which fixture a rehearsal read is
  still compared) — and `tests/rehearsal-parity.test.ts` pins that list, the line a
  difference is reported at, and the wiring, so a fourth normalisation cannot be
  slipped in to make a real disagreement pass. The three engines this repo can reach
  were compared with it before it was wired: **7.4.20, 7.6.x and 5.1 agree byte for
  byte on both suites.** Mutation-verified 3/3 — a scenario lost on one engine, a
  lifecycle step lost on one engine, a summary count drift — each caught with the
  suite, the two engines and the line named, each file restored byte-identical.

  **And the two legs are compared against the repository as well as against each
  other, because two engines only catch the engines DIVERGING.** Both run the same
  test on the same commit, so the ordinary change — a scenario renamed, a verdict
  flipped, a summary count edited — moves them together and passes a cross-engine
  comparison *by construction*: it reports on the engines, never on whether the
  rehearsals are still rehearsing what they were. `scripts/rehearsal-golden/` is the
  other half: the projected report each suite is expected to print, committed, so an
  edit to what the rehearsals observe lands as a diff on `scripts/rehearsal-golden/
  rehearsal-sentinels.txt` or its lifecycle sibling and somebody has to read it.
  What is committed is the PROJECTION rather than a captured stream — the
  rehearsal's own report lines, machine directories masked, LF, one trailing newline
  — which is what makes it something a repository can hold and a runner can match:
  npm's banner would turn every version bump into a baseline failure, an engine's
  warning would make it fail on whichever engine does not emit the warning, and the
  author's checkout path would make it fail everywhere else. `--write-golden` is the
  only way it changes, and it re-reads what it wrote in the same command so a
  baseline that does not match the run it came from cannot be left for CI.
  Both directions of absence fail as well, since each is coverage that quietly
  stopped: a suite that rehearsed with no baseline is a rehearsal nobody wrote down,
  and a baseline no leg uploaded is a pin comparing nothing — the second is
  invisible otherwise, because a whole suite missing from BOTH legs produces no
  cross-engine failure either. Measured: **all three reachable engines — 7.4.20,
  7.6.x and 5.1 — match the committed baseline on both suites**, from a Windows
  capture (CRLF, `C:\Workspace\…`) and from a POSIX one alike, and a line a leg
  printed that the other did not is still a cross-engine failure. Mutation-verified
  3/3 against the baseline — the same verdict moving every engine together (caught,
  naming the engine and the line while the legs still agree with each other), the
  fixture FILE changing, and the committed baseline itself drifting — each caught,
  each file restored byte-identical.

- **The weekly heartbeat retired a tripped sentinel only when the gap it named was really closed — and it no longer reads its own report as evidence.**

  The auditor judged a sentinel trip by the newest *scheduled* run's conclusion,
  which for an annual cron is a moment that never changes. Run `37183204922`
  concluded `failure` on 2026-10-04 because the Oct 3 chain had recorded no
  receipt; that receipt was **recovered onto #18 on 2026-10-09** (comment
  `6073315277`, `PASS_REFRESHED`), a forced dry run of the sentinel then reports
  `SENTINEL_OK` — and the heartbeat would have gone on re-filing that one deleted
  morning at every audit through 2026-11-30, eight more weekly filings, before
  the 62-day lookback quietly dropped the cron from the audited set in December.
  The stale finding was not going to be corrected; it was going to be lost. A
  finding that outlives its gap is not caution; it is the wallpaper that teaches
  a reader to skip the findings that are still real.

  Each `TRIPPERS` contract now declares its `cleared` half: the verifier marker
  and the window *that sentinel reads*, both pinned against the scripts that own
  them. A trip is reported only while no comment carrying that marker with a bold
  `PASS_...` verdict has landed inside the window **after** the trip — a trip is
  stale for having been contradicted by later evidence, never for having been
  wrong when it was filed. Live, this retires the standing Oct 4 trip:
  `findings=0`, the oct4 row becoming a note that names comment `6073315277`.

  The obvious alternative — trust a newer green sentinel run — was rejected on
  evidence, not taste: a sentinel's `workflow_dispatch` is a **smoke** drill that
  always concludes success while running `DRY_RUN` against nothing, and its date
  gate can also exit green without evaluating a thing, so a green run is no more
  a verdict here than it is in `RECEIPTS`. What is graded is the durable record
  the sentinel itself reads. The trip's remedy sentence was wrong and is fixed
  with it: a satisfied sentinel posts nothing, so re-running it never cleared
  anything — landing the receipt did.

  Both checks now refuse `SELF_MARKER`, the auditor's own comment, as a witness.
  That was a live false clear on the *receipt* side: the 2026-10-05 heartbeat
  reported "the Oct 3 verdict was never recorded on #18", and because that
  complaint quotes the marker, every later audit credited it as the receipt —
  the lost verdict whitewashed by the comment announcing the loss, and silent
  until the receipt genuinely landed four days later. A report *about* a gap is
  not evidence *of* one.

  `tests/heartbeat-schedule-grace.test.ts` — **81 pins, up from 64** — built on
  the two real comment bodies above rather than on invented ones.
  Mutation-verified **11/11**.

- **Both sentinels misread a single verdict comment, so a satisfied chain still tripped.**

  `$verdictComments = @($comments) | Where-Object {...}` wrapped only the *input*.
  PowerShell hands an intrinsic `.Count` to arrays and hashtables but not to a lone
  `PSCustomObject`: at exactly one element, `.Count` reads **empty**, so
  `$pass.Count -gt 0` was silently false and `if ($verdictComments.Count -gt 0)`
  silently took its else branch. One verdict is the normal case, and it is exactly
  the state left behind once the Oct 3 verdict was recovered: a forced dry run of
  the Oct 4 sentinel against today's #18 printed
  `#18 verifier comments since Oct 3: 2 (PASS: )` and reported
  **SENTINEL_RUN_NO_PASS** over a perfectly good `PASS_REFRESHED`. The Oct 29
  sentinel carries the same gate on `*post-Oct-28 verifier*`.

  Both now wrap the **result** - `@(@($comments) | Where-Object {...})` - and are
  proven at 0/1/2 elements on Windows PowerShell 5.1, which is what the workflows
  invoke. The wrap has to sit after the filter rather than around the raw response:
  `@($null)` is a **one**-element array, so the obvious fix would have turned "no
  comments" into a count of 1. Re-run live, the Oct 4 sentinel prints `(PASS: 1)`
  and exits 0 with **SENTINEL_OK**.

- **Component tests were failing on CPU contention, not on defects.**

  user-event's direct api (`userEvent.type(...)`, `userEvent.click(...)`) defaults
  to `delay: 0`, and that is not "no delay": `wait()` awaits a real
  `setTimeout(resolve, 0)` between every key and every pointer action, so wall
  time tracks the scheduler instead of the code under test. On this 12-core box
  `DeploySection`'s first test measured **1270ms idle, 3095ms under 10 CPU hogs,
  and 5056ms — `Test timed out in 5000ms` — under 24**, while the identical test
  built from `userEvent.setup({ delay: null })` took **1441ms under the same 24
  hogs**. `settings-form.test.tsx` sat at 3635ms and 3784ms under the same load
  — the same defect, one hop short of the same cliff, and it did surface as
  timeouts once the whole suite ran in parallel.

  Three suites now build their interactions from `setup({ delay: null })`, which
  still fires real per-key input events but skips the timer, and the two
  heaviest settings-form tests dropped to 387ms and 190ms under identical load.
  No assertion was weakened, relaxed or reordered.

  `tests/architecture-user-event-delay.test.ts` is the new guard: it strips
  comments first (prose about the api is not a violation), refuses any direct-api
  call anywhere in `tests/`, requires every `userEvent.setup()` to pass
  `delay: null`, and self-tests both of its own patterns so a mistyped regex
  cannot make it pass silently. Mutation-verified **3/3**.
- **A sentinel that fired was being reported as healthy.**

  Run 37183204922 - the Oct 4 sentinel, concluded `failure` at 2026-10-04T06:34:35Z
  because the Oct 3 chain had recorded no receipt - was graded `ok` by the
  weekly heartbeat. The rule behind that was deliberate and still correct for
  its own question: "a RED run is still evidence the schedule fired". It is the
  right rule for liveness and the wrong one here, because `oct4-sentinel.yml`
  ends its happy path with `SENTINEL TRIPPED - gap posted on issue #18"; exit 1`.
  For a sentinel, red is not a failure to run - it **is** the report.

  So the loudest signal the repo produces was being discarded by the one job
  whose job is to notice signals. A sentinel that fires has proven two things:
  the schedule is alive, and the condition it watches is present right now. Only
  the second is worth a finding.

  `assessTrip` now answers the third question a scheduled run can ask. A
  workflow listed in `TRIPPERS` that concludes non-success files a finding naming
  the run and the gap; a clean one is a note saying what it watched. The
  auditor reports **2 findings** against the real repo today where it reported 1.

  Deliberately excluded: the verifier workflows. `oct3`/`oct28-verify` exit 0
  even when they fail to record (the #129 bug), so their conclusion carries no
  signal either way - `RECEIPTS` is the contract that holds them to account.

  64 pins in `tests/heartbeat-schedule-grace.test.ts` (was 53), mutation-verified
  7/7. Three mutations survived the first pass - `assessTrip` is pure and fully
  pinned, which is exactly why nothing asserted that `main()` hands it the
  contract or reports what comes back. Those are pinned now, structurally, the
  same shape this file already uses for the CI permission guard.
- **Three cron comments sat glued to their values, and nothing could see it.**

  `oct3-verify.yml` line 26 and `oct28-verify.yml` lines 24 and 25 each read
  `'17 19 3 10 *'# evening backstop` - a comment with no separating space,
  present since #58. GitHub's parser tolerates them, so the crons still fire and
  every workflow keeps running; a strict YAML reader calls it `MISSING_CHAR`.

  It survived because of a gap with a name now: **no gate inspects the workflow
  files.** Every check in this repo reads code, so a malformed workflow merges
  with all legs green - nine green CI legs said nothing at all about whether the
  files defining them were valid.

- **A new gate now parses every workflow file, and it is wired into `ci-ok`.**

  `scripts/check-workflows.mjs` (`npm run check:workflows`) runs five checks on
  the **parsed** document rather than the text: the file parses with unique keys
  and strict comment separation; every `on.schedule[].cron` is five fields in
  range; every workflow that posts an issue comment holds the scope that lets it;
  **no workflow regenerates a committed record**; and **the one pin CI does
  refresh stays where it can be committed**. It runs as a step in the shared
  `gates-steps` action, so the blocking gates job and the canary run it and
  cannot drift apart, and `ci-ok` - already the required check - needs no
  branch-protection change.

  The last two are one policy, and they exist because the pinned artifacts in this
  repo are not all the same kind of thing. A **record** is evidence about behaviour
  the repository already had: the rehearsal baseline (`--write-golden`) and the
  generated pins (`new:pin`, read back by `verify:generated --strict`). Refreshing
  one where it is checked makes the check vacuous - in CI's discarded checkout it
  is a PASS about a file nobody has, and if a workflow committed it, the pin would
  be re-made by the very run it judges. So CI checks those and never writes them.
  A **mirror** is a copy of something upstream whose freshness is the whole point
  (the schedule snapshot), and CI does refresh it - on a step guarded to
  `schedule`/`workflow_dispatch` inside the one job holding `contents: write`, so
  the refresh lands as a bot commit instead of evaporating with the runner. Both
  halves check shape rather than intent, so `writeFileSync` across `scripts/` was
  audited first: three writers of committed files (`rehearsal-parity.mjs`,
  `new-generated-pin.mjs`, `update-schedule.js`) plus `rotate.mjs`, which writes
  only under the gitignored `.freebuff/` and therefore holds no pin at all. The
  policy is declared in the gate as `PIN_WRITERS`/`REFRESHABLE_PIN` - a new pattern
  or a new exception is a deliberate edit - and pinned by tests that run both
  halves against fixtures and against the real tree.

  The cron check earns its place on its own: GitHub **silently ignores** a cron
  it cannot parse. No error, no run, no notification. A typo'd cron is a
  scheduled job that does not exist, which is the same silent death as the
  missing `issues: write` above.

  Permission resolution is parsed rather than grepped, and that is a strictly
  stronger question than the existing text guard in
  `tests/heartbeat-schedule-grace.test.ts`: a job-level `permissions` block
  **replaces** the workflow-level one rather than merging with it, so a job is
  judged by the permissions GitHub actually applies to it. A grant held only by
  a sibling job does not count.

  One file can report every defect at once. A glued comment still parses, so the
  tree is kept and the cron and permission checks still run - otherwise fixing
  one typo per CI run is the tax for three typos in one file.

  34 pins in `tests/workflow-contract.test.ts`, including four that the gate is
  actually wired into the blocking chain. Mutation-verified: 14 logic mutations
  and 2 wiring mutations, all 16 killed.

- **`oct3-verify.yml` was missing the `issues: write` scope its own script needs.**

  The Oct 3 cron day is how this was found, and it is the first day the
  workflow had ever fired. All three crons came due on 2026-10-03 and all three
  ran (`37157439771`, green) - which was already better than the week before,
  when none of them had fired at all. But `verify-oct3.ps1` records its verdict
  by commenting on issue #18, and `oct3-verify.yml` was the only workflow in
  the repo that posts there without declaring `issues: write`. The POST came
  back `403 "Resource not accessible by integration"`; the script printed
  `COMMENT_FAILED` and then exited 0 on the strength of the
  `VERDICT=PASS_REFRESHED` it had just failed to record.

  So the run was green, the verdict was real, and the only copy of it was a
  workflow log that expires in 90 days. Every sibling that posts to #18
  (heartbeat, oct28-verify, oct29-sentinel, oct4-sentinel, verifier-drill)
  already declared the scope; this file was the lone omission.

### Changed
- **The schedule heartbeat now checks that a verdict LANDED, not just that a run STARTED.**

  The auditor's model - per-schedule patience derived from each schedule's own
  observed lag - answers "did a scheduled run appear?". That is necessary and
  it is not sufficient, and the 2026-10-03 cron day proved it: the schedule
  fired, the run went green, and nothing anywhere recorded the verdict. Silence
  is the failure this whole layer exists to catch, and that failure did not
  arrive as silence. It arrived wearing a green checkmark, and every check in
  the model read it as proof of life.

  Each workflow that promises a durable record now declares it, and a completed
  run that leaves no such record is a finding in its own right - the loud kind,
  because nothing else in the repo will ever say it. Two properties keep it
  honest: the window opens at the period's **first** due slot (the Oct 28 chain
  declares four retries for one morning, and grading the last retry against the
  last slot would discard the verdict the first attempt already recorded), and
  the sentinels are deliberately **absent** from the table (they post only when
  they trip, so a satisfied sentinel is silent by design - auditing one would
  file a permanent false finding).

  The live dry run against the real repo now reports the lost Oct 3 verdict as
  a single finding, named with the run that lost it. 53 pins in
  `tests/heartbeat-schedule-grace.test.ts`, mutation-verified.

### Changed
- **The schedule heartbeat now judges each schedule against its own history.**

  It used to file a DEAD finding the instant a cron slot's due minute passed.
  That is wrong here, because GitHub does not start a scheduled run at its due
  minute - it queues the run at low priority and starts it when a runner
  frees. Both schedules that have ever fired in this repo came in around eight
  and a half hours late, so a zero-grace check reports healthy schedules as
  broken. On 2026-10-03 it filed three findings against workflows that were all
  `active`, an hour or two after their slots came due.

  Replacing the missing grace with a constant would have been the quick fix and
  the wrong one. A single number tuned on the two samples available here would
  have been applied to every cron in the repo, including ones that fire
  punctually and deserve minutes of patience rather than hours. It also left
  two structural holes: the note quoted a schedule's own measured lag while the
  verdict ignored it, so a message could recommend waiting on a schedule the
  check had already condemned; and because only the most recent slot was ever
  examined, a cron that missed every week could never trip any time-based
  grace, because its silence never outlasted one interval.

  So the verdict is reconstructed from evidence instead of assumed:

  - **Every due slot the workflow owed is reconstructed** and matched against
    the runs that satisfied it, each run claiming the *latest* slot it could
    possibly satisfy.
  - **Patience is per schedule** - a multiple of the worst lag that schedule
    has actually shown, with 1.5x headroom. A punctual schedule gets minutes; a
    chronically slow one gets hours. The repo-wide floor, which a historyless
    schedule falls back to, is derived from the slowest anything here has ever
    run (currently 8h26m x 1.5 = 12.6h) rather than asserted. That figure is
    what the live audit now reports, which is the clearest evidence the
    baseline is genuinely learned instead of hardcoded.
  - **Repeated missed days escalate on their own.** Misses are counted in
    distinct *days*, not slots: the Oct 3 verifier declares three retry crons
    for one morning, and three retries are one missed opportunity, not three.
    Three consecutive silent days is a finding regardless of elapsed time.
  - **Unproven is not missed.** A slot older than the oldest run the API page
    reached is excluded from the miss count, so a shallow history cannot
    manufacture a dead-streak verdict out of slots nobody has evidence about.

  Live on 2026-10-03: `findings=0`, `HEARTBEAT_HEALTHY`, with each late cron
  reporting how long it has actually been silent and what it is being judged
  against - either its own worst recorded start or, for the three workflows
  that have never once fired on a schedule, an honest statement that there is
  no baseline of its own to judge by.

  Pinned in `tests/heartbeat-schedule-grace.test.ts` against the two real runs
  this repo has recorded, including the case the old shape could not catch: a
  schedule whose silence is *shorter* than its own grace, yet dead, because it
  has missed every slot.

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

- The recovery probe hanging up on a server that was answering, on any restart slow enough to notice.

  The probe gave one attempt three seconds and then abandoned it to try again. That is right for a
  refused connection — which returns in microseconds — and wrong for the case it actually meets after a
  restart: a server that is up but still compiling or serving a cold page. Measured on this repo, the
  first requests after a restart answered in 3.5–22s, so the probe reported `no answer within 30000ms`
  about a port that had answered *every* request it sent, and each abandoned request left its compile
  running in the pool being probed, which made the next attempt slower still (six abandoned requests,
  3.5s then 8, 8, 17, 8, 3.5s). The warm replay never ran either, and could not: it starts only once the
  probe has confirmed the port, so the failure was invisible behind a line that looked like a slow start.
  One attempt now gets the whole window — a slow answer is an answer, a refused connection still returns
  at the floor, and a server that accepts the socket and then truly stalls runs out the same window it
  always did. Verified live: the same forced restart now logs `back up — HTTP 200` 16s in, where before
  it logged `the port has not answered yet` about a server that was serving.

- The recovery line landing up to a poll interval after the restarted server had already answered.

  The probe asked the port again only once per `probeIntervalMs` (500ms), and it
  paid that wait after every refused connection — the one case that does not need
  it, because asking a loopback port that is not listening yet costs less than
  the wait it saves. The line that tells you a restart worked therefore arrived
  behind a server that was in fact already up, and the warm replay of the pages
  you were using started that much later. Measured here against a real server
  brought up 1.2s into the probe, six runs each: the old cadence answered
  366–738ms after the port did (median 423ms); the floor answers 9–76ms after it
  (median 44ms), at 25–28 loopback attempts instead of 4 — a few milliseconds of
  work spread over 1.2 seconds. `intervalMs` still bounds the wait and is the
  budget one attempt gets, so a server that accepts the socket and then stalls is
  paced by its own slow attempt rather than hammered; tests pin the floor, the
  tighter-than-floor case and the give-up path.

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
