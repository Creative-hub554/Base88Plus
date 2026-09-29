"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { notify } from "./toast";

/**
 * The dashboard's "Import zip" affordance: pick an Anybase export (or any
 * static-site zip), POST it to /api/projects/import, and land in the
 * builder. Import is the return leg of the export story — without it the
 * download button is a one-way door.
 *
 * A hidden file input keeps the button a plain <button> (no <form>, no
 * layout drift); FormData carries the file plus optional name/description
 * overrides derived from the filename.
 */
export function ImportZipButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const onPick = () => inputRef.current?.click();

  const onFile = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      // Weak hint only: an anybase export's embedded metadata wins over
      // this, so an exported app imports under its ORIGINAL name — the
      // filename stem is just the fallback for foreign zips.
      const stem = file.name.replace(/\.zip$/i, "").replace(/[^a-z0-9-]+/gi, " ").trim();
      if (stem) form.append("nameFromFilename", stem);

      const res = await fetch("/api/projects/import", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as {
        project?: { id: string };
        importedCount?: number;
        skipped?: { path: string; reason: string }[];
        error?: string;
      };

      if (!res.ok || !data.project) {
        notify(data.error || "Import failed", "danger");
        return;
      }

      const skippedCount = data.skipped?.length ?? 0;
      notify(
        `Imported ${data.importedCount ?? 0} file(s)` +
          (skippedCount > 0 ? ` · ${skippedCount} skipped` : ""),
        skippedCount > 0 ? "warn" : "info",
      );
      router.push(`/app/${data.project.id}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        data-testid="import-input"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // allow re-picking the same file
          if (f) void onFile(f);
        }}
      />
      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        data-testid="import-zip"
        className="rounded-lg border border-neutral-800 px-5 py-2.5 text-sm text-neutral-300 transition hover:bg-neutral-900 disabled:opacity-50"
      >
        {busy ? "Importing…" : "Import zip"}
      </button>
    </>
  );
}
