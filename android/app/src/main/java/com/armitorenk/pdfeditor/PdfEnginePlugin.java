package com.armitorenk.pdfeditor;

import android.graphics.Bitmap;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;

/**
 * Native PDF object-editing engine (PDFium) — Phase 0: openDoc + renderPage wired to PDFium via
 * {@link PdfiumBridge}. listObjects / editing methods follow in later steps
 * (see docs/object-editing-architecture.md).
 */
@CapacitorPlugin(name = "PdfEngine")
public class PdfEnginePlugin extends Plugin {

    /** Open PDFium document handle (DocHandle*); 0 when no document is open. */
    private long docHandle = 0;

    @Override
    public void load() {
        PdfiumBridge.nativeInit();
    }

    /** Load a document from base64 bytes; resolve the page count. */
    @PluginMethod
    public void openDoc(PluginCall call) {
        String b64 = call.getString("data");
        if (b64 == null) {
            call.reject("openDoc: missing 'data'");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(b64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("openDoc: invalid base64", e);
            return;
        }
        synchronized (this) {
            if (docHandle != 0) {
                PdfiumBridge.nativeCloseDocument(docHandle);
                docHandle = 0;
            }
            long handle = PdfiumBridge.nativeOpenDocument(bytes);
            if (handle == 0) {
                call.reject("openDoc: failed to parse PDF");
                return;
            }
            docHandle = handle;
            JSObject ret = new JSObject();
            ret.put("pages", PdfiumBridge.nativeGetPageCount(handle));
            call.resolve(ret);
        }
    }

    /** Rasterise a page at `scale` (default 1 = 72dpi) for display under the editing overlay. */
    @PluginMethod
    public void renderPage(PluginCall call) {
        Integer pageIndex = call.getInt("page");
        if (pageIndex == null) {
            call.reject("renderPage: missing 'page'");
            return;
        }
        double scale = call.getDouble("scale", 1.0);
        if (scale <= 0) scale = 1.0;

        synchronized (this) {
            if (docHandle == 0) {
                call.reject("renderPage: no open document");
                return;
            }
            long page = PdfiumBridge.nativeLoadPage(docHandle, pageIndex);
            if (page == 0) {
                call.reject("renderPage: failed to load page " + pageIndex);
                return;
            }
            try {
                double pageWidth = PdfiumBridge.nativeGetPageWidth(page);
                double pageHeight = PdfiumBridge.nativeGetPageHeight(page);
                int width = Math.max(1, (int) Math.round(pageWidth * scale));
                int height = Math.max(1, (int) Math.round(pageHeight * scale));

                Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                boolean ok = PdfiumBridge.nativeRenderPage(page, bitmap);
                if (!ok) {
                    bitmap.recycle();
                    call.reject("renderPage: native render failed");
                    return;
                }

                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, baos);
                bitmap.recycle();

                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP));
                ret.put("width", width);
                ret.put("height", height);
                ret.put("pageWidth", pageWidth);
                ret.put("pageHeight", pageHeight);
                call.resolve(ret);
            } finally {
                PdfiumBridge.nativeClosePage(page);
            }
        }
    }

    /** List a page's editable objects, Z-ordered. */
    @PluginMethod
    public void listObjects(PluginCall call) {
        // TODO(next step): FPDFPage_CountObjects / FPDFPage_GetObject / FPDFPageObj_GetType
        //                  / FPDFPageObj_GetBounds / FPDFPageObj_GetMatrix.
        JSObject ret = new JSObject();
        ret.put("objects", new JSArray());
        call.resolve(ret);
    }

    /** Release the open document and free native memory. */
    @PluginMethod
    public void closeDoc(PluginCall call) {
        synchronized (this) {
            if (docHandle != 0) {
                PdfiumBridge.nativeCloseDocument(docHandle);
                docHandle = 0;
            }
        }
        call.resolve();
    }
}
