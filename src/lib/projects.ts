import type { Annotation, ImageOverlay, PageRef, TextEdit } from "./pdf/types";

/**
 * Local project storage (IndexedDB). Lets the user keep an uploaded PDF + all their
 * edits on the device, reopen later to continue, and delete when done. Works the
 * same in the browser and inside the Android (Capacitor) WebView — no server.
 *
 * Two stores: `meta` (tiny — for the library list) and `blobs` (the full project,
 * including the original PDF bytes). Listing reads only `meta`, so it stays fast
 * even with large PDFs.
 */

const DB_NAME = "pdf-editor";
const DB_VERSION = 1;
const META = "meta";
const BLOBS = "blobs";

/** Lightweight record for the library list. */
export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  pageCount: number;
  thumbnail?: string; // small JPEG data URL of page 1
}

/** Full project payload restored when a project is opened. */
export interface LoadedProject {
  id: string;
  pdfBytes: Uint8Array;
  pageOrder: PageRef[];
  textEdits: Record<string, TextEdit>;
  images: ImageOverlay[];
  annotations: Annotation[];
}

/** Everything needed to persist a project (current editor state). */
export interface SaveInput extends Omit<LoadedProject, "id"> {
  id: string;
  name: string;
  pageCount: number;
  thumbnail?: string;
}

// Images are stored without their session-only object URL (`src`), recreated on load.
type StoredImage = Omit<ImageOverlay, "src">;
interface StoredBlob {
  id: string;
  pdfBytes: Uint8Array;
  pageOrder: PageRef[];
  textEdits: Record<string, TextEdit>;
  images: StoredImage[];
  annotations: Annotation[];
}

const available = () => typeof indexedDB !== "undefined";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** All saved projects, newest first. */
export async function listProjects(): Promise<ProjectMeta[]> {
  if (!available()) return [];
  const db = await openDb();
  try {
    const all = await reqToPromise(db.transaction(META, "readonly").objectStore(META).getAll());
    return (all as ProjectMeta[]).sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    db.close();
  }
}

/** Create or update a project. Returns the saved metadata. */
export async function saveProject(input: SaveInput): Promise<ProjectMeta> {
  if (!available()) throw new Error("Storage unavailable");
  const meta: ProjectMeta = {
    id: input.id,
    name: input.name,
    updatedAt: Date.now(),
    pageCount: input.pageCount,
    thumbnail: input.thumbnail,
  };
  const blob: StoredBlob = {
    id: input.id,
    pdfBytes: input.pdfBytes,
    pageOrder: input.pageOrder,
    textEdits: input.textEdits,
    images: input.images.map((im) => ({
      id: im.id,
      pageId: im.pageId,
      x: im.x,
      y: im.y,
      width: im.width,
      height: im.height,
      bytes: im.bytes,
      format: im.format,
      aspect: im.aspect,
    })),
    annotations: input.annotations,
  };

  const db = await openDb();
  try {
    const t = db.transaction([META, BLOBS], "readwrite");
    t.objectStore(META).put(meta);
    t.objectStore(BLOBS).put(blob);
    await txDone(t);
    return meta;
  } finally {
    db.close();
  }
}

/** Load a full project, recreating image object URLs. */
export async function loadProject(id: string): Promise<LoadedProject | null> {
  if (!available()) return null;
  const db = await openDb();
  try {
    const rec = (await reqToPromise(db.transaction(BLOBS, "readonly").objectStore(BLOBS).get(id))) as
      | StoredBlob
      | undefined;
    if (!rec) return null;
    const images: ImageOverlay[] = rec.images.map((im) => ({
      ...im,
      src: URL.createObjectURL(new Blob([im.bytes as BlobPart], { type: im.format === "png" ? "image/png" : "image/jpeg" })),
    }));
    return {
      id: rec.id,
      pdfBytes: rec.pdfBytes,
      pageOrder: rec.pageOrder,
      textEdits: rec.textEdits,
      images,
      annotations: rec.annotations,
    };
  } finally {
    db.close();
  }
}

/** Delete a project (both stores). */
export async function deleteProject(id: string): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  try {
    const t = db.transaction([META, BLOBS], "readwrite");
    t.objectStore(META).delete(id);
    t.objectStore(BLOBS).delete(id);
    await txDone(t);
  } finally {
    db.close();
  }
}
