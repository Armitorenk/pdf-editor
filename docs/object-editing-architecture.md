# PDF Nesne Düzenleme Motoru — Mimari Tasarım

> Durum: **TASARIM** (implementasyon öncesi). Foxit "Edit Object" benzeri gerçek nesne
> düzenleme için yol haritası ve teknik karar belgesi.

## 0. Bağlam & Mevcut Durum

Bu uygulama şu an **Capacitor/WebView** mimarisinde: Next.js (React) UI + `pdf.js` (render)
+ `pdf-lib` (yazma) + tamamen client-side. Mevcut "nesne düzenleme" özelliği `ObjectLayer.tsx`
/ `lift.ts` ile **"lift" (rasterize)** yapıyor: seçili bölgeyi PNG'ye çevirip overlay olarak
taşıyor. Bu **gerçek** bir nesne düzenleme değil — orijinal vektör/metin objesi değişmiyor,
sadece üstüne raster bindiriliyor.

**Sınır:** `pdf.js` content stream'i **yazamaz**, `pdf-lib` ise yeni obje **ekleyebilir**
ama mevcut bir text/path objesini **yerinde düzenleyemez**. Yani Foxit-tarzı "mevcut metni/
şekli/görseli düzenle" için web stack'i yetersiz → **native bir PDF nesne motoru** gerekiyor.

---

## 1. Gereksinimler

### 1.1 Nesne tipleri ve düzenlemeler
| Tip | Düzenlemeler |
|-----|-------------|
| **Text** | satır-içi düzenleme, font değiştir, boyut, renk, hizalama |
| **Image** | değiştir, sil, taşı, yeniden boyutlandır, döndür, kırp |
| **Shape/Path** | stroke kalınlığı, fill rengi, köşe (vertex) düzenleme |
| **Genel** | Z-index (öne/arkaya), grup/grubu boz, sil, kopyala |

### 1.2 Mobil UX
- **Touch target:** bounding-box köşe/rotate tutamakları min **48×48 dp**.
- **Gesture:** tek dokunuş=seç, çift dokunuş=metin düzenleme, iki parmak=pan+pinch,
  basılı-tut-sürükle=taşı.
- **Floating toolbar:** nesne seçilince üstünde/altında beliren **yatay, kaydırılabilir**
  yüzen araç çubuğu (Kopyala / Sil / Düzenle / Renk / Öne-Arkaya). Üstte/altta sabit
  karmaşık menü YOK.

---

## 2. Neden PDFium?

PDF sayfası bir **content stream**'dir: operatör dizisi —
`BT … Tj … ET` (metin), `q … /Im0 Do … Q` (görsel/XObject), `m l c re … f/S` (path), CTM
matrisleri (`cm`), renk operatörleri (`rg/RG/k/K`) vb. Bu ham stream'i elle parse edip
düzenlemek **çok kırılgandır** (her PDF farklı üretilmiş, nested Form XObject'ler, encoding,
font subset'leri…). Mevcut uygulamanın "lift" yaklaşımını seçmesinin sebebi tam buydu.

**PDFium**, ham stream yerine **page-object düzeyinde** çalışan bir API (`FPDFEdit`) sunar:
objeleri enumerate et → tip/matris/renk/bounds al-ver → sil/ekle/sırala → `FPDFPage_GenerateContent`
ile stream'i **PDFium yeniden yazar**. Yani content-stream cerrahisini PDFium soyutlar.

- PDFium = Chrome ve Android'in dahili PDF motoru → en olgun, ücretsiz, BSD lisans.
- Ticari alternatifler (turnkey ama lisanslı/ücretli): **Foxit SDK**, **PSPDFKit / Nutrient**.

---

## 3. PDFium Edit API — nesne tipine göre eşleme

> Başlıklar PDFium C API (`fpdf_edit.h`, `fpdf_text.h`, `fpdf_save.h`).

### 3.1 Genel (her nesne)
- `FPDFPage_CountObjects(page)` / `FPDFPage_GetObject(page, i)` → enumerate.
- `FPDFPageObj_GetType(obj)` → `TEXT | IMAGE | PATH | SHADING | FORM`.
- `FPDFPageObj_GetBounds(obj, &l,&b,&r,&t)` → seçim/bounding box.
- `FPDFPageObj_GetMatrix / SetMatrix(obj, a,b,c,d,e,f)` → **taşı / ölçekle / döndür** (tek API).
- `FPDFPage_RemoveObject(page, obj)` → sil.  `FPDFPage_InsertObject(page, obj)` → ekle.
- `FPDFPage_GenerateContent(page)` → stream'i yeniden üret (her düzenleme sonrası).
- `FPDF_SaveAsCopy / FPDF_SaveWithVersion` → kaydet.

### 3.2 Text
- Okuma: `FPDFTextObj_GetText`, `FPDFTextObj_GetFontSize`, `FPDFTextObj_GetFont`.
- Oluştur/yaz: `FPDFPageObj_NewTextObj(doc, font, size)`, `FPDFText_SetText(obj, wstr)`.
- Font: `FPDFText_LoadFont` (gömülü/TTF) veya `FPDFText_LoadStandardFont`.
- Renk: `FPDFPageObj_SetFillColor(obj, r,g,b,a)`.
- ⚠️ **Sınır:** mevcut bir metin run'ının string'ini *yerinde* değiştirme sınırlıdır
  (font subset'i yeni karakteri içermeyebilir, reflow yok). Pratik strateji: orijinal text
  objesini sil → aynı matris/font/renk ile **yeni** text objesi ekle (gerekirse fontu yeniden
  embed et). Foxit dahil tüm motorlarda bu kısım kısıtlıdır.

### 3.3 Image
- Değiştir: `FPDFImageObj_SetBitmap(pages,count,obj,bitmap)` veya `FPDFImageObj_LoadJpegFileInline`.
- Oku: `FPDFImageObj_GetBitmap` / `GetRenderedBitmap`.
- Taşı/boyut/döndür: `FPDFPageObj_SetMatrix` (image objeleri 1×1 birim kareye matris ile oturur).
- Kırp: native "crop" yok → ya **clip path** uygula ya da **cropped bitmap** ile `SetBitmap`.

### 3.4 Shape / Path
- Oluştur: `FPDFPageObj_CreateNewPath(x,y)` / `FPDFPageObj_CreateNewRect`.
- Vertex: `FPDFPath_MoveTo / LineTo / BezierTo / Close`; segment okuma `FPDFPath_CountSegments`,
  `FPDFPath_GetPathSegment`, `FPDFPathSegment_GetPoint/GetType` → **köşe düzenleme** = segment'leri
  oku, ilgili noktayı güncelle, path'i yeniden kur.
- Stroke/fill: `FPDFPageObj_SetStrokeColor`, `FPDFPageObj_SetStrokeWidth`, `FPDFPageObj_SetFillColor`,
  `FPDFPath_SetDrawMode(obj, fill, stroke)`.

### 3.5 Z-index & Grup
- **Z-order** = sayfadaki obje sırası = çizim sırası. Doğrudan "indeksi taşı" API'si garanti
  değil → pratikte **remove + doğru konuma yeniden ekle** ile yönetilir (veya tüm obje listesi
  kopyalanıp sırayla yeniden insert edilir).
- **Grup**: PDF'te birinci sınıf "group" yok. Seçenekler: (a) UI seviyesinde sanal grup +
  transformları birlikte uygula; (b) gerçek gruplama gerekiyorsa Form XObject (`/Fm`) içine sar.
  Öneri: **UI-seviyesi grup** (basit, yeterli).

---

## 4. Mimari Seçenekleri (KARAR)

### Seçenek A — **Hibrit: Capacitor + Native PDFium Plugin** ⭐ (önerilen)
Mevcut React UI'yi (cilaladığımız touch/typografi yatırımı) **koru**, motoru native'e taşı.

```
┌─────────────────────────── Capacitor App ───────────────────────────┐
│  WebView (mevcut React UI)                                           │
│   • PDFium'un render ettiği sayfa bitmap'ini gösterir               │
│   • Üstünde: bounding-box + 48dp handle + gesture + floating toolbar │
│        (mevcut ObjectLayer/ImageLayer/coordinates.ts mantığı genişler)│
│            │  JS ↔ native köprü (Capacitor plugin metodları)          │
│  ┌─────────▼──────────── Android Plugin (Kotlin) ──────────────────┐ │
│  │  JNI → PDFium (prebuilt .so, FPDFEdit API)                       │ │
│  │  metodlar: openDoc, renderPage(bitmap), listObjects,            │ │
│  │   getObject, setMatrix, setColor, setStroke, setText,           │ │
│  │   replaceImage, deleteObject, reorder, save                     │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```
- **Artı:** mevcut UI/UX yatırımı korunur; tek native modül; iOS'a da Capacitor plugin ile genişler.
- **Eksi:** WebView↔native köprü gecikmesi (sayfa bitmap'i ve obje meta transferi). Çözüm: bitmap'i
  blob/`Filesystem` üzerinden ver, sadece obje **meta**'sını (id, bounds, tip, matris) JSON ile geçir;
  render'ı debounce et.

### Seçenek B — **Full Native: Kotlin/Compose + PDFium (JNI)**
- En performanslı/temiz. Compose `Canvas` + `pointerInput` ile overlay & gesture.
- **Eksi:** React UI'yi sıfırdan yazmak demek (cilaladığımız her şey gider).

### Seçenek C — **Flutter + PDFium (dart:ffi)**
- `dart:ffi` ile **doğrudan** PDFium C API (JNI gerekmez). `CustomPaint` + `GestureDetector`
  ile overlay. Cross-platform (iOS ücretsiz gelir).
- **Eksi:** yine sıfırdan UI; ekip Flutter'a geçmeli.

**Öneri:** Mevcut Capacitor app + cilalı UI göz önüne alınınca **A (Hibrit)**. "Sıfırdan, maksimum
performans, iOS de" hedefi varsa **C (Flutter + FFI)** en zarif rewrite yolu.

---

## 5. PDFium'u Android'e getirme
- **bblanchon/pdfium-binaries**: prebuilt `.so` + header'lar, **TAM API (edit dahil)** — PDFium'u
  kendin derlemene gerek yok. (Yaygın `PdfiumAndroid` wrapper'ları sadece **render** açar, edit
  fonksiyonlarını expose etmez — o yüzden ince bir JNI/FFI binding yazılır.)
- Seçenek A/B → ince **JNI** binding.  Seçenek C → **dart:ffi** ile doğrudan.

---

## 6. Veri akışı (her düzenleme)
```
openDoc → renderPage→bitmap → UI overlay (seç/transform/edit)
      → native edit op (SetMatrix/SetColor/SetText/Replace/Delete/Reorder)
      → FPDFPage_GenerateContent → renderPage (güncel bitmap) → UI yenile
      → (bitiş) FPDF_SaveAsCopy
```
- **Koordinat:** ekran(px) ↔ PDF(point) dönüşümü + zoom/pan matrisi (mevcut `coordinates.ts`
  DOM↔PDF mantığı genişletilir; PDFium matrisi `[a b c d e f]` ile birebir eşlenir).
- **Undo/redo:** her edit op'u tersinir komut olarak sakla (mevcut undo/redo altyapısı genişler).

---

## 7. Yol haritası (fazlar)
- **Faz 0** — PDFium plugin iskeleti: openDoc + renderPage(bitmap) + `listObjects` (tip+bounds+matris).
- **Faz 1** — Seçim + bounding box + **move/scale/rotate** (tek `SetMatrix`). 48dp handle + gesture.
- **Faz 2** — **Image**: replace / delete / crop.
- **Faz 3** — **Path/Shape**: stroke/fill/width + vertex düzenleme.
- **Faz 4** — **Text**: renk/boyut/font; string edit (sil+yeni-obje stratejisi, sınırlarıyla).
- **Faz 5** — Z-order, grup (UI-seviyesi), floating toolbar, undo/redo, save.

---

## 8. Riskler & sınırlar
- **Text reflow / mevcut metni yerinde düzenleme** her motorda (Foxit dahil) kısıtlı: font subset,
  encoding, embedding. Strateji: sil→yeni-obje + gerekirse font re-embed.
- **WebView↔native köprü** (Seçenek A): büyük sayfa bitmap'i transferi → blob + debounce ile yönet.
- **PDFium edit API edge-case'leri**: native crop yok (clip/bitmap ile), z-order doğrudan taşıma yok
  (remove+insert), grup yok (UI-seviyesi).
- **Mevcut "lift" özelliği** bu motorla **kademeli olarak değiştirilir** (gerçek obje düzenleme,
  rasterize değil).

---

## 9. Sonraki adım
Karar: **Seçenek A (Hibrit)** ile devam → Faz 0 (PDFium Capacitor plugin iskeleti + render +
`listObjects`). Onaylanırsa plugin iskeleti + JNI binding ile başlanır.
