/**
 * Daily Archive — snapshot يومي لكل متجر عند منتصف الليل (توقيت الرياض)
 *
 * يحفظ snapshot لكل يوم في daily_archive_${storeId}.jsonl
 * يحسب: ordersTotal/ordersConfirmed/ordersRejected/revenue/avgOrder/uniqueCustomers
 *
 * الـ dashboard لا يحتاج "تصفير" — هو يعرض اليوم الحالي تلقائياً
 * (ts.startsWith(today)). عند منتصف الليل، الـ today يتغيّر فالأرقام تصفّر طبيعياً.
 */
const fs   = require("fs");
const path = require("path");
const atomicFs = require("./atomic-fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const ARCHIVE_STATE = path.join(DATA_DIR, "last_archive_date.json");
const RIYADH_TZ = "Asia/Riyadh";

const EARN_STATUSES = new Set(["confirmed", "completed", "delivered", "done"]);

function _todayRiyadh() {
  return new Date().toLocaleDateString("en-CA", { timeZone: RIYADH_TZ }); // YYYY-MM-DD
}

function _yesterdayRiyadh() {
  const now = new Date();
  const yest = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return yest.toLocaleDateString("en-CA", { timeZone: RIYADH_TZ });
}

function _readStores() {
  try {
    const { stores } = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "stores.json"), "utf8"));
    return stores || [];
  } catch { return []; }
}

function _ordersFile(storeId) {
  return storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
}

function _archiveFile(storeId) {
  return path.join(DATA_DIR, `daily_archive_${storeId}.jsonl`);
}

// snapshot ليوم محدد (date = YYYY-MM-DD)
function _buildDailySnapshot(storeId, date) {
  const file = _ordersFile(storeId);
  if (!fs.existsSync(file)) return null;

  const customers = new Set();
  let total = 0, confirmed = 0, rejected = 0, cancelled = 0, pending = 0;
  let revenue = 0;
  const productCounts = {};

  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (o._test) continue;
      const ts = (o.timestamp || "").slice(0, 10);
      if (ts !== date) continue;
      total++;
      if (o.customerPhone) customers.add(String(o.customerPhone));
      if (EARN_STATUSES.has(o.status)) {
        confirmed++;
        revenue += Number(o.total || 0);
        for (const it of (o.items || [])) {
          productCounts[it.name] = (productCounts[it.name] || 0) + (it.qty || 1);
        }
      } else if (o.status === "rejected") rejected++;
      else if (o.status === "cancelled") cancelled++;
      else if (o.status === "pending_confirmation") pending++;
    } catch {}
  }

  const topProducts = Object.entries(productCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([name, qty]) => ({ name, qty }));

  return {
    date,
    total,
    confirmed,
    rejected,
    cancelled,
    pending,
    revenue:        parseFloat(revenue.toFixed(2)),
    avgOrder:       confirmed ? parseFloat((revenue / confirmed).toFixed(2)) : 0,
    uniqueCustomers: customers.size,
    topProducts,
    snapshotAt:     new Date().toISOString(),
  };
}

// archive day = أرشف يوم محدد لمتجر واحد (idempotent — لن يضيف نفس اليوم مرتين)
function archiveDay(storeId, date) {
  const archFile = _archiveFile(storeId);
  // اقرأ الأرشيف الحالي وتأكد أن هذا اليوم غير محفوظ
  if (fs.existsSync(archFile)) {
    const existing = fs.readFileSync(archFile, "utf8").split("\n");
    for (const l of existing) {
      if (!l.trim()) continue;
      try { if (JSON.parse(l).date === date) return null; } catch {}
    }
  }
  const snap = _buildDailySnapshot(storeId, date);
  if (!snap || snap.total === 0) return null; // لا تحفظ يوماً بدون نشاط
  atomicFs.appendJsonlSync(archFile, snap);
  console.log(`[daily-archive] saved ${storeId} day=${date} orders=${snap.total} revenue=${snap.revenue}`);
  return snap;
}

// يستدعى من cron — يأرشف "أمس" لكل المتاجر (مرة واحدة في اليوم)
function runDailyArchive() {
  const yest = _yesterdayRiyadh();
  let lastRun = {};
  try { lastRun = JSON.parse(fs.readFileSync(ARCHIVE_STATE, "utf8")); } catch {}
  if (lastRun.lastArchivedDay === yest) return; // archived already
  const stores = _readStores();
  let archived = 0;
  for (const s of stores) {
    if (!s.id) continue;
    const result = archiveDay(s.id, yest);
    if (result) archived++;
  }
  lastRun.lastArchivedDay = yest;
  lastRun.runAt = new Date().toISOString();
  atomicFs.writeJsonSync(ARCHIVE_STATE, lastRun);
  console.log(`[daily-archive] cycle complete: ${archived}/${stores.length} stores archived for ${yest}`);
}

// قراءة أرشيف متجر (افتراضياً الشهر الحالي)
function readArchive(storeId, monthPrefix) {
  const file = _archiveFile(storeId);
  if (!fs.existsSync(file)) return [];
  const days = [];
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const d = JSON.parse(l);
      if (!monthPrefix || (d.date || "").startsWith(monthPrefix)) days.push(d);
    } catch {}
  }
  return days.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

// قراءة summary لشهر معين (إجمالي + أيام)
function getMonthSummary(storeId, monthPrefix) {
  const days = readArchive(storeId, monthPrefix);
  const totals = days.reduce((acc, d) => ({
    total:           acc.total + (d.total || 0),
    confirmed:       acc.confirmed + (d.confirmed || 0),
    rejected:        acc.rejected + (d.rejected || 0),
    cancelled:       acc.cancelled + (d.cancelled || 0),
    revenue:         acc.revenue + (d.revenue || 0),
    uniqueCustomers: Math.max(acc.uniqueCustomers, d.uniqueCustomers || 0),
  }), { total: 0, confirmed: 0, rejected: 0, cancelled: 0, revenue: 0, uniqueCustomers: 0 });
  totals.revenue  = parseFloat(totals.revenue.toFixed(2));
  totals.avgOrder = totals.confirmed ? parseFloat((totals.revenue / totals.confirmed).toFixed(2)) : 0;
  totals.daysCount = days.length;
  return { month: monthPrefix, totals, days };
}

// جدولة: تحقق كل دقيقة. لو دخلنا 00:00–00:10 في الرياض، شغّل
function startScheduler() {
  setInterval(() => {
    const hour = parseInt(new Date().toLocaleString("en-US", { timeZone: RIYADH_TZ, hour: "2-digit", hour12: false }));
    if (hour === 0) {
      try { runDailyArchive(); }
      catch (e) { console.error("[daily-archive] cron failed:", e.message); }
    }
  }, 60 * 1000);
  // أيضاً عند startup: archive any missing day (catch-up لو السيرفر كان مطفأ منتصف الليل)
  setTimeout(() => {
    try { runDailyArchive(); } catch (e) { console.warn("[daily-archive] catchup failed:", e.message); }
  }, 30 * 1000);
  console.log("📅 Daily archive scheduler نشط (00:00 توقيت الرياض)");
}

module.exports = {
  startScheduler,
  runDailyArchive,
  archiveDay,
  readArchive,
  getMonthSummary,
  _todayRiyadh,
  _yesterdayRiyadh,
};
