/**
 * Broadcast — بث رسائل لعملاء المتجر مع تقنيات مكافحة الحظر
 * ─────────────────────────────────────────────────────────────────
 * استراتيجية الأمان (anti-ban) — لأن Baileys ليس Cloud API الرسمي:
 *  1) أرقام من عملاء بدؤوا محادثة معك فقط (orders + customers.json) — opt-in implicit
 *  2) معدل بشري: 8-15 ثانية عشوائي بين الرسائل (لا 3 ثوانٍ ثابتة)
 *  3) سقف 50/يوم/متجر (لا 200) — يقلل risk drastically
 *  4) تخصيص: {{name}} يُستبدل باسم العميل لتفادي pattern "نفس النص"
 *  5) opt-out: يضيف "للإيقاف: اكتب stop" في نهاية كل رسالة
 *  6) backoff على الفشل: لو 3 فشل متتالي → توقف فوري
 *  7) cooldown يومي: لا بث > 1 مرة/24ساعة/متجر
 */

const fs    = require("fs");
const path  = require("path");
const waMgr = require("./whatsapp-manager");

const DATA_DIR = path.join(__dirname, "..", "data");
const COOLDOWN_FILE = path.join(DATA_DIR, "broadcast-cooldown.json");

// ── تكوين السلامة ─────────────────────────────────────────────────
const DELAY_MIN_MS    = 8_000;            // 8 ثوانٍ أقل تأخير
const DELAY_MAX_MS    = 15_000;           // 15 ثانية أقصى تأخير (عشوائي)
const MAX_PER_RUN     = 50;               // سقف صارم لكل بث
const COOLDOWN_HOURS  = 6;                // 6 ساعات بين البث الواحد والآخر/متجر
const MAX_FAILURES    = 3;                // 3 فشل متتالي → توقف فوري

// arbitrary number used by tests/dev (filter out from broadcast)
const TEST_PHONE_BLACKLIST = new Set(["999999999", "966500000000", "966509999999"]);

function isValidPhone(p) {
  const clean = String(p || "").replace(/\D/g, "");
  if (clean.length < 9 || clean.length > 15) return false;
  if (TEST_PHONE_BLACKLIST.has(clean)) return false;
  if (/^(\d)\1{8,}$/.test(clean)) return false;
  return true;
}

function loadCooldown() {
  if (!fs.existsSync(COOLDOWN_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf8")); } catch { return {}; }
}
function saveCooldown(d) {
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(d, null, 2), "utf8");
}

/** يتحقق هل المتجر في cooldown — يرجع { ok:true } أو { ok:false, hoursLeft } */
function checkCooldown(storeId) {
  const d = loadCooldown();
  const last = d[storeId]?.lastBroadcast;
  if (!last) return { ok: true };
  const hoursPassed = (Date.now() - new Date(last).getTime()) / 3600_000;
  if (hoursPassed >= COOLDOWN_HOURS) return { ok: true };
  return { ok: false, hoursLeft: Math.ceil(COOLDOWN_HOURS - hoursPassed) };
}

function markBroadcast(storeId, count) {
  const d = loadCooldown();
  d[storeId] = { lastBroadcast: new Date().toISOString(), lastCount: count };
  saveCooldown(d);
}

/**
 * يجمع أرقام العملاء (orders + customers) لمتجر ويفلتر الوهمي.
 * يرجع: [{ phone, name }]
 */
function getStoreCustomers(storeId) {
  const byPhone = new Map();

  // ── المصدر 1: orders.jsonl ────────────────────────────────────────
  const ordersFile = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);

  if (fs.existsSync(ordersFile)) {
    for (const line of fs.readFileSync(ordersFile, "utf8").split("\n")) {
      try {
        const o = JSON.parse(line);
        if (!o.customerPhone) continue;
        const clean = String(o.customerPhone).replace(/\D/g, "");
        if (!isValidPhone(clean)) continue;
        if (!byPhone.has(clean)) byPhone.set(clean, { phone: clean, name: o.customerName || "" });
      } catch {}
    }
  }

  // ── المصدر 2: customers.json (per-store via composite key) ─────────
  const customersFile = path.join(DATA_DIR, "customers.json");
  if (fs.existsSync(customersFile)) {
    try {
      const all = JSON.parse(fs.readFileSync(customersFile, "utf8"));
      for (const [key, info] of Object.entries(all || {})) {
        const [keyStoreId, keyPhone] = key.split("|");
        if (keyStoreId !== storeId) continue;
        const clean = String(keyPhone || "").replace(/\D/g, "");
        if (!isValidPhone(clean)) continue;
        if (!byPhone.has(clean)) byPhone.set(clean, { phone: clean, name: info?.name || "" });
      }
    } catch {}
  }

  return [...byPhone.values()];
}

/** wrapper للتوافق مع كود قديم */
function getStoreCustomerPhones(storeId) {
  return getStoreCustomers(storeId).map(c => c.phone);
}

/**
 * يبني نص الرسالة لكل عميل مع تخصيص + opt-out
 */
function buildPersonalizedMessage(template, customer) {
  let msg = String(template || "");
  // استبدال {{name}} باسم العميل أو "عميلنا الكريم"
  const name = customer.name && customer.name.length > 1 ? customer.name : "عميلنا الكريم";
  msg = msg.replace(/\{\{\s*name\s*\}\}/gi, name);
  // إضافة opt-out (مهم لتجنب الحظر)
  if (!/إيقاف|stop|توقف/i.test(msg)) {
    msg += "\n\n_للإيقاف: اكتب stop_";
  }
  return msg;
}

/**
 * يُرسل رسالة بث مع كل احتياطات السلامة
 * @returns { sent, failed, total, stopped?: reason, cooldownHours? }
 */
async function broadcast(storeId, messageTemplate, opts = {}) {
  // 1) cooldown check
  const cd = checkCooldown(storeId);
  if (!cd.ok) {
    console.log(`⏱️ [broadcast] ${storeId}: cooldown — ${cd.hoursLeft}h left`);
    return { sent: 0, failed: 0, total: 0, stopped: "cooldown", cooldownHours: cd.hoursLeft };
  }

  // 2) wa session check
  const status = waMgr.getStatus(storeId);
  if (status.status !== "open") {
    return { sent: 0, failed: 0, total: 0, stopped: "wa_closed" };
  }

  // 3) get customers (مفلترة)
  const customers = getStoreCustomers(storeId).slice(0, MAX_PER_RUN);
  const results = { sent: 0, failed: 0, total: customers.length };

  if (customers.length === 0) {
    return { ...results, stopped: "no_recipients" };
  }

  let consecutiveFailures = 0;

  for (let i = 0; i < customers.length; i++) {
    const customer = customers[i];
    const jid = customer.phone + "@s.whatsapp.net";
    const personalizedMsg = buildPersonalizedMessage(messageTemplate, customer);

    try {
      await waMgr.sendMessage(storeId, jid, personalizedMsg);
      results.sent++;
      consecutiveFailures = 0;
    } catch (e) {
      results.failed++;
      consecutiveFailures++;
      console.warn(`⚠️ [broadcast] ${storeId}: failed ${customer.phone}: ${e.message}`);
      if (consecutiveFailures >= MAX_FAILURES) {
        console.error(`🛑 [broadcast] ${storeId}: aborted — ${MAX_FAILURES} consecutive failures`);
        results.stopped = "consecutive_failures";
        break;
      }
    }

    // تأخير بشري عشوائي بين الرسائل (لا ثابت 3s)
    if (i < customers.length - 1) {
      const delay = DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
      await new Promise(r => setTimeout(r, delay));
    }
  }

  markBroadcast(storeId, results.sent);
  console.log(`📢 [broadcast] ${storeId}: ${results.sent}/${results.total} sent (${results.failed} failed)`);
  return results;
}

module.exports = {
  broadcast,
  getStoreCustomerPhones,
  getStoreCustomers,
  checkCooldown,
  MAX_PER_RUN,
  COOLDOWN_HOURS,
};
