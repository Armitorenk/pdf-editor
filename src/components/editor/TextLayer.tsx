"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { multiplyMatrix } from "@/lib/pdf/coordinates";
import { textEditKey, type TextEdit } from "@/lib/pdf/types";
import { cn } from "@/lib/utils";

/** A text run detected by pdf.js, with its matrix kept in PDF user space. */
interface DetectedText {
  itemIndex: number;
  str: string;
  /** pdf.js text-space matrix `[a,b,c,d,e,f]` (PDF user space, bottom-left origin). */
  transform: number[];
  /** Run width in PDF points. */
  width: number;
}

interface TextLayerProps {
  doc: PDFDocumentProxy;
  /** 1-based original page number, for pdf.js `getPage`. */
  pageNumber: number;
  /** Stable id of the page slot this layer belongs to. */
  pageId: string;
  scale: number;
  edits: Record<string, TextEdit>;
  onCommit: (edit: TextEdit) => void;
  onRemove: (key: string) => void;
}

/**
 * Editable overlay aligned to a page's canvas. Detects text runs with
 * `getTextContent()`, draws a transparent hit-box over each, and on click swaps in
 * an input. Committed edits show a white-on-canvas preview that mirrors what the
 * pdf-lib export will bake in. Positions are recomputed from the live viewport, so
 * the overlay tracks zoom automatically.
 */
export function TextLayer({ doc, pageNumber, pageId, scale, edits, onCommit, onRemove }: TextLayerProps) {
  const pageRef = useRef<PDFPageProxy | null>(null);
  const [items, setItems] = useState<DetectedText[] | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  // Detect text runs once per page.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      if (cancelled) return;
      pageRef.current = page;
      const detected: DetectedText[] = [];
      content.items.forEach((item, idx) => {
        if ("str" in item && item.str.trim().length > 0) {
          detected.push({ itemIndex: idx, str: item.str, transform: item.transform, width: item.width });
        }
      });
      setItems(detected);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber]);

  if (!items || !pageRef.current) return null;
  const viewport = pageRef.current.getViewport({ scale });

  return (
    <div className="absolute inset-0">
      {items.map((item) => {
        const key = textEditKey(pageId, item.itemIndex);
        const edit = edits[key];
        const isEditing = editingKey === key;

        // Device-space (CSS px) box, from combining the viewport and text matrices.
        const tx = multiplyMatrix(viewport.transform, item.transform);
        const fontPx = Math.hypot(tx[2], tx[3]);
        const left = tx[4];
        const top = tx[5] - fontPx;
        const widthPx = Math.max(item.width * scale, fontPx * 0.4);
        const boxHeight = fontPx * 1.25;

        // PDF-space font size (zoom-independent), captured for export.
        const pdfFontSize = Math.hypot(item.transform[2], item.transform[3]);

        const commit = (value: string) => {
          setEditingKey(null);
          if (value === item.str) {
            onRemove(key);
            return;
          }
          onCommit({
            pageId,
            itemIndex: item.itemIndex,
            originalText: item.str,
            newText: value,
            x: item.transform[4],
            y: item.transform[5],
            fontSize: pdfFontSize,
            width: item.width,
          });
        };

        if (isEditing) {
          return (
            <input
              key={key}
              autoFocus
              defaultValue={edit?.newText ?? item.str}
              onBlur={(e) => commit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  setEditingKey(null);
                }
              }}
              style={{ left, top, minWidth: widthPx, height: boxHeight, fontSize: fontPx }}
              className="absolute z-20 box-content whitespace-nowrap border border-blue-500 bg-white px-0.5 font-sans leading-none text-black shadow-sm outline-none"
            />
          );
        }

        return (
          <button
            key={key}
            onClick={() => setEditingKey(key)}
            title={edit ? `${item.str} → ${edit.newText}` : item.str}
            style={{
              left,
              top,
              width: edit ? "auto" : widthPx,
              minWidth: widthPx,
              height: boxHeight,
              fontSize: fontPx,
            }}
            className={cn(
              "absolute z-10 box-content cursor-text overflow-hidden whitespace-nowrap text-left font-sans leading-none text-black",
              edit
                ? "bg-white px-0.5 ring-1 ring-amber-400"
                : "rounded-sm hover:bg-blue-400/20 hover:ring-1 hover:ring-blue-400",
            )}
          >
            {edit?.newText ?? ""}
          </button>
        );
      })}
    </div>
  );
}
