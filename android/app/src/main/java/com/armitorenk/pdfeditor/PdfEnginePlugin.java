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

    /** List a page's editable objects, Z-ordered (index = paint order). */
    @PluginMethod
    public void listObjects(PluginCall call) {
        Integer pageIndex = call.getInt("page");
        if (pageIndex == null) {
            call.reject("listObjects: missing 'page'");
            return;
        }
        synchronized (this) {
            if (docHandle == 0) {
                call.reject("listObjects: no open document");
                return;
            }
            long page = PdfiumBridge.nativeLoadPage(docHandle, pageIndex);
            if (page == 0) {
                call.reject("listObjects: failed to load page " + pageIndex);
                return;
            }
            try {
                double[] flat = PdfiumBridge.nativeGetObjects(page);
                JSArray objects = new JSArray();
                if (flat != null) {
                    final int stride = 11;
                    for (int i = 0; i + stride <= flat.length; i += stride) {
                        JSObject o = new JSObject();
                        o.put("id", i / stride);
                        o.put("type", typeName((int) flat[i]));
                        JSArray bounds = new JSArray();
                        for (int k = 1; k <= 4; k++) bounds.put((Object) flat[i + k]);
                        o.put("bounds", bounds);
                        JSArray matrix = new JSArray();
                        for (int k = 5; k <= 10; k++) matrix.put((Object) flat[i + k]);
                        o.put("matrix", matrix);
                        objects.put(o);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("objects", objects);
                call.resolve(ret);
            } finally {
                PdfiumBridge.nativeClosePage(page);
            }
        }
    }

    /** Map FPDF_PAGEOBJ_* to the TS PdfObjectType string. */
    private static String typeName(int type) {
        switch (type) {
            case 1: return "text";
            case 2: return "path";
            case 3: return "image";
            case 4: return "shading";
            case 5: return "form";
            default: return "unknown";
        }
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
