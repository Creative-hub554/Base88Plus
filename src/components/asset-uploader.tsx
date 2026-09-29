"use client";

import { useCallback, useRef, useState } from "react";
import { ASSET_EXTENSIONS } from "../lib/asset-extensions";
import { notify } from "./toast";

interface AssetUploaderProps {
  projectId: string;
  files: { path: string }[];
  onFileSelect: (path: string) => void;
  activeFile: string | null;
  onUploaded?: (savedPaths: string[]) => void;
}

/**
 * The workspace file list with direct asset upload: click the "+" (or
 * drop files anywhere on the list) to add images/fonts to the project —
 * no zip round-trip, no chat detour. The client accept list is only UX;
 * the server re-validates extension/size/duplicates. Replace an asset by
 * re-uploading under the same name via zip import (deliberate friction:
 * silent overwrites of generated files are worse than a 409).
 */
export function FilePanel({
  projectId,
  files,
  onFileSelect,
  activeFile,
  onUploaded,
}: AssetUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  const upload = useCallback(
    async (list: FileList | File[]) => {
      const picked = [...list];
      if (picked.length === 0) return;
      setUploading(true);
      try {
        const form = new FormData();
        for (const f of picked) form.append("file", f);
        const res = await fetch(`/api/projects/${projectId}/assets`, {
          method: "POST",
          body: form,
        });
        const data = (await res.json().catch(() => ({}))) as {
          saved?: { path: string }[];
          errors?: { filename: string; error: string }[];
          error?: string;
        };
        if (data.error) {
          notify(data.error, "danger");
          return;
        }
        const saved = data.saved ?? [];
        const failed = data.errors ?? [];
        if (saved.length > 0) {
          notify(
            `Added ${saved.length} asset(s)` +
              (failed.length ? ` · ${failed.length} rejected` : ""),
            failed.length ? "warn" : "info",
          );
          onUploaded?.(saved.map((s) => s.path));
        } else if (failed.length > 0) {
          const first = failed[0];
          notify(`${first.filename}: ${first.error}`, "danger");
        }
      } finally {
        setUploading(false);
      }
    },
    [projectId, onUploaded],
  );

  return (
    <aside
      data-testid="file-panel"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length > 0) void upload(e.dataTransfer.files);
      }}
      className={`w-56 shrink-0 overflow-y-auto border-r p-2 transition ${
        dragOver
          ? "border-dashed border-neutral-500 bg-neutral-800/60"
          : "border-neutral-800"
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between px-2">
        <span className="text-[10px] uppercase tracking-wide text-neutral-600">
          Files
        </span>
        <button
          type="button"
          data-testid="asset-add"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          title="Add images or fonts"
          className="rounded px-1.5 py-0.5 text-xs text-neutral-400 transition hover:bg-neutral-800 hover:text-white disabled:opacity-50"
        >
          {uploading ? "…" : "+"}
        </button>
      </div>
      {files.map((f) => (
        <button
          key={f.path}
          onClick={() => onFileSelect(f.path)}
          className={`block w-full truncate rounded px-2 py-1.5 text-left text-xs ${
            activeFile === f.path
              ? "bg-neutral-800 text-white"
              : "text-neutral-400 hover:bg-neutral-900"
          }`}
        >
          {f.path}
        </button>
      ))}
      {dragOver && (
        <div className="mt-2 rounded border border-dashed border-neutral-600 px-2 py-3 text-center text-[10px] text-neutral-500">
          Drop to add assets
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ASSET_EXTENSIONS.map((e) => `.${e}`).join(",")}
        data-testid="asset-input"
        className="hidden"
        onChange={(e) => {
          const list = e.target.files;
          e.target.value = "";
          if (list && list.length > 0) void upload(list);
        }}
      />
    </aside>
  );
}
