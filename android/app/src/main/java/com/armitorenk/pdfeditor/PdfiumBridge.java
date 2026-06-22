package com.armitorenk.pdfeditor;

import android.graphics.Bitmap;

/**
 * Thin JNI binding to the prebuilt PDFium engine (libpdfengine.so, which links libpdfium.so).
 * Handles are opaque native pointers passed as {@code long}; see cpp/pdfium_jni.cpp.
 */
final class PdfiumBridge {

    static {
        // libpdfengine declares libpdfium as a dependency; load it first to be explicit.
        System.loadLibrary("pdfium");
        System.loadLibrary("pdfengine");
    }

    private PdfiumBridge() {}

    /** Initialise the PDFium library once per process. */
    static native void nativeInit();

    /** Load a document from bytes; returns a DocHandle pointer, or 0 on failure. */
    static native long nativeOpenDocument(byte[] data);

    /** Page count for an open document handle. */
    static native int nativeGetPageCount(long handle);

    /** Load a page; returns an FPDF_PAGE pointer, or 0 on failure. Close with {@link #nativeClosePage}. */
    static native long nativeLoadPage(long handle, int index);

    /** Page width in PDF points. */
    static native double nativeGetPageWidth(long page);

    /** Page height in PDF points. */
    static native double nativeGetPageHeight(long page);

    /** Render a loaded page into an ARGB_8888 bitmap sized to the desired output; true on success. */
    static native boolean nativeRenderPage(long page, Bitmap bitmap);

    /**
     * Enumerate a page's editable objects as a flat array, 11 doubles per object:
     * [type, left, bottom, right, top, a, b, c, d, e, f]. Empty array if none.
     */
    static native double[] nativeGetObjects(long page);

    /** Free a loaded page. */
    static native void nativeClosePage(long page);

    // --- editing ops (page + object by index; regenerate content; persist into the document) ---
    /** Pre-multiply the object's matrix by [a,b,c,d,e,f] (move/scale/rotate). */
    static native boolean nativeTransformObject(long handle, int pageIndex, int objIndex,
            double a, double b, double c, double d, double e, double f);
    /** Set the object's fill colour (0–255). */
    static native boolean nativeSetFillColor(long handle, int pageIndex, int objIndex, int r, int g, int b, int a);
    /** Replace a text object's string (kept in the object's existing font). */
    static native boolean nativeSetText(long handle, int pageIndex, int objIndex, String text);
    /** Remove the object from the page. */
    static native boolean nativeDeleteObject(long handle, int pageIndex, int objIndex);
    /** Serialise the (edited) document to PDF bytes. */
    static native byte[] nativeSaveDocument(long handle);

    /** Close a document handle and free its backing bytes. */
    static native void nativeCloseDocument(long handle);
}
