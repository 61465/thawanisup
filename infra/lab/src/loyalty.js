/**
 * Loyalty Points System — per-store + configurable rules
 * إعدادات قابلة للتخصيص من store-admin:
 *   spendPerPoint     : كم ر.س لكسب 1 نقطة (افتراضي 10)
 *   pointsForDiscount : كم نقطة تُستبدل دفعة واحدة (افتراضي 100)
 *   discountValue     : قيمة الخصم بالـ ر.س مقابل كل دفعة (افتراضي 10)
 *   enabled           : هل نظام النقاط مفعّل أصلاً
 * تخزين: data/loyalty_{storeId}.json
 */
const fs   = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

const DEFAULT_SETTINGS = {
  enabled:           true,
  spendPerPoint:     10,
  pointsForDiscount: 100,
  discountValue:     10,
};

function getSettings(store) {
  const s = store?.loyaltySettings || {};
  return {
    enabled:           s.enabled !== false,
    spendPerPoint:     Number(s.spendPerPoint)     > 0 ? Number(s.spendPerPoint)     : DEFAULT_SETTINGS.spendPerPoint,
    pointsForDiscount: Number(s.pointsForDiscount) > 0 ? Number(s.pointsForDiscount) : DEFAULT_SETTINGS.pointsForDiscount,
    discountValue:     Number(s.discountValue)     > 0 ? Number(s.discountValue)     : DEFAULT_SETTINGS.discountValue,
  };
}

function fileFor(storeId) {
  const safe = String(storeId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(DATA_DIR, `loyalty_${safe}.json`);
}

function load(storeId) {
  try { return JSON.parse(fs.readFileSync(fileFor(storeId), "utf8")); }
  catch { return {}; }
}

function save(storeId, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(fileFor(storeId), JSON.stringify(data, null, 2));
}

function calcPoints(total, store) {
  const { spendPerPoint } = getSettings(store);
  return Math.floor(total / spendPerPoint);
}

function ensureRecord(db, phone) {
  if (!db[phone]) db[phone] = { points: 0, totalOrders: 0, totalSpent: 0, history: [] };
  if (!Array.isArray(db[phone].history)) db[phone].history = [];
  return db[phone];
}

function pushHistory(rec, entry) {
  rec.history.push({ ...entry, date: new Date().toISOString().slice(0,10), ts: Date.now() });
  if (rec.history.length > 100) rec.history = rec.history.slice(-100);
}

function addPoints(storeId, phone, total, orderId, store, bonusOverride) {
  const settings = getSettings(store);
  // إن كان النظام مُغلقاً، لا earn ولا bonus — لا نقاط أشباح غير قابلة للاستبدال
  if (!settings.enabled) return { newPoints: 0, totalPoints: 0 };
  const db  = load(storeId);
  // bonusOverride: مقدار النقاط الثابت (مثلاً مكافأة تقييم 5 نقاط) — يتجاوز الحساب من total
  const pts = bonusOverride > 0 ? bonusOverride : calcPoints(total, store);
  if (pts <= 0) return { newPoints: 0, totalPoints: (db[phone]?.points || 0) };
  const rec = ensureRecord(db, phone);
  rec.points += pts;
  if (!bonusOverride) {
    rec.totalOrders += 1;
    rec.totalSpent  += total;
  }
  pushHistory(rec, { type: bonusOverride ? "bonus" : "earn", pts, orderId });
  save(storeId, db);
  return { newPoints: pts, totalPoints: rec.points };
}

function redeemPoints(storeId, phone, pointsToRedeem, store) {
  const settings = getSettings(store);
  if (!settings.enabled) return null;
  const db  = load(storeId);
  const rec = db[phone];
  if (!rec || rec.points < pointsToRedeem) return null;
  if (pointsToRedeem % settings.pointsForDiscount !== 0) return null;
  const discount = (pointsToRedeem / settings.pointsForDiscount) * settings.discountValue;
  rec.points -= pointsToRedeem;
  pushHistory(rec, { type: "redeem", pts: -pointsToRedeem, discount });
  save(storeId, db);
  return { discount, remainingPoints: rec.points };
}

function getPoints(storeId, phone) {
  const db = load(storeId);
  return db[phone] || { points: 0, totalOrders: 0, totalSpent: 0, history: [] };
}

function pointsMessage(storeId, phone, store) {
  const settings = getSettings(store);
  if (!settings.enabled) return "❌ نظام النقاط غير مفعّل في هذا المتجر";
  const info = getPoints(storeId, phone);
  const pts  = info.points;
  const { pointsForDiscount, discountValue, spendPerPoint } = settings;
  const next = pointsForDiscount - (pts % pointsForDiscount);
  if (pts === 0) return `🏆 *نقاط الولاء:* لا يوجد نقاط بعد\n💡 كل ${spendPerPoint}ر.س = نقطة واحدة`;
  return (
    `🏆 *رصيد نقاطك:* ${pts} نقطة\n` +
    `${pts >= pointsForDiscount ? `✨ يمكنك استبدال ${Math.floor(pts/pointsForDiscount)*pointsForDiscount} نقطة بخصم ${Math.floor(pts/pointsForDiscount)*discountValue}ر.س\n` : ""}` +
    `📈 ${next} نقطة للمكافأة القادمة`
  );
}

// ─── Admin functions ──────────────────────────────────────────────────────
function listCustomers(storeId) {
  const db = load(storeId);
  return Object.entries(db).map(([phone, r]) => ({
    phone,
    points:      r.points || 0,
    totalOrders: r.totalOrders || 0,
    totalSpent:  r.totalSpent || 0,
    lastDate:    (r.history || []).slice(-1)[0]?.date || null,
  })).sort((a, b) => b.points - a.points);
}

function getCustomerDetail(storeId, phone) {
  const db  = load(storeId);
  const rec = db[phone];
  if (!rec) return null;
  return {
    phone,
    points:      rec.points || 0,
    totalOrders: rec.totalOrders || 0,
    totalSpent:  rec.totalSpent || 0,
    history:     (rec.history || []).slice(-20).reverse(),
  };
}

function adjustPoints(storeId, phone, delta, reason) {
  const db   = load(storeId);
  const rec  = ensureRecord(db, phone);
  const d    = parseInt(delta, 10);
  if (!Number.isFinite(d) || d === 0) return null;
  rec.points = Math.max(0, rec.points + d);
  pushHistory(rec, { type: "adjust", pts: d, reason: String(reason || "تعديل يدوي من الإدارة") });
  save(storeId, db);
  return { newTotal: rec.points };
}

module.exports = {
  addPoints, redeemPoints, getPoints, pointsMessage, calcPoints, getSettings,
  listCustomers, getCustomerDetail, adjustPoints, DEFAULT_SETTINGS,
};
