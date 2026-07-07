/**
 * Subscription Enforcer — يفرض انتهاء الاشتراك تلقائياً
 *
 * المشكلة قبل هذا الموديول: لو تجاوز تاريخ subscriptionNextPayment، يبقى
 * المتجر "active" إلى الأبد ما لم يضغط الماستر "إيقاف". هذا يكسر التحصيل.
 *
 * عمل هذا الموديول:
 *   1) كل 30 دقيقة + مرة عند الإقلاع: يفحص كل المتاجر
 *   2) لكل متجر active + تاريخ انتهاء مضى:
 *      - subscriptionStatus → "expired"
 *      - revoke جلسات admin (storeRouter.revokeStoreTokens)
 *      - disconnectSession للبوت (waMgr)
 *      - SSE emit للماستر
 *      - audit log
 *      - WhatsApp إشعار للمالك (best-effort)
 */

const fs   = require("fs");
const path = require("path");
const atomicFs = require("./atomic-fs");
const waMgr    = require("./whatsapp-manager");
const { audit } = require("./audit-log");

const DATA_DIR    = path.join(__dirname, "..", "data");
const STORES_FILE = path.join(DATA_DIR, "stores.json");
const TICK_MS     = 30 * 60 * 1000; // 30 دقيقة

function _readStores() {
  try { return JSON.parse(fs.readFileSync(STORES_FILE, "utf8")); }
  catch { return { stores: [] }; }
}

function _writeStores(data) {
  atomicFs.writeJsonSync(STORES_FILE, data);
}

function _todayStartMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function _expiryDateOf(store) {
  // Stripe-managed → subscriptionExpiry، يدوي → subscriptionNextPayment
  return store.subscriptionExpiry || store.subscriptionNextPayment || null;
}

// مساعد: ابحث عن أي bot جاهز للإرسال (platform أولوية)
function _pickSenderBot() {
  const sessions = waMgr.listSessions();
  return sessions.find(s => s.storeId === "platform" && s.status === "open")
      || sessions.find(s => s.storeId === "lead"     && s.status === "open")
      || sessions.find(s => s.status === "open" && !/^try_/.test(s.storeId));
}

async function _notifyOwner(store) {
  try {
    const phone = String(store.ownerPhone || "").replace(/[\s\+\-\(\)]/g, "");
    if (!phone) return;
    const sender = _pickSenderBot();
    if (!sender) return;
    const jid = phone + "@s.whatsapp.net";
    const msg =
`⚠️ *انتهى اشتراكك*
متجر *${store.storeName || store.id}* — انتهت صلاحية الاشتراك بتاريخ ${_expiryDateOf(store)}.

تم إيقاف لوحة التحكم وردود البوت مؤقتاً. للتجديد تواصل مع الدعم:
wa.me/966508572902`;
    await waMgr.sendMessage(sender.storeId, jid, msg, { allowCold: true, reason: "subscription_expired" });
  } catch (e) {
    console.warn(`[subscription-enforcer] notify owner failed (${store.id}):`, e.message);
  }
}

// ⏰ تحذير قبل 24 ساعة من الانتهاء — مرة واحدة فقط
async function _notifyOwnerPreExpiry(store, hoursLeft) {
  try {
    const phone = String(store.ownerPhone || "").replace(/[\s\+\-\(\)]/g, "");
    if (!phone) return;
    const sender = _pickSenderBot();
    if (!sender) return;
    const jid = phone + "@s.whatsapp.net";
    const expiryDate = _expiryDateOf(store);
    const expiryStr = expiryDate ? new Date(expiryDate).toLocaleDateString("ar-EG", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) : "";
    const msg =
`⏳ *تذكير بتجديد الاشتراك*

عزيزنا تاجر *${store.storeName || store.id}*،

اشتراكك سينتهي خلال *${hoursLeft} ساعة* تقريباً
📅 تاريخ الانتهاء: ${expiryStr}

عند انتهاء الاشتراك:
• ❌ سيتوقف بوت الواتساب عن استقبال الطلبات
• ❌ لوحة التحكم لن تكون متاحة
• ✅ بياناتك ومتجرك ستبقى محفوظة

🔄 *للتجديد قبل الانتهاء:*
تواصل مع الدعم على
wa.me/966508572902

نشكرك على ثقتك بمنصة ثواني 🌹`;
    await waMgr.sendMessage(sender.storeId, jid, msg, { allowCold: true, reason: "subscription_pre_expiry" });
    // ضع علم في الـ store ليمنع تكرار الإرسال
    const data = _readStores();
    const idx = data.stores.findIndex(s => s.id === store.id);
    if (idx !== -1) {
      data.stores[idx].preExpiryWarnedAt = new Date().toISOString();
      _writeStores(data);
    }
    console.log(`⏰ [${store.id}] pre-expiry warning sent (${hoursLeft}h left)`);
  } catch (e) {
    console.warn(`[subscription-enforcer] pre-expiry notify failed (${store.id}):`, e.message);
  }
}

async function expireStore(store) {
  // ✏️ تحديث الملف
  const data = _readStores();
  const idx = data.stores.findIndex(s => s.id === store.id);
  if (idx === -1) return;
  data.stores[idx].subscriptionStatus = "expired";
  data.stores[idx].expiredAt = new Date().toISOString();
  _writeStores(data);

  // 🔓 ألغِ كل tokens لوحة الادمن
  try {
    const revoked = global.revokeStoreTokens?.(store.id) || 0;
    if (revoked > 0) console.log(`🔓 [${store.id}] revoked ${revoked} admin token(s) on expiry`);
  } catch (e) { console.warn(`[enforcer] revoke tokens failed (${store.id}):`, e.message); }

  // 🔇 افصل جلسة الواتساب للبوت (creds محفوظة لإعادة التفعيل بدون pairing جديد)
  try {
    await waMgr.disconnectSession(store.id, { keepCreds: true });
    console.log(`🔇 [${store.id}] bot session disconnected on expiry`);
  } catch (e) { console.warn(`[enforcer] disconnect failed (${store.id}):`, e.message); }

  // 📡 SSE للماستر
  try {
    global.sseSend?.("master", "subscription_changed", {
      storeId: store.id,
      storeName: store.storeName,
      status: "expired",
      active: store.active !== false,
      reason: "auto_expiry",
    });
  } catch {}

  // 📝 audit
  try {
    audit({
      actor: { type: "system", id: "subscription-enforcer" },
      action: "subscription.auto_expired",
      target: { type: "store", id: store.id },
      meta: { expiryDate: _expiryDateOf(store) },
    });
  } catch {}

  // 📱 best-effort notify owner (لا ينتظر)
  _notifyOwner(store);

  console.log(`⏰ [${store.id}] subscription auto-expired (was due: ${_expiryDateOf(store)})`);
}

async function runTick() {
  const { stores } = _readStores();
  if (!stores?.length) return { checked: 0, expired: 0, warned: 0 };

  const cutoff = _todayStartMs();
  const now = Date.now();
  let expired = 0;
  let warned = 0;

  for (const store of stores) {
    if (store.subscriptionStatus !== "active") continue;
    const expiryStr = _expiryDateOf(store);
    if (!expiryStr) continue;
    const expiryMs = new Date(expiryStr).getTime();
    if (!isFinite(expiryMs)) continue;

    // 🔴 منتهية → expire
    if (expiryMs < cutoff) {
      try { await expireStore(store); expired++; }
      catch (e) { console.error(`[enforcer] failed to expire ${store.id}:`, e.message); }
      continue;
    }

    // ⏳ تحذير قبل 24 ساعة (نافذة 22-26 ساعة قبل الانتهاء — مرة واحدة)
    const hoursLeft = (expiryMs - now) / (1000 * 60 * 60);
    if (hoursLeft > 0 && hoursLeft <= 26 && !store.preExpiryWarnedAt) {
      try {
        await _notifyOwnerPreExpiry(store, Math.max(1, Math.ceil(hoursLeft)));
        warned++;
      } catch (e) {
        console.warn(`[enforcer] pre-expiry warn failed ${store.id}:`, e.message);
      }
    }
  }

  if (expired > 0) console.log(`⏰ [subscription-enforcer] expired ${expired} store(s) this tick`);
  if (warned > 0)  console.log(`⏰ [subscription-enforcer] sent ${warned} pre-expiry warning(s)`);
  return { checked: stores.length, expired, warned };
}

let _timer = null;
function start() {
  if (_timer) return;
  // مرة عند الإقلاع (بعد 60 ثانية لإعطاء الـ sessions فرصة boot)
  setTimeout(() => runTick().catch(e => console.warn("[enforcer] boot tick failed:", e.message)), 60_000);
  // ثم كل 30 دقيقة
  _timer = setInterval(() => {
    runTick().catch(e => console.warn("[enforcer] tick failed:", e.message));
  }, TICK_MS);
  console.log("⏰ [subscription-enforcer] active — يفحص كل 30 دقيقة");
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, runTick, expireStore };
