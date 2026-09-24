/**
 * Component test: the chat footer surfaces what happened to a failed
 * attempt's partial files. The count is SERVER-computed metadata
 * (rolledBackFiles) — the client renders it verbatim and never re-derives
 * it (API↔UI contract rule). Covering: reverted count shown, absent when
 * clean, singular/plural, and independence from the degenerate flag.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "../src/components/builder-client";
import type { BuilderUIMessage } from "../src/lib/types";

function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
  metadata?: Record<string, unknown>,
): BuilderUIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    ...(metadata !== undefined ? { metadata } : {}),
  } as BuilderUIMessage;
}

describe("MessageBubble rollback footer", () => {
  it("shows the reverted-file count after a retried turn that rolled back partials", () => {
    render(
      <MessageBubble
        message={msg("a1", "assistant", "Here is your app.", {
          modelUsed: "qwen2.5-coder:7b",
          providerUsed: "Ollama (local)",
          fileCount: 3,
          retried: true,
          rolledBackFiles: 2,
        } as any)}
      />,
    );
    const footer = screen.getByText(/reverted 2 partial files/);
    expect(footer.textContent).toContain("auto-retried");
  });

  it("uses singular for one reverted file", () => {
    render(
      <MessageBubble
        message={msg("a1", "assistant", "done", {
          fileCount: 1,
          retried: true,
          rolledBackFiles: 1,
        } as any)}
      />,
    );
    expect(screen.getByText(/reverted 1 partial file from/)).toBeTruthy();
  });

  it("shows nothing when no rollback happened (clean retry or plain success)", () => {
    render(
      <MessageBubble
        message={msg("a1", "assistant", "done", {
          fileCount: 3,
          retried: true,
        } as any)}
      />,
    );
    expect(screen.queryByText(/reverted/)).toBeNull();
  });

  it("renders the rollback note even when the retry also failed (degenerate)", () => {
    render(
      <MessageBubble
        message={msg("a1", "assistant", "```any", {
          fileCount: 0,
          retried: true,
          degenerate: true,
          rolledBackFiles: 2,
        } as any)}
      />,
    );
    expect(screen.getByText(/reverted 2 partial files/)).toBeTruthy();
    expect(screen.getByText(/cut off/)).toBeTruthy();
  });
});
