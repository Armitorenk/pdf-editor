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

    /** Apply an affine transform [a,b,c,d,e,f] to an object (move/scale/rotate). */
    @PluginMethod
    public void transformObject(PluginCall call) {
        Integer page = call.getInt("page");
        Integer index = call.getInt("index");
        if (page == null || index == null) {
            call.reject("transformObject: missing page/index");
            return;
        }
        double a = call.getDouble("a", 1.0), b = call.getDouble("b", 0.0), c = call.getDouble("c", 0.0);
        double d = call.getDouble("d", 1.0), e = call.getDouble("e", 0.0), f = call.getDouble("f", 0.0);
        synchronized (this) {
            if (docHandle == 0) { call.reject("transformObject: no open document"); return; }
            if (PdfiumBridge.nativeTransformObject(docHandle, page, index, a, b, c, d, e, f)) call.resolve();
            else call.reject("transformObject: failed");
        }
    }

    /** Set an object's fill colour from a "#rrggbb" string. */
    @PluginMethod
    public void setObjectColor(PluginCall call) {
        Integer page = call.getInt("page");
        Integer index = call.getInt("index");
        String hex = call.getString("color");
        if (page == null || index == null || hex == null) {
            call.reject("setObjectColor: missing page/index/color");
            return;
        }
        int[] rgb = parseHex(hex);
        synchronized (this) {
            if (docHandle == 0) { call.reject("setObjectColor: no open document"); return; }
            if (PdfiumBridge.nativeSetFillColor(docHandle, page, index, rgb[0], rgb[1], rgb[2], 255)) call.resolve();
            else call.reject("setObjectColor: failed");
        }
    }

    /** Replace a text object's string (kept in its existing font; limited by the font's glyphs). */
    @PluginMethod
    public void setObjectText(PluginCall call) {
        Integer page = call.getInt("page");
        Integer index = call.getInt("index");
        String text = call.getString("text");
        if (page == null || index == null || text == null) {
            call.reject("setObjectText: missing page/index/text");
            return;
        }
        synchronized (this) {
            if (docHandle == 0) { call.reject("setObjectText: no open document"); return; }
            if (PdfiumBridge.nativeSetText(docHandle, page, index, text)) call.resolve();
            else call.reject("setObjectText: failed (font may not cover the new characters)");
        }
    }

    /** Delete an object from a page. Object indices shift afterwards — re-list on the JS side. */
    @PluginMethod
    public void deleteObject(PluginCall call) {
        Integer page = call.getInt("page");
        Integer index = call.getInt("index");
        if (page == null || index == null) {
            call.reject("deleteObject: missing page/index");
            return;
        }
        synchronized (this) {
            if (docHandle == 0) { call.reject("deleteObject: no open document"); return; }
            if (PdfiumBridge.nativeDeleteObject(docHandle, page, index)) call.resolve();
            else call.reject("deleteObject: failed");
        }
    }

    /** Move an object to front/back (Z-order); resolves the object's new index. */
    @PluginMethod
    public void reorderObject(PluginCall call) {
        Integer page = call.getInt("page");
        Integer index = call.getInt("index");
        Boolean toFront = call.getBoolean("toFront", true);
        if (page == null || index == null) {
            call.reject("reorderObject: missing page/index");
            return;
        }
        synchronized (this) {
            if (docHandle == 0) { call.reject("reorderObject: no open document"); return; }
            int ni = PdfiumBridge.nativeReorderObject(docHandle, page, index, toFront != null && toFront);
            if (ni < 0) { call.reject("reorderObject: failed"); return; }
            JSObject ret = new JSObject();
            ret.put("index", ni);
            call.resolve(ret);
        }
    }

    /** Add an image object from base64 RGBA pixels (used to duplicate); resolves its index. */
    @PluginMethod
    public void addImage(PluginCall call) {
        Integer page = call.getInt("page");
        String rgbaB64 = call.getString("rgba");
        Integer w = call.getInt("width");
        Integer h = call.getInt("height");
        if (page == null || rgbaB64 == null || w == null || h == null) {
            call.reject("addImage: missing page/rgba/width/height");
            return;
        }
        double a = call.getDouble("a", 1.0), b = call.getDouble("b", 0.0), c = call.getDouble("c", 0.0);
        double d = call.getDouble("d", 1.0), e = call.getDouble("e", 0.0), f = call.getDouble("f", 0.0);
        byte[] rgba;
        try {
            rgba = Base64.decode(rgbaB64, Base64.DEFAULT);
        } catch (IllegalArgumentException ex) {
            call.reject("addImage: invalid rgba base64", ex);
            return;
        }
        synchronized (this) {
            if (docHandle == 0) { call.reject("addImage: no open document"); return; }
            int ni = PdfiumBridge.nativeAddImage(docHandle, page, rgba, w, h, a, b, c, d, e, f);
            if (ni < 0) { call.reject("addImage: failed"); return; }
            JSObject ret = new JSObject();
            ret.put("index", ni);
            call.resolve(ret);
        }
    }

    /** Serialise the edited document to base64 PDF bytes. */
    @PluginMethod
    public void saveDocument(PluginCall call) {
        synchronized (this) {
            if (docHandle == 0) { call.reject("saveDocument: no open document"); return; }
            byte[] bytes = PdfiumBridge.nativeSaveDocument(docHandle);
            if (bytes == null) { call.reject("saveDocument: failed"); return; }
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(ret);
        }
    }

    /** Parse "#rrggbb" (or "rrggbb") into [r,g,b]; falls back to black. */
    private static int[] parseHex(String hex) {
        try {
            String s = hex.startsWith("#") ? hex.substring(1) : hex;
            if (s.length() == 3) {
                s = "" + s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
            }
            int v = Integer.parseInt(s, 16);
            return new int[] { (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF };
        } catch (Exception e) {
            return new int[] { 0, 0, 0 };
        }
    }
}
