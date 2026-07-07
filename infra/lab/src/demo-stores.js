/**
 * Demo Stores — متاجر تجريبية لـ try slots (للديمو على GitHub Pages)
 *
 * 3 قطاعات جاهزة: pharmacy, grocery, cafe
 * كل متجر له منتجات + أصناف ثابتة
 *
 * عند /try/init?sector=X:
 *   - يحجز slot من try_1..5
 *   - يربط slot بـ demo_X
 *   - عند وصول رسالة على slot، يستخدم بيانات demo_X
 *
 * عند /try/orders/:slotId:
 *   - يرجع آخر الطلبات على demo_X الخاص بالـ slot
 *
 * بيانات الديمو غير محفوظة في stores.json — تُبنى في الذاكرة عند الطلب
 * والطلبات تُحفظ في data/orders_demo_<sector>.jsonl
 */

const DEMO_STORES = {
  pharmacy: {
    id: "demo_pharmacy",
    storeName: "صيدلية الديمو 💊",
    storeType: "صيدلية",
    businessType: "pharmacy",
    currency: "ر.س",
    deliveryFee: 10,
    active: true,
    subscriptionStatus: "active",
    plan: "premium",
    workingHoursStart: "00:00",
    workingHoursEnd: "23:59",
    // ⚠️ ديمو: لا مالك (يمنع إشعارات لأي رقم)، علامة isDemo للفحص في الـ handlers
    ownerPhone: "",
    ownerName:  "",
    isDemo:     true,
    welcomeMessage: "أهلاً بك في *صيدلية الديمو* 💊\nاكتب: *قائمة* لتصفّح المنتجات",
    invoiceColor: "#0ea5e9",
    enableNumeric: true,
    enableAI: false,
    enableCoupons: false,
    categories: [
      { id: "c1", name: "مسكنات وخافضات حرارة", emoji: "💊" },
      { id: "c2", name: "فيتامينات ومكملات",   emoji: "🍊" },
      { id: "c3", name: "عناية شخصية",          emoji: "🧴" },
      { id: "c4", name: "عناية بالأطفال",       emoji: "🍼" },
    ],
    products: [
      { id: "p1",  name: "بنادول إكسترا 24 قرص",     category: "c1", price: 15, available: true },
      { id: "p2",  name: "بروفين 400 مج 30 قرص",      category: "c1", price: 18, available: true },
      { id: "p3",  name: "أسبرين 100 مج 30 قرص",      category: "c1", price: 12, available: true },
      { id: "p4",  name: "فيتامين C 1000 60 قرص",     category: "c2", price: 45, available: true },
      { id: "p5",  name: "فيتامين D3 50000 وحدة",     category: "c2", price: 35, available: true },
      { id: "p6",  name: "حديد فيروجلوبين كبسولات",    category: "c2", price: 55, available: true },
      { id: "p7",  name: "شامبو هيد آند شولدرز 600مل", category: "c3", price: 38, available: true },
      { id: "p8",  name: "صابون ديتول 4 قطع",          category: "c3", price: 22, available: true },
      { id: "p9",  name: "معجون أسنان سيجنال 100مل",   category: "c3", price: 14, available: true },
      { id: "p10", name: "حفاضات هاجيز مقاس 4 (66)",   category: "c4", price: 89, available: true },
      { id: "p11", name: "حليب نان ستيب 1 (400غ)",     category: "c4", price: 65, available: true },
      { id: "p12", name: "كريم سودوكريم 250غ",          category: "c4", price: 42, available: true },
    ],
  },

  grocery: {
    id: "demo_grocery",
    storeName: "بقالة الديمو 🛒",
    storeType: "بقالة",
    businessType: "grocery",
    currency: "ر.س",
    deliveryFee: 15,
    active: true,
    subscriptionStatus: "active",
    plan: "premium",
    workingHoursStart: "00:00",
    workingHoursEnd: "23:59",
    // ⚠️ ديمو: لا مالك (يمنع إشعارات لأي رقم)، علامة isDemo للفحص في الـ handlers
    ownerPhone: "",
    ownerName:  "",
    isDemo:     true,
    welcomeMessage: "أهلاً بك في *بقالة الديمو* 🌴\nاختر من الأصناف أو اكتب اسم المنتج",
    invoiceColor: "#16a34a",
    enableNumeric: true,
    enableAI: false,
    enableCoupons: false,
    categories: [
      { id: "c1", name: "ألبان وأجبان", emoji: "🥛" },
      { id: "c2", name: "خبز ومخبوزات", emoji: "🥖" },
      { id: "c3", name: "مشروبات",      emoji: "🥤" },
      { id: "c4", name: "منظفات",       emoji: "🧴" },
    ],
    products: [
      { id: "p1",  name: "حليب المراعي طويل الأجل 1 لتر", category: "c1", price: 6,  available: true },
      { id: "p2",  name: "جبن بوك كرتون 200غ",             category: "c1", price: 12, available: true },
      { id: "p3",  name: "زبادي المراعي طبيعي 170غ",        category: "c1", price: 3,  available: true },
      { id: "p4",  name: "خبز عربي أبيض كيس",               category: "c2", price: 4,  available: true },
      { id: "p5",  name: "توست صموني أسمر",                 category: "c2", price: 8,  available: true },
      { id: "p6",  name: "كرواسون بالشوكولاتة 4 قطع",        category: "c2", price: 18, available: true },
      { id: "p7",  name: "مياه نوفا 1.5 لتر × 6",            category: "c3", price: 12, available: true },
      { id: "p8",  name: "بيبسي 2 لتر",                      category: "c3", price: 8,  available: true },
      { id: "p9",  name: "عصير المراعي برتقال 1 لتر",        category: "c3", price: 7,  available: true },
      { id: "p10", name: "صابون فيري سائل 750مل",            category: "c4", price: 16, available: true },
      { id: "p11", name: "تايد مسحوق غسيل 5كغ",              category: "c4", price: 65, available: true },
      { id: "p12", name: "كلوركس 3 لتر",                     category: "c4", price: 22, available: true },
    ],
  },

  cafe: {
    id: "demo_cafe",
    storeName: "كافيه الديمو ☕",
    storeType: "كافيه",
    businessType: "cafe",
    currency: "ر.س",
    deliveryFee: 12,
    active: true,
    subscriptionStatus: "active",
    plan: "premium",
    workingHoursStart: "00:00",
    workingHoursEnd: "23:59",
    // ⚠️ ديمو: لا مالك (يمنع إشعارات لأي رقم)، علامة isDemo للفحص في الـ handlers
    ownerPhone: "",
    ownerName:  "",
    isDemo:     true,
    welcomeMessage: "أهلاً وسهلاً في *كافيه الديمو* ☕\nقهوة طازجة وحلويات شهية",
    invoiceColor: "#d4af37",
    enableNumeric: true,
    enableAI: false,
    enableCoupons: false,
    categories: [
      { id: "c1", name: "قهوة ساخنة",  emoji: "☕" },
      { id: "c2", name: "قهوة باردة",  emoji: "🧊" },
      { id: "c3", name: "حلويات",      emoji: "🍰" },
      { id: "c4", name: "وجبات خفيفة", emoji: "🥪" },
    ],
    products: [
      { id: "p1",  name: "إسبريسو سنجل",        category: "c1", price: 10, available: true },
      { id: "p2",  name: "كابتشينو",           category: "c1", price: 15, available: true },
      { id: "p3",  name: "لاتيه",              category: "c1", price: 17, available: true },
      { id: "p4",  name: "موكا بالشوكولاتة",    category: "c1", price: 19, available: true },
      { id: "p5",  name: "آيس لاتيه",          category: "c2", price: 18, available: true },
      { id: "p6",  name: "كولد برو",           category: "c2", price: 22, available: true },
      { id: "p7",  name: "فرابتشينو كراميل",    category: "c2", price: 24, available: true },
      { id: "p8",  name: "تشيز كيك فراولة",     category: "c3", price: 28, available: true },
      { id: "p9",  name: "براوني شوكولاتة",      category: "c3", price: 22, available: true },
      { id: "p10", name: "كروسان سادة",         category: "c3", price: 12, available: true },
      { id: "p11", name: "ساندويتش تركي",       category: "c4", price: 32, available: true },
      { id: "p12", name: "كيك جزر",             category: "c3", price: 25, available: true },
    ],
  },
};

// ─── slot → sector mapping (مع persist على القرص) ───────────────────────────
// عند /try/init?sector=X يُسجّل، وعند رسالة على الـ slot يُستخدم لاختيار المتجر
// ⚠️ يجب يبقى persistent: pm2 reload يمسح in-memory، لكن creds.json على القرص
//    تبقى → الجلسة تستمر بدون sector → fallback يستخدم متجر حقيقي = كارثة
const fs   = require("fs");
const path = require("path");

const DATA_DIR    = path.join(__dirname, "..", "data");
const SLOTS_FILE  = path.join(DATA_DIR, "demo-slots.json");

function _load() {
  try {
    if (!fs.existsSync(SLOTS_FILE)) return { slots: {} };
    return JSON.parse(fs.readFileSync(SLOTS_FILE, "utf8"));
  } catch { return { slots: {} }; }
}

function _save(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SLOTS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.warn("[demo-slots] save failed:", e.message); }
}

const _state = _load(); // { slots: { try_1: { sector, initAt } } }

function setSlotSector(slotId, sector) {
  if (!DEMO_STORES[sector]) throw new Error("Unknown sector: " + sector);
  _state.slots[slotId] = { sector, initAt: Date.now() };
  _save(_state);
}

function clearSlot(slotId) {
  if (_state.slots[slotId]) {
    delete _state.slots[slotId];
    _save(_state);
  }
}

function getSlotSector(slotId) {
  return _state.slots[slotId]?.sector || null;
}

function getSlotInfo(slotId) {
  const s = _state.slots[slotId];
  if (!s) return null;
  return {
    slotId,
    sector:    s.sector,
    storeName: DEMO_STORES[s.sector].storeName,
    storeId:   DEMO_STORES[s.sector].id,
    initAt:    s.initAt || null,
  };
}

function getDemoStore(sector) {
  const tmpl = DEMO_STORES[sector];
  if (!tmpl) return null;
  // deep clone عشان أي تعديل من الـ flow لا يلوث القالب
  return JSON.parse(JSON.stringify(tmpl));
}

function getDemoStoreBySlot(slotId) {
  const sector = _state.slots[slotId]?.sector;
  if (!sector) return null;
  return getDemoStore(sector);
}

// تنظيف الـ slots المنتهية كل 5 دقائق (45 دقيقة TTL)
const SLOT_TTL_MS = 45 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const slot of Object.keys(_state.slots)) {
    if (now - (_state.slots[slot].initAt || 0) > SLOT_TTL_MS) {
      delete _state.slots[slot];
      removed++;
      console.log(`⏰ [demo-slot] ${slot} expired (45 min TTL)`);
    }
  }
  if (removed > 0) _save(_state);
}, 5 * 60 * 1000);

module.exports = {
  DEMO_STORES,
  SECTORS: ["pharmacy", "grocery", "cafe"],
  setSlotSector,
  clearSlot,
  getSlotSector,
  getSlotInfo,
  getDemoStore,
  getDemoStoreBySlot,
};
