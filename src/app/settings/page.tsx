"use client";

import { SettingsForm } from "@/components/builder-client";

export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <a href="/" className="text-sm text-neutral-500 hover:text-white">
          ← Back to apps
        </a>
        <a
          href="/providers"
          className="text-sm text-neutral-500 hover:text-white"
        >
          Providers health →
        </a>
      </div>
      <SettingsForm onDone={() => history.back()} />
    </main>
  );
}
