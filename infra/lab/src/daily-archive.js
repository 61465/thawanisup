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

// snapshot ليوم محدد (date = YYYY-MM-DD) أو ضمن نافذة زمنية (sinceTs..untilTs)
function _buildDailySnapshot(storeId, date, sinceTs = null, untilTs = null) {
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
      // إذا حُدّدت نافذة زمنية، فلتر بها (للـ manual day-end)
      if (sinceTs !== null || untilTs !== null) {
        const t = new Date(o.timestamp || 0).getTime();
        if (sinceTs && t < sinceTs) continue;
        if (untilTs && t > untilTs) continue;
      } else {
        const ts = (o.timestamp || "").slice(0, 10);
        if (ts !== date) continue;
      }
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

// ─── إغلاق يدوي للـ shift (للبيزنس الذي ينتهي يومه قبل 24س) ────────────────
function _dayEndFile(storeId) {
  return path.join(DATA_DIR, `day_end_${storeId}.json`);
}

// آخر وقت إغلاق يدوي (يُستخدم في /store/stats كـ cutoff للـ "اليوم")
function getLastShiftEnd(storeId) {
  try {
    return JSON.parse(fs.readFileSync(_dayEndFile(storeId), "utf8")).closedAt || null;
  } catch { return null; }
}

// أنهِ اليوم الآن: snapshot للنشاط منذ آخر إغلاق + احفظ closedAt = الآن
function endDayNow(storeId, businessDate) {
  const archFile = _archiveFile(storeId);
  const today = businessDate || _todayRiyadh();
  const lastEnd = getLastShiftEnd(storeId);
  // النافذة: من آخر إغلاق (أو من 00:00 اليوم) إلى الآن
  const sinceTs = lastEnd
    ? new Date(lastEnd).getTime()
    : new Date(today + "T00:00:00").getTime();
  const untilTs = Date.now();

  const snap = _buildDailySnapshot(storeId, today, sinceTs, untilTs);
  if (!snap || snap.total === 0) {
    // ما زال نسجل closedAt حتى لا نحسب الفترة مرة أخرى
    atomicFs.writeJsonSync(_dayEndFile(storeId), {
      closedAt: new Date().toISOString(),
      businessDate: today,
      manual: true,
      ordersCount: 0,
    });
    return { saved: false, reason: "no_activity", closedAt: new Date().toISOString() };
  }

  snap.shiftMode = "manual";
  snap.shiftSince = new Date(sinceTs).toISOString();
  snap.shiftUntil = new Date(untilTs).toISOString();

  // لو اليوم موجود بالفعل في الأرشيف (أرشف صباحاً وعاد فتح)، نضمّ القيم
  let merged = false;
  if (fs.existsSync(archFile)) {
    const lines = fs.readFileSync(archFile, "utf8").split("\n").filter(Boolean);
    let foundIdx = -1, existing = null;
    for (let i = 0; i < lines.length; i++) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.date === today) { foundIdx = i; existing = d; break; }
      } catch {}
    }
    if (existing && foundIdx >= 0) {
      // اجمع الجلستين
      existing.total      += snap.total;
      existing.confirmed  += snap.confirmed;
      existing.rejected   += snap.rejected;
      existing.cancelled  += snap.cancelled;
      existing.revenue    = parseFloat(((existing.revenue || 0) + snap.revenue).toFixed(2));
      existing.avgOrder   = existing.confirmed ? parseFloat((existing.revenue / existing.confirmed).toFixed(2)) : 0;
      existing.uniqueCustomers = Math.max(existing.uniqueCustomers || 0, snap.uniqueCustomers);
      existing.shifts = (existing.shifts || 1) + 1;
      existing.shiftMode = "manual";
      lines[foundIdx] = JSON.stringify(existing);
      atomicFs.writeSync(archFile, lines.join("\n") + "\n");
      merged = true;
    } else {
      atomicFs.appendJsonlSync(archFile, snap);
    }
  } else {
    atomicFs.appendJsonlSync(archFile, snap);
  }

  atomicFs.writeJsonSync(_dayEndFile(storeId), {
    closedAt: new Date().toISOString(),
    businessDate: today,
    manual: true,
    ordersCount: snap.total,
  });
  console.log(`[shift-end] ${storeId} closed shift: orders=${snap.total} revenue=${snap.revenue} merged=${merged}`);
  return { saved: true, merged, snapshot: snap };
}

module.exports = {
  startScheduler,
  runDailyArchive,
  archiveDay,
  readArchive,
  getMonthSummary,
  endDayNow,
  getLastShiftEnd,
  _todayRiyadh,
  _yesterdayRiyadh,
};
