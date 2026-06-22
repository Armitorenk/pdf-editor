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

    /** Free a loaded page. */
    static native void nativeClosePage(long page);

    /** Close a document handle and free its backing bytes. */
    static native void nativeCloseDocument(long handle);
}
