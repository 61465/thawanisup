/**
 * Cart Abandonment Watcher — يستعيد السلات المتروكة عبر واتس
 *
 * كل 10 دقائق:
 *   1) يفحص data/carts/*\/*.json
 *   2) لكل سلة عمرها 30-120 دقيقة + لم تُحوّل لطلب:
 *      - يبحث عن رقم عميل في الـ contact metadata
 *      - يرسل واتس: "نسيت سلتك"
 *      - يضع علامة _abandonedNotified عشان ما يكرر
 *
 * يحتاج: التاجر يفعّل الميزة + الباقة تدعمها
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR  = path.join(__dirname, "..", "data");
const CARTS_DIR = path.join(DATA_DIR, "carts");

const MIN_AGE_MS = 30 * 60 * 1000;       // 30 دقيقة
const MAX_AGE_MS = 24 * 60 * 60 * 1000;  // لا نرسل بعد 24 ساعة
const TICK_MS    = 10 * 60 * 1000;       // كل 10 دقائق

let _timer = null;

async function runTick() {
  if (!fs.existsSync(CARTS_DIR)) return { checked: 0, recovered: 0 };

  const waMgr = (() => { try { return require("./whatsapp-manager"); } catch { return null; } })();
  if (!waMgr) return { checked: 0, recovered: 0 };

  const stores = _readStoresIndex();
  let checked = 0, recovered = 0;

  for (const sid of fs.readdirSync(CARTS_DIR)) {
    const dir = path.join(CARTS_DIR, sid);
    if (!fs.statSync(dir).isDirectory()) continue;

    const store = stores[sid];
    // الميزة تتطلب: المتجر نشط + الميزة مفعّلة + رقم العميل معروف
    if (!store || store.active === false) continue;
    if (store.subscriptionStatus && store.subscriptionStatus !== "active") continue;
    if (store.cartAbandonmentEnabled === false) continue;

    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const fp = path.join(dir, f);
      checked++;
      let cart;
      try { cart = JSON.parse(fs.readFileSync(fp, "utf8")); }
      catch { continue; }

      // تخطّى لو رُسل من قبل
      if (cart._abandonedNotified) continue;

      const age = Date.now() - new Date(cart.updatedAt || cart.createdAt || 0).getTime();
      if (age < MIN_AGE_MS) continue;
      if (age > MAX_AGE_MS) continue;
      if (!cart.items?.length) continue;
      if (!cart.customerPhone) continue; // ما عندنا رقم نرسل عليه

      // ✉️ ابعت
      try {
        const itemsText = (cart.lines || cart.items).slice(0, 3).map(l =>
          `• ${l.name} × ${l.qty || 1}`
        ).join("\n");
        const total = cart.total || 0;
        const currency = store.currency || "ر.س";
        const slug = store.slug || sid;
        const resumeUrl = `${process.env.PUBLIC_URL || ""}/store/${encodeURIComponent(slug)}`;

        const msg =
          `🛍️ *نسيت سلتك في ${store.storeName}*\n\n` +
          `حفظنا لك:\n${itemsText}\n\n` +
          `الإجمالي: *${total.toFixed(2)} ${currency}*\n\n` +
          `🎁 *خصم 10% لو أكملت خلال ساعة*\n` +
          `الكود: \`SAVE10\`\n\n` +
          `أكمل طلبك:\n${resumeUrl}`;

        const jid = String(cart.customerPhone).replace(/\D/g, "") + "@s.whatsapp.net";
        await waMgr.sendMessage(sid, jid, msg, {
          allowCold: true,
          reason: "order_notification",
        });
        // علّم السلة عشان ما نكرر
        cart._abandonedNotified = new Date().toISOString();
        fs.writeFileSync(fp, JSON.stringify(cart, null, 2));
        recovered++;
        console.log(`🛒 [cart-recovery] sent to ${cart.customerPhone} for ${sid}`);
      } catch (e) {
        console.warn(`[cart-recovery] failed for ${sid}/${f}:`, e.message);
      }
    }
  }

  if (recovered > 0) console.log(`🛒 [cart-abandonment] tick: ${recovered}/${checked} cart(s) recovered`);
  return { checked, recovered };
}

function _readStoresIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "stores.json"), "utf8"));
    return Object.fromEntries((data.stores || []).map(s => [s.id, s]));
  } catch { return {}; }
}

function start() {
  if (_timer) return;
  setTimeout(() => runTick().catch(e => console.warn("[cart-abandonment] boot tick:", e.message)), 60_000);
  _timer = setInterval(() => {
    runTick().catch(e => console.warn("[cart-abandonment] tick:", e.message));
  }, TICK_MS);
  console.log("🛒 [cart-abandonment] active — يفحص كل 10 دقائق");
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, runTick };
