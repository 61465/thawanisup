/**
 * Subscription Plans — يقرأ من owner-settings.json ديناميكياً
 * ويعود للقيم الافتراضية إذا لم يجد الملف
 */

const fs   = require("fs");
const path = require("path");

const SETTINGS_FILE = path.join(__dirname, "..", "data", "owner-settings.json");

// ⚡ v3: ميزات v3 (storefront + integration + cart-abandonment)
//   - storefront: المتجر العلني (يخدم /store/:slug)
//   - integration: الربط الذكي بين البوت والمتجر (Owner Report, cart resume, إلخ)
//   - cartAbandonment: استرداد السلات المتروكة تلقائياً عبر واتس
//
// ⚡ track: مسار الباقة — يحدد أي مجموعة tabs تظهر
//   - "cart":   متجر علني فقط (لا بوت)
//   - "bot":    بوت واتساب فقط (لا متجر علني)
//   ⚠️ "bundle" ألغيت 2026-06-23 — أي إشارة قديمة تُحوَّل إلى "bot"
const DEFAULT_PLANS = {
  starter: {
    id: "starter", nameAr: "الأساسية", nameEn: "Starter", emoji: "🌱", color: "#6b7280",
    track: "bot",
    features: {
      adminPanel: true, invoiceImage: false, customerRegistry: false, stripe: false,
      storefront: false, integration: false, cartAbandonment: false,
    },
  },
  pro: {
    id: "pro", nameAr: "الاحترافية", nameEn: "Pro", emoji: "⭐", color: "#1b5e20",
    track: "bot",
    features: {
      adminPanel: true, invoiceImage: true, customerRegistry: true, stripe: false, webOrder: true,
      storefront: true, integration: false, cartAbandonment: false,
    },
  },
  premium: {
    id: "premium", nameAr: "المتقدمة", nameEn: "Premium", emoji: "👑", color: "#C9A24B",
    track: "bot",
    features: {
      adminPanel: true, invoiceImage: true, customerRegistry: true, stripe: true, webOrder: true,
      storefront: true, integration: false, cartAbandonment: false,
    },
  },
  // 🚀 الباقة الجديدة: التكامل الكامل بين البوت والمتجر
  full_integration: {
    id: "full_integration", nameAr: "التكامل الكامل", nameEn: "Full Integration", emoji: "🚀", color: "#0ea5e9",
    track: "bot",
    features: {
      adminPanel: true, invoiceImage: true, customerRegistry: true, stripe: true, webOrder: true,
      storefront: true, integration: true, cartAbandonment: true,
      crossSell: true, unifiedCustomerView: true,
    },
  },
};

// الـ tracks المسموحة — bundle ألغيت، فقط cart أو bot
const ALLOWED_TRACKS = ["cart", "bot"];

function normalizeTrack(t) {
  // bundle (التاريخي) → bot افتراضياً
  if (t === "bundle") return "bot";
  return ALLOWED_TRACKS.includes(t) ? t : "bot";
}

// Returns plans from owner-settings (dynamic — يدعم plans مخصصة من الماستر)
function getPlansFromFile() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (!raw.plans || typeof raw.plans !== "object") return null;
    return raw.plans;
  } catch { return null; }
}

// Returns all plans (custom + default fallback) كقاموس
// 🔄 الـ file يطغى لكن لا يحذف plans أصلية — defaults تكمل ما هو مفقود من الـ file
function getAllPlans() {
  const file = getPlansFromFile();
  const out = {};
  // 1) ابدأ بكل plans في defaults (لضمان وجود full_integration حتى لو الـ file لا يحويها)
  for (const [id, def] of Object.entries(DEFAULT_PLANS)) {
    out[id] = { ...def };
  }
  // 2) دمج overrides من الـ file (لا يحذف plans غير موجودة فيه)
  if (file && Object.keys(file).length > 0) {
    for (const [id, p] of Object.entries(file)) {
      out[id] = {
        id,
        nameAr:  p.nameAr  || DEFAULT_PLANS[id]?.nameAr  || id,
        nameEn:  DEFAULT_PLANS[id]?.nameEn || p.nameEn || id,
        emoji:   p.emoji   || DEFAULT_PLANS[id]?.emoji   || "📦",
        color:   DEFAULT_PLANS[id]?.color || p.color || "#6b7280",
        price:   p.price ?? 0,
        track:   normalizeTrack(p.track || DEFAULT_PLANS[id]?.track),
        features: { ...DEFAULT_PLANS[id]?.features, ...(p.sysFeatures || p.features || {}) },
      };
    }
  }
  return out;
}

function getPlanTrack(planId) {
  return normalizeTrack(getPlan(planId).track);
}

function getPlan(planId) {
  const all = getAllPlans();
  if (all[planId]) return all[planId];
  // fallback: أول باقة متاحة (لأن الماستر قد يحذف starter)
  const first = Object.values(all)[0];
  return first || DEFAULT_PLANS.starter;
}

function getPlanFeatures(planId) {
  return getPlan(planId).features;
}

function hasFeature(planId, feature) {
  return !!getPlanFeatures(planId)[feature];
}

// Keep PLANS for backward compat (used by master-router GET /master/plans)
const PLANS = DEFAULT_PLANS;

module.exports = { PLANS, DEFAULT_PLANS, ALLOWED_TRACKS, normalizeTrack, getPlan, getPlanFeatures, getPlanTrack, hasFeature, getAllPlans };
