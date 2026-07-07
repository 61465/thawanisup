/**
 * AI Intent Parser — Groq + Llama 3.3 70B
 *
 * يحلل رسائل العميل ويُرجع نية منظمة. Fast path للأرقام والكلمات الواضحة،
 * AI fallback للنصوص الطبيعية. لو فشل AI، نُرجع unknown — البوت يعود
 * للسلوك الافتراضي (buttons/lists).
 *
 * متغيرات البيئة:
 *   GROQ_API_KEY       — مفتاح Groq (مجاني من groq.com)
 *   GROQ_MODEL         — اختياري، افتراضي llama-3.3-70b-versatile
 *   AI_ENABLED         — "1" لتفعيل AI fallback، أي قيمة أخرى = معطل
 *   AI_TIMEOUT_MS      — اختياري، افتراضي 6000
 */

const GROQ_API_KEY  = process.env.GROQ_API_KEY || "";
const GROQ_MODEL    = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_FALLBACK = process.env.GROQ_FALLBACK || "llama-3.1-8b-instant"; // عند 429/timeout على الأساسي
const GROQ_URL      = "https://api.groq.com/openai/v1/chat/completions";
const AI_ENABLED    = process.env.AI_ENABLED === "1" && !!GROQ_API_KEY;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 6000;

// ─── Fast-path matchers (تُطبَّق بعد normalizeAr، فلا حاجة لأشكال الهمزة)
const KW_MENU    = /^(قاءمه|قاءمه\s*الطلب|اعرض\s*القاءمه|منيو|menu)$/i;
const KW_CART    = /^(سله|سلتي|عربه|cart|اعرض\s*السله|طلبي)$/i;
const KW_CONFIRM = /^(تاكيد|اكد|تمام|تم|اوكي|اوك|confirm|ok|done|خلص|انتهيت)$/i;
const KW_CANCEL  = /^(الغاء|الغ|بطل|cancel|stop|الغي\s*الطلب|ايقاف)$/i;
const KW_PATH_BTN = /^(1|اختيار|ازرار|buttons|تقليدي)$/i;
const KW_PATH_WEB = /^(2|رابط|لينك|link|webview|تفاعليه)$/i;
const KW_PATH_AI  = /^(3|كلام|كتابه|اكتب|ai|chat)$/i;

// 🔄 KW_RESTART — يفهم "طلب جديد" بكل اللهجات + إشارات التيه/الخطأ
// (تُطبَّق بعد normalizeAr فالكلمات هنا بدون همزات)
const KW_RESTART = new RegExp([
  "^(ابدا|ابدء|ابدا\\s*من\\s*جديد|من\\s*البدايه|البدايه|بدايه)",
  "^(طلب\\s*جديد|اطلب\\s*جديد|اعمل\\s*طلب\\s*جديد|اريد\\s*طلب\\s*جديد|عايز\\s*طلب\\s*جديد|بدي\\s*طلب\\s*جديد|ابغي\\s*طلب\\s*جديد)",
  "^(ابدا\\s*ثاني|ابدا\\s*تاني|من\\s*الاول|كرر\\s*البدايه)",
  "^(restart|reset|start\\s*over|new\\s*order|fresh\\s*start)$",
  "^(الغي\\s*و?ابدا|كانسل\\s*و?ابدا|انسي\\s*الطلب)",
  "^(الرءيسيه|الرءيسيه|الرءيسي|home|main)",
  // إشارات التيه/الخطأ — يفهم العميل الذي ضاع
  "(ضيعت|تهت|تايه|في\\s*مشكله|البوت\\s*معلق|ما\\s*رد|ما\\s*فهمت|مش\\s*فاهم|اعد\\s*من\\s*الاول|خلني\\s*ابدا)",
].join("|"), "i");

/**
 * يُرجع `{type, value}`. الأنواع المتوقعة:
 *   - "number"    → value = int
 *   - "path"      → value = "buttons" | "webview" | "ai"
 *   - "menu"      → عرض القائمة
 *   - "cart"      → عرض السلة
 *   - "confirm"   → تأكيد الطلب
 *   - "cancel"    → إلغاء
 *   - "add"       → value = [{name, qty}] — إضافة منتجات
 *   - "remove"    → value = {name} — حذف منتج
 *   - "update"    → value = {name, qty} — تعديل كمية
 *   - "question"  → value = نص السؤال (للرد العام)
 *   - "unknown"   → لم نفهم
 *
 * @param {string} text       — نص الرسالة من العميل
 * @param {object} session    — حالة الجلسة (step, cart, path, category)
 * @param {object} menuCtx    — { categories: string[], items: {[cat]: [{name, price}]} }
 */
// 🔤 Arabic normalization — يوحّد التشكيل وأشكال الهمزة قبل أي مطابقة
function normalizeAr(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, "")  // تشكيل + sukoon + tatweel
    .replace(/ـ/g, "")                  // ـ tatweel
    .replace(/[إأآٱ]/g, "ا")                  // كل أشكال الهمزة على الألف → ا
    .replace(/ى/g, "ي")                       // ألف مقصورة → ي
    .replace(/ؤ/g, "و")                       // واو + همزة → و
    .replace(/ئ/g, "ي")                       // ياء + همزة → ي
    .replace(/ة/g, "ه")                       // تاء مربوطة → هاء (للمقارنة فقط)
    .replace(/\s+/g, " ")
    .trim();
}

// 🛡️ Anti-adversarial: كشف محاولات prompt injection / spam / abusive input
function _detectAdversarial(text) {
  const t = String(text || "");
  // محاولة تجاوز التعليمات (prompt injection)
  if (/ignore\s+(previous|prior|above|all)|system\s*:|<\|im_start\|>|assistant\s*:|forget\s+(everything|instructions)/i.test(t)) {
    return { reason: "prompt_injection", action: "reject" };
  }
  // فقط رموز/إيموجي/symbols (spam visual)
  const stripped = t.replace(/[؀-ۿݐ-ݿa-zA-Z0-9\s]/g, "");
  if (stripped.length > 20 && stripped.length / Math.max(1, t.length) > 0.7) {
    return { reason: "symbol_spam", action: "ignore" };
  }
  // تكرار حرف مفرط (مثل اااااااا)
  if (/(.)\1{10,}/.test(t)) {
    return { reason: "char_flood", action: "ignore" };
  }
  // رسالة طويلة جداً (>2000 حرف = غير طبيعي للمنيو)
  if (t.length > 2000) {
    return { reason: "too_long", action: "truncate" };
  }
  // روابط مشبوهة (phishing patterns)
  if (/bit\.ly\/|tinyurl\.|t\.co\/|click\s*here|verify\s*account/i.test(t)) {
    return { reason: "suspicious_link", action: "flag" };
  }
  return null;
}

async function parseIntent(text, session = {}, menuCtx = null) {
  const raw  = String(text || "").trim();
  const norm = normalizeAr(raw); // ⭐ normalize كل اللهجات الآن

  // 🛡️ فحص رسائل عدائية قبل أي معالجة
  const adv = _detectAdversarial(raw);
  if (adv) {
    if (adv.action === "reject" || adv.action === "ignore") {
      return { type: "gibberish", value: null, _adversarial: adv.reason };
    }
    if (adv.action === "truncate") {
      // تابع بنص مقطوع
    } else if (adv.action === "flag") {
      return { type: "suspicious", value: null, _reason: adv.reason };
    }
  }

  // ── Fast path 1: رقم مباشر ────────────────────────────────────────────────
  if (/^\d{1,3}$/.test(raw)) {
    return { type: "number", value: parseInt(raw, 10) };
  }

  // ── Fast path 2: اختيار مسار البوت (أول رسالة) ────────────────────────────
  if (KW_PATH_BTN.test(norm)) return { type: "path", value: "buttons" };
  if (KW_PATH_WEB.test(norm)) return { type: "path", value: "webview" };
  if (KW_PATH_AI.test(norm))  return { type: "path", value: "ai" };

  // ── Fast path 3: كلمات صريحة ──────────────────────────────────────────────
  if (KW_RESTART.test(norm)) return { type: "restart" };  // 🔄 إعادة البدء — أولوية
  if (KW_MENU.test(norm))    return { type: "menu" };
  if (KW_CART.test(norm))    return { type: "cart" };
  if (KW_CONFIRM.test(norm)) return { type: "confirm" };
  if (KW_CANCEL.test(norm))  return { type: "cancel" };

  // ── AI fallback ────────────────────────────────────────────────────────────
  if (!AI_ENABLED) return { type: "unknown" };

  return await _aiClassify(raw, session, menuCtx);
}

// 🧠 AI cache — مفتاح: text + menu hash + step، TTL 5 دقائق
const _aiCache = new Map();
const AI_CACHE_TTL = 5 * 60 * 1000;
function _cacheKey(text, menuCtx, step) {
  const menuHash = menuCtx ? (menuCtx.categories || []).length + "|" + Object.keys(menuCtx.items || {}).length : "0";
  return `${step}|${menuHash}|${text.slice(0, 80).toLowerCase()}`;
}

async function _aiClassify(text, session, menuCtx) {
  // 🧠 Cache check (يشمل recent messages لتجنب رد قديم في سياق جديد)
  const recentMsgs = (session.recentMessages || []).slice(-3);
  const cacheKey = _cacheKey(text, menuCtx, session.step || "idle") + "|" + recentMsgs.map(m => m.slice(0,20)).join("→");
  const cached = _aiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AI_CACHE_TTL) {
    return cached.result;
  }
  // cleanup قديم كل بضع دقائق
  if (_aiCache.size > 500) {
    const cutoff = Date.now() - AI_CACHE_TTL;
    for (const [k, v] of _aiCache) if (v.ts < cutoff) _aiCache.delete(k);
  }

  const menuJson = menuCtx
    ? JSON.stringify(menuCtx)
    : '{"categories":[],"items":{}}';
  const cartJson = JSON.stringify(session.cart || []);
  const step     = session.step || "idle";
  const recentJson = JSON.stringify(recentMsgs);

  const systemPrompt =
`أنت العقل الذكي لبوت طلبات تجاري عربي. تفهم كل اللهجات العربية: المصرية، السعودية، الخليجية، الشامية، المغربية. ردك JSON صرف بـ"type" و"value".

السياق:
- المنيو: ${menuJson}
- السلة: ${cartJson}
- الخطوة: ${step}
- آخر رسائل من العميل (للسياق): ${recentJson}

اقرأ آخر رسائل العميل قبل أن تقرر. مثال: لو سأل "كم سعرها؟" بعد أن عرضت قائمة قهوة → عن القهوة.
لو قال "نفس الطلب الأخير" أو "نفس اللي طلبته قبل" → {"type":"reorder","value":null}

أمثلة شاملة:

عربي فصحى:
"اعرض القائمة" → {"type":"menu","value":null}
"السلة" → {"type":"cart","value":null}
"أكد الطلب" → {"type":"confirm","value":null}

عامية مصرية:
"عايز قهوة" → {"type":"add","value":[{"name":"قهوة","qty":1}]}
"هات لي اتنين شاي" → {"type":"add","value":[{"name":"شاي","qty":2}]}
"شيل الكنافة" → {"type":"remove","value":{"name":"كنافة"}}
"يلا تمام" → {"type":"confirm","value":null}
"بكام الكباب؟" → {"type":"question","value":"سعر الكباب"}
"بطل" → {"type":"cancel","value":null}

عامية سعودية/خليجية:
"ابغى قهوة" → {"type":"add","value":[{"name":"قهوة","qty":1}]}
"اكفي" أو "زين تمام" → {"type":"confirm","value":null}
"وش السعر؟" → {"type":"question","value":"السعر"}
"الغي الطلب" → {"type":"cancel","value":null}
"عطني المنيو" → {"type":"menu","value":null}

عامية شامية/عراقية:
"رح آخذ شاي" → {"type":"add","value":[{"name":"شاي","qty":1}]}
"شو في عندك" → {"type":"menu","value":null}
"خلص أكد" → {"type":"confirm","value":null}

كميات:
"3 شاي" أو "ثلاثة شاي" → qty=3
"اتنين قهوة" → qty=2
"خمسة كنافة" → qty=5

تعديل:
"خلي الشاي 4" → {"type":"update","value":{"name":"شاي","qty":4}}
"زود كنافة" → {"type":"update","value":{"name":"كنافة","qty":"+1"}}

كشف Spam/Off-topic:
"اهلا" "هلا" "السلام عليكم" → {"type":"greeting","value":null}
"كيف حالك" "عامل ايه" "شخبارك" → {"type":"smalltalk","value":null}
"asdkjasdh" "اااااا" "؟؟؟؟" → {"type":"gibberish","value":null}
"كم عمرك" "من انت" → {"type":"offtopic","value":null}
"بكره الجو" "الفلوس مين معاه" → {"type":"offtopic","value":null}

طلب مسؤول:
"اريد مسؤول" "عايز انسان" "human help" → {"type":"handoff","value":null}

إعادة البدء (مهم جداً — العميل تايه أو ضاعت سلته):
"اريد طلب جديد" "ابدأ من جديد" "كانسل وابدأ" → {"type":"restart","value":null}
"ضيعت" "تهت" "ما فهمت" "البوت معلق" → {"type":"restart","value":null}
"ابدأ ثاني" "من الأول" "fresh start" "reset" → {"type":"restart","value":null}

قواعد صارمة:
1. استخدم اسم المنتج من المنيو حرفياً
2. لا تخترع منتجات
3. لو ما فهمت → "unknown"
4. JSON فقط بدون شرح`;

  // محاولة بنموذجين متتاليين (لو فشل الأساسي 429/timeout يجرب الاحتياطي)
  for (const model of [GROQ_MODEL, GROQ_FALLBACK]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: text },
          ],
          max_tokens:       250,
          temperature:      0.2,
          response_format:  { type: "json_object" },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`[ai-parser] ${model} HTTP ${res.status} — trying fallback`);
        if (model === GROQ_FALLBACK) return _heuristicFallback(text);
        continue; // جرّب النموذج التالي
      }

      const data    = await res.json();
      const content = data.choices?.[0]?.message?.content || "{}";
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        console.warn(`[ai-parser] JSON parse failed. Raw: ${content.slice(0, 200)}`);
        if (model === GROQ_FALLBACK) return _heuristicFallback(text);
        continue;
      }

      if (typeof parsed?.type !== "string") {
        if (model === GROQ_FALLBACK) return _heuristicFallback(text);
        continue;
      }
      console.log(`[ai-parser:${model.slice(0,15)}] "${text.slice(0, 40)}" → ${parsed.type}${parsed.value ? ` ${JSON.stringify(parsed.value).slice(0,80)}` : ""}`);
      // 🧠 Cache the result
      _aiCache.set(cacheKey, { ts: Date.now(), result: parsed });
      return parsed;
    } catch (e) {
      clearTimeout(timer);
      console.warn(`[ai-parser] ${model} failed: ${e.message}`);
      if (model === GROQ_FALLBACK) return _heuristicFallback(text);
    }
  }
  return _heuristicFallback(text);
}

// ─── Heuristic fallback عند فشل AI تماماً (keyword matching ذكي) ─────────────
function _heuristicFallback(text) {
  const t = normalizeAr(text);
  // أرقام كميات + كلمات أكل/شرب شائعة
  const qtyMatch = t.match(/^(\d+|واحد|اثنين|ثلاثة|اربعة|خمسة|اتنين)\s*(.+)/);
  const numMap = { "واحد":1, "اثنين":2, "اتنين":2, "ثلاثة":3, "اربعة":4, "خمسة":5 };
  if (qtyMatch) {
    const qty = parseInt(qtyMatch[1]) || numMap[qtyMatch[1]] || 1;
    const name = qtyMatch[2].trim();
    if (name.length >= 2) return { type: "add", value: [{ name, qty }] };
  }
  // كلمات نية واضحة
  if (/(ع?ا?يز|ابغى|اريد|عاوز|بدي|اشتي|نفسي|محتاج).{1,30}/.test(t)) {
    const name = t.replace(/^(ع?ا?يز|ابغى|اريد|عاوز|بدي|اشتي|نفسي|محتاج)\s*/, "").trim();
    if (name.length >= 2) return { type: "add", value: [{ name, qty: 1 }] };
  }
  if (/(شيل|الغ|بطل|احذف|امسح)/.test(t)) {
    const name = t.replace(/^(شيل|الغ|بطل|احذف|امسح)\s*/, "").trim();
    if (name) return { type: "remove", value: { name } };
  }
  // 🔄 restart heuristic (للـ AI fallback)
  if (/(طلب\s*جديد|ابدا\s*من\s*جديد|من\s*البدايه|كانسل\s*و?ابدا|ضيعت|تهت|في\s*مشكله|البوت\s*معلق|اعد\s*من\s*الاول|restart|reset|new\s*order|fresh\s*start)/.test(t)) {
    return { type: "restart" };
  }
  if (/(تأكيد|تاكيد|اوكي|اوك|تمام|اكد|خلص|انتهيت)/.test(t)) return { type: "confirm" };
  if (/(الغ|بطل|ايقاف|stop|cancel)/.test(t)) return { type: "cancel" };
  if (/(منيو|قائم|menu|اعرض)/.test(t)) return { type: "menu" };
  if (/(سلة|عربة|cart|طلبي)/.test(t)) return { type: "cart" };
  if (/(اهلا|مرحب|هلا|سلام|hi|hello|صباح|مساء)/.test(t)) return { type: "greeting" };
  if (/(مسؤول|انسان|human|بشري)/.test(t)) return { type: "handoff" };
  if (/(كم|بكم|سعر|price)/.test(t)) return { type: "question", value: text.slice(0, 100) };
  if (/^(.{0,3}\?+|.{0,3}!+|[?!؟]+|ا{3,}|ه{3,})$/.test(t)) return { type: "gibberish" };
  return { type: "unknown" };
}

// ─── AI Time Parser — يفهم أوقاتاً عامية معقدة ───────────────────────────────
// يُستخدم كـ fallback إذا فشل rule-based parser في order-scheduler.js
// Returns: { type: "absolute" | "relative", minutes?: number, hour?: number, minute?: number } or null
async function aiParseTime(text) {
  if (!AI_ENABLED) return null;
  const raw = String(text || "").trim();
  if (!raw || raw.length > 80) return null;

  const systemPrompt =
`أنت محلل أوقات لعميل عربي يطلب طعاماً. حلل النص وأرجع JSON بالشكل المحدد فقط.

أنواع النية:
1. relative: وقت نسبي من الآن (مثل "بعد نص ساعة"، "خلال ربع ساعة"). value = عدد الدقائق
2. absolute: وقت محدد في اليوم (مثل "الساعة 7 مساء"، "9 الصبح"). value = HH:MM (24h)
3. unknown: لم تفهم

أمثلة:
- "بعد نص ساعة" → {"type":"relative","minutes":30}
- "نص ساعة" → {"type":"relative","minutes":30}
- "ربع ساعة" → {"type":"relative","minutes":15}
- "بعد ١٠ دقايق" → {"type":"relative","minutes":10}
- "خلال ساعة وشوية" → {"type":"relative","minutes":75}
- "بعد كم دقيقة بس" → {"type":"relative","minutes":10}
- "بعد شوي" → {"type":"relative","minutes":15}
- "ساعة 7 المسا" → {"type":"absolute","time":"19:00"}
- "بعد العصر" → {"type":"absolute","time":"16:30"}
- "كلام غير مفهوم xxxxx" → {"type":"unknown"}

أعد JSON صرف فقط بدون أي شرح أو نص إضافي.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:           GROQ_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: raw },
        ],
        max_tokens:       80,
        temperature:      0.1,
        response_format:  { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data    = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed  = JSON.parse(content);
    if (parsed?.type === "relative" && Number.isFinite(parsed.minutes) && parsed.minutes > 0 && parsed.minutes <= 1440) {
      console.log(`[ai-time] "${raw}" → +${parsed.minutes} min`);
      const d = new Date();
      d.setMinutes(d.getMinutes() + parsed.minutes);
      return d;
    }
    if (parsed?.type === "absolute" && typeof parsed.time === "string") {
      const m = parsed.time.match(/^(\d{1,2}):(\d{2})$/);
      if (m) {
        const h = parseInt(m[1], 10);
        const mn = parseInt(m[2], 10);
        if (h <= 23 && mn <= 59) {
          console.log(`[ai-time] "${raw}" → ${parsed.time}`);
          const d = new Date();
          d.setHours(h, mn, 0, 0);
          if (d <= new Date()) d.setDate(d.getDate() + 1);
          return d;
        }
      }
    }
    return null;
  } catch (e) {
    console.warn(`[ai-time] failed: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 🧠 parseIntentSmart — يستخدم NEXUS bot-intent agent للحالات المعقدة.
 *
 * Strategy:
 *   - رسالة قصيرة (≤4 كلمات) أو تطابق fast-path → parseIntent العادي (Groq وحده)
 *   - رسالة طويلة/معقدة + الإعداد NEXUS_BOT_BRAIN=1 → نستخدم NEXUS
 *   - إن فشل NEXUS، fallback لـ parseIntent العادي
 *
 * @param {string} text
 * @param {object} session
 * @param {object} storeContext — { storeName, businessType, products, categories }
 * @param {object} sessionContext — { step, cart, history }
 */
async function parseIntentSmart(text, session, storeContext = null, sessionContext = null) {
  // Fast path: لا shellot للنصوص القصيرة
  const wordCount = String(text || "").trim().split(/\s+/).length;
  const useNexus = process.env.NEXUS_BOT_BRAIN === "1" && wordCount > 4 && storeContext;
  if (!useNexus) return parseIntent(text, session);

  try {
    const nexus = require("./nexus/orchestrator");
    const result = await nexus.run("bot-intent", {
      message: text,
      storeContext,
      sessionContext: sessionContext || {},
    });
    // Map NEXUS output → ai-parser format
    return {
      type: result.intent || "unknown",
      value: result.entities || {},
      _smart: true,
      _provider: result.provider,
      _sentiment: result.sentiment,
      _reply: result.reply,
      _handoff: result.handoff,
      _confidence: result.confidence,
    };
  } catch (e) {
    console.warn("[ai-parser] NEXUS smart parse failed, fallback to Groq:", e.message);
    return parseIntent(text, session);
  }
}

// ─── AI Smart Fallback — يفهم ردود غير متوقعة على أسئلة البوت ──────────────
// يُستدعى من handleDynamicQuestion عند فشل validation الـ rule-based
// expectedType: number | date | choice | text | phone
// options: [] للـ choice
async function aiSmartFallback(question, userReply, expectedType, options) {
  if (!AI_ENABLED) return { understood: false, extracted: "", confidence: 0, interpretation: "AI disabled" };
  const raw = String(userReply || "").trim();
  if (!raw || raw.length > 200) {
    return { understood: false, extracted: "", confidence: 0, interpretation: "نص فارغ أو طويل جداً" };
  }
  const optionsBlock = (expectedType === "choice" && Array.isArray(options) && options.length)
    ? `\nالخيارات المتاحة: ${options.map((o,i)=>`${i+1}=${o}`).join(" | ")}`
    : "";
  const systemPrompt =
`أنت نظام فحص ذكي لردود بوت WhatsApp تجاري. تستخرج المعنى من رد العميل بصياغته العفوية.

تستقبل: سؤال البوت + رد العميل + نوع متوقع.
ترجع JSON فقط:
{
  "understood": true|false,
  "extracted": "<القيمة في الصيغة الصحيحة أو فارغ>",
  "confidence": 0-1
}

قواعد:
- number → extracted = رقم فقط (مثل "5")
- choice → extracted = الرقم 1-N للخيار المختار (إن كان expectedType="choice")
- date → extracted = "YYYY-MM-DD"
- phone → extracted = أرقام فقط مع كود الدولة
- text → extracted = النص الأصلي إن كان مفهوماً

تعامل مع لهجات سعودية/مصرية/خليجية.
رفض الكلمات غير المنطقية: { "understood": false, "extracted": "", "confidence": 0 }`;

  const userPrompt = `سؤال البوت: "${question}"
رد العميل: "${raw}"
نوع متوقع: ${expectedType}${optionsBlock}

أرجع JSON فقط.`;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL || "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 120,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { understood: false, extracted: "", confidence: 0, interpretation: `HTTP ${r.status}` };
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    return {
      understood: !!parsed.understood,
      extracted:  String(parsed.extracted || "").slice(0, 200),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
      interpretation: String(parsed.interpretation || "").slice(0, 200),
    };
  } catch (e) {
    return { understood: false, extracted: "", confidence: 0, interpretation: e.message };
  }
}

module.exports = {
  parseIntent,
  parseIntentSmart,
  aiParseTime,
  aiSmartFallback,
  normalizeAr,
  AI_ENABLED,
  GROQ_MODEL,
};
