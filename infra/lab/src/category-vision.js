/**
 * Category Vision — استخراج منتجات قسم واحد من صورة رف
 *
 * الفرق عن ai-menu-import:
 *   - ai-menu-import يستخرج كل المنيو + ينظمه في أقسام
 *   - هذا الموديول يعرف القسم مسبقاً (e.g. "الألبان") → دقة أعلى + crops أنظف
 *
 * كل منتج يُرجع:
 *   - name + brand? + size?  ← AI يستخرج
 *   - image_bbox            ← لقصّ الصورة من الأصلية
 *   - price                  ← null لو غير ظاهر؛ المتجر يضيف يدوياً
 *   - confidence
 *
 * يعتمد على نفس Groq vision model الذي تستخدمه ai-menu-import
 * (لتوحيد الإعداد ومفاتيح .env).
 */

const path = require("path");
const fs   = require("fs");

const GROQ_KEY   = process.env.GROQ_API_KEY || "";
const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent";

let sharp; try { sharp = require("sharp"); } catch {}

const VISION_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
];
const TIMEOUT_MS = 45_000;

// ─── Vision call: Groq Llama 4 ─────────────────────────────────────────────
async function _callGroqVision(imageDataUrl, ctx, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const systemPrompt =
`أنت محلّل صور خبير لاستخراج منتجات من صور رفوف المتاجر.

📂 *السياق المُسبق:*
- نوع المتجر: ${ctx.businessType || "متجر"}
- اسم القسم: "${ctx.categoryName}"${ctx.subCategoryName ? ` (صنف فرعي: ${ctx.subCategoryName})` : ""}
- اسم المتجر: ${ctx.storeName || "—"}

⚠️ كل المنتجات في الصورة *يجب* أن تكون من هذا القسم. لو رأيت منتج لا يناسب → استبعده.

${ctx.imageWidth ? `📏 *أبعاد الصورة:* ${ctx.imageWidth} × ${ctx.imageHeight} pixel

🖼️ ━━━━━━━━━━━━ اقتطاع صور المنتجات ━━━━━━━━━━━━
لكل منتج ظاهر بوضوح، أضف:
"image_bbox": {"x": رقم, "y": رقم, "w": رقم, "h": رقم}

شرح:
- x = البكسل من اليسار (0 = أقصى يسار)
- y = البكسل من الأعلى
- w/h = العرض/الارتفاع بالبكسل

قواعد bbox:
1. اقطع بدقة حول العلبة/المنتج فقط — لا تضمّن منتج آخر
2. لو منتج مكرر (نفس النوع 5 مرات على الرف)، أضفه مرة واحدة
3. لو غير متأكد من حدوده → استبعده (أفضل من قطع خاطئ)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━` : ""}

📦 الناتج JSON فقط بالشكل التالي:
{
  "items": [
    {
      "name": "اسم المنتج كامل كما يظهر",
      "brand": "الماركة لو واضحة (مثال: نيدو، باراسيتامول)، أو فارغ",
      "size":  "الحجم/الوزن (مثال: 1 لتر، 500غ، 24 قطعة)، أو فارغ",
      "price": رقم لو ظاهر على الرف، أو null,
      "image_bbox": {"x": رقم, "y": رقم, "w": رقم, "h": رقم},
      "confidence": "high | medium | low"
    }
  ]
}

⚠️ قواعد صارمة:
1. استخرج كل منتج فريد ظاهر — لا تتخطى شيئاً
2. لا تخترع منتجات غير ظاهرة
3. السعر لو غير واضح → null (المتجر يضيفه يدوياً)
4. الاسم كاملاً ودقيقاً كما يظهر على المنتج
5. لو لم تظهر إلا لافتات سعر بدون منتج → ignore
6. النص بنفس لغته (لا تترجم)`;

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: [
            { type: "text",      text: `استخرج كل منتج ظاهر في الصورة، يخص القسم "${ctx.categoryName}".` },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ]},
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`groq HTTP ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Gemini fallback (لو Groq فشل أو رد ضعيف) ────────────────────────────
async function _callGeminiVision(imageBase64, mimeType, ctx) {
  if (!GEMINI_KEY) return null;
  const prompt =
`استخرج منتجات قسم "${ctx.categoryName}" من صورة الرف هذه.
نوع المتجر: ${ctx.businessType || "متجر"}
${ctx.imageWidth ? `أبعاد الصورة: ${ctx.imageWidth} × ${ctx.imageHeight} pixel` : ""}

أعد JSON بهذا الشكل بالضبط:
{
  "items": [
    {
      "name": "اسم المنتج",
      "brand": "الماركة أو فارغ",
      "size": "الحجم أو فارغ",
      "price": رقم أو null,
      "image_bbox": {"x": رقم, "y": رقم, "w": رقم, "h": رقم},
      "confidence": "high|medium|low"
    }
  ]
}
- كل المنتجات يجب تكون من قسم "${ctx.categoryName}" فقط
- بنود مكررة على الرف → عنصر واحد فقط
- bbox بدقة حول المنتج وحده`;

  try {
    const res = await fetch(GEMINI_URL + "?key=" + GEMINI_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } },
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 6000, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) { console.warn(`[cat-vision/gemini] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return JSON.parse(content);
  } catch (e) {
    console.warn(`[cat-vision/gemini] failed: ${e.message}`);
    return null;
  }
}

// ─── Crop products from original image ──────────────────────────────────
async function cropProducts({ imageBuffer, items, outputDir }) {
  if (!sharp) {
    console.warn("[cat-vision] sharp not installed — skipping crops");
    return items.map(it => ({ ...it, croppedPath: null }));
  }
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const results = [];
  for (const it of items) {
    let croppedPath = null;
    const bbox = it.image_bbox;
    if (bbox && Number.isFinite(bbox.x) && Number.isFinite(bbox.y) && Number.isFinite(bbox.w) && Number.isFinite(bbox.h) && bbox.w > 20 && bbox.h > 20) {
      try {
        // 5px padding للأمان
        const pad = 5;
        const meta = await sharp(imageBuffer).metadata();
        const left   = Math.max(0, Math.round(bbox.x - pad));
        const top    = Math.max(0, Math.round(bbox.y - pad));
        const width  = Math.min(meta.width  - left, Math.round(bbox.w + pad * 2));
        const height = Math.min(meta.height - top,  Math.round(bbox.h + pad * 2));
        if (width > 0 && height > 0) {
          const filename = `crop-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
          const fullPath = path.join(outputDir, filename);
          await sharp(imageBuffer)
            .extract({ left, top, width, height })
            .resize(400, 400, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toFile(fullPath);
          croppedPath = filename; // relative — caller يبني الـ URL
        }
      } catch (e) {
        console.warn(`[cat-vision] crop failed for "${it.name}":`, e.message);
      }
    }
    results.push({ ...it, croppedPath });
  }
  return results;
}

// ─── Main orchestrator ────────────────────────────────────────────────────
async function extractProductsFromCategoryImage({
  imageBase64, mimeType, categoryName, subCategoryName, businessType, storeName,
}) {
  if (!GROQ_KEY && !GEMINI_KEY) {
    throw new Error("لا يوجد مفتاح AI vision مُعرّف (GROQ_API_KEY أو GEMINI_API_KEY)");
  }
  if (!imageBase64) throw new Error("صورة مطلوبة");
  if (!categoryName) throw new Error("اسم القسم مطلوب");

  // أبعاد الصورة لإرسالها للـ AI
  const imageBuffer = Buffer.from(imageBase64, "base64");
  let imageWidth, imageHeight;
  if (sharp) {
    try {
      const meta = await sharp(imageBuffer).metadata();
      imageWidth = meta.width; imageHeight = meta.height;
    } catch (e) { console.warn("[cat-vision] meta failed:", e.message); }
  }

  const ctx = { categoryName, subCategoryName, businessType, storeName, imageWidth, imageHeight };
  const imageDataUrl = `data:${mimeType || "image/jpeg"};base64,${imageBase64}`;

  // 1) جرّب Groq — موديل أول، ثم الثاني لو فشل
  let result = null, lastErr;
  if (GROQ_KEY) {
    for (const model of VISION_MODELS) {
      try {
        const t0 = Date.now();
        result = await _callGroqVision(imageDataUrl, ctx, model);
        console.log(`[cat-vision] groq ${model} OK in ${Date.now() - t0}ms — ${(result?.items || []).length} items`);
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[cat-vision] groq ${model} failed: ${e.message}`);
      }
    }
  }

  // 2) Fallback لـ Gemini لو Groq فشل
  if ((!result || !result.items?.length) && GEMINI_KEY) {
    try {
      const t0 = Date.now();
      const g = await _callGeminiVision(imageBase64, mimeType, ctx);
      if (g && g.items?.length) {
        result = g;
        console.log(`[cat-vision] gemini fallback OK in ${Date.now() - t0}ms — ${g.items.length} items`);
      }
    } catch (e) { lastErr = e; }
  }

  if (!result) throw lastErr || new Error("فشل تحليل الصورة");

  // طبّع النتائج
  const items = (result.items || [])
    .filter(it => it && it.name && String(it.name).trim().length >= 2)
    .map(it => ({
      name:        String(it.name || "").trim().slice(0, 120),
      brand:       String(it.brand || "").trim().slice(0, 60),
      size:        String(it.size  || "").trim().slice(0, 40),
      price:       (it.price === 0 || it.price === null || it.price === undefined)
                     ? null : Number(it.price),
      image_bbox:  it.image_bbox && typeof it.image_bbox === "object" ? it.image_bbox : null,
      confidence:  String(it.confidence || "medium").trim(),
    }));

  return { items, imageWidth, imageHeight, imageBuffer };
}

module.exports = {
  extractProductsFromCategoryImage,
  cropProducts,
};
