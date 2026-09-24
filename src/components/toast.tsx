"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Promise-based in-app dialogs: the pin/fix recovery flows need DECISIONS
 * (pin anyway / switch to the complete version / publish now) and OUTCOME
 * messages (fixed / partial / failed) that used to be window.confirm /
 * window.alert. Native dialogs block the whole tab and can't be styled or
 * tested through the UI; these toasts carry explicit action buttons, render
 * in a fixed bottom-right host, and resolve the awaiting flow's promise.
 *
 * A module-level bus keeps the API callable from anywhere (async flow code
 * outside React state) — no provider to wire into the tree. <ToastHost />
 * mounts once per page via BuilderClient; no-ops until a dialog shows.
 */

type Tone = "info" | "warn" | "danger";

interface ToastAction {
  /** Value the pending choose() resolves with when clicked. */
  value: string;
  label: string;
  /** Visual weight — the recommended action renders solid white. */
  primary?: boolean;
  danger?: boolean;
}

interface ActiveToast {
  id: number;
  message: string;
  actions: ToastAction[];
  tone: Tone;
}

let current: ActiveToast | null = null;
let nextId = 1;
let pendingResolve: ((v: string) => void) | null = null;
const listeners = new Set<(t: ActiveToast | null) => void>();

function emit(toast: ActiveToast | null) {
  current = toast;
  for (const l of listeners) l(current);
}

/**
 * Show a DECISION toast and resolve with the clicked action's value
 * (caller-chosen, e.g. "confirm"/"cancel"/"switch"). The toast stays up
 * until an action is clicked. A newer choose() replaces an older one and
 * settles the superseded promise with its non-primary action's value (the
 * "walk away" choice) so no flow hangs on a toast that no longer exists.
 */
export function choose(message: string, actions: ToastAction[]): Promise<string> {
  const superseded = current;
  if (superseded) {
    const walkAway = superseded.actions.find((a) => !a.primary);
    if (walkAway) {
      const resolve = pendingResolve;
      pendingResolve = null;
      emit(null);
      resolve?.(walkAway.value);
    }
  }
  return new Promise((resolve) => {
    pendingResolve = resolve;
    emit({ id: nextId++, message, actions, tone: "info" });
  });
}

/**
 * Show an OUTCOME toast that dismisses itself (6s) — the replacement for
 * window.alert.
 */
export function notify(message: string, tone: Tone = "info") {
  const id = nextId++;
  emit({ id, message, actions: [], tone });
  window.setTimeout(() => {
    if (current?.id === id) emit(null);
  }, 6000);
}

/** Clicked by the host's action buttons. */
function settle(value: string) {
  const resolve = pendingResolve;
  pendingResolve = null;
  emit(null);
  resolve?.(value);
}

/** Clear any open toast and settle its promise with the walk-away choice.
 *  Test hygiene: the bus is module-level, so reset between tests. */
export function resetToasts() {
  const superseded = current;
  const resolve = pendingResolve;
  pendingResolve = null;
  emit(null);
  if (resolve && superseded) {
    const walkAway = superseded.actions.find((a) => !a.primary);
    resolve(walkAway?.value ?? "cancel");
  }
}

const TONE_TEXT: Record<Tone, string> = {
  info: "text-neutral-200",
  warn: "text-amber-200",
  danger: "text-red-200",
};

/**
 * Self-mounting host for the active toast (bottom-right). Render once per
 * page (BuilderClient does); nothing renders until a dialog shows.
 */
export function ToastHost() {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    setToast(current);
    const l = (t: ActiveToast | null) => setToast(t);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  if (!mounted || !toast) return null;
  return createPortal(
    <div
      data-testid="toast-host"
      role="alertdialog"
      aria-live="assertive"
      className="fixed bottom-4 right-4 z-[100] w-[340px] animate-rise rounded-lg border border-neutral-700 bg-neutral-900/95 px-3.5 py-3 shadow-2xl backdrop-blur"
    >
      <p className={`whitespace-pre-wrap text-xs leading-relaxed ${TONE_TEXT[toast.tone]}`}>
        {toast.message}
      </p>
      {toast.actions.length > 0 && (
        <div className="mt-2.5 flex justify-end gap-2">
          {toast.actions.map((a) => (
            <button
              key={a.value}
              type="button"
              data-testid={`toast-${a.value}`}
              onClick={() => settle(a.value)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                a.danger
                  ? "border border-red-700 bg-red-900/60 text-red-200 hover:bg-red-800/60"
                  : a.primary
                    ? "bg-white text-neutral-900 hover:bg-neutral-200"
                    : "border border-neutral-600 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
