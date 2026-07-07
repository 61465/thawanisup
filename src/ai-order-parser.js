/**
 * AI Order Parser — يحلل نص حر (عربي) لطلب مطعم
 * مثلاً: "أبغى شاورما دجاج كبير ثومية بدون مخلل" → {items:[{productId, qty, sizeIdx, options, excluded}]}
 *
 * يعمل لكل المطاعم/الكافيهات بدون إعداد خاص — يستخدم store.products الموجود + الـ schema الجديد:
 *   - p.sizes[]              — مطابقة "كبير"/"صغير"
 *   - p.modifiers[] / .options[] — مطابقة "ثومية"/"حار"
 *   - p.removableIngredients[]   — مطابقة "بدون مخلل"
 *
 * يعتمد Groq Llama 3.3-70B (نفس مفتاح ai-parser.js). يفشل بشكل آمن → unclear.
 */

const GROQ_API_KEY  = process.env.GROQ_API_KEY || "";
const GROQ_MODEL    = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_FALLBACK = process.env.GROQ_FALLBACK || "llama-3.1-8b-instant";
const GROQ_URL      = "https://api.groq.com/openai/v1/chat/completions";
const AI_TIMEOUT_MS = Number(process.env.AI_ORDER_TIMEOUT_MS) || 5000; // 5s أسرع للموبايل

// 💾 cache الـ menu prompt — نفس المتجر = نفس prompt (يوفر بناء الـ string كل مرة)
const _menuCache = new Map(); // storeId → { menu, productsHash, builtAt }
const _MENU_CACHE_TTL = 5 * 60_000; // 5 دقائق

// 🧠 Naraya/Bynara router (OpenAI-compatible)
const NARAYA_API_KEY = process.env.NARAYA_API_KEY || process.env.BYNARA_API_KEY || "";
const NARAYA_URL     = process.env.NARAYA_URL || "https://router.bynara.id/v1/chat/completions";

// 🎯 العقل الرئيسي: نموذج قوي يفهم اللهجات + النية + الأخطاء الإملائية بطبيعته
//    Claude Haiku 4.5 — أذكى نموذج عربي على Bynara
const PRIMARY_MODEL = process.env.AI_ORDER_PRIMARY || "claude-haiku-4-5";
// 🚀 المساعدون: نماذج أسرع للتصويت + fallback (لو الرئيسي تأخر)
const ASSIST_MODELS = (process.env.AI_ORDER_ASSISTANTS || "mistral-large-free,mimo-v2.5-free").split(",").map(s => s.trim()).filter(Boolean);

const { normalizeAr } = require("./ai-parser");

// ─── بناء ملخص مضغوط للمنتجات (≤ 2KB) ────────────────────────────────────
function _buildMenuPrompt(products, globalMods = []) {
  const lines = [];
  let charBudget = 1800;
  for (const p of products) {
    if (charBudget < 50) break;
    if (p.available === false) continue;
    const sizesTxt   = Array.isArray(p.sizes) && p.sizes.length
      ? ` | الأحجام: ${p.sizes.map((s, i) => `[${i}]${s.name}=${s.price||p.price}`).join("، ")}`
      : "";
    // إضافات المنتج الخاصة + الإضافات العامة المنطبقة عليه (productIds فارغة أو تحتوي p.id)
    const productMods = Array.isArray(p.modifiers) ? p.modifiers : (Array.isArray(p.options) ? p.options : []);
    const globalForP  = (Array.isArray(globalMods) ? globalMods : [])
      .filter(g => !Array.isArray(g.productIds) || g.productIds.length === 0 || g.productIds.includes(String(p.id)));
    const allMods = [...productMods, ...globalForP.map(g => ({ name: g.name, price: g.price }))];
    const modsTxt    = allMods.length
      ? ` | إضافات: ${allMods.map((m, i) => `[${i}]${m.name||m.label}=+${m.price||0}`).join("، ")}`
      : "";
    const remTxt     = Array.isArray(p.removableIngredients) && p.removableIngredients.length
      ? ` | قابل للإزالة: ${p.removableIngredients.join("، ")}`
      : "";
    const line = `${p.id}|${p.name}|${p.price||0} ر.س${sizesTxt}${modsTxt}${remTxt}`;
    if (line.length > charBudget) break;
    lines.push(line);
    charBudget -= line.length + 1;
  }
  return lines.join("\n");
}

const _SYS_PROMPT = `أنت موظف ذكي في مطعم/كافيه. مهمتك: قراءة رسائل الزبائن وتحويلها لطلب منظم.

أنت تفهم:
- كل اللهجات العربية (سعودي/مصري/شامي/خليجي/مغاربي)
- الأخطاء الإملائية ("شاورمه" = "شاورما"، "بطاطا" = "بطاطس")
- الاختصارات ("لارج" = كبير، "إكسترا" = زيادة، "شيلي" = بدون)
- النية الكاملة من سياق الكلام

📋 القائمة المتاحة (productId | اسم | سعر | الأحجام | الإضافات | المكونات القابلة للإزالة):
{{MENU}}

🎯 المطلوب — أَخرج JSON فقط:
{
  "items": [{
    "productId": "id من القائمة",
    "qty": عدد,
    "sizeIdx": رقم حجم (0 افتراضي),
    "options": [أرقام indices من الإضافات],
    "excluded": ["أسماء مكونات للإزالة"],
    "requestedName": "ما قاله العميل بالضبط",
    "customNotes": "أي تخصيص خاص بهذا المنتج لم يتناسب مع schema"
  }],
  "unclear": [{"item": "ما لم نفهمه", "reason": "السبب"}],
  "notes": "ملاحظات عامة للأدمن (تحيات، استفسارات، طلبات خاصة)"
}

✅ قواعد:
- اختر productId من القائمة فقط — لا تخترع IDs
- لو شيء غير موجود في القائمة → ضعه في unclear
- لو العميل طلب إضافة/إزالة غير معرّفة في الإعدادات → ضعها في customNotes للمنتج أو notes العام
- لو فيه غموض (اسمان متشابهان) → اسأل عبر unclear
- لا ترفض طلب صحيح بسبب modifier غير معرّف — اقبله مع customNotes

JSON فقط، بدون أي نص قبل أو بعد.`;

// ─── استدعاء عام لـ OpenAI-compatible endpoint مع timeout + AbortController مشترك ───
async function _callLLM({ url, apiKey, model, messages, label, signal: externalSignal }) {
  if (!apiKey) throw new Error(`${label} key missing`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  // 🛑 لو إشارة خارجية وصلت (race aborted)، أوقف الـ fetch
  if (externalSignal) {
    if (externalSignal.aborted) { clearTimeout(timer); throw new Error(`${label} aborted (race)`); }
    externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`${label} HTTP ${res.status}: ${t.slice(0, 120)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  } finally { clearTimeout(timer); }
}

// ─── Groq wrapper (الأساسي) ──────────────────────────────────────────────
const _callGroq = (messages, model, signal) =>
  _callLLM({ url: GROQ_URL, apiKey: GROQ_API_KEY, model: model || GROQ_MODEL, messages, label: "Groq", signal });

// ─── Naraya wrapper (للـ ensemble) ───────────────────────────────────────
const _callNaraya = (messages, model, signal) =>
  _callLLM({ url: NARAYA_URL, apiKey: NARAYA_API_KEY, model, messages, label: "Naraya:" + model, signal });

// ─── Ensemble voting: يجمع نتائج عدة نماذج ويختار الإجماع ───────────────
function _voteEnsemble(results) {
  // كل نتيجة: {items:[{productId,qty,sizeIdx,options[],excluded[]}], unclear:[]}
  // نُحوّل كل items لـ "signature" — لو الأغلبية يتفقون، نأخذ ذاك
  const valid = results.filter(r => r && Array.isArray(r.items));
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];

  // signature لكل item: productId|qty|sizeIdx|options_sorted|excluded_sorted
  const sigOf = (it) => [
    it.productId, it.qty, it.sizeIdx,
    (it.options || []).slice().sort((a,b) => a-b).join(","),
    (it.excluded || []).slice().sort().join(","),
  ].join("|");

  // عدّ الـ signatures عبر كل نموذج
  const orderSigCount = new Map(); // "sig1;sig2" sorted → count
  const orderToResult = new Map();
  for (const r of valid) {
    const sigs = (r.items || []).map(sigOf).sort().join(";");
    orderSigCount.set(sigs, (orderSigCount.get(sigs) || 0) + 1);
    if (!orderToResult.has(sigs)) orderToResult.set(sigs, r);
  }

  // أعلى تكرار = الإجماع
  let bestSig = null, bestCount = 0;
  for (const [sig, c] of orderSigCount) { if (c > bestCount) { bestCount = c; bestSig = sig; } }
  const winner = orderToResult.get(bestSig);
  // confidence: نسبة الموافقين
  winner._ensembleAgreement = bestCount / valid.length;
  winner._ensembleSize = valid.length;
  return winner;
}

// ─── Validation صارمة لمخرجات الـ LLM ────────────────────────────────────
function _validateAndSanitize(parsed, products) {
  const byId = new Map(products.map(p => [String(p.id), p]));
  const items = [];
  const unclear = Array.isArray(parsed.unclear)
    ? parsed.unclear.slice(0, 10).map(u => ({
        item:   String(u?.item || "").slice(0, 100) || "غير محدد",
        reason: String(u?.reason || "غير واضح").slice(0, 100),
      }))
    : [];
  let notes = String(parsed.notes || "").slice(0, 500);
  const extraNotes = []; // ⭐ ملاحظات تلقائية من الـ validator (excluded/options غير موجودة في schema)

  if (!Array.isArray(parsed.items)) return { items: [], unclear: [{ item: "AI response", reason: "missing items array" }], notes };

  for (const raw of parsed.items.slice(0, 20)) {
    if (!raw || typeof raw !== "object") continue;
    const prod = byId.get(String(raw.productId || ""));
    if (!prod) {
      const displayName = String(raw.requestedName || raw.productId || "").slice(0, 60) || "منتج غير معروف";
      unclear.push({ item: displayName, reason: "غير موجود في القائمة" });
      continue;
    }
    if (prod.available === false) {
      unclear.push({ item: prod.name, reason: "غير متاح حالياً" });
      continue;
    }

    const qty = Math.max(1, Math.min(99, parseInt(raw.qty, 10) || 1));
    let sizeIdx = parseInt(raw.sizeIdx, 10);
    if (!Array.isArray(prod.sizes) || !Number.isFinite(sizeIdx) || sizeIdx < 0 || sizeIdx >= prod.sizes.length) sizeIdx = 0;

    const modsArr = Array.isArray(prod.modifiers) ? prod.modifiers : (Array.isArray(prod.options) ? prod.options : []);
    const options = [];
    const rejectedOpts = [];
    if (Array.isArray(raw.options)) {
      for (const i of raw.options) {
        const idx = parseInt(i, 10);
        if (Number.isFinite(idx) && idx >= 0 && idx < modsArr.length) options.push(idx);
        else if (typeof i === "string") rejectedOpts.push(i);
      }
    }
    if (rejectedOpts.length) extraNotes.push(`${prod.name}: زيادة ${rejectedOpts.join("، ")}`);

    // 🔥 excluded: نقبل أي مكوّن (حتى لو غير معرّف في removableIngredients)
    // الأدمن سيراه ويتصرف. علامة removable=true لو معرّف، false لو "ملاحظة عميل"
    const removableSet = new Set(Array.isArray(prod.removableIngredients) ? prod.removableIngredients : []);
    const excluded = [];
    if (Array.isArray(raw.excluded)) {
      for (const s of raw.excluded) {
        if (typeof s !== "string") continue;
        const clean = s.trim().slice(0, 50);
        if (clean) excluded.push(clean);
      }
    }
    // ملاحظة للأدمن: المكونات التي ليست في removableIngredients (تخصيص خاص من العميل)
    const customExcl = excluded.filter(s => !removableSet.has(s));
    if (customExcl.length) extraNotes.push(`${prod.name}: بدون ${customExcl.join("، ")} (طلب خاص)`);

    // 📝 customNotes من الـ AI (تخصيصات لا تُلائم schema)
    const customNotes = String(raw.customNotes || "").slice(0, 200);
    if (customNotes) extraNotes.push(`${prod.name}: ${customNotes}`);

    items.push({ productId: String(prod.id), name: prod.name, qty, sizeIdx, options, excluded, customNotes: customNotes || undefined });
  }

  // دمج extraNotes مع notes الأصلية
  if (extraNotes.length) {
    const auto = "ملاحظات إضافية (لم تكن مُعرَّفة): " + extraNotes.join(" • ");
    notes = notes ? (notes + " | " + auto) : auto;
  }

  return { items, unclear, notes };
}

/**
 * المحلّل الرئيسي — يستقبل نص + متجر، يُرجع طلب منظم.
 * @returns {{items: Array, unclear: Array, confidence: number, fallback: boolean}}
 */
async function parseFreeTextOrder(text, store) {
  const normalized = String(text || "").trim();
  if (!normalized || normalized.length > 1000) {
    return { items: [], unclear: [{ item: normalized.slice(0, 50), reason: "نص فارغ أو طويل جداً" }], confidence: 0 };
  }
  if (!store?.products || !Array.isArray(store.products) || !store.products.length) {
    return { items: [], unclear: [{ item: "", reason: "لا منتجات في المتجر" }], confidence: 0 };
  }
  if (!GROQ_API_KEY) {
    return { items: [], unclear: [{ item: normalized.slice(0, 50), reason: "AI_DISABLED" }], confidence: 0 };
  }

  // 💾 cache menu prompt للمتجر
  const storeId = store.storeId || store.id || "_";
  const gmHash = Array.isArray(store.globalModifiers) ? store.globalModifiers.map(g => g.name+":"+g.price).join(",") : "";
  const productsHash = (store.products || []).map(p => p.id + ":" + (p.name||"") + ":" + (p.sizes?.length||0)).join("|") + "|gm:" + gmHash;
  let menu;
  const cached = _menuCache.get(storeId);
  if (cached && cached.productsHash === productsHash && Date.now() - cached.builtAt < _MENU_CACHE_TTL) {
    menu = cached.menu;
  } else {
    menu = _buildMenuPrompt(store.products, store.globalModifiers);
    _menuCache.set(storeId, { menu, productsHash, builtAt: Date.now() });
  }
  const sysContent = _SYS_PROMPT.replace("{{MENU}}", menu);
  const messages = [
    { role: "system", content: sysContent },
    { role: "user",   content: `حلل هذا الطلب: ${normalized}` },
  ];

  // 🎯 العقل الرئيسي + مساعدون مع AbortController مشترك
  //    أول نموذج يرد بنتيجة صالحة → نقطع الباقي → سرعة قصوى
  const raceController = new AbortController();
  const calls = [];
  if (NARAYA_API_KEY) {
    calls.push(_callNaraya(messages, PRIMARY_MODEL, raceController.signal).catch(() => null));
    for (const m of ASSIST_MODELS) {
      calls.push(_callNaraya(messages, m, raceController.signal).catch(() => null));
    }
  }
  if (GROQ_API_KEY) {
    calls.push(_callGroq(messages, GROQ_MODEL, raceController.signal).catch(() => null));
  }
  if (!calls.length) {
    return { items: [], unclear: [{ item: normalized.slice(0, 50), reason: "AI_DISABLED" }], confidence: 0 };
  }

  // ⚡ race: أول من يرد بنتيجة فيها items → خذها فوراً + abort الباقي
  let winner = null;
  await new Promise(resolve => {
    let completed = 0;
    const tryFinish = () => { if (!winner) winner = null; resolve(); };
    calls.forEach((p) => {
      p.then(raw => {
        completed++;
        if (winner) return; // أحدهم سبق
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            const v = _validateAndSanitize(parsed, store.products);
            if (v.items?.length > 0) {
              winner = v;
              raceController.abort(); // اقطع الباقي
              resolve();
              return;
            }
          } catch {}
        }
        if (completed === calls.length) { tryFinish(); }
      });
    });
    // hard timeout 5s
    setTimeout(() => resolve(), AI_TIMEOUT_MS);
  });

  // لو ما فاز أحد → ننتظر كل النتائج ونصوّت (لـ unclear)
  let rawResults;
  if (winner) {
    rawResults = [JSON.stringify({ items: winner.items, unclear: winner.unclear, notes: winner.notes })];
  } else {
    const allSettled = await Promise.allSettled(calls);
    rawResults = allSettled.map(s => s.status === "fulfilled" ? s.value : null);
  }
  const parsedResults = [];
  for (const raw of rawResults) {
    if (!raw) continue;
    try {
      const p = JSON.parse(raw);
      const v = _validateAndSanitize(p, store.products);
      parsedResults.push(v);
    } catch { /* skip invalid JSON */ }
  }

  if (!parsedResults.length) {
    return { items: [], unclear: [{ item: normalized.slice(0, 50), reason: "AI_FAILED" }], confidence: 0 };
  }

  // اختر بالتصويت (لو winner من الـ race السابق موجود → نستخدمه مباشرة)
  const final = winner || _voteEnsemble(parsedResults) || parsedResults[0];
  const total = final.items.length + (final.unclear?.length || 0);
  const baseConf = total > 0 ? final.items.length / total : 0;
  const agreement = final._ensembleAgreement ?? 1;
  const confidence = Math.round(baseConf * agreement * 100) / 100;

  return {
    items:      final.items,
    unclear:    final.unclear || [],
    notes:      final.notes || "",
    confidence,
    ensemble:   { agreement, models: final._ensembleSize || 1 },
  };
}

module.exports = { parseFreeTextOrder, _buildMenuPrompt, _validateAndSanitize };
