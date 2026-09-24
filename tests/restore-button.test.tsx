/**
 * Component test: the per-turn Restore button renders only on assistant
 * turns that have a server-persisted snapshot (availability passed in by
 * the parent from the snapshots API — the client never guesses), and the
 * MessageBubble places it in the footer.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageBubble, RestoreTurnButton } from "../src/components/builder-client";
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

describe("RestoreTurnButton", () => {
  it("calls onRestore with its messageId on click", () => {
    const onRestore = vi.fn();
    render(<RestoreTurnButton messageId="m1" onRestore={onRestore} />);
    fireEvent.click(screen.getByTestId("restore-m1"));
    expect(onRestore).toHaveBeenCalledOnce();
    expect(onRestore).toHaveBeenCalledWith("m1");
  });

  it("is disabled while busy and does not fire", () => {
    const onRestore = vi.fn();
    render(<RestoreTurnButton messageId="m1" onRestore={onRestore} disabled />);
    const btn = screen.getByTestId("restore-m1") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("fetches the hover diff on mouseenter and focus", () => {
    const onHover = vi.fn();
    render(<RestoreTurnButton messageId="m1" onRestore={vi.fn()} onHover={onHover} />);
    const btn = screen.getByTestId("restore-m1");
    fireEvent.mouseEnter(btn);
    fireEvent.focus(btn);
    expect(onHover).toHaveBeenCalledTimes(2);
  });

  it("renders the diff summary (+ added, − removed, ~ modified) when loaded", () => {
    render(
      <RestoreTurnButton
        messageId="m1"
        onRestore={vi.fn()}
        diff={{ added: ["app.js"], removed: ["landing.html"], modified: ["index.html"] }}
      />,
    );
    const tip = screen.getByTestId("restore-diff-m1");
    const text = tip.textContent;
    expect(text).toContain("Restoring will:");
    expect(text).toContain("+ app.js");
    expect(text).toContain("− landing.html");
    expect(text).toContain("~ index.html");
  });

  it("tells the user when the workspace already matches the snapshot", () => {
    render(
      <RestoreTurnButton
        messageId="m1"
        onRestore={vi.fn()}
        diff={{ added: [], removed: [], modified: [] }}
      />,
    );
    expect(screen.getByTestId("restore-diff-m1").textContent).toContain(
      "already matches",
    );
  });

  it("renders no tooltip until a diff is loaded", () => {
    render(<RestoreTurnButton messageId="m1" onRestore={vi.fn()} />);
    expect(screen.queryByTestId("restore-diff-m1")).toBeNull();
  });
});

describe("RestoreTurnButton — health badge in the tooltip", () => {
  it("shows ✓ complete for a healthy snapshot", () => {
    render(
      <RestoreTurnButton
        messageId="m1"
        onRestore={vi.fn()}
        diff={{ added: ["x"], removed: [], modified: [] }}
        missing={[]}
      />,
    );
    const badge = screen.getByTestId("restore-health-m1");
    expect(badge.textContent).toContain("✓");
    expect(badge.textContent).toContain("safe to restore");
  });

  it("shows ⚠ with the missing files when nothing complete exists", () => {
    render(
      <RestoreTurnButton
        messageId="m1"
        onRestore={vi.fn()}
        diff={{ added: [], removed: [], modified: [] }}
        missing={["app.js"]}
        suggestId={null}
      />,
    );
    const badge = screen.getByTestId("restore-health-m1");
    expect(badge.textContent).toContain("⚠");
    expect(badge.textContent).toContain("app.js");
    expect(badge.textContent).toContain("404");
  });

  it("shows 🛠 naming the complete snapshot to switch to instead", () => {
    render(
      <RestoreTurnButton
        messageId="m1"
        onRestore={vi.fn()}
        diff={{ added: [], removed: [], modified: [] }}
        missing={["app.js"]}
        suggestId="m2"
      />,
    );
    const badge = screen.getByTestId("restore-health-m1");
    expect(badge.textContent).toContain("🛠");
    expect(badge.textContent).toContain("m2");
  });

  it("treats an absent missing list as healthy (legacy callers)", () => {
    render(
      <RestoreTurnButton
        messageId="m1"
        onRestore={vi.fn()}
        diff={{ added: ["x"], removed: [], modified: [] }}
      />,
    );
    expect(screen.getByTestId("restore-health-m1").textContent).toContain("✓");
  });

  it("renders no health badge before the tooltip exists", () => {
    render(<RestoreTurnButton messageId="m1" onRestore={vi.fn()} />);
    expect(screen.queryByTestId("restore-health-m1")).toBeNull();
  });
});

describe("MessageBubble footer wiring", () => {
  it("renders the Restore button for a snapshotted assistant turn", () => {
    render(
      <MessageBubble
        message={msg("a1", "assistant", "done", { fileCount: 3, modelUsed: "m" })}
        footer={<RestoreTurnButton messageId="a1" onRestore={vi.fn()} />}
      />,
    );
    expect(screen.getByTestId("restore-a1")).toBeTruthy();
  });

  it("renders nothing extra for turns without a snapshot", () => {
    render(
      <MessageBubble
        message={msg("a2", "assistant", "chat only", { fileCount: 0 })}
        footer={null}
      />,
    );
    expect(screen.queryByTestId("restore-a2")).toBeNull();
  });
});
