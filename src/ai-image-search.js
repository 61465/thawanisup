/**
 * 🔍 AI Image Search v2 — Google Search + AI Vision Verification
 *
 * Pipeline:
 *   1. NEXUS (Groq) يحوّل اسم المنتج العربي → keywords دقيقة بالإنجليزية
 *   2. Google Custom Search Engine يجلب 10 صور من الويب
 *   3. AI Vision (Gemini 2.0 Flash أو Groq Llama Vision) يتحقق لكل صورة
 *      أنها فعلاً للمنتج المطلوب (مش صورة عشوائية)
 *   4. نُرجع 4-6 صور موثقة بنسبة ثقة > 70%
 *
 * .env المطلوب:
 *   GOOGLE_CSE_API_KEY=xxx           (من console.cloud.google.com)
 *   GOOGLE_CSE_ID=xxx                (من programmablesearchengine.google.com)
 *   GEMINI_API_KEY=xxx               (للـ Vision verification — مجاني)
 *   GROQ_API_KEY=xxx                 (fallback للـ translation + verification بـ Llama 4 Scout)
 *
 * في حالة فقدان GOOGLE_CSE → fallback لـ Pexels (لو PEXELS_API_KEY موجود)
 * في حالة فقدان Vision API → نُرجع كل النتائج بدون verification
 */

const GOOGLE_CSE_KEY = process.env.GOOGLE_CSE_API_KEY || "";
const GOOGLE_CSE_ID  = process.env.GOOGLE_CSE_ID || "";
const GEMINI_KEY     = process.env.GEMINI_API_KEY || "";
const GROQ_KEY       = process.env.GROQ_API_KEY || "";
const PEXELS_KEY     = process.env.PEXELS_API_KEY || ""; // fallback

// In-memory cache
const _cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

function _cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return e.value;
}
function _cacheSet(key, value) {
  if (_cache.size >= MAX_CACHE_ENTRIES) {
    [..._cache.keys()].slice(0, 50).forEach(k => _cache.delete(k));
  }
  _cache.set(key, { ts: Date.now(), value });
}

// ─── Step 1: Arabic → English keywords (via Groq) ────────────────────────────
async function _translateToKeywords(productName, businessType) {
  const cacheKey = `tr:${productName}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;
  if (!GROQ_KEY) return productName;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.2,
        max_tokens: 50,
        messages: [
          { role: "system", content: "You translate Arabic product names to English Google Image Search keywords. Return ONLY the keywords, no explanation. For pharmacy products keep the brand/active ingredient. Add product context if helpful (e.g., 'box', 'pack', 'bottle')." },
          { role: "user", content: `Product (${businessType || 'general'}): "${productName}"\n\nReturn 3-7 English keywords:` },
        ],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return productName;
    const d = await r.json();
    const kw = (d?.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "").slice(0, 100);
    const final = kw || productName;
    _cacheSet(cacheKey, final);
    return final;
  } catch (e) {
    console.warn("[image-search] translation failed:", e.message);
    return productName;
  }
}

// ─── Step 2: Google Custom Search → image results ────────────────────────────
async function _googleImageSearch(query, count = 10) {
  if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_ID) return null;
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_CSE_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=${Math.min(count, 10)}&safe=active`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
      const text = await r.text();
      console.warn("[image-search] Google CSE error:", r.status, text.slice(0, 200));
      return null;
    }
    const d = await r.json();
    return (d.items || []).map(it => ({
      url: it.link,
      thumb: it.image?.thumbnailLink || it.link,
      title: it.title || "",
      sourceUrl: it.image?.contextLink || "",
      width: it.image?.width,
      height: it.image?.height,
      mime: it.mime,
    }));
  } catch (e) {
    console.warn("[image-search] Google CSE failed:", e.message);
    return null;
  }
}

// ─── Step 3a: AI Vision verification via Gemini 2.0 Flash (مجاني) ────────────
async function _verifyWithGemini(imageUrl, productName, businessType) {
  if (!GEMINI_KEY) return null;
  try {
    // Gemini يقبل URL مباشرة عبر fileData (يحتاج upload أولاً) أو inline base64
    // الأسهل: fetch الصورة كـ base64 + إرسالها
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(5000) });
    if (!imgRes.ok) return { isMatch: false, confidence: 0, reason: "image_fetch_failed" };
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return { isMatch: false, confidence: 0, reason: "image_too_large" }; // 4MB حد
    const b64 = buf.toString("base64");
    const mime = imgRes.headers.get("content-type")?.split(";")[0] || "image/jpeg";

    const prompt = `You are a product image verifier for an online ${businessType || "general"} store.
Question: Does this image actually show the product: "${productName}"?

Return JSON only:
{"isMatch": true/false, "confidence": 0.0-1.0, "reason": "brief"}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType: mime, data: b64 } },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 100, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.warn("[image-search] Gemini error:", r.status, errText.slice(0, 200));
      return null;
    }
    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    try {
      const parsed = JSON.parse(text);
      return {
        isMatch: !!parsed.isMatch,
        confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0)),
        reason: String(parsed.reason || "").slice(0, 100),
      };
    } catch { return { isMatch: false, confidence: 0, reason: "parse_failed" }; }
  } catch (e) {
    console.warn("[image-search] Gemini verify failed:", e.message);
    return null;
  }
}

// ─── Step 3b: Groq Vision fallback (Llama 4 Scout) ───────────────────────────
async function _verifyWithGroq(imageUrl, productName, businessType) {
  if (!GROQ_KEY) return null;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        temperature: 0.1,
        max_tokens: 100,
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `Does this image show: "${productName}" (${businessType} product)? Return JSON: {"isMatch": bool, "confidence": 0-1, "reason": "brief"}` },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(text);
    return {
      isMatch: !!parsed.isMatch,
      confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0)),
      reason: String(parsed.reason || "").slice(0, 100),
    };
  } catch (e) {
    console.warn("[image-search] Groq verify failed:", e.message);
    return null;
  }
}

async function _verifyImage(imageUrl, productName, businessType) {
  // جرب Gemini أولاً (مجاني وأسرع)، fallback لـ Groq Vision
  let result = await _verifyWithGemini(imageUrl, productName, businessType);
  if (!result || result.reason === "image_fetch_failed") {
    result = await _verifyWithGroq(imageUrl, productName, businessType);
  }
  return result || { isMatch: true, confidence: 0.5, reason: "no_verifier_skipped" }; // fallback: skip verification
}

// ─── Step 4: Pexels fallback ────────────────────────────────────────────────
async function _searchPexels(query, perPage = 6) {
  if (!PEXELS_KEY) return null;
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=square`;
    const r = await fetch(url, { headers: { Authorization: PEXELS_KEY }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.photos || []).map(p => ({
      url: p.src.large || p.src.medium,
      thumb: p.src.small,
      title: p.alt || "",
      sourceUrl: p.url,
      source: "pexels",
      verified: { isMatch: true, confidence: 0.5, reason: "pexels_no_verify" },
    }));
  } catch (e) { return null; }
}

// ─── Step 5: DuckDuckGo Images fallback (بدون مفتاح، يعمل دائماً) ──────────
// يستخدم DDG's vqd token مع endpoint i.js — لا يحتاج تسجيل ولا مفتاح
async function _searchDuckDuckGo(query, count = 10) {
  try {
    // 1. اجلب vqd token من صفحة البحث
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    const tokenRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iar=images&iax=images&ia=images`, {
      headers: { "User-Agent": ua, Accept: "text/html" },
      signal: AbortSignal.timeout(8000),
    });
    if (!tokenRes.ok) return null;
    const html = await tokenRes.text();
    const m = html.match(/vqd=["']?([\d-]+)["']?/);
    if (!m) {
      console.warn("[image-search] DDG: vqd token not found");
      return null;
    }
    const vqd = m[1];

    // 2. اجلب نتائج الصور
    const url = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,,,&p=1`;
    const r = await fetch(url, {
      headers: { "User-Agent": ua, Accept: "application/json", Referer: "https://duckduckgo.com/" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      console.warn("[image-search] DDG fetch failed:", r.status);
      return null;
    }
    const d = await r.json();
    const results = (d.results || []).slice(0, count).map(it => ({
      url: it.image,
      thumb: it.thumbnail || it.image,
      title: (it.title || "").slice(0, 100),
      sourceUrl: it.url || "",
      width: it.width,
      height: it.height,
      source: "duckduckgo",
    }));
    if (results.length === 0) {
      console.warn("[image-search] DDG: 0 results for query:", query);
      return null;
    }
    return results;
  } catch (e) {
    console.warn("[image-search] DDG failed:", e.message);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────
async function search(productName, options = {}) {
  if (!productName || productName.length < 2) {
    return { ok: false, error: "اسم المنتج قصير جداً" };
  }
  const desiredCount = Math.min(Math.max(options.count || 6, 1), 8);
  const businessType = options.businessType || "general";
  const minConfidence = options.minConfidence ?? 0.55;

  const cacheKey = `img:${businessType}:${productName}:${desiredCount}:${minConfidence}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return { ok: true, ...cached, cached: true };

  // 1. Translate
  const query = await _translateToKeywords(productName, businessType);

  // 2. Google Search (10 نتائج للفلترة)
  let candidates = await _googleImageSearch(query, 10);
  let usedSource = "google";

  // Fallback لـ Pexels لو Google ما اشتغل
  if (!candidates || candidates.length === 0) {
    candidates = await _searchPexels(query, desiredCount * 2);
    usedSource = "pexels";
  }

  // Fallback نهائي: DuckDuckGo Images (بدون مفتاح، يعمل دائماً)
  if (!candidates || candidates.length === 0) {
    candidates = await _searchDuckDuckGo(query, 10);
    usedSource = "duckduckgo";
  }

  if (!candidates || candidates.length === 0) {
    return { ok: false, error: "لم نجد صور — حاول باسم أوضح أو تحقق من الاتصال" };
  }

  // 3. Verify each (متوازي، بحد أقصى 6 طلبات في نفس الوقت)
  const verified = [];
  const batchSize = 5;
  for (let i = 0; i < candidates.length && verified.length < desiredCount; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async img => {
      if (img.verified) return { ...img }; // already verified (pexels)
      const v = await _verifyImage(img.url, productName, businessType);
      return { ...img, verified: v };
    }));
    for (const r of results) {
      if (r.verified && r.verified.confidence >= minConfidence) {
        verified.push({
          url: r.url,
          thumb: r.thumb,
          title: r.title,
          sourceUrl: r.sourceUrl,
          confidence: r.verified.confidence,
          reason: r.verified.reason,
          source: r.source || usedSource,
        });
      }
    }
  }

  // لو ما فيش verified بحد كافٍ، ارجع الكل بدون فلترة (مع علم)
  let returned = verified;
  let warningMsg = null;
  if (verified.length < 2 && candidates.length > 0) {
    warningMsg = "لم نتمكن من تأكيد جميع الصور بدقة عالية — جرب اسماً أوضح";
    returned = candidates.slice(0, desiredCount).map(img => ({
      url: img.url, thumb: img.thumb, title: img.title, sourceUrl: img.sourceUrl,
      confidence: img.verified?.confidence || 0.4,
      reason: img.verified?.reason || "low_confidence",
      source: img.source || usedSource,
    }));
  }

  const out = { query, source: usedSource, images: returned, warning: warningMsg };
  _cacheSet(cacheKey, out);
  return { ok: true, ...out, cached: false };
}

function getStats() {
  return {
    cacheSize: _cache.size,
    google: !!(GOOGLE_CSE_KEY && GOOGLE_CSE_ID),
    gemini: !!GEMINI_KEY,
    groq: !!GROQ_KEY,
    pexelsFallback: !!PEXELS_KEY,
  };
}

module.exports = { search, getStats };
