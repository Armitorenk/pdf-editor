"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { usePdfDocument } from "@/hooks/usePdfDocument";
import { cn } from "@/lib/utils";
import { saveFile } from "@/lib/save";
import { exportPdf } from "@/lib/pdf/export";
import { extractText, imagesToZip, pdfToImages, type ExportFormat } from "@/lib/pdf/convert";
import { liftRegion, solidColorPng } from "@/lib/pdf/lift";
import { buildFontStyleMap, type FontStyleInfo } from "@/lib/pdf/fontStyles";
import {
  deleteProject,
  listProjects,
  loadProject,
  saveProject,
  type ProjectMeta,
} from "@/lib/projects";
import { domRectToPdfRect, type Rect } from "@/lib/pdf/coordinates";
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
import { MobileToolbar } from "./MobileToolbar";
import { AnnotationToolbar } from "./AnnotationToolbar";
import { ThumbnailSidebar } from "./ThumbnailSidebar";
import { ProjectLibrary } from "./ProjectLibrary";
import { PdfViewer, type ViewerApi } from "./PdfViewer";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.25;
const DEFAULT_SCALE = 1.2;
const A4: PageSize = { width: 595.28, height: 841.89 };

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** The full editable state, snapshotted for undo/redo. */
interface EditSnapshot {
  pageOrder: PageRef[];
  textEdits: Record<string, TextEdit>;
  imageOverlays: ImageOverlay[];
  annotations: Annotation[];
}

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
  const [pagesOpen, setPagesOpen] = useState(false); // mobile pages drawer

  const [editMode, setEditMode] = useState<EditMode>("view");
  const [pageOrder, setPageOrder] = useState<PageRef[]>([]);
  const [textEdits, setTextEdits] = useState<Record<string, TextEdit>>({});
  const [imageOverlays, setImageOverlays] = useState<ImageOverlay[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("pen");
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [annotationColor, setAnnotationColor] = useState("#ef4444");
  const [annotationWidth, setAnnotationWidth] = useState(2);
  const [isExporting, setIsExporting] = useState(false);

  // --- Project library / persistence ---
  const [projectId, setProjectId] = useState<string | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const viewerApiRef = useRef<ViewerApi | null>(null);

  // Undo/redo history (see the Undo / redo section below for how these are used).
  const pastRef = useRef<EditSnapshot[]>([]);
  const futureRef = useRef<EditSnapshot[]>([]);
  const presentRef = useRef<EditSnapshot | null>(null);
  const applyingRef = useRef(false); // true while a setter batch comes from undo/redo
  const epochRef = useRef(0); // bumped per document so each load starts a fresh baseline
  const recordedEpochRef = useRef(-1);
  const [histVersion, setHistVersion] = useState(0); // forces re-render for can-undo/redo
  // Holds saved state to apply once a reopened project's pdf.js doc has loaded.
  const restoreRef = useRef<{
    pageOrder: PageRef[];
    textEdits: Record<string, TextEdit>;
    images: ImageOverlay[];
    annotations: Annotation[];
  } | null>(null);

  const { doc, numPages, status, error } = usePdfDocument(fileBytes);

  // Parse the document's font metadata once (FontDescriptor flags / italic angle /
  // weight) so text edits can detect the original run's bold/italic/serif from the
  // PDF itself rather than guessing from pixels. See src/lib/pdf/fontStyles.ts.
  const [fontStyleMap, setFontStyleMap] = useState<Map<string, FontStyleInfo> | null>(null);
  useEffect(() => {
    if (!fileBytes) {
      setFontStyleMap(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { PDFDocument } = await import("pdf-lib");
        const d = await PDFDocument.load(fileBytes.slice(), { updateMetadata: false, ignoreEncryption: true });
        const map = buildFontStyleMap(d);
        if (!cancelled) setFontStyleMap(map);
      } catch {
        if (!cancelled) setFontStyleMap(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileBytes]);

  // Original (converted) font programs captured from edited runs, keyed by PostScript
  // name, so export can reuse the document's own font where it covers the new text.
  const originalFontsRef = useRef<Map<string, Uint8Array>>(new Map());
  const registerFont = useCallback((psName: string, data: Uint8Array) => {
    if (!originalFontsRef.current.has(psName)) originalFontsRef.current.set(psName, data);
  }, []);

  // When a document loads: restore a reopened project's saved edits, or build the
  // default page order (originals, in order) for a fresh upload.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const restore = restoreRef.current;
    restoreRef.current = null;
    if (restore) {
      setPageOrder(restore.pageOrder);
      setTextEdits(restore.textEdits);
      setImageOverlays(restore.images);
      setAnnotations(restore.annotations);
    } else {
      setPageOrder(
        Array.from({ length: doc.numPages }, (_, i) => ({
          id: `orig:${i}`,
          kind: "original" as const,
          originalIndex: i,
        })),
      );
    }
    (async () => {
      const { width, height } = (await doc.getPage(1)).getViewport({ scale: 1 });
      if (!cancelled) setFirstPageSize({ width, height });
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // Generate a page-1 thumbnail for the library whenever a document loads.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const v = page.getViewport({ scale: 200 / base.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(v.width);
      canvas.height = Math.ceil(v.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport: v }).promise;
      if (!cancelled) setThumbnail(canvas.toDataURL("image/jpeg", 0.6));
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // Refresh the library list on mount.
  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (err) {
      console.error("Failed to list projects:", err);
    }
  }, []);
  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  // Auto-save the open project (debounced) whenever its content changes.
  useEffect(() => {
    if (!projectId || !fileBytes || !doc) return;
    const handle = setTimeout(() => {
      void saveProject({
        id: projectId,
        name: fileName ?? "Untitled.pdf",
        pageCount: pageOrder.length,
        thumbnail: thumbnail ?? undefined,
        pdfBytes: fileBytes,
        pageOrder,
        textEdits,
        images: imageOverlays,
        annotations,
      })
        .then(refreshProjects)
        .catch((err) => console.error("Auto-save failed:", err));
    }, 800);
    return () => clearTimeout(handle);
  }, [projectId, fileBytes, doc, fileName, pageOrder, textEdits, imageOverlays, annotations, thumbnail, refreshProjects]);

  /** Reset all per-document state; `restore` carries saved edits for a reopen. */
  const resetEditorState = useCallback(() => {
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
    setSelectedAnnotationId(null);
    // New document -> fresh undo baseline (object URLs are only revoked here, never
    // on individual deletes, so an undone delete still has a live image src).
    epochRef.current += 1;
    pastRef.current = [];
    futureRef.current = [];
    presentRef.current = null;
    originalFontsRef.current = new Map(); // captured fonts belong to the old document
  }, []);

  const loadFile = useCallback(
    async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      restoreRef.current = null;
      resetEditorState();
      setFileName(file.name);
      setThumbnail(null);
      setProjectId(crypto.randomUUID()); // a fresh upload becomes a new project
      setFileBytes(bytes);
    },
    [resetEditorState],
  );

  /** Open a saved project: restore its edits once its document has loaded. */
  const openProject = useCallback(
    async (meta: ProjectMeta) => {
      const data = await loadProject(meta.id);
      if (!data) return;
      resetEditorState();
      restoreRef.current = {
        pageOrder: data.pageOrder,
        textEdits: data.textEdits,
        images: data.images,
        annotations: data.annotations,
      };
      setFileName(meta.name);
      setThumbnail(meta.thumbnail ?? null);
      setProjectId(meta.id);
      setFileBytes(data.pdfBytes);
    },
    [resetEditorState],
  );

  /** Close the open document and return to the library (auto-save already ran). */
  const closeProject = useCallback(() => {
    restoreRef.current = null;
    resetEditorState();
    setFileName(null);
    setThumbnail(null);
    setProjectId(null);
    setFileBytes(null);
    void refreshProjects();
  }, [resetEditorState, refreshProjects]);

  const handleDeleteProject = useCallback(
    async (id: string) => {
      await deleteProject(id);
      await refreshProjects();
    },
    [refreshProjects],
  );

  // Android hardware back button: step out of the current context instead of letting
  // the WebView send the whole app to the background. Drawer open -> close it; a
  // document open -> back to the library; already at the library -> exit the app.
  const backStateRef = useRef({ pagesOpen: false, hasProject: false });
  useEffect(() => {
    backStateRef.current = { pagesOpen, hasProject: fileBytes != null };
  }, [pagesOpen, fileBytes]);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let handle: { remove: () => void } | undefined;
    void (async () => {
      const { App } = await import("@capacitor/app");
      handle = await App.addListener("backButton", () => {
        const s = backStateRef.current;
        if (s.pagesOpen) {
          setPagesOpen(false);
        } else if (s.hasProject) {
          closeProject();
        } else {
          void App.exitApp();
        }
      });
    })();
    return () => handle?.remove();
  }, [closeProject]);

  /** Switch tools; object selections only matter within their own mode. */
  const setMode = useCallback((mode: EditMode) => {
    setEditMode(mode);
    if (mode !== "image") setSelectedImageId(null);
    if (mode !== "annotate") setSelectedAnnotationId(null);
  }, []);

  /** Pick the annotation tool; leaving "select" clears any current selection. */
  const pickAnnotationTool = useCallback((tool: AnnotationTool) => {
    setAnnotationTool(tool);
    if (tool !== "select") setSelectedAnnotationId(null);
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
    // Note: don't revoke the object URL here — an undo could restore this image and
    // would need a live src. URLs are revoked only on document switch (reset).
    setImageOverlays((prev) => prev.filter((im) => im.id !== id));
    setSelectedImageId((cur) => (cur === id ? null : cur));
  }, []);

  // --- Lift existing object -------------------------------------------------
  // Rasterise the boxed region of an ORIGINAL page into a movable image, and place
  // a solid cover (sampled page colour) underneath at the same spot so the original
  // appears "removed". Both overlays are added together -> one undo step. The user
  // lands in image mode with the lifted copy selected, ready to move/resize/delete.
  const liftObject = useCallback(
    async (pageId: string, pageNumber: number, pageHeight: number, domRect: Rect) => {
      if (!doc) return;
      try {
        const page = await doc.getPage(pageNumber);
        const pdfRect = domRectToPdfRect(domRect, pageHeight, scale);
        const { imageBytes, bgColor } = await liftRegion(page, pdfRect, pageHeight);
        const coverBytes = await solidColorPng(bgColor);
        const aspect = pdfRect.width / pdfRect.height;
        const geom = { pageId, x: pdfRect.x, y: pdfRect.y, width: pdfRect.width, height: pdfRect.height };
        const cover: ImageOverlay = {
          id: crypto.randomUUID(),
          ...geom,
          src: URL.createObjectURL(new Blob([coverBytes as BlobPart], { type: "image/png" })),
          bytes: coverBytes,
          format: "png",
          aspect,
        };
        const liftedId = crypto.randomUUID();
        const lifted: ImageOverlay = {
          id: liftedId,
          ...geom,
          src: URL.createObjectURL(new Blob([imageBytes as BlobPart], { type: "image/png" })),
          bytes: imageBytes,
          format: "png",
          aspect,
        };
        setImageOverlays((prev) => [...prev, cover, lifted]); // cover under lifted
        setEditMode("image");
        setSelectedImageId(liftedId);
      } catch (err) {
        console.error("Lift failed:", err);
        alert("Could not lift that region. See the console for details.");
      }
    },
    [doc, scale],
  );

  // --- Annotations ----------------------------------------------------------
  const addAnnotation = useCallback((ann: Annotation) => setAnnotations((prev) => [...prev, ann]), []);
  const undoAnnotation = useCallback(() => setAnnotations((prev) => prev.slice(0, -1)), []);
  const clearPageAnnotations = useCallback(() => {
    const ref = pageOrder[activePage];
    if (ref) setAnnotations((prev) => prev.filter((a) => a.pageId !== ref.id));
    setSelectedAnnotationId(null);
  }, [pageOrder, activePage]);

  const moveAnnotation = useCallback((id: string, dx: number, dy: number) => {
    setAnnotations((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        return a.kind === "pen"
          ? { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
          : { ...a, x: a.x + dx, y: a.y + dy };
      }),
    );
  }, []);

  const deleteAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setSelectedAnnotationId((cur) => (cur === id ? null : cur));
  }, []);

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
      // Keep object URLs alive (see deleteImage) so deleting a page is undoable.
      setImageOverlays((prev) => prev.filter((im) => im.pageId !== ref.id));
      setAnnotations((prev) => prev.filter((a) => a.pageId !== ref.id));
      setActivePage((p) => Math.min(p, pageOrder.length - 2));
    },
    [pageOrder],
  );

  /** Insert a blank page at `atIndex` (default: append at the end). */
  const addBlankPage = useCallback(
    (atIndex?: number) => {
      const size = firstPageSize ?? A4;
      const blank: PageRef = {
        id: `blank:${crypto.randomUUID()}`,
        kind: "blank",
        width: size.width,
        height: size.height,
      };
      setPageOrder((prev) => {
        const at = atIndex == null ? prev.length : Math.max(0, Math.min(atIndex, prev.length));
        const next = [...prev];
        next.splice(at, 0, blank);
        return next;
      });
    },
    [firstPageSize],
  );

  // --- Undo / redo ----------------------------------------------------------
  // A single snapshot history over all four edit state pieces. Every user edit
  // (including multi-field ones like deletePage, which batch into one render) lands
  // as one history entry; undo/redo replays a snapshot back into the four setters.
  // (History refs are declared up top so resetEditorState can clear them.)
  const applySnapshot = useCallback((s: EditSnapshot) => {
    applyingRef.current = true;
    setPageOrder(s.pageOrder);
    setTextEdits(s.textEdits);
    setImageOverlays(s.imageOverlays);
    setAnnotations(s.annotations);
  }, []);

  useEffect(() => {
    if (!(status === "ready" && doc && pageOrder.length > 0)) return;
    const next: EditSnapshot = { pageOrder, textEdits, imageOverlays, annotations };
    if (applyingRef.current) {
      applyingRef.current = false;
      presentRef.current = next;
      return;
    }
    if (recordedEpochRef.current !== epochRef.current) {
      // First stable snapshot of a freshly loaded/opened document: set the baseline,
      // no undo step before it.
      recordedEpochRef.current = epochRef.current;
      presentRef.current = next;
      pastRef.current = [];
      futureRef.current = [];
      setHistVersion((v) => v + 1);
      return;
    }
    if (presentRef.current) pastRef.current.push(presentRef.current);
    futureRef.current = [];
    presentRef.current = next;
    setHistVersion((v) => v + 1);
  }, [status, doc, pageOrder, textEdits, imageOverlays, annotations]);

  const undo = useCallback(() => {
    if (pastRef.current.length === 0) return;
    const prev = pastRef.current.pop()!;
    if (presentRef.current) futureRef.current.push(presentRef.current);
    presentRef.current = prev;
    applySnapshot(prev);
    setHistVersion((v) => v + 1);
  }, [applySnapshot]);

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const nxt = futureRef.current.pop()!;
    if (presentRef.current) pastRef.current.push(presentRef.current);
    presentRef.current = nxt;
    applySnapshot(nxt);
    setHistVersion((v) => v + 1);
  }, [applySnapshot]);

  void histVersion; // referenced so canUndo/canRedo recompute each change
  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  // Keyboard: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo. Ignored while
  // typing into a field (e.g. the inline text-edit input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

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
          await saveFile(`${base}.txt`, new Blob([text], { type: "text/plain;charset=utf-8" }));
          return;
        }

        const pdfBytes = await exportPdf(fileBytes, {
          pageOrder,
          textEdits: Object.values(textEdits),
          images: imageOverlays,
          annotations,
          originalFonts: originalFontsRef.current,
        });

        if (format === "pdf") {
          await saveFile(`${base}-edited.pdf`, new Blob([pdfBytes as BlobPart], { type: "application/pdf" }));
          return;
        }

        // png | jpeg: rasterise the edited PDF; one page saves directly, more than
        // one is bundled into a ZIP.
        const ext = format === "png" ? "png" : "jpg";
        const images = await pdfToImages(pdfBytes, format);
        if (images.length === 1) {
          await saveFile(`${base}.${ext}`, images[0].blob);
        } else {
          await saveFile(`${base}-${ext}.zip`, await imagesToZip(images));
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
        onToggleObjectMode={() => setMode(editMode === "object" ? "view" : "object")}
        onAddImage={openImagePicker}
        onExport={handleExport}
        onHome={closeProject}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
      />

      <MobileToolbar
        fileName={fileName}
        numPages={pageOrder.length}
        activePage={activePage}
        hasDoc={!!ready}
        editMode={editMode}
        editCount={Object.keys(textEdits).length}
        isExporting={isExporting}
        onUploadClick={openFilePicker}
        onOpenPages={() => setPagesOpen(true)}
        onSetMode={setMode}
        onExport={handleExport}
        onHome={closeProject}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
      />

      {editMode === "annotate" && ready && (
        <AnnotationToolbar
          tool={annotationTool}
          color={annotationColor}
          strokeWidth={annotationWidth}
          onToolChange={pickAnnotationTool}
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
            mobileOpen={pagesOpen}
            onCloseMobile={() => setPagesOpen(false)}
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
              onZoom={(s) => setScale(clampScale(s))}
              editMode={editMode}
              pageOrder={pageOrder}
              textEdits={textEdits}
              onCommitTextEdit={commitTextEdit}
              onRemoveTextEdit={removeTextEdit}
              fontStyleMap={fontStyleMap}
              onRegisterFont={registerFont}
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
              selectedAnnotationId={selectedAnnotationId}
              onSelectAnnotation={setSelectedAnnotationId}
              onMoveAnnotation={moveAnnotation}
              onDeleteAnnotation={deleteAnnotation}
              onLiftObject={liftObject}
              apiRef={viewerApiRef}
              onActivePageChange={setActivePage}
            />
          ) : status === "loading" ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-500">
              <Loader2 className="h-8 w-8 animate-spin" />
              <p>Loading PDF…</p>
            </div>
          ) : (
            <ProjectLibrary
              projects={projects}
              isDragging={isDragging}
              error={error}
              onOpenFile={openFilePicker}
              onOpenProject={openProject}
              onDeleteProject={handleDeleteProject}
            />
          )}

          {/* Verbose hint: desktop only (mobile uses the bottom controls / FAB). */}
          {editMode !== "view" && ready && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 hidden -translate-x-1/2 rounded-full bg-neutral-900/90 px-4 py-1.5 text-sm text-white shadow-lg md:block">
              {editMode === "text"
                ? "Click any text to edit · Enter to save · Esc to cancel"
                : editMode === "image"
                  ? "Add an image, then drag to move · drag a corner to resize · trash to delete"
                  : editMode === "object"
                    ? "Draw a box around an existing object to lift it — then move, resize or delete it"
                    : "Draw on the page · pick a tool, colour and width above"}
            </div>
          )}

          {/* Mobile object-mode hint (this mode is the least obvious by touch). */}
          {editMode === "object" && ready && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-full bg-neutral-900/90 px-4 py-1.5 text-center text-xs text-white shadow-lg md:hidden">
              Draw a box around an object to lift it
            </div>
          )}

          {/* Mobile-only: floating zoom pill + contextual "Add image" FAB. */}
          {ready && (
            <div
              className="absolute bottom-4 right-3 z-30 flex flex-col overflow-hidden rounded-full border border-neutral-200 bg-white shadow-lg md:hidden"
              style={{ marginBottom: "env(safe-area-inset-bottom)" }}
            >
              <button onClick={zoomIn} aria-label="Zoom in" className="flex h-12 w-12 items-center justify-center text-neutral-700 active:bg-neutral-100">
                <ZoomIn className="h-5 w-5" />
              </button>
              <button onClick={fitWidth} aria-label="Fit width" className="flex h-10 w-12 items-center justify-center border-y border-neutral-200 text-neutral-700 active:bg-neutral-100">
                <Maximize className="h-4 w-4" />
              </button>
              <button onClick={zoomOut} aria-label="Zoom out" className="flex h-12 w-12 items-center justify-center text-neutral-700 active:bg-neutral-100">
                <ZoomOut className="h-5 w-5" />
              </button>
            </div>
          )}

          {editMode === "image" && ready && (
            <button
              onClick={openImagePicker}
              className="absolute bottom-5 left-1/2 z-30 flex h-12 -translate-x-1/2 items-center gap-2 rounded-full bg-blue-600 px-5 font-medium text-white shadow-lg active:bg-blue-700 md:hidden"
              style={{ marginBottom: "env(safe-area-inset-bottom)" }}
            >
              <ImagePlus className="h-5 w-5" />
              Add image
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

