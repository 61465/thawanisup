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

const GROQ_KEY   = process.env.GROQ_API_KEY || "";
const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent";

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

🖼️ ━━━━━━━━━━━━ اقتطاع صور المنتجات (مهم جداً) ━━━━━━━━━━━━
لكل منتج له **صورة مرئية** في المنيو، أضف الحقل التالي بالضبط:
"image_bbox": {"x": 100, "y": 250, "w": 180, "h": 180}

شرح:
- x = البكسل من اليسار  (0 = أقصى يسار، ${ctx.imageWidth} = أقصى يمين)
- y = البكسل من الأعلى  (0 = أعلى، ${ctx.imageHeight} = الأسفل)
- w = العرض بالبكسل
- h = الارتفاع بالبكسل

مثال كامل لمنتج له صورة:
{
  "name": "لاتيه",
  "price": 18,
  "description": "مع رغوة كثيفة",
  "image_bbox": {"x": 320, "y": 580, "w": 200, "h": 200},
  "confidence": "high"
}

مثال لمنتج بدون صورة (نص فقط):
{
  "name": "إسبريسو",
  "price": 10,
  "description": "",
  "confidence": "high"
}
(لاحظ: لا يوجد image_bbox)

قواعد bbox:
1. ضع image_bbox **فقط** لو ترى صورة فعلية للمنتج في المنيو
2. لا تضعه لو المنتج نص فقط أو فقط أيقونة عامة
3. اقطع بدقة حول الصورة فقط — لا تضمّن النص أو السعر
4. لو في شك → لا تضعه (أفضل من قطع خاطئ)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━` : ""}

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

📐 *دمج الأحجام والأنواع — مهم جداً:*
لو المنتج له أحجام/أنواع متعددة (مثل: لاتيه صغير 12 / لاتيه وسط 15 / لاتيه كبير 18)
*لا تنشئها كـ 3 منتجات منفصلة!* بل منتج واحد بـ "sizes":
{
  "name": "لاتيه",
  "price": 12,  ← أصغر سعر
  "sizes": [
    {"label": "صغير", "price": 12},
    {"label": "وسط", "price": 15},
    {"label": "كبير", "price": 18}
  ]
}
نفس الشيء لـ: small/medium/large، نص/كامل، بالدجاج/باللحم، حار/عادي...
الإشارات: نفس اسم المنتج مع scale أو modifier فقط، أو أعمدة أسعار جنب بعض.

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
10. حاول استخدام نفس أسماء الأقسام الموجودة لو ظهر منتج مطابق
11. **ادمج الأحجام/الأنواع كـ sizes داخل منتج واحد** (انظر القاعدة أعلاه)`,
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

// 🧠 Gemini Vision (أدق في object detection — لو المفتاح متاح)
async function _callGeminiVision(imageBase64, mimeType, ctx) {
  if (!GEMINI_KEY) return null;
  const prompt =
`أنت محلّل صور خبير. اقرأ صورة المنيو هذه واستخرج JSON دقيق:
${ctx.businessType ? `نوع النشاط: ${ctx.businessType}` : ""}
${ctx.existingCategories?.length ? `الأقسام الموجودة: ${ctx.existingCategories.map(c=>c.name).join("، ")}` : ""}
أبعاد الصورة: ${ctx.imageWidth} × ${ctx.imageHeight} pixel

أعد JSON بهذا الشكل:
{
  "categories": [
    {
      "name": "اسم القسم",
      "items": [
        {
          "name": "اسم المنتج",
          "price": رقم,
          "description": "الوصف",
          "image_bbox": {"x": رقم, "y": رقم, "w": رقم, "h": رقم},
          "confidence": "high"
        }
      ]
    }
  ]
}

🎯 image_bbox: ضع إحداثيات صورة المنتج بدقة عالية بالـ pixel.
- (0,0) أعلى يسار
- لا تضع image_bbox لو المنتج نص فقط
- اقطع حول الصورة بدقة فائقة — لا تضمّن النص بجوارها
- ادمج الأحجام في "sizes": [{"label":"كبير","price":15}, ...]`;

  try {
    const res = await fetch(GEMINI_URL + "?key=" + GEMINI_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 6000, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) { console.warn(`[gemini-vision] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return JSON.parse(content);
  } catch (e) {
    console.warn(`[gemini-vision] failed: ${e.message}`);
    return null;
  }
}

// 3 محاولات بنماذج/temperatures مختلفة → نأخذ الأفضل (majority + ثقة)
// + Gemini إن توفّر (أدق في الـ bboxes)
async function brain1_extractFromImage(imageDataUrl, ctx = {}, imageBase64 = null, mimeType = null) {
  const attempts = await Promise.allSettled([
    _callVision(imageDataUrl, VISION_MODELS[0], 0.0, ctx),
    _callVision(imageDataUrl, VISION_MODELS[0], 0.2, ctx),
    _callVision(imageDataUrl, VISION_MODELS[1], 0.1, ctx),
    // 🌟 Gemini كـ vision 4 (أدق في bboxes)
    GEMINI_KEY && imageBase64
      ? _callGeminiVision(imageBase64, mimeType, ctx).then(r => r || Promise.reject(new Error("gemini null")))
      : Promise.reject(new Error("no gemini")),
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

  // عدّل confidence حسب الاتفاق + اجلب image_bbox من أي محاولة وضعتها
  for (const cat of (primary.categories || [])) {
    for (const it of (cat.items || [])) {
      const key = _normKey(it.name);
      const variants = allItemsByName.get(key) || [];
      // 🖼️ لو الـ primary ليس له bbox، خذها من أي محاولة أخرى
      if (!it.image_bbox) {
        const withBbox = variants.find(v => v.image_bbox && typeof v.image_bbox === "object");
        if (withBbox) it.image_bbox = withBbox.image_bbox;
      }
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
// 🧠 العقل 4 (المتخصص): Image-Only Locator — يحدد bboxes فقط
// لا يستخرج نصاً ولا أسعاراً — مهمته الوحيدة: تحديد مواقع صور المنتجات
// بدقة pixel-level. يأخذ قائمة الأسماء من brain1 ويسأل: أين صورة كل واحد؟
// ════════════════════════════════════════════════════════════════════
async function brain4_imageSpecialist(imageDataUrl, productNames, imgMeta) {
  if (!productNames.length || !imgMeta?.imageWidth) return null;

  const systemPrompt =
`أنت متخصص واحد فقط: تحديد مواقع صور المنتجات في صورة المنيو بدقة pixel-level.
*لا تستخرج أسماء جديدة، لا أسعار، لا أقسام، لا أوصاف*.
أنت كاميرا فقط — تشير لأين الصور.

أبعاد الصورة: ${imgMeta.imageWidth} × ${imgMeta.imageHeight} pixel

ستحصل على قائمة أسماء منتجات. مهمتك:
لكل اسم، حدد إن كان له صورة في المنيو، وأين بالضبط.

اقتراحات للدقة:
✓ افحص الصورة بعناية كاميرا
✓ ضع bbox حول الصورة فقط — استبعد النص والسعر بجوارها
✓ لا تضع bbox لو المنتج نص فقط (لا صورة) — اتركه null
✓ كن دقيقاً بـ ±5 pixel
✓ لو منتج مكرر في الصورة، اختر الأوضح

ناتج JSON فقط:
{
  "items": [
    { "name": "اسم المنتج كما أعطيتك", "bbox": {"x": 100, "y": 250, "w": 180, "h": 180} },
    { "name": "منتج آخر بدون صورة", "bbox": null }
  ]
}`;

  // 3 محاولات بـ models مختلفة + Gemini إن متوفر
  const attempts = [];
  for (const model of VISION_MODELS) {
    attempts.push((async () => {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.0, // صارم للدقة
          max_tokens: 3000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: "حدد bbox لكل منتج في القائمة (null لو بدون صورة):\n" + productNames.map((n, i) => `${i+1}. ${n}`).join("\n") },
                { type: "image_url", image_url: { url: imageDataUrl } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) throw new Error(`brain4 ${model} HTTP ${res.status}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "{}";
      return JSON.parse(content);
    })());
  }
  // أضف Gemini كخامس attempt لو المفتاح متوفر (الأدق في object detection)
  if (GEMINI_KEY) {
    const imageBase64 = imageDataUrl.split(",")[1];
    const mimeType = (imageDataUrl.match(/data:([^;]+);/) || [])[1] || "image/jpeg";
    attempts.push((async () => {
      const geminiPrompt = systemPrompt + "\n\nالمنتجات:\n" + productNames.map((n, i) => `${i+1}. ${n}`).join("\n");
      const res = await fetch(GEMINI_URL + "?key=" + GEMINI_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: geminiPrompt },
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
          ]}],
          generationConfig: { temperature: 0.0, maxOutputTokens: 4000, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) throw new Error("gemini HTTP " + res.status);
      const data = await res.json();
      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      return JSON.parse(content);
    })());
  }

  const results = await Promise.allSettled(attempts);
  const ok = results.filter(r => r.status === "fulfilled" && r.value?.items).map(r => r.value);
  const errors = results.filter(r => r.status === "rejected").map(r => r.reason?.message || "?");
  console.log(`[brain4] specialist: ${ok.length}/${results.length} succeeded${errors.length ? ", errors: " + errors.slice(0,2).join("; ") : ""}`);

  if (!ok.length) return null;

  // دمج النتائج: لكل منتج، نأخذ متوسط bboxes إن اتفقت، أو أوضح واحد
  const merged = new Map();
  for (const result of ok) {
    for (const item of result.items || []) {
      if (!item?.name || !item?.bbox) continue;
      const key = _normKey(item.name);
      if (!merged.has(key)) merged.set(key, { name: item.name, bboxes: [] });
      merged.get(key).bboxes.push(item.bbox);
    }
  }

  // لكل منتج: نأخذ median bbox (أقل تأثراً بـ outliers)
  const finalItems = [];
  for (const [_, entry] of merged) {
    if (!entry.bboxes.length) continue;
    const median = (arr) => {
      const s = arr.slice().sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
    };
    const bbox = {
      x: Math.round(median(entry.bboxes.map(b => Number(b.x) || 0))),
      y: Math.round(median(entry.bboxes.map(b => Number(b.y) || 0))),
      w: Math.round(median(entry.bboxes.map(b => Number(b.w) || 0))),
      h: Math.round(median(entry.bboxes.map(b => Number(b.h) || 0))),
    };
    if (bbox.w > 30 && bbox.h > 30) finalItems.push({ name: entry.name, bbox });
  }
  console.log(`[brain4] specialist: ${finalItems.length} bboxes finalized (median of ${ok.length} attempts)`);
  return { items: finalItems };
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
        // 📐 تنظيف الأحجام/الأنواع
        const cleanSizes = Array.isArray(item.sizes)
          ? item.sizes
              .map(s => ({ label: String(s?.label || "").trim().slice(0, 40), price: Number(s?.price) || 0 }))
              .filter(s => s.label && s.price > 0)
              .slice(0, 8)
          : [];
        result.newItems.push({
          name:        String(item.name || "").trim(),
          price:       Number(item.price) || (cleanSizes[0]?.price || 0),
          description: String(item.description || "").trim(),
          sizes:       cleanSizes,
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
  const extracted = await brain1_extractFromImage(imageDataUrl, ctx, imageBase64, mimeType);
  const t1 = Date.now();
  console.log(`[ai-menu-import] brain1 done in ${t1 - t0}ms — items: ${_countItems(extracted)}`);

  // 🧠 العقل الرابع المتخصص (Image-only) — يعمل بالتوازي مع brain2
  // مهمته الوحيدة: تحديد bbox لكل منتج بدقة عالية (بدون استخراج نص أو أسعار)
  const productNames = [];
  for (const cat of extracted.categories || []) {
    for (const it of cat.items || []) if (it.name) productNames.push(it.name);
  }
  const imgSpecialistPromise = imgMeta._buffer
    ? brain4_imageSpecialist(imageDataUrl, productNames, imgMeta).catch(() => null)
    : Promise.resolve(null);

  // 🛡️ احفظ image_bboxes من extracted قبل refine (brain2 الصغير قد يحذفها)
  const bboxBackup = new Map();
  for (const cat of extracted.categories || []) {
    for (const it of cat.items || []) {
      if (it.image_bbox && typeof it.image_bbox === "object") {
        bboxBackup.set(_normKey(it.name), it.image_bbox);
      }
    }
  }
  console.log(`[ai-menu-import] bboxes detected in extracted: ${bboxBackup.size}/${_countItems(extracted)}`);

  // مرحلة 2 + العقل الرابع: parallel — تنظيف + تحديد bboxes متخصص
  const [refined, specialistBboxes] = await Promise.all([
    brain2_refineSchema(extracted),
    imgSpecialistPromise,
  ]);
  const t2 = Date.now();

  // 🔄 ادمج الـ bboxes — أولوية للعقل الرابع المتخصص، ثم backup من brain1
  const specialistMap = new Map();
  if (specialistBboxes && Array.isArray(specialistBboxes.items)) {
    for (const it of specialistBboxes.items) {
      if (it.bbox && typeof it.bbox === "object") {
        specialistMap.set(_normKey(it.name), it.bbox);
      }
    }
  }
  let fromSpecialist = 0, fromBackup = 0;
  for (const cat of refined.categories || []) {
    for (const it of cat.items || []) {
      const key = _normKey(it.name);
      // الأفضل: عقل #4 المتخصص (أدق)
      const specBbox = specialistMap.get(key);
      if (specBbox) { it.image_bbox = specBbox; fromSpecialist++; continue; }
      // التالي: backup من brain1
      if (!it.image_bbox) {
        const bk = bboxBackup.get(key);
        if (bk) { it.image_bbox = bk; fromBackup++; }
      }
    }
  }
  console.log(`[ai-menu-import] brain2 done in ${t2 - t1}ms — items: ${_countItems(refined)}, bboxes: ${fromSpecialist} from specialist + ${fromBackup} from backup`);

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

// 🪡 اقتطاع الصور المضمّنة من صورة المنيو مع 4 طبقات حماية
async function _cropImagesForNewItems(refined, diff, imgMeta) {
  const path = require("path");
  const fs   = require("fs");
  const IMAGES_DIR = path.join(__dirname, "..", "data", "images");
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  // ابنِ خريطة: normName → bbox من النتيجة المُحسّنة
  const bboxList = []; // {key, name, bbox}
  for (const cat of refined.categories || []) {
    for (const it of cat.items || []) {
      if (it.image_bbox && typeof it.image_bbox === "object") {
        bboxList.push({ key: _normKey(it.name), name: it.name, bbox: it.image_bbox });
      }
    }
  }

  // 🛡️ طبقة 1: منع التداخل — > 50% فقط (كان 30% صارم جداً)
  // + نتجاهل تكرار نفس الاسم (يعني الـ AI كرّر، لا تداخل حقيقي)
  const accepted = [];
  const seenNames = new Set();
  for (const b of bboxList) {
    if (seenNames.has(b.key)) continue; // تكرار اسم → خذ أول واحد فقط
    seenNames.add(b.key);
    const conflict = accepted.find(a => _bboxIntersectionRatio(a.bbox, b.bbox) > 0.5);
    if (conflict) {
      console.warn(`[crop:overlap] rejected "${b.name}" (overlaps with "${conflict.name}")`);
      continue;
    }
    accepted.push(b);
  }

  // ابنِ خريطة accepted
  const acceptedMap = new Map(accepted.map(a => [a.key, a.bbox]));
  let cropped = 0, verified = 0, rejected = 0;
  const cropTasks = [];

  for (const item of diff.newItems || []) {
    const bbox = acceptedMap.get(_normKey(item.name));
    if (!bbox) continue;
    // 🛡️ Shrink 8% من كل جهة لتجنّب أخذ نص بجوار الصورة
    const SHRINK = 0.08;
    const rawX = Math.round(bbox.x);
    const rawY = Math.round(bbox.y);
    const rawW = Math.round(bbox.w);
    const rawH = Math.round(bbox.h);
    const dx = Math.round(rawW * SHRINK);
    const dy = Math.round(rawH * SHRINK);
    const x = Math.max(0, rawX + dx);
    const y = Math.max(0, rawY + dy);
    const w = Math.max(20, Math.min(imgMeta.imageWidth - x, rawW - 2 * dx));
    const h = Math.max(20, Math.min(imgMeta.imageHeight - y, rawH - 2 * dy));
    // 🛡️ طبقة 2: قيود الحجم — مخفّفة قليلاً (50 بدل 80)
    if (w < 50 || h < 50) { console.warn(`[crop:too-small] "${item.name}" ${w}x${h}`); continue; }
    const aspect = w / h;
    if (aspect > 5 || aspect < 0.2) { console.warn(`[crop:bad-aspect] "${item.name}" ratio=${aspect.toFixed(2)}`); continue; }
    // 🛡️ طبقة 3: نسبة من الصورة — < 50%
    const areaPct = (w * h) / (imgMeta.imageWidth * imgMeta.imageHeight);
    if (areaPct > 0.5) { console.warn(`[crop:too-big] "${item.name}" pct=${(areaPct*100).toFixed(0)}%`); continue; }

    cropTasks.push((async () => {
      try {
        const filename = `menu-crop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.jpg`;
        const filepath = path.join(IMAGES_DIR, filename);
        const cropBuf = await sharp(imgMeta._buffer)
          .extract({ left: x, top: y, width: w, height: h })
          .resize({ width: 600, withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        // 🛡️ طبقة 4: AI verification — احفظ الصورة مباشرة (متفائلون)
        // نُجري verification لكن لا نرفض إلا لو AI واثق "no" مع confidence high
        await fs.promises.writeFile(filepath, cropBuf);
        item._croppedImageUrl = `/store-images/${filename}`;
        const verifiedResult = await _verifyCropMatchesProduct(cropBuf, item.name).catch(() => ({ match: "unknown", confidence: "low" }));
        if (verifiedResult.match === "no" && verifiedResult.confidence === "high") {
          console.warn(`[crop:ai-reject] "${item.name}" — high-confidence no: ${verifiedResult.reason || ""}`);
          item._cropVerification = { match: false, reason: verifiedResult.reason, confidence: verifiedResult.confidence };
          rejected++;
        } else {
          item._cropVerification = { match: verifiedResult.match === "yes", confidence: verifiedResult.confidence };
          if (verifiedResult.match === "yes") verified++;
          cropped++;
        }
      } catch (e) { console.warn(`[crop] failed for "${item.name}":`, e.message); }
    })());
  }

  // شغّل كل الـ verifications بالتوازي
  await Promise.allSettled(cropTasks);
  if (cropped + rejected > 0) {
    console.log(`[ai-menu-import] crop summary: ${cropped} accepted (${verified} AI-verified), ${rejected} flagged for manual review`);
  }
}

// نسبة تداخل bboxes (intersection over smaller area)
function _bboxIntersectionRatio(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? inter / smaller : 0;
}

// 🧠 عقل #5: AI verification — هل الصورة المقطوعة تطابق المنتج؟
async function _verifyCropMatchesProduct(cropBuf, productName) {
  if (!GROQ_KEY || !cropBuf) return { match: "unknown" };
  const dataUrl = `data:image/jpeg;base64,${cropBuf.toString("base64")}`;
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODELS[1], // أسرع وأخف للتحقق
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
`أنت مدقق صور. تحدد لو صورة فعلاً تمثّل اسم منتج معين.
ارجع JSON فقط:
{
  "match": "yes" | "no" | "unknown",
  "confidence": "high" | "medium" | "low",
  "reason": "وصف قصير لما رأيته في الصورة وسبب القبول/الرفض"
}

قواعد:
- "yes": إذا كانت الصورة فعلاً للمنتج (مثلاً صورة قهوة لمنتج اسمه "قهوة")
- "no": إذا الصورة نص فقط، أو خلفية فارغة، أو منتج مختلف تماماً
- "unknown": إذا الصورة غير واضحة لكن لا يمكن نفي التطابق
- كن متساهلاً في "yes": صورة عامة لمشروب مع منتج اسمه قهوة → yes`,
          },
          {
            role: "user",
            content: [
              { type: "text", text: `هل هذه الصورة تطابق منتج اسمه: "${productName}"؟` },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { match: "unknown" };
    const data = await res.json();
    return JSON.parse(data.choices?.[0]?.message?.content || '{"match":"unknown"}');
  } catch (e) {
    console.warn("[verify-crop] failed:", e.message);
    return { match: "unknown" };
  }
}

module.exports = {
  importMenuFromImage,
  brain1_extractFromImage,
  brain2_refineSchema,
  brain3_diff,
  _suggestEmoji,
  _normKey,
};
