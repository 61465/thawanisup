/**
 * server-helpers — pure utility functions extracted from server.js (Phase 1)
 * No side effects, no I/O, no dependencies on app state.
 * Used by server.js, store-router.js, storefront-router.js.
 */

// ─── Business type ──────────────────────────────────────────────────────────
function getBusinessType(store) {
  return store?.businessType || "delivery";
}

// 🕐 هل نسأل العميل عن وقت التسليم؟
function shouldAskDeliveryTime(store) {
  if (store?.askDeliveryTime === false) return false;
  if (store?.askDeliveryTime === true)  return true;
  const btype = getBusinessType(store);
  if (["homeService", "walkin", "booking", "service", "salon"].includes(btype)) return true;
  return false;
}

// 🕐 يحسب نص ETA للمتاجر — يدعم دقائق/ساعات/أيام
// unit: "minute" (default) | "hour" | "day"
function computeETAText(store) {
  const raw = Number(store?.avgDeliveryMin) || Number(store?.estimatedMinutes) || 30;
  const unit = String(store?.deliveryTimeUnit || "minute").toLowerCase();
  // 🎯 وحدة دقائق (default) — عرض بوقت وصول تقديري
  if (unit === "minute") {
    try {
      const eta = new Date(Date.now() + raw * 60000);
      const fmt = eta.toLocaleTimeString("ar-EG", {
        timeZone: process.env.TZ || "Asia/Riyadh",
        hour: "2-digit", minute: "2-digit", hour12: true,
      });
      return `خلال ${raw} دقيقة (≈ ${fmt})`;
    } catch { return `خلال ${raw} دقيقة`; }
  }
  // 🕐 وحدة ساعات
  if (unit === "hour") {
    if (raw === 1) return "خلال ساعة واحدة";
    if (raw === 2) return "خلال ساعتين";
    if (raw <= 10) return `خلال ${raw} ساعات`;
    return `خلال ${raw} ساعة`;
  }
  // 📅 وحدة أيام
  if (unit === "day") {
    if (raw === 1) return "خلال يوم واحد";
    if (raw === 2) return "خلال يومين";
    if (raw <= 10) return `خلال ${raw} أيام`;
    return `خلال ${raw} يوم`;
  }
  return `خلال ${raw}`;
}

// 🕐 يحسب نص مختصر للـ chip (بلا "خلال" وبلا وقت وصول)
// أمثلة: "25-35 دقيقة" | "2 يوم" | "3 ساعات"
function computeETAChipText(store) {
  const raw = Number(store?.avgDeliveryMin) || 30;
  const unit = String(store?.deliveryTimeUnit || "minute").toLowerCase();
  if (unit === "minute") {
    return `${Math.max(15, raw - 5)}–${raw + 5} دقيقة`;
  }
  if (unit === "hour") {
    if (raw === 1) return "ساعة";
    if (raw === 2) return "ساعتين";
    return `${raw} ساعات`;
  }
  if (unit === "day") {
    if (raw === 1) return "يوم";
    if (raw === 2) return "يومين";
    return `${raw} أيام`;
  }
  return String(raw);
}

// labels حسب نوع النشاط — needsLocation/feeLabel/timeLabel/locationPrompt
function businessLabels(btype) {
  const t = String(btype || "").toLowerCase();
  if (t === "rental" || t.includes("تأجير") || t.includes("شاليه") || t.includes("منزل") || t.includes("استراحة") || t.includes("فيلا") || t.includes("فلل")) {
    return { needsLocation: false, feeLabel: null, timeLabel: "الوصول", locationPrompt: null };
  }
  switch (btype) {
    case "pickup":      return { needsLocation: false, feeLabel: null,            timeLabel: "الاستلام",  locationPrompt: null };
    case "homeService": return { needsLocation: true,  feeLabel: "رسوم الخدمة",   timeLabel: "الخدمة",    locationPrompt: "أرسل موقعك للخدمة" };
    case "walkin":      return { needsLocation: false, feeLabel: null,            timeLabel: "الموعد",    locationPrompt: null };
    case "booking":     return { needsLocation: false, feeLabel: null,            timeLabel: "الموعد",    locationPrompt: null };
    default:            return { needsLocation: true,  feeLabel: "رسوم التوصيل",  timeLabel: "التوصيل",   locationPrompt: "أرسل موقعك للتوصيل" };
  }
}

// ─── Text validation ────────────────────────────────────────────────────────
function isGibberish(text) {
  const s = String(text || "").trim();
  if (s.length < 2) return false;
  if (/(.)\1{4,}/.test(s)) return true;
  if (s.length >= 9) {
    const unique = new Set(s.toLowerCase().replace(/\s/g, "")).size;
    if (unique / s.replace(/\s/g, "").length < 0.3) return true;
  }
  const hasLetters = /[؀-ۿa-zA-Z]/.test(s);
  if (!hasLetters && s.length >= 4) return true;
  return false;
}

function isOffTopicQuery(text) {
  const s = String(text || "").trim().toLowerCase();
  if (s.length < 3) return false;
  const patterns = [
    /(ما|ايش|إيش|شو|وش)\s*اسمك/i,
    /كم\s*عمرك/i,
    /من\s*انت/i,
    /(انت|أنت)\s*(بوت|روبوت|انسان|إنسان|آلة)/i,
    /تحكي\s*عربي/i,
    /(الطقس|الجو|weather)/i,
    /كيف\s*حالك/i,
    /كيف\s*الحال/i,
    /(صباح|مساء)\s*(الخير|الفل|النور)/i,
    /^(haha|hehe|lol|🤣|😂|hi|hello|مرحبا)$/i,
    /(تحب|بتحب)\s*(ال|أ|إ)/i,
  ];
  return patterns.some(p => p.test(s));
}

function isValidName(text) {
  const s = String(text || "").trim();
  if (s.length < 2 || s.length > 80) return false;
  if (isGibberish(s) || isOffTopicQuery(s)) return false;
  if (!/[؀-ۿa-zA-Z]/.test(s)) return false;
  if (/^[\d\s]+$/.test(s)) return false;
  return true;
}

function isEditIntent(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s || s.length > 50) return false;
  return /(تعديل|تعدل|عدل|تغيير|غير|رجوع|ارجع|إرجع|عودة|عود|back|edit|change|modify|cancel)/i.test(s);
}

function isValidLocation(text) {
  if (!text || text.trim().length < 3) return false;
  if (/maps\.google\.com|goo\.gl\/maps|maps\.app\.goo\.gl|google\.com\/maps/.test(text)) return true;
  if (text.startsWith("📍")) return true;
  return text.trim().length >= 3;
}

// ─── Product/Stock ──────────────────────────────────────────────────────────
function isProductInStock(p) {
  if (!p || p.available === false) return false;
  return p.stock === null || p.stock === undefined || p.stock > 0;
}

// ─── Strings ────────────────────────────────────────────────────────────────
function truncate(str, max) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

// Strip WhatsApp JID suffixes — keeps full JID for sending, returns plain phone
function phoneNum(jid) {
  return (jid || "").replace(/@s\.whatsapp\.net|@lid/g, "");
}

module.exports = {
  getBusinessType,
  shouldAskDeliveryTime,
  computeETAText,
  computeETAChipText,
  businessLabels,
  isGibberish,
  isOffTopicQuery,
  isValidName,
  isEditIntent,
  isValidLocation,
  isProductInStock,
  truncate,
  phoneNum,
};
