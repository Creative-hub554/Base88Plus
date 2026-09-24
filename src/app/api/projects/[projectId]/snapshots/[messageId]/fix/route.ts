import { NextRequest } from "next/server";
import { streamText } from "ai";
import { BUILDER_SYSTEM_PROMPT, extractFiles } from "@/lib/prompt";
import { resolveGenerationFor } from "@/lib/providers/gateway";
import {
  getProject,
  listTurnSnapshots,
  readTurnSnapshotFile,
  recordTurnSnapshot,
  snapshotMissingAssets,
} from "@/lib/store";

export const maxDuration = 300;

/** In-flight fixes (per process, same pattern as template generation). */
const fixing = new Set<string>();

/**
 * "Fix this snapshot": regenerate ONLY the assets the snapshot's HTML
 * references but lacks, merge them into the snapshot, and re-snapshot it —
 * the workspace is never touched. Returns what was written and what is
 * still missing (a stubborn small model may not produce everything).
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string; messageId: string }> },
) {
  const { projectId, messageId } = await ctx.params;
  if (!getProject(projectId)) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  const entry = listTurnSnapshots(projectId).find((s) => s.messageId === messageId);
  if (!entry) {
    return Response.json({ error: "Snapshot not found" }, { status: 404 });
  }
  const missing = snapshotMissingAssets(projectId, messageId);
  if (missing.length === 0) {
    return Response.json(
      { error: "Snapshot is not missing any assets." },
      { status: 400 },
    );
  }
  const key = `${projectId}:${messageId}`;
  if (fixing.has(key)) {
    return Response.json(
      { error: "This snapshot is already being fixed." },
      { status: 409 },
    );
  }

  let generation;
  try {
    generation = await resolveGenerationFor(projectId);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "No AI provider configured — set one in Settings first.",
      },
      { status: 400 },
    );
  }

  fixing.add(key);
  try {
    // The snapshot's current files (immutable originals, read-only).
    const originals: { path: string; content: string }[] = [];
    for (const p of entry.files) {
      const content = readTurnSnapshotFile(projectId, messageId, p);
      if (content !== null) originals.push({ path: p, content });
    }
    if (originals.length === 0) {
      return Response.json(
        { error: "Snapshot folder is unreadable." },
        { status: 404 },
      );
    }

    const instruction = (missingList: string[]) =>
      `Here is the app's current HTML:\n\n${
        originals.find((f) => f.path.endsWith(".html"))?.content ?? "(no html)"
      }\n\nThe page references these files that are MISSING: ${missingList.join(
        ", ",
      )}.\n\nFINAL INSTRUCTION: This reply must BE the missing file(s) — not a description of them. Output ONLY the missing file(s) in ONE \`\`\`anybase code block using the === file === format for each, close the code fence, and write nothing after it.`;

    let stillMissing = missing;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = streamText({
        model: generation.resolved.model,
        instructions: BUILDER_SYSTEM_PROMPT,
        prompt: instruction(stillMissing),
      });
      let text = "";
      for await (const delta of result.textStream) text += delta;
      const generated = extractFiles(text);
      if (!generated || generated.length === 0) continue;

      // Merge: generated content wins for paths it emitted; every original
      // stays unless the generation rewrote it. Workspace untouched.
      const byPath = new Map(originals.map((f) => [f.path, f.content]));
      for (const f of generated) byPath.set(f.path, f.content);
      const merged = [...byPath].map(([path, content]) => ({ path, content }));
      recordTurnSnapshot(projectId, messageId, merged);

      stillMissing = snapshotMissingAssets(projectId, messageId);
      if (stillMissing.length === 0) break;
    }

    return Response.json({
      fixed: missing.filter((m) => !stillMissing.includes(m)),
      stillMissing,
      snapshot: { messageId, files: entry.files },
    });
  } finally {
    fixing.delete(key);
  }
}
