import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessageStreamWriter,
} from "ai";
import { NextRequest } from "next/server";
import {
  appendMessages,
  deleteAppFile,
  listAppFiles,
  loadMessages,
  recordTurnSnapshot,
  saveMessages,
  saveAppFile,
  snapshotWorkspace,
  restoreWorkspace,
  touchProject,
} from "@/lib/store";
import {
  buildWorkspaceContext,
  CONTINUE_REMINDER,
  extractFiles,
  extractPartialFiles,
  isSummaryImitation,
  localRefsFromHtml,
  shouldOfferContinue,
  stripCodeBlocks,
  BUILDER_SYSTEM_PROMPT,
} from "@/lib/prompt";
import {
  isQuotaError,
  resolveFallbackGeneration,
  resolveGenerationFor,
  type ResolvedGeneration,
} from "@/lib/providers/gateway";
import type { BuilderUIMessage, FileUpdate } from "@/lib/types";

export const maxDuration = 300;

/** Appended on the single automatic retry after a degenerate generation. */
const RETRY_REMINDER = `\n\nIMPORTANT: Your previous response was cut off or was not a valid app. Try again: output the COMPLETE app in ONE \`\`\`anybase code block using the === file === format for every file, close the code fence, and write nothing after it.`;

/**
 * Appended to fallback-provider attempts: the fallback model (often a
 * smaller local one) must know up front that the reply must BE an app —
 * otherwise it may answer in prose and the user gets no files at all.
 * Appended (not prepended) because small models weight the end of the
 * prompt far more than the start, and must out-shout the imitable
 * "[wrote N file(s)]" notes in the compacted history.
 */
const FALLBACK_REMINDER = `\n\nFINAL INSTRUCTION: This reply must BE the updated app — not a description of it. Output the COMPLETE app in ONE \`\`\`anybase code block using the === file === format for every file, close the code fence, and write nothing after it. Do not summarize. Do not repeat earlier notes.`;

type ResolvedModel = import("@/lib/providers/gateway").ResolvedGeneration;

interface GenerationAttempt {
  ok: boolean;
  error: string | null;
  /** The error was a provider-side quota/rate-limit exhaustion. */
  quota: boolean;
  /** The response contained an opening \`\`\`anybase fence. */
  hadFence: boolean;
  /** That fence was closed before the stream ended. */
  fenceClosed: boolean;
  files: FileUpdate[] | null;
  textLength: number;
  /** Visible (non-code) narration the attempt produced. */
  narrationText: string;
}

/**
 * Small models sometimes degenerate: empty output, or an anybase block that
 * never closes (truncated at EOS). Those attempts produce no files, so we
 * detect them and retry once with a format reminder instead of showing a
 * broken result.
 */
function isDegenerate(a: GenerationAttempt): boolean {
  if (a.files && a.files.length > 0) return false; // files were produced
  if (a.hadFence) return true; // fenced output that yielded no usable files:
  //   cut off mid-block, or fenced prose with no === file === sections
  if (!a.ok) return true; // provider/stream error with nothing parsed
  if (a.textLength === 0) return true; // empty response
  return false; // plain narration with no fence — a legitimate chat reply
}

export async function POST(req: NextRequest) {
  const { messages, projectId, continueDegenerate }: {
    messages: BuilderUIMessage[];
    projectId: string;
    /** One-click Continue: retry the last degenerate turn on minimal history. */
    continueDegenerate?: boolean;
  } = await req.json();

  // The transport sends the full conversation each turn; appendMessages
  // dedupes by id so refining never duplicates history (and never feeds the
  // model a doubled transcript — quadratic tokens, degeneration bait).
  const existing = appendMessages(projectId, messages);

  let generation;
  try {
    generation = await resolveGenerationFor(projectId);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "No provider configured" },
      { status: 400 },
    );
  }
  const resolved = generation.resolved;

  console.log(
    `[chat] resolved provider=${resolved.providerId} model=${resolved.modelId} source=${generation.source}`,
  );

  // Compact assistant narration out of the history: long/unclosed code
  // fragments in past turns (a small-model failure mode) poison later
  // generations. The current-files context below carries the real state.
  const compacted = existing.map((m) => {
    if (m.role !== "assistant") return m;
    const text = m.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .slice(0, 300);
    // NOTE: no "[wrote N file(s)]" annotation here. The current-files
    // context below already tells the model the workspace state, and the
    // bracketed-note format proved dangerously imitable: a small model
    // that failed a task reproduced the note verbatim as its entire answer.
    // Keep a non-empty placeholder so message alternation stays valid.
    return {
      ...m,
      parts: [{ type: "text" as const, text: text.trim() || "(updated the app files)" }],
    };
  })
    // Assistant turns that produced ZERO files (errors, truncations,
    // summary-imitations) are dropped from the model's history entirely:
    // they carry no information the current-files context doesn't, and a
    // small model imitates its own past failures — an earlier "```any\n[wrote
    // 3 file(s)]" turn reproduced itself verbatim across attempts AND its
    // retry until removed. User turns are always kept.
    .filter(
      (m) =>
        m.role !== "assistant" ||
        Boolean((m.metadata as { fileCount?: number } | undefined)?.fileCount),
    );

  // Continue mode: the stream will regenerate the degenerate assistant
  // turn, so keep ONLY the latest user request — the same minimal-history
  // recipe that makes the degenerate retry effective (no imitation bait,
  // no poisoned turns; the current-files context carries the real state).
  const historySource = continueDegenerate
    ? [
        [...compacted].reverse().find((m) => m.role === "user") ??
          compacted[compacted.length - 1],
      ].filter(Boolean)
    : compacted;
  const history = await convertToModelMessages(historySource);

  /**
   * Minimal-history variant for fallback attempts: small local fallback
   * models degrade under the full compacted history (they start imitating
   * the narration notes instead of writing an app). The latest user turn
   * plus the in-instructions current-files context carries the real state.
   */
  const fallbackHistory = await convertToModelMessages([
    ...messages.filter((m) => m.role === "user").slice(-1),
  ]);

  /**
   * Minimal-history variant for the degenerate RETRY as well: the retry's
   * job is to produce the app NOW from the current files + the latest
   * request, not to continue a conversation whose history just produced a
   * degenerate answer. Re-sending the full transcript re-exposes every
   * imitation bait; the latest user turn does not.
   */
  const retryHistory = fallbackHistory;

  // Give the model eyes: include the CURRENT workspace files in the
  // instructions so iterative edits reference real element IDs, real
  // functions, and real file names instead of hallucinating them.
  // buildWorkspaceContext (prompt.ts) is the single definition — the
  // degenerate retry REBUILDS its context with it after rolling the
  // workspace back, so a failed attempt's draft can never leak in.
  const baseInstructions = BUILDER_SYSTEM_PROMPT + buildWorkspaceContext(listAppFiles(projectId));

  /** Files the turn finally produced — read by onEnd for the undo snapshot. */
  let turnFiles: Awaited<ReturnType<typeof listAppFiles>> = [];

  const stream = createUIMessageStream<BuilderUIMessage>({
    originalMessages: messages,
    onError: (error) =>
      error instanceof Error ? error.message : "Unexpected error",
    execute: async ({ writer }) => {
      // Tell the user when a project pin couldn't be honored (e.g. the
      // pinned provider's key was removed) so the fallback isn't a surprise.
      if (generation.source === "fallback") {
        writer.write({ type: "text-start", id: "fallback-note" });
        writer.write({
          type: "text-delta",
          id: "fallback-note",
          delta: `⚠ The model pinned for this project is unavailable right now — using the global default (${resolved.providerName} · ${resolved.modelId}) for this message.`,
        });
        writer.write({ type: "text-end", id: "fallback-note" });
      }

      // Snapshot before the first attempt so a degenerate turn's partial
      // writes (progressive streaming persists completed sections before
      // the fence closes) can be rolled back before any retry.
      const snapshot = snapshotWorkspace(projectId);
      /**
       * Retry instruction builder with degenerate-turn isolation: rolls the
       * workspace back to the pre-attempt snapshot, then rebuilds the file
       * context from it. The draft's hallucinated element IDs, class names,
       * and half-written files never leak into what a retry believes the
       * project looks like — a 7b retry once bound its JS to
       * .long-break-indicator, an element that existed only in its own
       * truncated first attempt.
       * The number of files the failed attempt had touched is surfaced in
       * message metadata so the chat can tell the user what was reverted.
       */
      /**
       * Cumulative rollback tracking: every rollback in this turn (quota
       * switchover, degenerate retry) adds the paths it reverted, so the
       * metadata reports everything the user saw written and then reverted,
       * even across multiple recovery paths.
       */
      const rolledBackPaths = new Set<string>();
      const rollback = () => {
        const before = new Map(listAppFiles(projectId).map((f) => [f.path, f.content]));
        const snapMap = new Map(snapshot.map((f) => [f.path, f.content]));
        restoreWorkspace(projectId, snapshot);
        // Count every path whose on-disk state the attempt changed — created
        // files (streamed live into the file panel, then removed) and
        // modified ones alike. That's what the user "almost kept".
        for (const p of new Set([...before.keys(), ...snapMap.keys()])) {
          if (before.get(p) !== snapMap.get(p)) rolledBackPaths.add(p);
        }
      };
      const rolledBackInstructions = () => {
        rollback();
        return BUILDER_SYSTEM_PROMPT + buildWorkspaceContext(snapshot);
      };

      let outcome = await runGeneration({
        writer,
        resolved,
        history,
        // Continue mode replaces the model history with the single latest
        // user turn and prepends a hard format reminder.
        instructions:
          baseInstructions + (continueDegenerate ? CONTINUE_REMINDER : ""),
        projectId,
      });

      let retried = false;
      // A quota'd provider gets NO same-provider retry: the fallback path
      // owns recovery (retrying a provider already known to be out of
      // quota wastes a generation, and a retry that succeeded would erase
      // the quota state entirely). Wire-level test: tests/quota-fallback.test.ts.
      if (
        !outcome.quota &&
        (isDegenerate(outcome) || isSummaryImitation(outcome))
      ) {
        retried = true;
        console.log("[chat] degenerate generation — retrying once with format reminder");
        outcome = await runGeneration({
          writer,
          resolved,
          history: retryHistory,
          instructions: rolledBackInstructions() + RETRY_REMINDER,
          projectId,
        });
      }

      /**
       * Explicit flag for the UI: this turn produced NO files despite the
       * automatic retry, so the chat offers a one-click Continue button.
       * Server-computed (the client never re-derives it) per the
       * API↔UI contract rule.
       */
      const degenerate = shouldOfferContinue({
        hadFence: outcome.hadFence,
        files: outcome.files,
        error: outcome.error,
        narrationText: outcome.narrationText,
      });

      /**
       * Completion retry for the missing-asset failure mode: a turn rewrites
       * index.html referencing scripts it never (re)wrote — the classic
       * small-model pattern of dying partway through the longest file. Ask
       * the model to emit ONLY that one file; a single-file block is well
       * within capacity even when the full app is not. If the model still
       * can't, the previously working files stay in place.
       */
      if (outcome.files?.length) {
        const ws = listAppFiles(projectId);
        const wsMap = new Map(ws.map((f) => [f.path, f.content]));
        const written = new Set(outcome.files.map((f) => f.path));
        const html = wsMap.get("index.html");
        const missing = html
          ? localRefsFromHtml(html).filter((r) => !wsMap.has(r) || (written.has("index.html") && !written.has(r)))
          : [];
        if (html && missing.length > 0) {
          console.log(`[chat] index.html references un-written assets — completion retry for: ${missing.join(", ")}`);
          writer.write({ type: "text-start", id: "completion-note" });
          writer.write({
            type: "text-delta",
            id: "completion-note",
            delta: `· finishing ${missing.join(", ")}…`,
          });
          writer.write({ type: "text-end", id: "completion-note" });
          const completion = await runGeneration({
            writer,
            resolved,
            history: retryHistory,
            instructions:
              baseInstructions +
              `\n\nThe workspace ALREADY CONTAINS a complete index.html, styles.css and ${missing.join(", ")}. Your ONLY job now: re-emit JUST ${missing.join(" and ")} so it matches the current index.html exactly. Output ONE \`\`\`anybase code block with ONLY the === ${missing[0]} === section (plus the other listed file if also listed). No other files. No prose. Close the fence.`,
            projectId,
          });
          if (completion.files?.length) {
            outcome = {
              ...outcome,
              files: [...(outcome.files ?? []), ...completion.files],
            };
          }
        }
      }

      // Free-tier quota exhausted (e.g. Workers AI daily neurons): tell the
      // user plainly and try once on another configured provider. Checked
      // before falling back so a quota error can never be swallowed by the
      // degenerate retry or a failed fallback attempt.
      let quotaFallback: ResolvedGeneration | null = null;
      let quotaEvent = outcome.quota;
      if (outcome.quota) {
        console.log(
          `[chat] provider ${resolved.providerId} hit a quota/rate limit — trying a fallback provider`,
        );
        // Isolation for the switchover too: the quota attempt may have
        // persisted partial files before dying mid-stream. The fallback
        // must start from the pre-turn workspace, not the dead attempt's
        // draft — same rule as the degenerate retry.
        rollback();
        const fallback = await resolveFallbackGeneration([resolved.providerId]);
        writer.write({ type: "text-start", id: "quota-note" });
        writer.write({
          type: "text-delta",
          id: "quota-note",
          delta: fallback
            ? `⚠ ${resolved.providerName}'s free tier is out of capacity right now (daily quota or rate limit). Trying ${fallback.providerName} for this message — you can also switch models any time in the header.`
            : `⚠ ${resolved.providerName}'s free tier is out of capacity right now (daily quota or rate limit), and no other provider is configured. Add an API key in Settings → AI Providers, or wait for the quota to reset — free tiers reset daily.`,
        });
        writer.write({ type: "text-end", id: "quota-note" });

        if (fallback) {
          quotaFallback = fallback;
          quotaEvent = true;
          outcome = await runGeneration({
            writer,
            resolved: fallback,
            history: fallbackHistory,
            instructions: baseInstructions + FALLBACK_REMINDER,
            projectId,
          });
          // The fallback deserves the same degenerate retry as the primary
          // attempt — small local models (a common fallback target) often
          // need the format reminder to produce usable files.
          if (isDegenerate(outcome)) {
            console.log(
              "[chat] fallback generation degenerate — retrying once with format reminder",
            );
            outcome = await runGeneration({
              writer,
              resolved: fallback,
              history: fallbackHistory,
              instructions: rolledBackInstructions() + FALLBACK_REMINDER + RETRY_REMINDER,
              projectId,
            });
          }
        }
      }

      const files = outcome.files;
      turnFiles = (files ?? []).map((f) => ({ path: f.path, content: f.content ?? "" }));

      if (outcome.error) {
        // Surface provider failures in the chat instead of finishing
        // silently with an empty stream.
        writer.write({ type: "text-start", id: "error-note" });
        writer.write({
          type: "text-delta",
          id: "error-note",
          delta: `⚠ Generation failed: ${outcome.error}`,
        });
        writer.write({ type: "text-end", id: "error-note" });
      }

      // Report the provider that actually produced the final result: the
      // fallback when it ran (whether or not it also failed), otherwise the
      // original. quotaEvent flags any quota hit for the UI banner.
      const reported = quotaFallback ?? resolved;
      writer.write({
        type: "finish",
        messageMetadata: {
          modelUsed: reported.modelId,
          providerUsed: reported.providerName,
          fileCount: files?.length ?? 0,
          retried,
          quotaFallback: quotaEvent,
          degenerate,
          rolledBackFiles: rolledBackPaths.size || undefined,
        },
      });
    },
    onEnd: ({ responseMessage }) => {
      // Deduped append: if the client already sent this message id (e.g. an
      // in-flight assistant placeholder), merge instead of duplicating.
      appendMessages(projectId, [responseMessage]);
      // Per-turn undo: persist the workspace state this generation ended
      // with, keyed by the assistant message id. Only turns that actually
      // wrote files create a snapshot (prose chat has nothing to restore).
      if (turnFiles.length > 0) {
        try {
          recordTurnSnapshot(projectId, responseMessage.id, listAppFiles(projectId));
        } catch (err) {
          console.error("[chat] turn snapshot failed:", err);
        }
      }
      touchProject(projectId);
    },
  });

  return createUIMessageStreamResponse({ stream });
}

/**
 * Runs one generation attempt: streams narration to the chat, parses and
 * persists anybase blocks as files, and reports what happened so the caller
 * can decide whether to retry.
 */
async function runGeneration({
  writer,
  resolved,
  history,
  instructions,
  projectId,
}: {
  writer: UIMessageStreamWriter<BuilderUIMessage>;
  resolved: ResolvedModel;
  history: Awaited<ReturnType<typeof convertToModelMessages>>;
  instructions: string;
  projectId: string;
}): Promise<GenerationAttempt> {
  let generationError: string | null = null;
  // Keep the raw error object for quota classification (response bodies
  // carry the provider's quota wording, which .message alone may lack).
  const streamErrorRef: { current: unknown } = { current: null };

  const result = streamText({
    model: resolved.model,
    instructions,
    messages: history,
    onError: ({ error }) => {
      console.error("[chat] generation error:", error);
      streamErrorRef.current = error;
      generationError =
        error instanceof Error ? error.message : "Generation failed";
    },
  });

  // Buffer text so we can parse complete anybase blocks as they close,
  // while still streaming the narration live.
  let full = "";
  let sentText = "";
  let emittedFiles: FileUpdate[] | null = null;
  let narrationOpen = false;
  let hadFence = false;
  let fenceClosed = false;
  /**
   * Progressive emission state: path → content already saved + streamed
   * during this attempt. Partials stream the moment a `=== file ===`
   * section completes (before the fence closes), so the workspace fills
   * live; the authoritative close-time emission skips anything identical.
   */
  const emittedPartial = new Map<string, string>();

  const writeNarration = (delta: string) => {
    if (!delta) return;
    if (!narrationOpen) {
      writer.write({ type: "text-start", id: "narration" });
      narrationOpen = true;
    }
    writer.write({ type: "text-delta", id: "narration", delta });
  };

  try {
    for await (const delta of result.textStream) {
      full += delta;
      // "```any" (a truncated "```anybase") still means the model tried to
      // open an app block and degenerated — classify it as a fence so the
      // degenerate retry fires instead of the junk leaking into the chat
      // as narration.
      if (!hadFence && full.includes("```any")) hadFence = true;
      const fenceEnd = findClosedFence(full);
      if (fenceEnd !== null) fenceClosed = true;
      // Narration = visible text before the first closed fence. While the
      // block is open (or closed) nothing further is shown to the user —
      // the code goes to the file panel instead of the chat.
      // Hide text from the open fence's first character — an unclosed
      // ````anybase` line with no trailing newline yet would otherwise leak
      // into the chat (stripCodeBlocks needs the newline to match).
      const fenceStart = full.indexOf("```any");
      const stopAt = fenceEnd ?? (fenceStart !== -1 ? fenceStart : full.length);
      const visible = stripCodeBlocks(full.slice(0, stopAt));
      if (visible.length > sentText.length) {
        writeNarration(visible.slice(sentText.length));
        sentText = visible;
      }
      // Stream COMPLETED file sections as they arrive — the workspace
      // builds live instead of popping in fully-formed at fence close.
      for (const f of extractPartialFiles(full)) {
        if (emittedPartial.get(f.path) === f.content) continue;
        saveAppFile(projectId, f.path, f.content);
        emittedPartial.set(f.path, f.content);
        writer.write({
          type: "data-files",
          id: `files-${Date.now()}-${f.path}`,
          data: [{ path: f.path, action: "create", content: f.content }],
        });
      }
      if (fenceEnd !== null && !emittedFiles) {
        const emitted = emitFiles(writer, full.slice(0, fenceEnd), projectId, emittedPartial);
        if (emitted) emittedFiles = emitted;
      }
    }
  } catch (err) {
    console.error("[chat] stream consumption failed:", err);
    streamErrorRef.current = err;
    generationError =
      err instanceof Error ? err.message : "Generation failed";
  }

  // Flush anything remaining after the last fence.
  const tail = stripCodeBlocks(full);
  if (tail.length > sentText.length) {
    writeNarration(tail.slice(sentText.length));
  }
  if (narrationOpen) {
    writer.write({ type: "text-end", id: "narration" });
    narrationOpen = false;
  }

  // Note: we deliberately do NOT salvage partial files from an unclosed
  // fence — a truncated last file is worse than retrying, and persisting it
  // would mask the degenerate attempt from retry detection.
  const files = emittedFiles;

  return {
    ok: generationError === null,
    error: generationError,
    quota: generationError !== null && isQuotaError(streamErrorRef.current),
    hadFence,
    fenceClosed,
    files,
    textLength: full.trim().length,
    narrationText: sentText,
  };
}

/** Returns the index just after a closed ``` fence, or null if none is closed yet. */
function findClosedFence(text: string): number | null {
  const start = text.indexOf("```anybase");
  if (start === -1) return null;
  const end = text.indexOf("```", start + 3);
  return end === -1 ? null : end + 3;
}

/**
 * Parses anybase blocks in `text`, persists the files, and writes a
 * data-files part. Returns the parsed files (null if no block present).
 */
function emitFiles(
  writer: UIMessageStreamWriter<BuilderUIMessage>,
  text: string,
  projectId: string,
  /** Partial files already streamed + saved during this attempt. */
  skip?: Map<string, string>,
): FileUpdate[] | null {
  const parsed = extractFiles(text);
  if (!parsed) return null;
  const updates: FileUpdate[] = [];
  for (const file of parsed) {
    if (skip?.get(file.path) === file.content) continue; // partial already delivered
    saveAppFile(projectId, file.path, file.content);
    updates.push({ path: file.path, action: "create", content: file.content });
  }
  if (updates.length > 0) {
    writer.write({ type: "data-files", id: `files-${Date.now()}`, data: updates });
  }
  return parsed.map((f) => ({ path: f.path, action: "create", content: f.content }));
}

export async function GET() {
  return Response.json({ ok: true });
}

// Keep unused import referenced for future delete support in chat flows.
void deleteAppFile;
