/**
 * 📅 Booking Reminder Scheduler
 * يفحص كل 15 دقيقة الحجوزات المُستحقّة للتذكير، 3 أنواع:
 *   - reminder_24h: قبل 24 ساعة من الموعد
 *   - reminder_day: صباح يوم الحجز (8 صباحاً)
 *   - reminder_1h:  قبل ساعة من الموعد (للحجوزات بوقت محدد)
 *
 * كل نوع له علم منفصل لمنع التكرار.
 */

const bookings = require("./bookings");
const fs = require("fs");
const path = require("path");

const STORES_FILE = path.join(__dirname, "..", "data", "stores.json");
const INTERVAL_MS = 15 * 60 * 1000; // كل 15 دقيقة

let _timer = null;

function _readAllStores() {
  try {
    const data = JSON.parse(fs.readFileSync(STORES_FILE, "utf8"));
    return Array.isArray(data.stores) ? data.stores : [];
  } catch { return []; }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function _renderTemplate(tpl, vars) {
  let s = tpl;
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), String(v || ""));
  }
  return s;
}

function _bookingVars(store, b) {
  const dt = new Date(b.startAt);
  const timeStr = dt.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit", hour12: true });
  const dateStr = dt.toLocaleDateString("ar-EG", { weekday: "long", month: "long", day: "numeric" });
  return {
    customerName: b.customerName || "عزيزنا",
    storeName:    store.storeName || "متجرنا",
    unitName:     b.unitName || b.serviceName || "",
    serviceName:  b.serviceName || b.unitName || "",
    date:         dateStr,
    time:         timeStr,
    total:        b.totalPrice || "",
    bookingId:    b.id,
    checkInTime:  store.checkInTime || "3 مساءً",
    checkOutTime: store.checkOutTime || "12 ظهراً",
  };
}

// ─── Templates افتراضية (قابلة للتخصيص من الادمن) ──────────────────────────
const DEFAULT_TEMPLATES = {
  reminder_24h: `⏰ *تذكير بموعدك غداً*

أهلاً {{customerName}} 👋

نذكّرك بموعدك في *{{storeName}}* بعد 24 ساعة:

🏠 {{unitName}}
📅 {{date}}
🕐 {{time}}

نراك قريباً! 🌹
لإلغاء أو تأجيل: تواصل معنا.`,

  reminder_day: `🌅 *صباح الخير {{customerName}}*

اليوم موعدك في *{{storeName}}*! 🎉

🏠 {{unitName}}
🕐 وقت الوصول: {{checkInTime}}

تأكد من:
✓ إحضار الهوية
✓ أي طلبات خاصة جهزتها مسبقاً

نراك اليوم! 🌹`,

  reminder_1h: `🔔 *موعدك بعد ساعة*

أهلاً {{customerName}}

تذكير سريع — موعدك في *{{storeName}}* بعد ساعة:

🏠 {{unitName}}
🕐 {{time}}

نحن جاهزون لاستقبالك 🌹`,

  bookingCompletedTemplate: `🌟 *شكراً لاختيارك {{storeName}}*

أهلاً {{customerName}} 👋

نتمنى أن تكون قد قضيت وقتاً ممتعاً في *{{unitName}}*.

⭐ نرحب بتقييمك من 1 إلى 5
يساعدنا تقييمك على تطوير خدماتنا

سعداء بخدمتك مرة أخرى 🌹`,
};

// ─── Scan logic ────────────────────────────────────────────────────────────
function _getDueByType(allBookings, now) {
  const due = { reminder_24h: [], reminder_day: [], reminder_1h: [], bookingCompletedTemplate: [] };
  const in24h = now + 24 * 3600 * 1000;
  const in1h  = now + 1 * 3600 * 1000;
  const window24h = 30 * 60_000; // ± 30 دقيقة
  const window1h  = 10 * 60_000; // ± 10 دقيقة

  // ساعة الصباح (8 ص بتوقيت السعودية = UTC+3)
  const morningHour = 8;
  const nowDate = new Date(now);
  const nowHourLocal = (nowDate.getUTCHours() + 3) % 24;
  const isMorningWindow = nowHourLocal >= morningHour && nowHourLocal < (morningHour + 1);

  for (const b of allBookings) {
    // ⭐ rating بعد آخر يوم — للحجوزات المنتهية (endAt مضى بـ ساعة على الأقل)
    if (!b.reminderSentCompleted && (b.status === "confirmed" || b.status === "completed")) {
      const endTs = new Date(b.endAt || b.startAt).getTime();
      const oneHourAfterEnd = endTs + 3600_000;
      // نافذة: مرت ساعة بعد النهاية + ≤ 12 ساعة (لتفادي رسائل متأخرة جداً)
      if (now >= oneHourAfterEnd && now - oneHourAfterEnd <= 12 * 3600_000) {
        due.bookingCompletedTemplate.push(b);
      }
    }

    if (b.status !== "confirmed" && b.status !== "pending") continue;
    const ts = new Date(b.startAt).getTime();
    if (ts <= now) continue; // مضى الموعد

    // 24h reminder
    if (!b.reminderSent24h && !b.reminderSent && Math.abs(ts - in24h) <= window24h) {
      due.reminder_24h.push(b);
    }

    // Morning of day reminder (8 صباحاً + الموعد اليوم)
    if (!b.reminderSentDay && isMorningWindow) {
      const bookingDate = new Date(b.startAt);
      const bookingDateLocal = new Date(bookingDate.getTime() + 3 * 3600_000); // +3h KSA
      const nowLocal = new Date(now + 3 * 3600_000);
      if (bookingDateLocal.toISOString().slice(0,10) === nowLocal.toISOString().slice(0,10)) {
        due.reminder_day.push(b);
      }
    }

    // 1h reminder
    if (!b.reminderSent1h && Math.abs(ts - in1h) <= window1h) {
      due.reminder_1h.push(b);
    }
  }
  return due;
}

async function _scanOnce() {
  const stores = _readAllStores();
  const waMgr = require("./whatsapp-manager");

  for (const store of stores) {
    try {
      // ⚠️ includeExpired=true ضروري — نحتاج الحجوزات المنتهية لإرسال rating بعد endAt
      const allBookings = bookings.listBookings(store.id, { includeExpired: true });
      if (!allBookings.length) continue;
      const due = _getDueByType(allBookings, Date.now());

      for (const [type, list] of Object.entries(due)) {
        for (const b of list) {
          if (!b.customerPhone) continue;
          // SESSION_GUARD_v1 — تخطى المتاجر غير المتصلة بواتس (بدل الفشل المكرر)
          const _st = waMgr.getStatus(store.id);
          if (!_st || _st.status !== "open") {
            console.log(`[booking-reminder] skip ${type} for ${b.id}: session=${_st?.status||"missing"}`);
            continue;
          }
          // ⭐ bookingCompletedTemplate له اسم مفتاح مختلف (يحوي "Template" أصلاً)
          const tplKey = type.endsWith("Template") ? type : type + "Template";
          const tpl = store[tplKey] || DEFAULT_TEMPLATES[type];
          const vars = _bookingVars(store, b);
          const msg = _renderTemplate(tpl, vars);
          try {
            const jid = b.customerPhone + "@s.whatsapp.net";
            const reason = type === "bookingCompletedTemplate" ? "order_completed" : "booking_reminder";
            await waMgr.sendMessage(store.id, jid, msg, { allowCold: true, reason });
            // علم خاص بنوع التذكير
            const flagMap = {
              reminder_24h: "reminderSent24h",
              reminder_day: "reminderSentDay",
              reminder_1h:  "reminderSent1h",
              bookingCompletedTemplate: "reminderSentCompleted",
            };
            const extra = { [flagMap[type]]: true, [flagMap[type] + "At"]: new Date().toISOString() };
            // backward compat للحقل القديم
            if (type === "reminder_24h") { extra.reminderSent = true; extra.reminderSentAt = extra[flagMap[type] + "At"]; }
            bookings.updateBookingStatus(store.id, b.id, b.status, extra);
            console.log(`[booking-reminder] ${type} sent for ${b.id} → ${store.id}`);
          } catch (e) {
            console.warn(`[booking-reminder] ${type} failed for ${b.id}:`, e.message);
          }
        }
      }
    } catch (e) {
      console.warn(`[booking-reminder] scan failed for ${store.id}:`, e.message);
    }
  }
}

function start() {
  if (_timer) return;
  setTimeout(_scanOnce, 60_000);
  _timer = setInterval(_scanOnce, INTERVAL_MS);
  _timer.unref?.();
  console.log(`📅 [booking-reminder] active — يفحص كل ${INTERVAL_MS/60_000} دقيقة (24h + day + 1h)`);
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, _scanOnce, DEFAULT_TEMPLATES };
