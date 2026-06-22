"use client";

import { FileText, FileUp, Trash2 } from "lucide-react";
import type { ProjectMeta } from "@/lib/projects";
import { cn } from "@/lib/utils";

interface ProjectLibraryProps {
  projects: ProjectMeta[];
  isDragging: boolean;
  error: string | null;
  onOpenFile: () => void;
  onOpenProject: (meta: ProjectMeta) => void;
  onDeleteProject: (id: string) => void;
}

/**
 * Home screen shown when no document is open: a big "open a PDF" target plus the
 * list of saved projects (stored locally on the device). Tap a card to continue
 * editing; trash to remove it.
 */
export function ProjectLibrary({
  projects,
  isDragging,
  error,
  onOpenFile,
  onOpenProject,
  onDeleteProject,
}: ProjectLibraryProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
        <button
          onClick={onOpenFile}
          className={cn(
            "flex w-full flex-col items-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center transition-colors sm:p-12",
            isDragging ? "border-blue-500 bg-blue-50" : "border-neutral-300 bg-white active:bg-neutral-50 hover:border-neutral-400",
          )}
        >
          <FileUp className="h-10 w-10 text-blue-600" />
          <span className="text-lg font-semibold text-neutral-800">Open a PDF</span>
          <span className="text-sm text-neutral-500">Tap to browse, or drop a file here. Everything stays on your device.</span>
        </button>

        {error && (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
        )}

        <div className="mt-8">
          <h2 className="mb-3 px-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Your projects {projects.length > 0 && `(${projects.length})`}
          </h2>

          {projects.length === 0 ? (
            <p className="rounded-xl border border-neutral-200 bg-white px-4 py-8 text-center text-sm text-neutral-400">
              Saved projects appear here so you can pick up where you left off.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {projects.map((p) => (
                <li key={p.id} className="group relative">
                  <button
                    onClick={() => onOpenProject(p)}
                    className="flex w-full flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white text-left shadow-sm transition-shadow active:shadow-md hover:shadow-md"
                  >
                    <span className="flex aspect-[3/4] items-center justify-center overflow-hidden bg-neutral-100">
                      {p.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.thumbnail} alt="" className="h-full w-full object-contain" />
                      ) : (
                        <FileText className="h-10 w-10 text-neutral-300" />
                      )}
                    </span>
                    <span className="flex flex-col gap-0.5 p-2.5">
                      <span className="truncate text-sm font-medium text-neutral-800" title={p.name}>
                        {p.name}
                      </span>
                      <span className="text-xs text-neutral-400">
                        {p.pageCount} page{p.pageCount === 1 ? "" : "s"} · {formatDate(p.updatedAt)}
                      </span>
                    </span>
                  </button>

                  <button
                    onClick={() => {
                      if (confirm(`Delete "${p.name}"? This can't be undone.`)) onDeleteProject(p.id);
                    }}
                    aria-label={`Delete ${p.name}`}
                    className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-red-600 shadow ring-1 ring-black/5 active:bg-red-50 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}
