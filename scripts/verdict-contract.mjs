/**
 * The verdict/receipt contract, loaded and derived.
 *
 * `verdict-contract.json` is the declaration; this module is the one place that
 * turns it into the shapes the JS consumers use, so the heartbeat auditor and the
 * recovery pass cannot answer "did the record land?" differently. The PowerShell
 * scripts read the same JSON through `verdict-contract.ps1`.
 *
 * Everything here is pure derivation - no policy, no prose beyond what the JSON
 * declares - because a second opinion in a loader is just as capable of drifting
 * as a second opinion in a consumer.
 *
 * Deliberately NOT exported: any global verdict shape. "What counts as a record"
 * is per workflow (oct28-verify posts `NO_DISPATCH_RUN` and `PRE_PROMO_*` by
 * design), and the one global regex this repo used to carry declared those good
 * records missing - the same class of error as an auditor that cannot see its own
 * findings.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the declaration, so a caller can report it in a failure. */
export const CONTRACT_PATH = join(HERE, 'verdict-contract.json');

const RAW = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

export const REPO = RAW.repo;
export const ISSUE = RAW.issue;

/** Log and artifact retention for this repo (GitHub's default for public repos). */
export const RETENTION_DAYS = RAW.artifactRetentionDays;

/** The auditor's own comment, by its stable prefix. Never a record (rule 3). */
export const AUDITOR_MARKER = RAW.auditorMarker;

/** The lines a run prints so its log can be read back. */
export const LOG = RAW.logSyntax;

/**
 * `${marker} (${where})` - the identity of ONE record, rendered.
 *
 * Rendered, not pattern-matched: the text a script writes into a comment is the
 * text it must search for when it asks whether it already posted. Those were two
 * different strings in verify-oct3/verify-oct28 (searched `verifier run <id>`,
 * wrote `post-Oct-3 verifier (run <id>, <day>)`), so `ALREADY_RECORDED` could
 * never fire and a re-run posted a duplicate record.
 */
export function renderHeader(entry, { run, day }) {
  // One record really is phrased without a run segment (oct28's NO_DISPATCH_RUN),
  // so the declaration carries that phrasing instead of the loader inventing one.
  const template = String(run) === 'none' && entry.headerNoRun ? entry.headerNoRun : entry.header;
  return template.replaceAll('{run}', String(run)).replaceAll('{day}', String(day));
}

/**
 * One resolved contract entry.
 *
 * Declared rather than inferred on purpose: `Object.entries(WORKFLOWS)` in a
 * consumer must hand back a typed entry, not `unknown` - a contract that cannot
 * be read without a cast is a contract people stop reading.
 *
 * @typedef {object} VerdictWorkflow
 * @property {string} workflow          workflow file name (the key)
 * @property {string} script            the PowerShell script that writes the record
 * @property {'verifier'|'sentinel'} kind
 * @property {string} marker            the record's marker
 * @property {string} what              what the record (or the tripped sentinel) says
 * @property {string} header            record-identity template, {run} / {day}
 * @property {string} [headerNoRun]     phrasing used when no run was found at all
 * @property {string} readsSince        ISO instant it scans the record issue from
 * @property {string} recordsOn         the day it records
 * @property {string} recordShape       regex source: is a comment my record?
 * @property {string} [satisfiedShape]  regex source: is a record a satisfied one?
 * @property {string} artifact          run artifact the record can be recovered from
 * @property {string} log               file inside that artifact
 * @property {'always'|'tripped'} postsWhen
 * @property {string} [witnesses]       sentinels: the chain whose record they watch
 * @property {string} [provenanceSince] verifiers: a snapshot-age floor they assert
 * @property {RegExp} shape             compiled recordShape
 * @property {RegExp|null} satisfied    compiled satisfiedShape
 * @property {VerdictWorkflow|null} witness resolved `witnesses`
 */

/**
 * Resolve the declaration into entries with every derived field materialised.
 *
 * Two passes on purpose: a sentinel inherits its window from the chain it
 * witnesses, and inheritance that depends on declaration order is the kind of
 * wiring that works until someone moves a block.
 *
 * @returns {Record<string, VerdictWorkflow>}
 */
function resolveWorkflows() {
  /** @type {Record<string, VerdictWorkflow>} */
  const entries = {};
  for (const [workflow, e] of Object.entries(RAW.workflows)) {
    entries[workflow] = {
      ...e,
      workflow,
      shape: new RegExp(e.recordShape),
      satisfied: e.satisfiedShape ? new RegExp(e.satisfiedShape) : null,
      witness: null,
    };
  }
  for (const [workflow, e] of Object.entries(entries)) {
    if (!e.witnesses) continue;
    const witness = entries[e.witnesses];
    if (!witness) throw new Error(`verdict-contract: ${workflow} witnesses unknown workflow ${e.witnesses}`);
    if (witness.kind !== 'verifier') throw new Error(`verdict-contract: ${workflow} witnesses non-verifier ${e.witnesses}`);
    e.witness = witness;
    // A sentinel does not declare a window of its own: it watches the same one.
    e.readsSince = e.readsSince ?? witness.readsSince;
  }
  return entries;
}

/**
 * Every declared workflow, keyed by workflow file, with derived fields.
 *
 * @type {Record<string, VerdictWorkflow>}
 */
export const WORKFLOWS = resolveWorkflows();

/** One entry, or a throw naming the workflow - a silent undefined would read as "no contract". */
export function contractFor(workflow) {
  const entry = WORKFLOWS[workflow];
  if (!entry) throw new Error(`verdict-contract: no entry for ${workflow}`);
  return entry;
}

/** The scripts that write the records, keyed by script path, for pins. */
export const SCRIPT_OWNERS = Object.fromEntries(
  Object.entries(WORKFLOWS).map(([workflow, e]) => [e.script, workflow]),
);

// ---------------------------------------------------------------- derivations

/**
 * The heartbeat's receipt contract: what each verifier promises, and the shape that
 * makes a comment its record rather than prose about one.
 */
export const RECEIPTS = Object.fromEntries(
  Object.entries(WORKFLOWS)
    .filter(([, e]) => e.kind === 'verifier')
    .map(([workflow, e]) => [workflow, { marker: e.marker, what: e.what, shape: e.shape }]),
);

/**
 * The recovery contract: every workflow that promises a durable record, with what
 * it takes to recognise one and how to rebuild it from a run log.
 */
export const RECOVERABLE = Object.fromEntries(
  Object.entries(WORKFLOWS).map(([workflow, e]) => [
    workflow,
    {
      marker: e.marker,
      what: e.what,
      artifact: e.artifact,
      log: e.log,
      shape: e.shape,
      postsWhen: e.postsWhen,
      header: e.header,
      script: e.script,
    },
  ]),
);

/**
 * The fake-day seam, for the Node tools (the PowerShell side has its own in
 * scripts/verdict-contract.ps1: VERIFY_GNOMON plus Test-VerdictSimulatedTransport).
 *
 * A tool whose dates come off the wall clock cannot rehearse a timeline: a run next
 * week derives next week's dates, and the events being modelled fall out of their
 * own windows. So each Node tool that dates something reads its clock through here,
 * and the fake is honoured ONLY while the only transport is a rehearsal's simulated
 * world (`node --import scripts/rehearse-world.mjs`, which sets REHEARSAL_WORLD and
 * REHEARSAL_SHIM). A faked clock on a real transport would stamp and file a false
 * record, which is not hypothetical: a 2026-09-30 gnomon rehearsal posted a false
 * SENTINEL_NO_SCHEDULED_RUN onto #18 exactly that way.
 *
 * @param {string} name the tool's own variable (HEARTBEAT_GNOMON, RECOVER_GNOMON...)
 */
export function simulatedNow(name, env = process.env, wall = Date.now) {
  const simulated = env.REHEARSAL_SHIM === "1" && Boolean(env.REHEARSAL_WORLD);
  const raw = env[name];
  if (!simulated || !raw) return wall();
  const at = Date.parse(raw);
  if (Number.isNaN(at)) throw new Error(`${name} is not a date: ${JSON.stringify(raw)}`);
  return at;
}

/**
 * The tripper contract: a sentinel reports a gap, and retires when the record of
 * the chain it witnesses says the gap is closed.
 *
 * `cleared` is derived from the WITNESS, never restated: the sentinel watches
 * oct3-verify's receipt, so the marker it waits for and the window it reads are
 * oct3-verify's own declared values. Restating them is how the two ends drift.
 */
/**
 * The shape a witnessed chain's satisfied record has, or a throw.
 *
 * Fail fast at load: a sentinel whose witness declares no `satisfiedShape` has
 * no way to be cleared, so every trip it ever files would stand forever. That is
 * a broken contract, not a runtime condition to tolerate quietly.
 */
function satisfiedShapeOf(witness, sentinel) {
  if (!witness.satisfied) {
    throw new Error(`verdict-contract: ${sentinel} watches ${witness.workflow}, which declares no satisfiedShape`);
  }
  return witness.satisfied;
}

export const TRIPPERS = Object.fromEntries(
  Object.entries(WORKFLOWS)
    .filter(([, e]) => e.kind === 'sentinel')
    .map(([workflow, e]) => [
      workflow,
      {
        what: e.what,
        cleared: {
          marker: e.witness.marker,
          since: e.witness.readsSince,
          shape: satisfiedShapeOf(e.witness, workflow),
        },
      },
    ]),
);
