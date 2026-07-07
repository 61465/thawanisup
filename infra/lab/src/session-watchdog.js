/**
 * Session Watchdog — مراقبة جلسات Baileys
 * كل 5 دقائق يتحقق من حالة كل جلسة متجر نشط
 * عند الانقطاع: تنبيه لأبو حاتم (MASTER_PHONE) + مالك المتجر
 */

const fs    = require("fs");
const path  = require("path");
const waMgr = require("./whatsapp-manager");

const DATA_DIR    = path.join(__dirname, "..", "data");
const STORES_FILE = path.join(DATA_DIR, "stores.json");

const CHECK_INTERVAL_MS  = 5 * 60 * 1000; // كل 5 دقائق
const INITIAL_DELAY_MS   = 90_000;         // انتظر 90 ث للبوت يستقر

// آخر حالة معروفة لكل متجر — لمنع التنبيهات المكررة
const lastStatus = new Map();
// آخر وقت تنبيه لكل متجر — لمنع الإزعاج
const lastAlert  = new Map();
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // لا تعيد التنبيه في أقل من 30 دقيقة

function readStores() {
  try { return JSON.parse(fs.readFileSync(STORES_FILE, "utf8")); }
  catch { return { stores: [] }; }
}

// يحاول الإرسال عبر أي جلسة مفتوحة (platform أولاً، ثم أي متجر)
async function trySend(excludeStoreId, jid, text) {
  const candidates = ["platform", "lead"];
  for (const id of candidates) {
    if (id === excludeStoreId) continue;
    if (waMgr.getStatus(id).status === "open") {
      try { await waMgr.sendMessage(id, jid, text); return true; } catch {}
    }
  }
  // آخر محاولة: أي متجر نشط
  const { stores } = readStores();
  for (const s of stores) {
    if (s.id === excludeStoreId) continue;
    if (waMgr.getStatus(s.id).status === "open") {
      try { await waMgr.sendMessage(s.id, jid, text); return true; } catch {}
    }
  }
  return false;
}


// ─── Auto-Resume Expired Pauses ──────────────────────────────────────────────
// عندما تفشل جلسة 3 مرات → paused لـ 6 ساعات (whatsapp-manager)
// بعد انتهاء الـ cooldown، لا توجد آلية auto-init — تبقى ميتة حتى pm2 restart.
// هذا الـ watcher يفحص كل 5 دقائق وينشّط الجلسات التي انتهى paused لها.
// stagger 10s بين كل واحدة لتجنّب 428 flood-flag من WhatsApp.
async function autoResumeExpiredPauses() {
  try {
    const map = waMgr.pausedUntil;
    if (!map || typeof map.forEach !== 'function') return;
    const now = Date.now();
    const candidates = [];
    map.forEach((ts, storeId) => {
      if (typeof ts === 'number' && ts <= now) {
        const st = (waMgr.getStatus(storeId) || {}).status;
        if (st !== 'open' && st !== 'connecting') candidates.push(storeId);
      }
    });
    if (candidates.length === 0) return;
    console.log(String.fromCharCode(0x1F504) + ' [watchdog] auto-resume: ' + candidates.length + ' expired-paused session(s)');
    for (let i = 0; i < candidates.length; i++) {
      const id = candidates[i];
      try {
        waMgr.clearSessionPause(id);
        await waMgr.initSession(id, { force: true });
        console.log('   resumed ' + id);
      } catch (e) {
        console.error('   failed ' + id + ': ' + e.message);
      }
      if (i < candidates.length - 1) await new Promise(r => setTimeout(r, 10000));
    }
  } catch (e) {
    console.error('[watchdog] autoResumeExpiredPauses error:', e.message);
  }
}

async function check() {
  await autoResumeExpiredPauses().catch(() => {});
  const { stores } = readStores();
  const activeStores = stores.filter(
    s => s.active && s.subscriptionStatus === "active"
  );

  for (const store of activeStores) {
    const current = waMgr.getStatus(store.id).status;
    const prev    = lastStatus.get(store.id);

    // سجّل الحالة الأولى دون تنبيه
    if (prev === undefined) {
      lastStatus.set(store.id, current);
      continue;
    }

    // كان مفتوحاً وأصبح غير مفتوح
    if (prev === "open" && current !== "open") {
      const now = Date.now();
      const lastAlertTime = lastAlert.get(store.id) || 0;

      if (now - lastAlertTime > ALERT_COOLDOWN_MS) {
        lastAlert.set(store.id, now);
        console.warn(`⚠️ [watchdog] ${store.id} انقطع (${current})`);

        const masterPhone = process.env.MASTER_PHONE;
        const masterMsg =
          `⚠️ *تنبيه: انقطع اتصال متجر*\n\n` +
          `المتجر: *${store.storeName}*\n` +
          `الحالة: ${current}\n\n` +
          `النظام يحاول إعادة الاتصال تلقائياً.`;

        if (masterPhone) {
          const masterJid = masterPhone.replace(/\D/g, "") + "@s.whatsapp.net";
          await trySend(store.id, masterJid, masterMsg).catch(() => {});
        }

        // تنبيه مالك المتجر
        if (store.ownerPhone) {
          const ownerMsg =
            `⚠️ *انقطع الاتصال بمتجرك مؤقتاً*\n\n` +
            `متجر: *${store.storeName}*\n\n` +
            `النظام يحاول إعادة الاتصال تلقائياً.\n` +
            `إذا استمرت المشكلة أكثر من 10 دقائق تواصل مع الدعم.`;
          const ownerJid = store.ownerPhone.replace(/\D/g, "") + "@s.whatsapp.net";
          await trySend(store.id, ownerJid, ownerMsg).catch(() => {});
        }
      }
    }

    // عاد للاتصال — أبلغ أبو حاتم
    if (prev !== "open" && prev !== undefined && current === "open") {
      const masterPhone = process.env.MASTER_PHONE;
      if (masterPhone) {
        const masterJid = masterPhone.replace(/\D/g, "") + "@s.whatsapp.net";
        const recovMsg  =
          `✅ *استُعيد الاتصال*\n\n` +
          `المتجر: *${store.storeName}* عاد للعمل.`;
        await trySend(null, masterJid, recovMsg).catch(() => {});
      }
      console.log(`✅ [watchdog] ${store.id} استُعيد`);
    }

    lastStatus.set(store.id, current);
  }
}

function start() {
  setTimeout(() => {
    check().catch(console.error);
    setInterval(() => check().catch(console.error), CHECK_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  console.log(`🔍 Session watchdog جاهز (فحص كل 5 دقائق، يبدأ بعد 90 ث)`);
}

module.exports = { start };
