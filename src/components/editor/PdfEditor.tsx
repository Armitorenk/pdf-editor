"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { usePdfDocument } from "@/hooks/usePdfDocument";
import { cn } from "@/lib/utils";
import { downloadBlob, downloadBytes } from "@/lib/download";
import { exportPdf } from "@/lib/pdf/export";
import { extractText, imagesToZip, pdfToImages, type ExportFormat } from "@/lib/pdf/convert";
import type { Rect } from "@/lib/pdf/coordinates";
import {
  textEditKey,
  type Annotation,
  type AnnotationTool,
  type EditMode,
  type ImageOverlay,
  type PageRef,
  type PageSize,
  type TextEdit,
} from "@/lib/pdf/types";
import { Toolbar } from "./Toolbar";
import { AnnotationToolbar } from "./AnnotationToolbar";
import { ThumbnailSidebar } from "./ThumbnailSidebar";
import { PdfViewer, type ViewerApi } from "./PdfViewer";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.25;
const DEFAULT_SCALE = 1.2;
const A4: PageSize = { width: 595.28, height: 841.89 };

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Read an image's natural pixel dimensions from an object URL. */
function loadImageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve({ w: image.naturalWidth, h: image.naturalHeight });
    image.onerror = () => reject(new Error("Could not read image"));
    image.src = src;
  });
}

/**
 * Top-level editor: owns the document bytes, the working page order, and every
 * edit (text / image / annotation), and composes the toolbar, thumbnail rail, and
 * viewer. Edits are keyed by stable page id, so reordering/deleting pages keeps
 * them attached to the right page. Export rebuilds the PDF from this state.
 */
export function PdfEditor() {
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [activePage, setActivePage] = useState(0);
  const [firstPageSize, setFirstPageSize] = useState<PageSize | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [editMode, setEditMode] = useState<EditMode>("view");
  const [pageOrder, setPageOrder] = useState<PageRef[]>([]);
  const [textEdits, setTextEdits] = useState<Record<string, TextEdit>>({});
  const [imageOverlays, setImageOverlays] = useState<ImageOverlay[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("pen");
  const [annotationColor, setAnnotationColor] = useState("#ef4444");
  const [annotationWidth, setAnnotationWidth] = useState(2);
  const [isExporting, setIsExporting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const viewerApiRef = useRef<ViewerApi | null>(null);

  const { doc, numPages, status, error } = usePdfDocument(fileBytes);

  // Build the initial page order (originals, in order) when a document loads.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    setPageOrder(
      Array.from({ length: doc.numPages }, (_, i) => ({
        id: `orig:${i}`,
        kind: "original" as const,
        originalIndex: i,
      })),
    );
    (async () => {
      const { width, height } = (await doc.getPage(1)).getViewport({ scale: 1 });
      if (!cancelled) setFirstPageSize({ width, height });
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const loadFile = useCallback(async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    setFileName(file.name);
    setActivePage(0);
    setScale(DEFAULT_SCALE);
    setFirstPageSize(null);
    setEditMode("view");
    setPageOrder([]);
    setTextEdits({});
    setImageOverlays((prev) => {
      prev.forEach((im) => URL.revokeObjectURL(im.src));
      return [];
    });
    setSelectedImageId(null);
    setAnnotations([]);
    setFileBytes(bytes);
  }, []);

  /** Switch tools; image selection only matters while in image mode. */
  const setMode = useCallback((mode: EditMode) => {
    setEditMode(mode);
    if (mode !== "image") setSelectedImageId(null);
  }, []);

  // --- Text edits -----------------------------------------------------------
  const commitTextEdit = useCallback((edit: TextEdit) => {
    setTextEdits((prev) => ({ ...prev, [textEditKey(edit.pageId, edit.itemIndex)]: edit }));
  }, []);

  const removeTextEdit = useCallback((key: string) => {
    setTextEdits((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // --- Images ---------------------------------------------------------------
  const addImage = useCallback(
    async (file: File) => {
      const ref = pageOrder[activePage];
      if (!ref) return;
      const format: ImageOverlay["format"] = file.type.includes("png") ? "png" : "jpg";
      const bytes = new Uint8Array(await file.arrayBuffer());
      const src = URL.createObjectURL(new Blob([bytes], { type: file.type }));
      const { w, h } = await loadImageSize(src);

      let pw: number;
      let ph: number;
      if (ref.kind === "original" && doc) {
        const vp = (await doc.getPage(ref.originalIndex + 1)).getViewport({ scale: 1 });
        pw = vp.width;
        ph = vp.height;
      } else {
        pw = ref.kind === "blank" ? ref.width : A4.width;
        ph = ref.kind === "blank" ? ref.height : A4.height;
      }

      const width = Math.min(pw * 0.35, w);
      const height = width * (h / w);
      const id = crypto.randomUUID();
      setImageOverlays((prev) => [
        ...prev,
        { id, pageId: ref.id, x: (pw - width) / 2, y: (ph - height) / 2, width, height, src, bytes, format, aspect: w / h },
      ]);
      setEditMode("image");
      setSelectedImageId(id);
    },
    [doc, activePage, pageOrder],
  );

  const changeImage = useCallback((id: string, rect: Rect) => {
    setImageOverlays((prev) =>
      prev.map((im) =>
        im.id === id ? { ...im, x: rect.x, y: rect.y, width: rect.width, height: rect.height } : im,
      ),
    );
  }, []);

  const deleteImage = useCallback((id: string) => {
    setImageOverlays((prev) => {
      const target = prev.find((im) => im.id === id);
      if (target) URL.revokeObjectURL(target.src);
      return prev.filter((im) => im.id !== id);
    });
    setSelectedImageId((cur) => (cur === id ? null : cur));
  }, []);

  // --- Annotations ----------------------------------------------------------
  const addAnnotation = useCallback((ann: Annotation) => setAnnotations((prev) => [...prev, ann]), []);
  const undoAnnotation = useCallback(() => setAnnotations((prev) => prev.slice(0, -1)), []);
  const clearPageAnnotations = useCallback(() => {
    const ref = pageOrder[activePage];
    if (ref) setAnnotations((prev) => prev.filter((a) => a.pageId !== ref.id));
  }, [pageOrder, activePage]);

  // --- Page management ------------------------------------------------------
  const reorderPages = useCallback((from: number, to: number) => {
    setPageOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const deletePage = useCallback(
    (slotIndex: number) => {
      const ref = pageOrder[slotIndex];
      if (!ref || pageOrder.length <= 1) return;
      setPageOrder((prev) => prev.filter((_, i) => i !== slotIndex));
      setTextEdits((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([, v]) => v.pageId !== ref.id)),
      );
      setImageOverlays((prev) => {
        prev.filter((im) => im.pageId === ref.id).forEach((im) => URL.revokeObjectURL(im.src));
        return prev.filter((im) => im.pageId !== ref.id);
      });
      setAnnotations((prev) => prev.filter((a) => a.pageId !== ref.id));
      setActivePage((p) => Math.min(p, pageOrder.length - 2));
    },
    [pageOrder],
  );

  const addBlankPage = useCallback(() => {
    const size = firstPageSize ?? A4;
    setPageOrder((prev) => [
      ...prev,
      { id: `blank:${crypto.randomUUID()}`, kind: "blank", width: size.width, height: size.height },
    ]);
  }, [firstPageSize]);

  // --- Export / convert -----------------------------------------------------
  // Every format starts from the same edited PDF, so image/PDF outputs all reflect
  // the current edits. Text is the exception: it reads the original document (see
  // extractText) to avoid the export's covered-but-still-present original glyphs.
  const handleExport = useCallback(
    async (format: ExportFormat) => {
      if (!fileBytes || !doc) return;
      setIsExporting(true);
      try {
        const base = fileName?.replace(/\.pdf$/i, "") ?? "document";

        if (format === "txt") {
          const text = await extractText(doc, pageOrder, textEdits);
          downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `${base}.txt`);
          return;
        }

        const pdfBytes = await exportPdf(fileBytes, {
          pageOrder,
          textEdits: Object.values(textEdits),
          images: imageOverlays,
          annotations,
        });

        if (format === "pdf") {
          downloadBytes(pdfBytes, `${base}-edited.pdf`);
          return;
        }

        // png | jpeg: rasterise the edited PDF; one page downloads directly, more
        // than one is bundled into a ZIP.
        const images = await pdfToImages(pdfBytes, format);
        if (images.length === 1) {
          downloadBlob(images[0].blob, `${base}.${format === "png" ? "png" : "jpg"}`);
        } else {
          downloadBlob(await imagesToZip(images), `${base}-${format === "png" ? "png" : "jpg"}.zip`);
        }
      } catch (err) {
        console.error("Export failed:", err);
        alert("Export failed. See the console for details.");
      } finally {
        setIsExporting(false);
      }
    },
    [fileBytes, doc, pageOrder, textEdits, imageOverlays, annotations, fileName],
  );

  // --- Upload / zoom / nav --------------------------------------------------
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);
  const openImagePicker = useCallback(() => imageInputRef.current?.click(), []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void loadFile(file);
    e.target.value = "";
  };

  const handleImageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void addImage(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = Array.from(e.dataTransfer.files).find((f) => f.type === "application/pdf");
    if (file) void loadFile(file);
  };

  const zoomIn = () => setScale((s) => clampScale(s * ZOOM_STEP));
  const zoomOut = () => setScale((s) => clampScale(s / ZOOM_STEP));
  const zoomReset = () => setScale(1);
  const fitWidth = () => {
    if (mainRef.current && firstPageSize) {
      setScale(clampScale((mainRef.current.clientWidth - 48) / firstPageSize.width));
    }
  };

  const selectPage = (slotIndex: number) => {
    setActivePage(slotIndex);
    viewerApiRef.current?.scrollToPage(slotIndex);
  };

  const ready = status === "ready" && doc && pageOrder.length > 0;

  return (
    <div className="flex h-screen flex-col bg-neutral-100 text-neutral-900">
      <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleInputChange} />
      <input ref={imageInputRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={handleImageInputChange} />

      <Toolbar
        fileName={fileName}
        numPages={pageOrder.length}
        activePage={activePage}
        scale={scale}
        hasDoc={!!ready}
        editMode={editMode}
        editCount={Object.keys(textEdits).length}
        isExporting={isExporting}
        onUploadClick={openFilePicker}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomReset={zoomReset}
        onFitWidth={fitWidth}
        onToggleTextMode={() => setMode(editMode === "text" ? "view" : "text")}
        onToggleImageMode={() => setMode(editMode === "image" ? "view" : "image")}
        onToggleAnnotateMode={() => setMode(editMode === "annotate" ? "view" : "annotate")}
        onAddImage={openImagePicker}
        onExport={handleExport}
      />

      {editMode === "annotate" && ready && (
        <AnnotationToolbar
          tool={annotationTool}
          color={annotationColor}
          strokeWidth={annotationWidth}
          onToolChange={setAnnotationTool}
          onColorChange={setAnnotationColor}
          onWidthChange={setAnnotationWidth}
          onUndo={undoAnnotation}
          onClearPage={clearPageAnnotations}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {ready && (
          <ThumbnailSidebar
            doc={doc}
            pageOrder={pageOrder}
            activePage={activePage}
            onSelectPage={selectPage}
            onReorder={reorderPages}
            onDeletePage={deletePage}
            onAddBlankPage={addBlankPage}
          />
        )}

        <div
          ref={mainRef}
          className="relative min-w-0 flex-1"
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          {ready ? (
            <PdfViewer
              doc={doc}
              scale={scale}
              editMode={editMode}
              pageOrder={pageOrder}
              textEdits={textEdits}
              onCommitTextEdit={commitTextEdit}
              onRemoveTextEdit={removeTextEdit}
              images={imageOverlays}
              selectedImageId={selectedImageId}
              onSelectImage={setSelectedImageId}
              onChangeImage={changeImage}
              onDeleteImage={deleteImage}
              annotations={annotations}
              annotationTool={annotationTool}
              annotationColor={annotationColor}
              annotationWidth={annotationWidth}
              onAddAnnotation={addAnnotation}
              apiRef={viewerApiRef}
              onActivePageChange={setActivePage}
            />
          ) : (
            <EmptyState status={status} error={error} isDragging={isDragging} onUploadClick={openFilePicker} />
          )}

          {editMode !== "view" && ready && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full bg-neutral-900/90 px-4 py-1.5 text-sm text-white shadow-lg">
              {editMode === "text"
                ? "Click any text to edit · Enter to save · Esc to cancel"
                : editMode === "image"
                  ? "Add an image, then drag to move · drag the corner to resize · trash to delete"
                  : "Draw on the page · pick a tool, colour and width above"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface EmptyStateProps {
  status: ReturnType<typeof usePdfDocument>["status"];
  error: string | null;
  isDragging: boolean;
  onUploadClick: () => void;
}

function EmptyState({ status, error, isDragging, onUploadClick }: EmptyStateProps) {
  if (status === "loading") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-500">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p>Loading PDF…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <button
        onClick={onUploadClick}
        className={cn(
          "flex w-full max-w-md flex-col items-center gap-3 rounded-xl border-2 border-dashed p-12 text-center transition-colors",
          isDragging ? "border-blue-500 bg-blue-50" : "border-neutral-300 bg-white hover:border-neutral-400",
        )}
      >
        <FileUp className="h-10 w-10 text-blue-600" />
        <span className="text-lg font-medium text-neutral-800">Drop a PDF here, or click to browse</span>
        <span className="text-sm text-neutral-500">Everything stays in your browser — nothing is uploaded.</span>
        {status === "error" && (
          <span className="mt-2 rounded-md bg-red-50 px-3 py-1.5 text-sm text-red-600">
            {error ?? "Could not open that file."}
          </span>
        )}
      </button>
    </div>
  );
}
