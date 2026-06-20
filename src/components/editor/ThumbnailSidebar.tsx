"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { ChevronDown, ChevronUp, Plus, Trash2, X } from "lucide-react";
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
  /** Mobile drawer open state (ignored by the desktop rail). */
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

/**
 * Page manager: thumbnails with reorder (▲/▼ — reliable on touch, unlike native
 * drag-and-drop), per-page delete, and append-blank. Rendered two ways: a static
 * rail on `md+`, and a slide-over drawer on phones (same inner list).
 */
export function ThumbnailSidebar({
  doc,
  pageOrder,
  activePage,
  onSelectPage,
  onReorder,
  onDeletePage,
  onAddBlankPage,
  mobileOpen,
  onCloseMobile,
}: ThumbnailSidebarProps) {
  const list = (onPick: (i: number) => void) => (
    <>
      <ul className="flex flex-col gap-3">
        {pageOrder.map((ref, i) => (
          <li key={ref.id}>
            <ThumbnailItem
              doc={doc}
              pageRef={ref}
              index={i}
              active={i === activePage}
              isFirst={i === 0}
              isLast={i === pageOrder.length - 1}
              canDelete={pageOrder.length > 1}
              onClick={() => onPick(i)}
              onMoveUp={() => onReorder(i, i - 1)}
              onMoveDown={() => onReorder(i, i + 1)}
              onDelete={() => onDeletePage(i)}
            />
          </li>
        ))}
      </ul>

      <button
        onClick={onAddBlankPage}
        className="mt-3 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-neutral-300 py-3 text-sm text-neutral-600 active:bg-white hover:border-neutral-400 hover:bg-white"
      >
        <Plus className="h-4 w-4" />
        Blank page
      </button>
    </>
  );

  return (
    <>
      {/* Desktop rail */}
      <aside className="hidden w-44 shrink-0 flex-col overflow-y-auto border-r border-neutral-200 bg-neutral-50 p-3 md:flex">
        {list(onSelectPage)}
      </aside>

      {/* Mobile slide-over drawer */}
      <div className={cn("fixed inset-0 z-50 md:hidden", !mobileOpen && "pointer-events-none")}>
        <div
          onClick={onCloseMobile}
          className={cn(
            "absolute inset-0 bg-black/40 transition-opacity duration-200",
            mobileOpen ? "opacity-100" : "opacity-0",
          )}
        />
        <aside
          className={cn(
            "absolute left-0 top-0 flex h-full w-72 max-w-[82%] flex-col bg-neutral-50 shadow-xl transition-transform duration-200 pt-safe pb-safe",
            mobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 px-4">
            <span className="font-semibold text-neutral-800">Pages</span>
            <button
              onClick={onCloseMobile}
              aria-label="Close"
              className="flex h-10 w-10 items-center justify-center rounded-lg text-neutral-600 active:bg-neutral-200"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {list((i) => {
              onSelectPage(i);
              onCloseMobile();
            })}
          </div>
        </aside>
      </div>
    </>
  );
}

interface ThumbnailItemProps {
  doc: PDFDocumentProxy;
  pageRef: PageRef;
  index: number;
  active: boolean;
  isFirst: boolean;
  isLast: boolean;
  canDelete: boolean;
  onClick: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}

function ThumbnailItem({
  doc,
  pageRef,
  index,
  active,
  isFirst,
  isLast,
  canDelete,
  onClick,
  onMoveUp,
  onMoveDown,
  onDelete,
}: ThumbnailItemProps) {
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
      className={cn(
        "rounded-lg border p-1.5 transition-colors",
        active ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500" : "border-neutral-200 bg-white",
      )}
    >
      <button onClick={onClick} className="flex w-full justify-center" aria-label={`Go to page ${index + 1}`}>
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
            <span className="py-10 text-xs text-neutral-300">Blank</span>
          )}
        </span>
      </button>

      <div className="mt-1 flex items-center gap-1">
        <span className={cn("w-5 text-center text-xs tabular-nums", active ? "font-semibold text-blue-700" : "text-neutral-500")}>
          {index + 1}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn label="Move up" disabled={isFirst} onClick={onMoveUp}>
            <ChevronUp className="h-4 w-4" />
          </IconBtn>
          <IconBtn label="Move down" disabled={isLast} onClick={onMoveDown}>
            <ChevronDown className="h-4 w-4" />
          </IconBtn>
          <IconBtn label="Delete page" disabled={!canDelete} danger onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </IconBtn>
        </div>
      </div>
    </div>
  );
}

function IconBtn({
  label,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:opacity-30",
        danger ? "text-red-600 active:bg-red-50 hover:bg-red-50" : "text-neutral-600 active:bg-neutral-200 hover:bg-neutral-200",
      )}
    >
      {children}
    </button>
  );
}
