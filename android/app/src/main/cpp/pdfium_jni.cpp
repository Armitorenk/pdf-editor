// JNI binding to the prebuilt PDFium engine — Phase 0: openDoc + renderPage (arm64-v8a first).
// See docs/object-editing-architecture.md. The editing methods (listObjects/setMatrix/...) follow
// in later steps; this file currently wires document loading and page rasterisation only.

#include <jni.h>
#include <android/bitmap.h>
#include <android/log.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "fpdf_edit.h"
#include "fpdf_save.h"
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
