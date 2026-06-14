/**
 * AI Menu Import — استيراد منيو من صورة بـ AI متعدد العقول
 *
 * 🧠 3 عقول تعمل بالتوازي:
 *   عقل 1: Vision Extractor — يقرأ الصورة ويستخرج البنية (Groq Llama Vision)
 *   عقل 2: Schema Refiner   — يحوّل النص لـ JSON منظم + ينظف الأخطاء
 *   عقل 3: Diff Reconciler  — يقارن بالمنيو الحالي → new/updated/unchanged
 *
 * يدعم: PNG / JPG / WebP (حتى 4 MB)
 * النموذج: meta-llama/llama-4-scout (Groq) — أفضل دقة عربية حالياً
 */

const GROQ_KEY = process.env.GROQ_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

let sharp; try { sharp = require("sharp"); } catch {}

const VISION_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
];
const TEXT_MODEL = "llama-3.3-70b-versatile";
const TEXT_FALLBACK = "llama-3.1-8b-instant";

const AI_TIMEOUT_MS = 45_000;

// ════════════════════════════════════════════════════════════════════
// 🧠 العقل 1: Vision Extractor — يقرأ الصورة
// ════════════════════════════════════════════════════════════════════
async function _callVision(imageDataUrl, model, temperature = 0.1, ctx = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
`أنت محلّل صور خبير في قراءة منيو المطاعم والكافيهات بالعربية والإنجليزية.
استخرج كل العناصر بدقة فائقة من الصورة.

${ctx.businessType ? `🎯 *نوع النشاط:* ${ctx.businessType}${ctx.storeName ? " — " + ctx.storeName : ""}` : ""}
${ctx.existingCategories?.length ? `📂 *الأقسام الموجودة في المتجر:*\n${ctx.existingCategories.map(c => `  - ${c.name}`).join("\n")}\n⚠️ استخدم نفس هذه الأسماء بدقة لو ظهر منتج مطابق` : ""}

${ctx.imageWidth ? `📏 *أبعاد الصورة:* ${ctx.imageWidth} × ${ctx.imageHeight} pixel
🖼️ *مهم:* لكل منتج له صورة مرئية في المنيو، أضف "image_bbox": {"x": رقم, "y": رقم, "w": رقم, "h": رقم}
   - الإحداثيات بالـ pixel، يبدأ (0,0) أعلى يسار الصورة
   - x = الحافة اليسرى، y = الحافة العلوية، w = العرض، h = الارتفاع
   - **مهم:** ضع image_bbox فقط لو فعلاً ترى صورة للمنتج. لو نص فقط → اتركها null
   - دقيقاً قدر الإمكان — لا توسّع الـ bbox على نص بجانبها` : ""}

الناتج JSON فقط بالشكل:
{
  "language": "ar | en | mixed",
  "currency_hint": "ر.س | ج.م | $ | د.أ | (الذي تراه في الصورة)",
  "categories": [
    {
      "name": "اسم القسم",
      "items": [
        {
          "name": "اسم المنتج كما هو بالضبط",
          "price": رقم (بدون عملة، 0 لو غير واضح),
          "description": "الوصف لو موجود، وإلا فارغ",
          "confidence": "high | medium | low"
        }
      ]
    }
  ]
}

قواعد صارمة:
1. استخرج كل صنف وفئة موجود — لا تتخطى شيئاً
2. إذا السعر غير واضح، ضع 0 و confidence: "low"
3. حافظ على ترتيب المنيو من الأعلى للأسفل
4. **القسم يجب أن يكون موجوداً فعلاً في الصورة كعنوان واضح** — لا تخترع أقسام (لا "متنوع"، لا "إضافات" إن لم تظهر)
5. **لا تنشئ قسم لا يخص النشاط** — لو نشاطك "كافيه" لا تنشئ "فطائر/مخبوزات" إلا لو ظاهر صراحة كقسم في الصورة
6. لو القسم غير مكتوب لكن المنتجات متشابهة (3+ مشروبات متتالية)، أنشئ قسم منطقياً بسيطاً
7. لا تخترع منتجات ولا أسعار غير موجودة
8. أرقام عربية أو إنجليزية → ارجع رقم إنجليزي
9. النص بنفس لغته (لا تترجم)
10. حاول استخدام نفس أسماء الأقسام الموجودة لو ظهر منتج مطابق`,
          },
          {
            role: "user",
            content: [
              { type: "text", text: "اقرأ صورة المنيو هذه واستخرج كل التفاصيل في JSON دقيق:" },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`vision HTTP ${res.status} ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// 3 محاولات بنماذج/temperatures مختلفة → نأخذ الأفضل (majority + ثقة)
async function brain1_extractFromImage(imageDataUrl, ctx = {}) {
  const attempts = await Promise.allSettled([
    _callVision(imageDataUrl, VISION_MODELS[0], 0.0, ctx),
    _callVision(imageDataUrl, VISION_MODELS[0], 0.2, ctx),
    _callVision(imageDataUrl, VISION_MODELS[1], 0.1, ctx),
  ]);

  const ok = attempts.filter(a => a.status === "fulfilled").map(a => a.value);
  const errors = attempts.filter(a => a.status === "rejected").map(a => a.reason?.message || "?");
  console.log(`[brain1] ${ok.length}/3 succeeded, errors:`, errors.slice(0, 2));

  if (!ok.length) {
    throw new Error("جميع محاولات قراءة الصورة فشلت: " + errors.join(" | "));
  }
  return _mergeExtractions(ok);
}

// دمج 3 نتائج: نأخذ التركيبة الأشمل (أكثر منتجات) ونضع confidence حسب الاتفاق
function _mergeExtractions(results) {
  // اختر النتيجة الأشمل أساساً
  const sorted = results.sort((a, b) => _countItems(b) - _countItems(a));
  const primary = sorted[0];
  if (results.length === 1) return primary;

  // اجمع كل المنتجات من كل النتائج للمقارنة
  const allItemsByName = new Map();
  for (const r of results) {
    for (const cat of (r.categories || [])) {
      for (const it of (cat.items || [])) {
        const key = _normKey(it.name);
        if (!key) continue;
        if (!allItemsByName.has(key)) allItemsByName.set(key, []);
        allItemsByName.get(key).push({ ...it, _catName: cat.name });
      }
    }
  }

  // عدّل confidence حسب الاتفاق
  for (const cat of (primary.categories || [])) {
    for (const it of (cat.items || [])) {
      const key = _normKey(it.name);
      const variants = allItemsByName.get(key) || [];
      if (variants.length >= 2) {
        // أخذ متوسط السعر إن اختلفت
        const prices = variants.map(v => Number(v.price) || 0).filter(p => p > 0);
        if (prices.length >= 2) {
          const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
          const variance = prices.reduce((a, b) => a + Math.abs(b - avg), 0) / prices.length;
          if (variance < 1) it.confidence = "high";
        }
      } else {
        it.confidence = it.confidence || "medium";
      }
    }
  }
  return primary;
}

function _countItems(menu) {
  return (menu.categories || []).reduce((s, c) => s + (c.items?.length || 0), 0);
}

function _normKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, "")
    .trim();
}

// ════════════════════════════════════════════════════════════════════
// 🧠 العقل 2: Schema Refiner — ينظف ويحقق الـ JSON
// ════════════════════════════════════════════════════════════════════
async function brain2_refineSchema(extracted) {
  // محاولة بنموذج الذكي، ثم fallback للسريع
  for (const model of [TEXT_MODEL, TEXT_FALLBACK]) {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 4000,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
`أنت مدقق منيو محترف. تحسّن البيانات المستخرجة من صور المنيو:
- توحّد أسماء الأصناف المكررة (مثل "قهوه" و"قهوة" → "قهوة")
- تكتشف الأسعار الواضحة الخاطئة (مثلاً سعر 0 لقهوة → ضع null)
- تنظف أسماء المنتجات (تزيل الرموز الزائدة)
- تتأكد ألا تخلط الأقسام (مثلاً "كيك" تحت "مشروبات" → انقله)
- ترتب الأقسام منطقياً (مشروبات ساخنة → باردة → حلويات → ...)

أعد JSON بنفس الشكل المعطى، مع تحسينات فقط.
لا تخترع منتجات. حافظ على نفس عدد المنتجات.`,
            },
            { role: "user", content: JSON.stringify(extracted) },
          ],
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (model === TEXT_FALLBACK) throw new Error(`refine HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "{}";
      const refined = JSON.parse(content);
      console.log(`[brain2:${model.slice(0,15)}] refined: ${_countItems(refined)} items`);
      return refined;
    } catch (e) {
      console.warn(`[brain2:${model}] failed: ${e.message}`);
      if (model === TEXT_FALLBACK) return extracted; // fallback: استخدم الـ raw
    }
  }
  return extracted;
}

// ════════════════════════════════════════════════════════════════════
// 🧠 العقل 3: Diff Reconciler — يقارن بالمنيو الحالي
// ════════════════════════════════════════════════════════════════════
async function brain3_diff(newMenu, existingProducts, existingCategories) {
  // ملخّص للموجود: name → {price, category, id}
  const existingMap = new Map();
  for (const p of existingProducts || []) {
    existingMap.set(_normKey(p.name), {
      id:       p.id,
      name:     p.name,
      price:    Number(p.price) || 0,
      category: p.category || "",
    });
  }
  const catMap = new Map();
  for (const c of existingCategories || []) {
    catMap.set(_normKey(c.name), { id: c.id, name: c.name });
  }

  const result = {
    newItems:      [],   // منتجات جديدة بالكامل
    updatedItems:  [],   // موجود لكن السعر/الاسم تغيّر
    unchanged:     [],   // نفس المنتج بنفس السعر
    newCategories: [],   // أقسام لم تكن
  };

  for (const cat of newMenu.categories || []) {
    const catKey = _normKey(cat.name);
    let existingCatId = catMap.get(catKey)?.id || null;
    let isNewCat = !existingCatId;
    if (isNewCat) {
      const newCatId = "c_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      result.newCategories.push({
        _tempId:    newCatId,
        name:       cat.name,
        emoji:      _suggestEmoji(cat.name),
      });
      existingCatId = newCatId;
    }

    for (const item of cat.items || []) {
      const key = _normKey(item.name);
      const existing = existingMap.get(key);
      if (!existing) {
        // 🆕 جديد بالكامل
        result.newItems.push({
          name:        String(item.name || "").trim(),
          price:       Number(item.price) || 0,
          description: String(item.description || "").trim(),
          categoryId:  existingCatId,
          categoryName: cat.name,
          confidence:  item.confidence || "medium",
          isNewCat,
        });
      } else {
        const newPrice = Number(item.price) || 0;
        const priceChanged = newPrice > 0 && Math.abs(newPrice - existing.price) >= 0.5;
        const nameChanged = item.name && item.name.trim() !== existing.name && _normKey(item.name) === key;
        if (priceChanged || nameChanged) {
          // 🔄 محدّث
          result.updatedItems.push({
            id:           existing.id,
            oldName:      existing.name,
            newName:      item.name.trim(),
            oldPrice:     existing.price,
            newPrice,
            priceChanged,
            nameChanged,
            categoryId:   existingCatId,
            categoryName: cat.name,
          });
        } else {
          // ✅ بدون تغيير
          result.unchanged.push({
            id:       existing.id,
            name:     existing.name,
            price:    existing.price,
          });
        }
      }
    }
  }

  // إحصاءات للـ UI
  result.summary = {
    new:        result.newItems.length,
    updated:    result.updatedItems.length,
    unchanged:  result.unchanged.length,
    newCats:    result.newCategories.length,
  };
  return result;
}

function _suggestEmoji(catName) {
  const n = _normKey(catName);
  if (/قهوه|قهوة|اسبرسو|كابتشينو|مكياتو|لاتيه|coffee|tea|شاي/.test(n)) return "☕";
  if (/مشروب|عصير|عصاير|بيبسي|كولا|drink/.test(n)) return "🥤";
  if (/حلو|حلوي|كيك|تشيز|بسكويت|دونات|dessert|cake/.test(n)) return "🍰";
  if (/فطار|breakfast|بيض/.test(n)) return "🍳";
  if (/برجر|burger/.test(n)) return "🍔";
  if (/بيتزا|pizza/.test(n)) return "🍕";
  if (/شاورما|كباب|مشاوي/.test(n)) return "🥙";
  if (/سلطه|سلطة|salad/.test(n)) return "🥗";
  if (/سندوتش|سندويتش|sandwich/.test(n)) return "🥪";
  if (/معجنات|فطاير/.test(n)) return "🥐";
  if (/مكرونه|باستا|pasta/.test(n)) return "🍝";
  if (/ايس|ايسكريم|ice/.test(n)) return "🍦";
  return "🍽️";
}

// ════════════════════════════════════════════════════════════════════
// 🚀 الـ Orchestrator — يشغّل العقول الثلاثة
// ════════════════════════════════════════════════════════════════════
async function importMenuFromImage({ imageBase64, mimeType, existingProducts, existingCategories, businessType, storeName }) {
  if (!GROQ_KEY) throw new Error("لا يوجد مفتاح AI مُعرّف (GROQ_API_KEY)");
  const imageDataUrl = `data:${mimeType || "image/jpeg"};base64,${imageBase64}`;

  // 🖼️ استخرج أبعاد الصورة لإرسالها للـ AI (لكي يحدد bounding boxes صحيحة)
  let imgMeta = {};
  if (sharp) {
    try {
      const buf = Buffer.from(imageBase64, "base64");
      const meta = await sharp(buf).metadata();
      imgMeta = { imageWidth: meta.width, imageHeight: meta.height, _buffer: buf };
    } catch (e) { console.warn("[ai-menu] metadata failed:", e.message); }
  }

  // مرحلة 1: استخراج من الصورة (parallel attempts) مع سياق المتجر
  const ctx = {
    businessType,
    storeName,
    existingCategories: (existingCategories || []).slice(0, 30).map(c => ({ name: c.name })),
    imageWidth:  imgMeta.imageWidth,
    imageHeight: imgMeta.imageHeight,
  };
  const t0 = Date.now();
  const extracted = await brain1_extractFromImage(imageDataUrl, ctx);
  const t1 = Date.now();
  console.log(`[ai-menu-import] brain1 done in ${t1 - t0}ms — items: ${_countItems(extracted)}`);

  // مرحلة 2 + 3: parallel — تنظيف + استعداد للـ diff
  const [refined, _] = await Promise.all([
    brain2_refineSchema(extracted),
    Promise.resolve(null),
  ]);
  const t2 = Date.now();
  console.log(`[ai-menu-import] brain2 done in ${t2 - t1}ms — items: ${_countItems(refined)}`);

  // مرحلة 3: مقارنة (بعد التنظيف)
  const diff = await brain3_diff(refined, existingProducts, existingCategories);
  const t3 = Date.now();
  console.log(`[ai-menu-import] brain3 done in ${t3 - t2}ms — new:${diff.summary.new} upd:${diff.summary.updated} same:${diff.summary.unchanged}`);

  // مرحلة 4: 🪡 اقتطاع الصور — للمنتجات الجديدة التي حصلت على image_bbox
  if (sharp && imgMeta._buffer) {
    await _cropImagesForNewItems(refined, diff, imgMeta);
  }
  const t4 = Date.now();

  return {
    extracted: refined,
    diff,
    timings: { vision: t1 - t0, refine: t2 - t1, diff: t3 - t2, crop: t4 - t3, total: t4 - t0 },
  };
}

// 🪡 اقتطاع الصور المضمّنة من صورة المنيو
async function _cropImagesForNewItems(refined, diff, imgMeta) {
  const path = require("path");
  const fs   = require("fs");
  const IMAGES_DIR = path.join(__dirname, "..", "data", "images");
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  // ابنِ خريطة: normName → bbox من النتيجة المُحسّنة
  const bboxMap = new Map();
  for (const cat of refined.categories || []) {
    for (const it of cat.items || []) {
      if (it.image_bbox && typeof it.image_bbox === "object") {
        bboxMap.set(_normKey(it.name), it.image_bbox);
      }
    }
  }

  // اقتطع لكل منتج جديد
  let cropped = 0;
  for (const item of diff.newItems || []) {
    const bbox = bboxMap.get(_normKey(item.name));
    if (!bbox) continue;
    const x = Math.max(0, Math.round(bbox.x));
    const y = Math.max(0, Math.round(bbox.y));
    const w = Math.max(20, Math.min(imgMeta.imageWidth - x, Math.round(bbox.w)));
    const h = Math.max(20, Math.min(imgMeta.imageHeight - y, Math.round(bbox.h)));
    if (w < 50 || h < 50) continue; // صغير جداً، تخطّ
    try {
      const filename = `menu-crop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.jpg`;
      const filepath = path.join(IMAGES_DIR, filename);
      await sharp(imgMeta._buffer)
        .extract({ left: x, top: y, width: w, height: h })
        .resize({ width: 600, withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(filepath);
      item._croppedImageUrl = `/store-images/${filename}`;
      cropped++;
    } catch (e) { console.warn(`[crop] failed for "${item.name}":`, e.message); }
  }
  if (cropped > 0) console.log(`[ai-menu-import] cropped ${cropped} product images`);
}

module.exports = {
  importMenuFromImage,
  brain1_extractFromImage,
  brain2_refineSchema,
  brain3_diff,
  _suggestEmoji,
  _normKey,
};
