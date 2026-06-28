// JNI binding to the prebuilt PDFium engine — Phase 0: openDoc + renderPage (arm64-v8a first).
// See docs/object-editing-architecture.md. The editing methods (listObjects/setMatrix/...) follow
// in later steps; this file currently wires document loading and page rasterisation only.

#include <jni.h>
#include <android/bitmap.h>
#include <android/log.h>

#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "fpdf_edit.h"
#include "fpdf_save.h"
#include "fpdf_text.h"
#include "fpdfview.h"

#define LOG_TAG "PdfEngine"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// Pairs the document handle with the in-memory PDF bytes. FPDF_LoadMemDocument does NOT copy its
// input buffer, so the bytes must outlive the document; we own the copy here and free it on close.
struct DocHandle {
    FPDF_DOCUMENT doc;
    void* bytes;
};

extern "C" {

JNIEXPORT void JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeInit(JNIEnv*, jclass) {
    FPDF_InitLibrary();
    LOGI("PDFium library initialised");
}

JNIEXPORT jlong JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeOpenDocument(JNIEnv* env, jclass, jbyteArray data) {
    const jsize len = env->GetArrayLength(data);
    if (len <= 0) return 0;
    void* copy = malloc(static_cast<size_t>(len));
    if (!copy) return 0;
    env->GetByteArrayRegion(data, 0, len, reinterpret_cast<jbyte*>(copy));

    FPDF_DOCUMENT doc = FPDF_LoadMemDocument(copy, static_cast<int>(len), nullptr);
    if (!doc) {
        LOGE("FPDF_LoadMemDocument failed, err=%lu", FPDF_GetLastError());
        free(copy);
        return 0;
    }
    auto* handle = new DocHandle{doc, copy};
    return reinterpret_cast<jlong>(handle);
}

JNIEXPORT jint JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeGetPageCount(JNIEnv*, jclass, jlong handle) {
    auto* h = reinterpret_cast<DocHandle*>(handle);
    if (!h || !h->doc) return 0;
    return FPDF_GetPageCount(h->doc);
}

JNIEXPORT jlong JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeLoadPage(JNIEnv*, jclass, jlong handle, jint index) {
    auto* h = reinterpret_cast<DocHandle*>(handle);
    if (!h || !h->doc) return 0;
    FPDF_PAGE page = FPDF_LoadPage(h->doc, index);
    return reinterpret_cast<jlong>(page);
}

JNIEXPORT jdouble JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeGetPageWidth(JNIEnv*, jclass, jlong pagePtr) {
    auto page = reinterpret_cast<FPDF_PAGE>(pagePtr);
    if (!page) return 0;
    return FPDF_GetPageWidth(page);
}

JNIEXPORT jdouble JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeGetPageHeight(JNIEnv*, jclass, jlong pagePtr) {
    auto page = reinterpret_cast<FPDF_PAGE>(pagePtr);
    if (!page) return 0;
    return FPDF_GetPageHeight(page);
}

JNIEXPORT jboolean JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeRenderPage(JNIEnv* env, jclass, jlong pagePtr,
                                                            jobject bitmap) {
    auto page = reinterpret_cast<FPDF_PAGE>(pagePtr);
    if (!page) return JNI_FALSE;

    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS) {
        LOGE("AndroidBitmap_getInfo failed");
        return JNI_FALSE;
    }
    if (info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
        LOGE("Unexpected bitmap format %d (need RGBA_8888)", info.format);
        return JNI_FALSE;
    }

    void* pixels = nullptr;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS) {
        LOGE("AndroidBitmap_lockPixels failed");
        return JNI_FALSE;
    }

    const int w = static_cast<int>(info.width);
    const int h = static_cast<int>(info.height);

    // Render straight into the Android bitmap's own buffer. PDFium's BGRA format lays out bytes as
    // B,G,R,A; Android RGBA_8888 expects R,G,B,A — so after rendering we swap the R/B byte per pixel.
    FPDF_BITMAP bmp = FPDFBitmap_CreateEx(w, h, FPDFBitmap_BGRA, pixels, static_cast<int>(info.stride));
    FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xFFFFFFFF);
    FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, FPDF_ANNOT);
    FPDFBitmap_Destroy(bmp);

    auto* base = reinterpret_cast<uint8_t*>(pixels);
    for (int y = 0; y < h; ++y) {
        uint8_t* row = base + static_cast<size_t>(y) * info.stride;
        for (int x = 0; x < w; ++x) {
            uint8_t* px = row + static_cast<size_t>(x) * 4;
            const uint8_t t = px[0];
            px[0] = px[2];
            px[2] = t;
        }
    }

    AndroidBitmap_unlockPixels(env, bitmap);
    return JNI_TRUE;
}

// Enumerate a page's editable objects as a flat double[] with stride 11 per object:
// [type, left, bottom, right, top, a, b, c, d, e, f]. Bounds are PDF points (lower-left origin),
// matrix is FPDFPageObj_GetMatrix [a..f]. Returns an empty array for a page with no objects.
JNIEXPORT jdoubleArray JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeGetObjects(JNIEnv* env, jclass, jlong pagePtr) {
    auto page = reinterpret_cast<FPDF_PAGE>(pagePtr);
    if (!page) return nullptr;

    int count = FPDFPage_CountObjects(page);
    if (count < 0) count = 0;

    constexpr int stride = 11;
    std::vector<jdouble> buf(static_cast<size_t>(count) * stride, 0.0);

    for (int i = 0; i < count; ++i) {
        FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, i);
        jdouble* row = buf.data() + static_cast<size_t>(i) * stride;
        if (!obj) continue;  // type stays 0 (unknown)

        row[0] = static_cast<jdouble>(FPDFPageObj_GetType(obj));

        float left = 0, bottom = 0, right = 0, top = 0;
        if (FPDFPageObj_GetBounds(obj, &left, &bottom, &right, &top)) {
            row[1] = left;
            row[2] = bottom;
            row[3] = right;
            row[4] = top;
        }

        FS_MATRIX m;
        if (FPDFPageObj_GetMatrix(obj, &m)) {
            row[5] = m.a;
            row[6] = m.b;
            row[7] = m.c;
            row[8] = m.d;
            row[9] = m.e;
            row[10] = m.f;
        }
    }

    jdoubleArray arr = env->NewDoubleArray(static_cast<jsize>(buf.size()));
    if (!arr) return nullptr;
    if (!buf.empty()) {
        env->SetDoubleArrayRegion(arr, 0, static_cast<jsize>(buf.size()), buf.data());
    }
    return arr;
}

JNIEXPORT void JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeClosePage(JNIEnv*, jclass, jlong pagePtr) {
    auto page = reinterpret_cast<FPDF_PAGE>(pagePtr);
    if (page) FPDF_ClosePage(page);
}

// ---- editing ops --------------------------------------------------------------------------------
// Each loads the page by index, mutates the object by index, regenerates the page content stream
// (so the change is persisted into the document) and closes the page. Re-render to see the result;
// changes are included by nativeSaveDocument.

JNIEXPORT jboolean JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeTransformObject(JNIEnv*, jclass, jlong handle,
        jint pageIndex, jint objIndex,
        jdouble a, jdouble b, jdouble c, jdouble d, jdouble e, jdouble f) {
    auto* h = reinterpret_cast<DocHandle*>(handle);
    if (!h || !h->doc) return JNI_FALSE;
    FPDF_PAGE page = FPDF_LoadPage(h->doc, pageIndex);
    if (!page) return JNI_FALSE;
    jboolean ok = JNI_FALSE;
    FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, objIndex);
    if (obj) {
        FPDFPageObj_Transform(obj, a, b, c, d, e, f);
        FPDFPage_GenerateContent(page);
        ok = JNI_TRUE;
    }
    FPDF_ClosePage(page);
    return ok;
}

JNIEXPORT jboolean JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeSetFillColor(JNIEnv*, jclass, jlong handle,
        jint pageIndex, jint objIndex, jint r, jint g, jint b, jint a) {
    auto* h = reinterpret_cast<DocHandle*>(handle);
    if (!h || !h->doc) return JNI_FALSE;
    FPDF_PAGE page = FPDF_LoadPage(h->doc, pageIndex);
    if (!page) return JNI_FALSE;
    jboolean ok = JNI_FALSE;
    FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, objIndex);
    if (obj) {
        FPDFPageObj_SetFillColor(obj, (unsigned int) r, (unsigned int) g, (unsigned int) b, (unsigned int) a);
        FPDFPage_GenerateContent(page);
        ok = JNI_TRUE;
    }
    FPDF_ClosePage(page);
    return ok;
}

JNIEXPORT jboolean JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeSetText(JNIEnv* env, jclass, jlong handle,
        jint pageIndex, jint objIndex, jstring text) {
    auto* h = reinterpret_cast<DocHandle*>(handle);
    if (!h || !h->doc) return JNI_FALSE;
    FPDF_PAGE page = FPDF_LoadPage(h->doc, pageIndex);
    if (!page) return JNI_FALSE;
    jboolean ok = JNI_FALSE;
    FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, objIndex);
    if (obj) {
        const jchar* chars = env->GetStringChars(text, nullptr);
        const jsize len = env->GetStringLength(text);
        std::vector<unsigned short> buf(static_cast<size_t>(len) + 1, 0);  // UTF-16LE, null-terminated
        for (jsize i = 0; i < len; ++i) buf[i] = chars[i];
        env->ReleaseStringChars(text, chars);
        if (FPDFText_SetText(obj, reinterpret_cast<FPDF_WIDESTRING>(buf.data()))) {
            FPDFPage_GenerateContent(page);
            ok = JNI_TRUE;
        }
    }
    FPDF_ClosePage(page);
    return ok;
}

// Inspect a text object's font and return the best matching bundled-face id for substitution, e.g.
// "arimo-bold", "tinos", "carlito-italic", "mono". The id = family + style suffix; the family is a
// METRIC-COMPATIBLE open clone of the original (Arial→Arimo, Times→Tinos, Calibri→Carlito,
// Courier→mono/Cousine) so a substituted edit looks ~identical. Style comes from the font's flags /
// weight / italic-angle and its (subset-stripped) name. Returns "sans" when it can't tell.
JNIEXPORT jstring JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeGetTextFace(JNIEnv* env, jclass, jlong handle,
        jint pageIndex, jint objIndex) {
    std::string face = "sans";
    auto* h = reinterpret_cast<DocHandle*>(handle);
    if (h && h->doc) {
        FPDF_PAGE page = FPDF_LoadPage(h->doc, pageIndex);
        if (page) {
            FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, objIndex);
            if (obj && FPDFPageObj_GetType(obj) == FPDF_PAGEOBJ_TEXT) {
                FPDF_FONT font = FPDFTextObj_GetFont(obj);
                if (font) {
                    char nameBuf[256] = {0};
                    FPDFFont_GetBaseFontName(font, nameBuf, sizeof(nameBuf));
                    std::string name(nameBuf);
                    for (char& c : name) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
                    int flags = FPDFFont_GetFlags(font);
                    int weight = FPDFFont_GetWeight(font);
                    int italicAngle = 0;
                    FPDFFont_GetItalicAngle(font, &italicAngle);
                    auto has = [&](const char* s) { return name.find(s) != std::string::npos; };

                    bool fixedPitch = (flags & 1) != 0;      // PDF FontDescriptor flag bits
                    bool serifFlag = (flags & 2) != 0;
                    bool italicFlag = (flags & 64) != 0;
                    bool forceBold = (flags & (1 << 18)) != 0;
                    bool bold = forceBold || weight >= 600 || has("bold") || has("black") ||
                                has("heavy") || has("semibold");
                    bool italic = italicFlag || italicAngle != 0 || has("italic") || has("oblique");
                    bool mono = fixedPitch || has("mono") || has("courier") || has("consol") || has("cousine");
                    bool serif = !mono && (serifFlag || has("times") || has("serif") || has("roman") ||
                                 has("georgia") || has("minion") || has("garamond") || has("tinos") ||
                                 has("cambria") || has("book antiqua") || has("palatino"));

                    std::string fam;
                    if (mono) fam = "mono";                                          // Cousine (Courier metric)
                    else if (has("times") || has("tinos")) fam = "tinos";            // Times metric
                    else if (has("calibri") || has("carlito")) fam = "carlito";      // Calibri metric
                    else if (has("arial") || has("helvetica") || has("arimo") || has("liberation sans")) fam = "arimo";
                    else if (serif) fam = "tinos";                                   // generic serif → Times clone
                    else fam = "arimo";                                             // generic sans  → Arial clone

                    std::string suffix;
                    if (bold && italic) suffix = "-bolditalic";
                    else if (bold) suffix = "-bold";
                    else if (italic) suffix = "-italic";
                    face = fam + suffix;
                }
            }
            FPDF_ClosePage(page);
        }
    }
    return env->NewStringUTF(face.c_str());
}

// Replace a text object's string IN PLACE. We must avoid the ".notdef boxes" trap: the object's
// embedded font is usually a SUBSET containing only the glyphs that object already uses, so
// FPDFText_SetText can "succeed" yet render empty boxes for any character the subset lacks (e.g.
// changing case, or adding a new letter — "HİZMETE ÖZEL" → "Hizmete Bedir" loses every lowercase).
// So we keep the embedded font ONLY when every character of the new text already appears in the
// object's ORIGINAL text (then it is certainly in the subset); otherwise we SUBSTITUTE with the
// bundled full TTF in fontBytes, preserving size/matrix/colour. r/g/b/a < 0 keeps the original fill
// colour. Returns the (possibly new) object index, or -1 on failure.
JNIEXPORT jint JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeReplaceText(JNIEnv* env, jclass, jlong handle,
        jint pageIndex, jint objIndex, jstring text, jbyteArray fontBytes,
        jint r, jint g, jint b, jint a) {
    auto* h = reinterpret_cast<DocHandle*>(handle);
    if (!h || !h->doc) return -1;
    FPDF_PAGE page = FPDF_LoadPage(h->doc, pageIndex);
    if (!page) return -1;

    jint result = -1;
    FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, objIndex);
    if (obj) {
        const jchar* chars = env->GetStringChars(text, nullptr);
        const jsize tlen = env->GetStringLength(text);
        std::vector<unsigned short> buf(static_cast<size_t>(tlen) + 1, 0);  // UTF-16, null-terminated
        for (jsize i = 0; i < tlen; ++i) buf[i] = chars[i];
        env->ReleaseStringChars(text, chars);
        auto* wide = reinterpret_cast<FPDF_WIDESTRING>(buf.data());

        // Read the object's original text so we can tell whether its (subset) font covers the new
        // glyphs. Covered == every new code unit already appeared in the original string.
        std::vector<unsigned short> orig;
        FPDF_TEXTPAGE tp = FPDFText_LoadPage(page);
        if (tp) {
            unsigned long olen = FPDFTextObj_GetText(obj, tp, nullptr, 0);  // count incl. terminator
            if (olen > 0) {
                orig.assign(olen, 0);
                FPDFTextObj_GetText(obj, tp, reinterpret_cast<FPDF_WCHAR*>(orig.data()), olen);
            }
            FPDFText_ClosePage(tp);
        }
        bool covered = !orig.empty();
        for (jsize i = 0; i < tlen && covered; ++i) {
            unsigned short ch = buf[i];
            if (ch == 0) continue;
            bool found = false;
            for (unsigned short oc : orig) if (oc == ch) { found = true; break; }
            if (!found) covered = false;
        }

        bool substitute = !covered;
        if (!substitute) {
            // Every glyph is in the subset → keep the original typeface (best fidelity).
            if (FPDFText_SetText(obj, wide)) {
                FPDFPage_GenerateContent(page);
                result = objIndex;  // object did not move
            } else {
                substitute = (fontBytes != nullptr);  // unexpected failure → fall back
            }
        }
        if (substitute && result < 0 && fontBytes != nullptr) {
            // Rebuild the text object with the supplied bundled TTF (a metric-compatible clone of the
            // original, chosen by nativeGetTextFace). Because the clone shares the original's metrics,
            // copying the original font size + text matrix reproduces the SAME size/position — no
            // box-fitting needed; only the (missing-glyph) typeface differs, and the clone matches it.
            const jsize flen = env->GetArrayLength(fontBytes);
            jbyte* fdata = env->GetByteArrayElements(fontBytes, nullptr);
            if (fdata && flen > 0) {
                // cid=1 → load as a CID/Type0 font (2-byte, full Unicode). cid=0 is a simple
                // single-byte font (≤256 chars) and mangles Turkish (>U+00FF) AND drops spaces once
                // the run contains any such char, so it MUST be 1 here.
                FPDF_FONT font = FPDFText_LoadFont(h->doc, reinterpret_cast<const uint8_t*>(fdata),
                        static_cast<uint32_t>(flen), FPDF_FONT_TRUETYPE, /*cid*/ 1);
                if (font) {
                    float fontSize = 12.0f;
                    FPDFTextObj_GetFontSize(obj, &fontSize);
                    if (!(fontSize > 0)) fontSize = 12.0f;
                    FS_MATRIX m;
                    bool haveM = FPDFPageObj_GetMatrix(obj, &m);
                    unsigned int orr = 0, og = 0, ob = 0, oa = 255;
                    FPDFPageObj_GetFillColor(obj, &orr, &og, &ob, &oa);

                    FPDF_PAGEOBJECT nt = FPDFPageObj_CreateTextObj(h->doc, font, fontSize);
                    if (nt && FPDFText_SetText(nt, wide)) {
                        if (haveM) FPDFPageObj_SetMatrix(nt, &m);
                        unsigned int fr = (r >= 0) ? (unsigned int) r : orr;
                        unsigned int fg = (g >= 0) ? (unsigned int) g : og;
                        unsigned int fb = (b >= 0) ? (unsigned int) b : ob;
                        unsigned int fa = (a >= 0) ? (unsigned int) a : (oa ? oa : 255);
                        FPDFPageObj_SetFillColor(nt, fr, fg, fb, fa);
                        if (FPDFPage_RemoveObject(page, obj)) FPDFPageObj_Destroy(obj);
                        result = FPDFPage_CountObjects(page);  // appended -> this index
                        FPDFPage_InsertObject(page, nt);
                        FPDFPage_GenerateContent(page);
                    } else if (nt) {
                        FPDFPageObj_Destroy(nt);  // not inserted -> we still own it
                    }
                    FPDFFont_Close(font);  // doc keeps its own reference once embedded
                }
            }
            if (fdata) env->ReleaseByteArrayElements(fontBytes, fdata, JNI_ABORT);
        }
    }
    FPDF_ClosePage(page);
    return result;
}

JNIEXPORT jboolean JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeDeleteObject(JNIEnv*, jclass, jlong handle,
        jint pageIndex, jint objIndex) {
    auto* h = reinterpret_cast<DocHandle*>(handle);
    if (!h || !h->doc) return JNI_FALSE;
    FPDF_PAGE page = FPDF_LoadPage(h->doc, pageIndex);
    if (!page) return JNI_FALSE;
    jboolean ok = JNI_FALSE;
    FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, objIndex);
    if (obj && FPDFPage_RemoveObject(page, obj)) {
        FPDFPageObj_Destroy(obj);  // RemoveObject detaches but does not free
        FPDFPage_GenerateContent(page);
        ok = JNI_TRUE;
    }
    FPDF_ClosePage(page);
    return ok;
}

// FPDF_FILEWRITE sink that appends the saved bytes to a vector (fw must be the first member).
struct ByteSink {
    FPDF_FILEWRITE fw;
    std::vector<uint8_t>* out;
};
static int WriteBlockToVector(FPDF_FILEWRITE* pThis, const void* data, unsigned long size) {
    auto* sink = reinterpret_cast<ByteSink*>(pThis);
    const uint8_t* p = static_cast<const uint8_t*>(data);
    sink->out->insert(sink->out->end(), p, p + size);
    return 1;
}

// Change Z-order: remove the object and re-insert it at the front (append) or back (index 0).
// Returns the object's new index, or -1 on failure.
JNIEXPORT jint JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeReorderObject(JNIEnv*, jclass, jlong handle,
        jint pageIndex, jint objIndex, jboolean toFront) {
    auto* h = reinterpret_cast<DocHandle*>(handle);
    if (!h || !h->doc) return -1;
    FPDF_PAGE page = FPDF_LoadPage(h->doc, pageIndex);
    if (!page) return -1;
    jint newIndex = -1;
    const int count = FPDFPage_CountObjects(page);
    FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, objIndex);
    if (obj && FPDFPage_RemoveObject(page, obj)) {
        if (toFront) {
            FPDFPage_InsertObject(page, obj);  // append = painted last = on top
            newIndex = count - 1;
        } else {
            FPDFPage_InsertObjectAtIndex(page, obj, 0);  // index 0 = painted first = at back
            newIndex = 0;
        }
        FPDFPage_GenerateContent(page);
    }
    FPDF_ClosePage(page);
    return newIndex;
}

// Add a new image object from raw RGBA pixels at matrix [a,b,c,d,e,f] (used for duplicate).
// Returns the new object's index, or -1 on failure.
JNIEXPORT jint JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeAddImage(JNIEnv* env, jclass, jlong handle,
        jint pageIndex, jbyteArray rgba, jint w, jint h,
        jdouble a, jdouble b, jdouble c, jdouble d, jdouble e, jdouble f) {
    auto* hh = reinterpret_cast<DocHandle*>(handle);
    if (!hh || !hh->doc || w <= 0 || h <= 0) return -1;
    FPDF_PAGE page = FPDF_LoadPage(hh->doc, pageIndex);
    if (!page) return -1;

    jint newIndex = -1;
    FPDF_PAGEOBJECT img = FPDFPageObj_NewImageObj(hh->doc);
    FPDF_BITMAP bmp = FPDFBitmap_CreateEx(w, h, FPDFBitmap_BGRA, nullptr, 0);
    if (img && bmp) {
        auto* dst = static_cast<uint8_t*>(FPDFBitmap_GetBuffer(bmp));
        const int stride = FPDFBitmap_GetStride(bmp);
        jbyte* src = env->GetByteArrayElements(rgba, nullptr);
        const jsize srcLen = env->GetArrayLength(rgba);
        if (dst && src && srcLen >= static_cast<jsize>(w) * h * 4) {
            const auto* s0 = reinterpret_cast<const uint8_t*>(src);
            for (int y = 0; y < h; ++y) {
                for (int x = 0; x < w; ++x) {
                    const uint8_t* s = s0 + (static_cast<size_t>(y) * w + x) * 4;       // RGBA
                    uint8_t* dp = dst + static_cast<size_t>(y) * stride + static_cast<size_t>(x) * 4;  // BGRA
                    dp[0] = s[2];
                    dp[1] = s[1];
                    dp[2] = s[0];
                    dp[3] = s[3];
                }
            }
        }
        if (src) env->ReleaseByteArrayElements(rgba, src, JNI_ABORT);
        FPDFImageObj_SetBitmap(nullptr, 0, img, bmp);
        FS_MATRIX m = { static_cast<float>(a), static_cast<float>(b), static_cast<float>(c),
                        static_cast<float>(d), static_cast<float>(e), static_cast<float>(f) };
        FPDFPageObj_SetMatrix(img, &m);
        newIndex = FPDFPage_CountObjects(page);  // appended -> this index
        FPDFPage_InsertObject(page, img);
        FPDFPage_GenerateContent(page);
    }
    if (bmp) FPDFBitmap_Destroy(bmp);
    FPDF_ClosePage(page);
    return newIndex;
}

JNIEXPORT jbyteArray JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeSaveDocument(JNIEnv* env, jclass, jlong handle) {
    auto* h = reinterpret_cast<DocHandle*>(handle);
    if (!h || !h->doc) return nullptr;
    std::vector<uint8_t> out;
    ByteSink sink;
    sink.fw.version = 1;
    sink.fw.WriteBlock = WriteBlockToVector;
    sink.out = &out;
    if (!FPDF_SaveAsCopy(h->doc, &sink.fw, FPDF_NO_INCREMENTAL)) return nullptr;
    jbyteArray arr = env->NewByteArray(static_cast<jsize>(out.size()));
    if (!arr) return nullptr;
    if (!out.empty()) {
        env->SetByteArrayRegion(arr, 0, static_cast<jsize>(out.size()), reinterpret_cast<const jbyte*>(out.data()));
    }
    return arr;
}

JNIEXPORT void JNICALL
Java_com_armitorenk_pdfeditor_PdfiumBridge_nativeCloseDocument(JNIEnv*, jclass, jlong handle) {
    auto* h = reinterpret_cast<DocHandle*>(handle);
    if (!h) return;
    if (h->doc) FPDF_CloseDocument(h->doc);
    free(h->bytes);
    delete h;
}

}  // extern "C"
