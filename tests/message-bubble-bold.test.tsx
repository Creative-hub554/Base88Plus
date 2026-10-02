/**
 * Pin for MessageBubble's inline-bold rendering (src/components/builder-client.tsx).
 *
 * The template-promotion route seeds the chat with `This app started from the
 * **SaaS site** template …`, and the builder system prompt asks the model for a
 * one-line summary — both use ** for names. The bubble used to print the raw
 * asterisks, so the first thing a new user saw after "Use this template" was
 * unrendered markdown.
 *
 * Rendered through text nodes and <strong>, never dangerouslySetInnerHTML —
 * assistant text is model output, so it must never be parsed as HTML.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "@/components/builder-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const assistant = (text: string) =>
  ({
    id: "m1",
    role: "assistant",
    parts: [{ type: "text", text }],
  }) as never;

describe("MessageBubble inline bold", () => {
  it("renders **bold** as a strong element", () => {
    render(<MessageBubble message={assistant("Started from the **SaaS site** template.")} />);
    const strong = screen.getByText("SaaS site");
    expect(strong.tagName).toBe("STRONG");
    // the asterisks are gone from the visible text
    expect(document.body.textContent).not.toContain("**");
  });

  it("renders every bold span in one message", () => {
    render(<MessageBubble message={assistant("**One** then **Two**.")} />);
    expect(screen.getByText("One").tagName).toBe("STRONG");
    expect(screen.getByText("Two").tagName).toBe("STRONG");
  });

  it("leaves plain text alone", () => {
    render(<MessageBubble message={assistant("no markup here")} />);
    expect(screen.getByText(/no markup here/)).toBeTruthy();
    expect(document.querySelector("strong")).toBeNull();
  });

  it("does not interpret html in assistant text", () => {
    render(<MessageBubble message={assistant("<img src=x onerror=alert(1)> **ok**")} />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("ok").tagName).toBe("STRONG");
  });

  it("leaves user messages verbatim — the user typed the asterisks", () => {
    const msg = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "make it **bold**" }],
    } as never;
    render(<MessageBubble message={msg} />);
    expect(document.body.textContent).toContain("**bold**");
  });
});