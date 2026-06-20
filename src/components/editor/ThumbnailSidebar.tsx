"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isRenderCancelled, renderPageToCanvas } from "@/lib/pdf/render";
import type { PageRef } from "@/lib/pdf/types";

const THUMB_WIDTH = 132;

interface ThumbnailSidebarProps {
  doc: PDFDocumentProxy;
  pageOrder: PageRef[];
  activePage: number;
  onSelectPage: (slotIndex: number) => void;
  onReorder: (from: number, to: number) => void;
  onDeletePage: (slotIndex: number) => void;
  onAddBlankPage: () => void;
}

/** Page rail: thumbnails with drag-to-reorder, per-page delete, and append-blank. */
export function ThumbnailSidebar({
  doc,
  pageOrder,
  activePage,
  onSelectPage,
  onReorder,
  onDeletePage,
  onAddBlankPage,
}: ThumbnailSidebarProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  return (
    <aside className="hidden w-44 shrink-0 flex-col overflow-y-auto border-r border-neutral-200 bg-neutral-50 p-3 md:flex">
      <ul className="flex flex-col gap-3">
        {pageOrder.map((ref, i) => (
          <li
            key={ref.id}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragOver={(e) => {
              e.preventDefault();
              setOverIndex(i);
            }}
            onDrop={() => {
              if (dragIndex !== null && dragIndex !== i) onReorder(dragIndex, i);
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
            className={cn(
              "rounded-md",
              overIndex === i && dragIndex !== null && dragIndex !== i && "ring-2 ring-blue-400",
            )}
          >
            <ThumbnailItem
              doc={doc}
              pageRef={ref}
              index={i}
              active={i === activePage}
              canDelete={pageOrder.length > 1}
              onClick={() => onSelectPage(i)}
              onDelete={() => onDeletePage(i)}
            />
          </li>
        ))}
      </ul>

      <button
        onClick={onAddBlankPage}
        className="mt-3 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-neutral-300 py-2 text-sm text-neutral-600 hover:border-neutral-400 hover:bg-white"
      >
        <Plus className="h-4 w-4" />
        Blank page
      </button>
    </aside>
  );
}

interface ThumbnailItemProps {
  doc: PDFDocumentProxy;
  pageRef: PageRef;
  index: number;
  active: boolean;
  canDelete: boolean;
  onClick: () => void;
  onDelete: () => void;
}

function ThumbnailItem({ doc, pageRef, index, active, canDelete, onClick, onDelete }: ThumbnailItemProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || pageRef.kind !== "original") return;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageRef.originalIndex + 1);
      if (cancelled || !canvasRef.current) return;
      const { width } = page.getViewport({ scale: 1 });
      renderTaskRef.current?.cancel();
      const task = renderPageToCanvas(page, canvasRef.current, THUMB_WIDTH / width);
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch (err) {
        if (!isRenderCancelled(err)) throw err;
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [doc, pageRef, visible]);

  return (
    <div
      ref={wrapRef}
      onClick={onClick}
      className={cn(
        "group relative flex cursor-pointer flex-col items-center gap-1 rounded-md border p-1.5 transition-colors",
        active ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500" : "border-neutral-200 bg-white hover:border-neutral-300",
      )}
    >
      {canDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete page"
          className="absolute -right-2 -top-2 z-10 hidden h-5 w-5 items-center justify-center rounded-full bg-red-600 text-white shadow group-hover:flex"
        >
          <X className="h-3 w-3" />
        </button>
      )}

      <span
        className="flex items-center justify-center overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-black/5"
        style={{
          width: THUMB_WIDTH,
          height: pageRef.kind === "blank" ? THUMB_WIDTH * (pageRef.height / pageRef.width) : undefined,
        }}
      >
        {pageRef.kind === "original" ? (
          <canvas ref={canvasRef} className="block" />
        ) : (
          <span className="text-xs text-neutral-300">Blank</span>
        )}
      </span>

      <span className={cn("text-xs", active ? "font-semibold text-blue-700" : "text-neutral-500")}>
        {index + 1}
      </span>
    </div>
  );
}
