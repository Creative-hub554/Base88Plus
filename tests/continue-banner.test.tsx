/**
 * Component test for the one-click Continue recovery banner.
 *
 * The banner appears only after an assistant turn the SERVER stamped
 * `degenerate: true` (no files despite the automatic retry) — the client
 * never re-derives that flag (API↔UI contract rule, same as configured /
 * reachable / pinBroken). Clicking it calls onContinue with the message id;
 * BuilderClient wires that to useChat().regenerate({ messageId, body:
 * { continueDegenerate: true } }).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContinueGenerationBanner } from "../src/components/builder-client";
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

describe("ContinueGenerationBanner", () => {
  it("renders with a working Continue button after a degenerate assistant turn", () => {
    const onContinue = vi.fn();
    render(
      <ContinueGenerationBanner
        messages={[
          msg("u1", "user", "build a timer"),
          msg("a1", "assistant", "```any", {
            fileCount: 0,
            retried: true,
            degenerate: true,
          }),
        ]}
        onContinue={onContinue}
      />,
    );
    expect(screen.getByTestId("continue-banner")).toBeTruthy();
    const btn = screen.getByRole("button", { name: /continue/i });
    fireEvent.click(btn);
    expect(onContinue).toHaveBeenCalledOnce();
    expect(onContinue).toHaveBeenCalledWith("a1");
  });

  it("does NOT render after a successful generation", () => {
    render(
      <ContinueGenerationBanner
        messages={[
          msg("u1", "user", "build a timer"),
          msg("a1", "assistant", "done", { fileCount: 3 }),
        ]}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("continue-banner")).toBeNull();
  });

  it("does NOT render when the client-side flag is absent (server-stamped only)", () => {
    render(
      <ContinueGenerationBanner
        messages={[msg("a1", "assistant", "```any", { fileCount: 0, retried: true })]}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("continue-banner")).toBeNull();
  });

  it("does NOT render after a plain user message", () => {
    render(
      <ContinueGenerationBanner
        messages={[msg("u1", "user", "and add a footer")]}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("continue-banner")).toBeNull();
  });
});
