package com.armitorenk.pdfeditor;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Native PDF object-editing engine (PDFium FPDFEdit API) — Phase 0 skeleton.
 *
 * This wires up the Capacitor bridge so the WebView UI can call into native; the actual PDFium
 * JNI binding is added in the next step (see docs/object-editing-architecture.md). Methods
 * currently return stub data / reject, so the bridge can be verified end-to-end first.
 */
@CapacitorPlugin(name = "PdfEngine")
public class PdfEnginePlugin extends Plugin {

    /** Load a document from base64 bytes; resolve the page count. */
    @PluginMethod
    public void openDoc(PluginCall call) {
        // TODO(Phase 0+1): base64 -> bytes -> FPDF_LoadMemDocument; return FPDF_GetPageCount.
        JSObject ret = new JSObject();
        ret.put("pages", 0);
        call.resolve(ret);
    }

    /** Rasterise a page for display under the editing overlay. */
    @PluginMethod
    public void renderPage(PluginCall call) {
        // TODO(Phase 0+1): FPDF_LoadPage + FPDF_RenderPageBitmap -> PNG (base64).
        call.reject("renderPage: PDFium binding not wired yet (Phase 0 stub)");
    }

    /** List a page's editable objects, Z-ordered. */
    @PluginMethod
    public void listObjects(PluginCall call) {
        // TODO(Phase 0+1): FPDFPage_CountObjects / FPDFPage_GetObject / FPDFPageObj_GetType
        //                  / FPDFPageObj_GetBounds / FPDFPageObj_GetMatrix.
        JSObject ret = new JSObject();
        ret.put("objects", new JSArray());
        call.resolve(ret);
    }

    /** Release the open document and free native memory. */
    @PluginMethod
    public void closeDoc(PluginCall call) {
        // TODO(Phase 0+1): FPDF_ClosePage / FPDF_CloseDocument.
        call.resolve();
    }
}
