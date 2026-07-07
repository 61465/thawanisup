/**
 * Inactivity Watcher — يلغي طلبات العميل الخاملة بعد 5 دقائق
 *
 * المشكلة قبل هذا الموديول: لو العميل بدأ flow طلب (اختار صنف، طلب عنوان، اختار وقت)
 * ثم انشغل، الـ session تبقى نشطة 30 دقيقة كاملة. لو رجع بعد ربع ساعة وكتب "هلا"،
 * البوت يفسرها كمدخل للـ step الذي توقف عنده (مثل العنوان أو الوقت) — فوضى.
 *
 * عمل هذا الموديول:
 *   1) كل دقيقة: يفحص كل الـ sessions النشطة
 *   2) لو session في step يطلب رد العميل + مرت 5 دقائق على آخر نشاط:
 *      - أرسل رسالة: "تم إلغاء الطلب لطول الانتظار، يرجى البدء من جديد"
 *      - reset الـ session للترحيب (next msg = welcome من جديد)
 *      - audit log
 *
 * ⚠️  لا نلمس sessions في WELCOME/POST_ORDER/RATING (لا يوجد طلب نشط)
 * ⚠️  لا نلمس sessions الميتة جداً (>30 دقيقة) — session.js يحذفها أصلاً
 */

const { sessionManager } = require("./session");
const waMgr = require("./whatsapp-manager");

const TICK_MS         = 60 * 1000;           // فحص كل دقيقة
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;       // 5 دقائق من السكوت → إلغاء
const MAX_AGE_MS      = 30 * 60 * 1000;      // لا نلمس sessions أقدم من 30 دقيقة (session.js يحذفها)

// الـ steps التي تعني "العميل في mid-flow ينتظر منه رد"
// لو ما رد لـ5 دقائق، نلغي ونرحّب من جديد
const ACTIVE_FLOW_STEPS = new Set([
  "PATH_SELECT",        // اختر طريقة: webview / numeric / AI
  "CATEGORY",           // عرض الأصناف
  "PRODUCT",            // عرض منتجات الصنف
  "QUANTITY",           // كم العدد
  "CART_ACTION",        // عرض السلة (تعديل / متابعة)
  "CART_EDIT",          // تعديل سلة
  "COUPON",             // إدخال كوبون
  "NUMERIC_MENU",       // قائمة رقمية
  "NUMERIC_FEEDBACK",   // ملاحظة نمط رقمي
  "AI_BROWSE",          // كتابة طلب AI
  "COLLECT_NAME",       // طلب الاسم
  "COLLECT_LOCATION",   // طلب العنوان ← مهم (#3)
  "SCHEDULE_ORDER",     // اختيار الوقت
  "COLLECT_TIME",       // كتابة الوقت
  "CONFIRM_ORDER",      // تأكيد نهائي
  "DYNAMIC_Q",          // أسئلة ديناميكية
  "ORDER_BROWSE",       // تصفح طلبات الكتالوج
  "MAIN_MENU",          // قائمة رئيسية
]);

// steps لا تُعتبر idle (لا يوجد flow نشط):
//   WELCOME, POST_ORDER, RATING

let _ticks = 0;

async function runTick() {
  let sessions;
  try {
    sessions = sessionManager.snapshotAll();
  } catch (e) {
    console.warn("[inactivity-watcher] snapshot failed:", e.message);
    return { checked: 0, cancelled: 0 };
  }

  if (!sessions.length) return { checked: 0, cancelled: 0 };

  const now = Date.now();
  let cancelled = 0;

  for (const sess of sessions) {
    try {
      const idleMs = now - (sess.lastActive || 0);

      // فقط في النافذة [5min, 30min) — قبل ذلك خامل قليلاً، بعد ذلك session.js يحذف
      if (idleMs < IDLE_TIMEOUT_MS) continue;
      if (idleMs >= MAX_AGE_MS) continue;

      // لا تلمس sessions ليست في mid-flow
      if (!ACTIVE_FLOW_STEPS.has(sess.step)) continue;

      // لا تلمس sessions مكتومة (mutedUntil في المستقبل) — لا فائدة من رسالة لها
      if (sess.data?.mutedUntil && sess.data.mutedUntil > now) continue;

      // ⚠️ علامة _inactivityCancelled تمنع إرسال نفس الرسالة مرتين لو الـ session بقي حياً
      if (sess.data?._inactivityCancelled) continue;

      // ⚠️ sess.key هو "storeId|phone" (مفتاح مركّب) — يجب فكّه
      // قبل الإصلاح كان يُستخدم كـ jid فاسد → sendMessage يفشل + reset يضرب key خاطئ → session تبقى حية بمحتوى متجر آخر
      const keyStr = String(sess.key || "");
      const pipeIdx = keyStr.indexOf("|");
      const customerFrom = pipeIdx >= 0 ? keyStr.slice(pipeIdx + 1) : keyStr; // phone فقط
      const storeId      = sess.data?._storeId || (pipeIdx >= 0 ? keyStr.slice(0, pipeIdx) : null);

      // أرسل رسالة الإلغاء (best-effort)
      const msg =
`⏰ *تم إلغاء الطلب لطول الانتظار*

لم نتلقَّ ردك خلال 5 دقائق.

اكتب أي رسالة *للبدء من جديد* 🌸`;

      try {
        if (storeId) {
          await waMgr.sendMessage(storeId, customerFrom, msg);
        } else {
          // fallback: استخدم أي session نشطة (شائع: storeId مش محفوظ في الـ data)
          const ss = waMgr.listSessions();
          const sender = ss.find(s => s.status === "open");
          if (sender) await waMgr.sendMessage(sender.storeId, customerFrom, msg);
        }
      } catch (e) {
        console.warn(`[inactivity-watcher] send failed for ${customerFrom}:`, e.message);
      }

      // ❗ Reset للسيشن: المرة القادمة العميل يكتب → sendWelcome يرحّب من جديد
      // ⚠️ استعمل resetByFullKey لأن sess.key هو "storeId|phone" مركّب
      try {
        if (typeof sessionManager.resetByFullKey === "function") {
          sessionManager.resetByFullKey(sess.key);
        } else {
          sessionManager.reset(customerFrom); // fallback
        }
      } catch (e) {
        console.warn(`[inactivity-watcher] reset failed for ${sess.key}:`, e.message);
      }

      cancelled++;
      console.log(`⏰ [inactivity] cancelled ${customerFrom} — step=${sess.step}, idle=${Math.round(idleMs/1000)}s`);
    } catch (e) {
      console.warn("[inactivity-watcher] per-session error:", e.message);
    }
  }

  _ticks++;
  if (cancelled > 0) {
    console.log(`⏰ [inactivity-watcher] tick #${_ticks}: cancelled ${cancelled} idle session(s) of ${sessions.length}`);
  }
  return { checked: sessions.length, cancelled };
}

let _timer = null;
function start() {
  if (_timer) return;
  _timer = setInterval(() => {
    runTick().catch(e => console.warn("[inactivity-watcher] tick failed:", e.message));
  }, TICK_MS);
  console.log("⏰ [inactivity-watcher] active — يفحص كل دقيقة (timeout=5 دقائق)");
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, runTick };
