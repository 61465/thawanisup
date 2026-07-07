/**
 * 🔔 Notifications Inbox — يجمع الأحداث من ملفات النظام لكل متجر
 * النوع: pending_order, negative_rating, sub_expiring, wa_disconnect,
 *        handoff, low_stock, rejected_order, info
 */
const fs   = require("fs");
const path = require("path");
const atomicFs = require("./atomic-fs");

const DATA_DIR = path.join(__dirname, "..", "data");

function _readFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function _ordersFile(storeId) {
  return storeId === "nakheel_001" ? path.join(DATA_DIR, "orders.jsonl")
                                   : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
}
function _readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
function _readState(storeId) {
  const f = path.join(DATA_DIR, `notifications_read_${storeId}.json`);
  return _readFile(f, { readIds: [] });
}
function _saveState(storeId, state) {
  const f = path.join(DATA_DIR, `notifications_read_${storeId}.json`);
  // اقتصار الـ readIds على آخر 500 لمنع التضخم
  if (state.readIds.length > 500) state.readIds = state.readIds.slice(-500);
  atomicFs.writeJsonSync(f, state);
}

function _getStore(storeId) {
  const stores = _readFile(path.join(DATA_DIR, "stores.json"), { stores: [] }).stores;
  return stores.find(s => s.id === storeId) || null;
}

// 🛒 الطلبات pending
function _collectPendingOrders(storeId) {
  const out = [];
  const orders = _readJsonl(_ordersFile(storeId));
  for (const o of orders) {
    if (o._test) continue;
    if (o.status !== "pending_confirmation") continue;
    out.push({
      id:        "pend_" + o.orderId,
      type:      "pending_order",
      severity:  "warning",
      icon:      "⏳",
      title:     "طلب بانتظار التأكيد",
      body:      `${o.customerName || "عميل"} — ${(o.total || 0).toFixed(2)} ${o.currency || "ر.س"}`,
      ts:        o.timestamp || new Date().toISOString(),
      link:      "orders",
      meta:      { orderId: o.orderId },
    });
  }
  return out;
}

// ⭐ التقييمات السلبية (1-2)
function _collectNegativeRatings(storeId, sinceDays = 30) {
  const out = [];
  const file = path.join(DATA_DIR, "ratings.jsonl");
  const ratings = _readJsonl(file);
  const cutoff = Date.now() - sinceDays * 86400_000;
  for (const r of ratings) {
    if (r.storeId !== storeId) continue;
    if ((r.rating || 5) > 2) continue;
    const ts = new Date(r.timestamp || 0).getTime();
    if (ts < cutoff) continue;
    out.push({
      id:        "rate_" + (r.id || r.orderId),
      type:      "negative_rating",
      severity:  "critical",
      icon:      "⭐",
      title:     `تقييم سلبي (${r.rating}/5)`,
      body:      r.comment ? `"${String(r.comment).slice(0, 80)}"` : `الطلب: ${r.orderId || "—"}`,
      ts:        r.timestamp || new Date().toISOString(),
      link:      "ratings",
      meta:      { ratingId: r.id, orderId: r.orderId },
    });
  }
  return out;
}

// 💳 الاشتراك ينتهي قريباً
function _collectSubscriptionAlerts(storeId) {
  const out = [];
  const store = _getStore(storeId);
  if (!store?.subscriptionNextPayment) return out;
  const days = Math.ceil((new Date(store.subscriptionNextPayment) - new Date()) / 86400_000);
  if (days < 0) {
    out.push({
      id: "sub_expired",
      type: "sub_expired",
      severity: "critical",
      icon: "⛔",
      title: "الاشتراك منتهي",
      body: `تجديد متأخر بـ ${Math.abs(days)} يوم — تواصل لتجديد الاشتراك`,
      ts: new Date().toISOString(),
      link: "settings",
    });
  } else if (days <= 7) {
    out.push({
      id: "sub_expiring",
      type: "sub_expiring",
      severity: days <= 3 ? "critical" : "warning",
      icon: "⏰",
      title: `الاشتراك ينتهي خلال ${days} يوم`,
      body: `جدّد قبل ${new Date(store.subscriptionNextPayment).toLocaleDateString("ar-EG")}`,
      ts: new Date().toISOString(),
      link: "settings",
    });
  }
  return out;
}

// 🆘 طلبات مسؤول (handoffs)
function _collectHandoffs(storeId) {
  const out = [];
  const handoffs = _readFile(path.join(DATA_DIR, "handoffs.json"), {});
  for (const [key, h] of Object.entries(handoffs)) {
    if (h.storeId !== storeId) continue;
    out.push({
      id:       "hand_" + key,
      type:     "handoff",
      severity: "warning",
      icon:     "🆘",
      title:    "عميل يطلب مسؤول",
      body:     `${(h.phone || "").replace(/\D/g, "").slice(0, 6)}*** — "${(h.lastMsg || "").slice(0, 50)}"`,
      ts:       h.startedAt || h.at || new Date().toISOString(),
      link:     "support",
    });
  }
  return out;
}

// 📦 منتجات منخفضة المخزون (≤3)
function _collectLowStock(storeId) {
  const out = [];
  const store = _getStore(storeId);
  if (!store) return out;
  for (const p of store.products || []) {
    if (p.stock === null || p.stock === undefined) continue;
    if (p.stock > 3) continue;
    out.push({
      id:       "stock_" + p.id,
      type:     "low_stock",
      severity: p.stock === 0 ? "critical" : "warning",
      icon:     p.stock === 0 ? "❌" : "⚠️",
      title:    p.stock === 0 ? `نفذ: ${p.name}` : `متبقي ${p.stock} من: ${p.name}`,
      body:     `جدّد الكمية من تب المخزون`,
      ts:       new Date().toISOString(),
      link:     "inventory",
      meta:     { productId: p.id, stock: p.stock },
    });
  }
  return out;
}

// ❌ الطلبات المرفوضة الأخيرة (آخر 7 أيام)
function _collectRejected(storeId) {
  const out = [];
  const orders = _readJsonl(_ordersFile(storeId));
  const cutoff = Date.now() - 7 * 86400_000;
  for (const o of orders) {
    if (o._test) continue;
    if (o.status !== "rejected") continue;
    if (!o.rejectReason) continue;
    const ts = new Date(o.timestamp || 0).getTime();
    if (ts < cutoff) continue;
    out.push({
      id:       "rej_" + o.orderId,
      type:     "rejected_order",
      severity: "info",
      icon:     "❌",
      title:    `طلب مرفوض: ${o.orderId}`,
      body:     `السبب: ${String(o.rejectReason).slice(0, 80)}`,
      ts:       o.timestamp || new Date().toISOString(),
      link:     "rejections",
    });
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────
function listForStore(storeId, { unreadOnly = false } = {}) {
  const all = [
    ..._collectPendingOrders(storeId),
    ..._collectNegativeRatings(storeId),
    ..._collectSubscriptionAlerts(storeId),
    ..._collectHandoffs(storeId),
    ..._collectLowStock(storeId),
    ..._collectRejected(storeId),
  ];
  const state = _readState(storeId);
  const readSet = new Set(state.readIds || []);
  const enriched = all.map(n => ({ ...n, read: readSet.has(n.id) }));
  const filtered = unreadOnly ? enriched.filter(n => !n.read) : enriched;
  return filtered.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
}

function unreadCount(storeId) {
  return listForStore(storeId, { unreadOnly: true }).length;
}

function markRead(storeId, notifId) {
  const state = _readState(storeId);
  if (!state.readIds.includes(notifId)) {
    state.readIds.push(notifId);
    _saveState(storeId, state);
  }
}

function markAllRead(storeId) {
  const all = listForStore(storeId);
  const state = _readState(storeId);
  const set = new Set(state.readIds || []);
  for (const n of all) set.add(n.id);
  state.readIds = Array.from(set);
  _saveState(storeId, state);
  return all.length;
}

module.exports = { listForStore, unreadCount, markRead, markAllRead };
