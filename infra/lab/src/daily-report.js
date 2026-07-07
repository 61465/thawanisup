/**
 * Daily Report — تقرير يومي تلقائي
 * يُرسَل لكل مالك متجر الساعة 11 مساءً
 * يتضمن: عدد الطلبات، الإيراد، أكثر المنتجات مبيعاً، متوسط الطلب
 */

const fs    = require("fs");
const path  = require("path");
const waMgr = require("./whatsapp-manager");

const DATA_DIR    = path.join(__dirname, "..", "data");
const STORES_FILE = path.join(DATA_DIR, "stores.json");

function readStores() {
  try { return JSON.parse(fs.readFileSync(STORES_FILE, "utf8")); }
  catch { return { stores: [] }; }
}

function readStoreOrders(storeId) {
  const file = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function getTodayOrders(orders) {
  const today = new Date().toISOString().slice(0, 10);
  return orders.filter(o =>
    (o.date || o.timestamp || "").slice(0, 10) === today
  );
}

function buildReport(store, todayOrders) {
  const currency = store.currency || "ر.س";
  const revenue  = todayOrders.reduce((s, o) => s + (o.total || 0), 0);
  const avg      = todayOrders.length > 0 ? revenue / todayOrders.length : 0;

  // أكثر المنتجات مبيعاً
  const prodCount = {};
  for (const order of todayOrders) {
    for (const item of (order.items || [])) {
      prodCount[item.name] = (prodCount[item.name] || 0) + (item.qty || 1);
    }
  }
  const top = Object.entries(prodCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, qty], i) => `${["🥇","🥈","🥉"][i]} ${name} — ${qty} طلب`)
    .join("\n");

  const dateLabel = new Date().toLocaleDateString("ar-SA", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  return (
    `📊 *تقرير اليوم — ${store.storeName}*\n\n` +
    `📅 ${dateLabel}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `🛍️ الطلبات: *${todayOrders.length}*\n` +
    `💰 الإيراد: *${revenue.toFixed(2)} ${currency}*\n` +
    `📈 متوسط الطلب: *${avg.toFixed(2)} ${currency}*\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    (top
      ? `🏆 *أكثر المنتجات مبيعاً:*\n${top}\n\n`
      : "") +
    `شكراً لاستخدامك *NEXUS* ✦\nغداً يوم أفضل إن شاء الله 💚`
  );
}

async function sendDailyReports() {
  const { stores } = readStores();
  const active = stores.filter(
    s => s.active && s.subscriptionStatus === "active" && s.ownerPhone
  );

  console.log(`📊 [daily-report] إرسال لـ ${active.length} متجر...`);

  for (const store of active) {
    try {
      const allOrders   = readStoreOrders(store.id);
      const todayOrders = getTodayOrders(allOrders);

      if (todayOrders.length === 0) continue; // لا طلبات = لا تقرير

      const report   = buildReport(store, todayOrders);
      const ownerJid = store.ownerPhone.replace(/\D/g, "") + "@s.whatsapp.net";

      if (waMgr.getStatus(store.id).status === "open") {
        await waMgr.sendMessage(store.id, ownerJid, report);
        console.log(`✅ [daily-report] أُرسل لـ ${store.id}`);
      }
    } catch (err) {
      console.error(`❌ [daily-report] فشل ${store.id}:`, err.message);
    }
  }
}

// يجدوَل الإرسال الساعة 23:00 كل يوم
function start() {
  function scheduleNext() {
    const now  = new Date();
    const next = new Date();
    next.setHours(23, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next - now;
    const inMin = Math.round(delay / 60_000);
    console.log(`📊 التقرير اليومي مجدول الساعة 23:00 (بعد ${inMin} دقيقة)`);

    setTimeout(async () => {
      await sendDailyReports().catch(console.error);
      scheduleNext(); // أعِد الجدولة ليوم الغد
    }, delay);
  }

  scheduleNext();
}

module.exports = { start, sendDailyReports };
