/**
 * Order Scheduler — الطلبات المسبقة بوقت محدد
 * يتتبع الطلبات التي اختار فيها العميل وقت استلام محدد
 * يُنبّه مالك المتجر قبل 5 دقائق من الموعد
 */

const waMgr = require("./whatsapp-manager");

// قائمة الطلبات المجدولة في الذاكرة
// { orderId, storeId, ownerPhone, scheduledMs, scheduledStr, customerName, total, currency, notified }
const queue = [];

/**
 * يحوّل نص وقت عربي/إنجليزي إلى Date في اليوم الحالي (أو غداً إن مضى)
 * يقبل أنماطاً متعددة:
 *  - وقت محدد: "7:30 مساء", "19:30", "7 PM", "8 صباحاً", "20:00"
 *  - وقت نسبي: "بعد ساعة", "بعد ساعتين", "بعد 30 دقيقة", "بعد ساعة ونصف",
 *               "نصف ساعة", "ربع ساعة", "ساعة"
 *  - فوري:     "الآن"
 */
function parseArabicTime(str) {
  if (!str) return null;
  const s = str.trim().toLowerCase();

  // فوري
  if (/^(الآن|الان|الأن|now|⚡|فور(اً|ا)?)$/i.test(s)) {
    return new Date();
  }

  // أرقام عربية → غربية
  const western = s.replace(/[٠-٩]/g, d => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)]);

  // ─── 1) أوقات نسبية: "بعد X دقيقة/ساعة" أو بدون "بعد" ──────────────────────
  // أولوية: ساعتين / دقيقتين كنماذج محددة
  if (/(ساعتين|ساعتان)/.test(western)) {
    const half = /(ونصف|و\s*نصف|نص)/.test(western) ? 30 : 0;
    return _addMinutes(120 + half);
  }
  if (/(دقيقتين|دقيقتان)/.test(western)) {
    return _addMinutes(2);
  }

  // "بعد X (دقيقة|ساعة|ساعات|دقائق)" — مع كسور "ونصف"/"وربع"
  // ملاحظة: \b لا يعمل بعد الحروف العربية، فنستخدم lookbehind ونتجنّبه
  const relMatch = western.match(/(?:بعد|خلال|after|in)?\s*(\d{1,3})\s*(?:دقيقة|دقائق|دقايق|minutes?|mins?|m\b)/);
  if (relMatch) {
    return _addMinutes(parseInt(relMatch[1], 10));
  }
  const relHrs = western.match(/(?:بعد|خلال|after|in)?\s*(\d{1,2})\s*(?:و\s*)?(?:ساعة|ساعات|hours?|hrs?)/);
  if (relHrs) {
    const h = parseInt(relHrs[1], 10);
    const half = /(ونصف|و\s*نصف|نص)/.test(western) ? 30 : (/(وربع|و\s*ربع)/.test(western) ? 15 : 0);
    return _addMinutes(h * 60 + half);
  }
  // "ساعة" بمفردها = 60 دقيقة (مع كسور)
  if (/^(?:بعد\s+)?ساعة(?:\s+(ونصف|وربع|و\s*نصف|و\s*ربع|ونص|و\s*نص))?$/.test(western)) {
    const half = /(ونصف|و\s*نصف|ونص|و\s*نص)/.test(western) ? 30 : (/(وربع|و\s*ربع)/.test(western) ? 15 : 0);
    return _addMinutes(60 + half);
  }
  // "نصف ساعة" / "نص ساعة" / "نصو ساعة" (عامية)
  if (/(?:بعد\s+)?(نصف|نص|نصو|نصف\s*ال)\s*ساعة/.test(western))   return _addMinutes(30);
  // "ربع ساعة" / "ربع الساعة"
  if (/(?:بعد\s+)?ربع\s*(?:ال)?ساعة/.test(western))                return _addMinutes(15);
  // "ثلث ساعة" / "تلت ساعة" (عامية مصرية) / "20 دقيقة"
  if (/(?:بعد\s+)?(?:ثلث|تلت|3\/4)\s*(?:ال)?ساعة/.test(western))    return _addMinutes(20);
  // "ثلاثة أرباع الساعة" / "45 دقيقة"
  if (/(?:بعد\s+)?(?:ثلاثة\s*ارباع|3\s*ارباع|٣\/٤)\s*(?:ال)?ساعة/.test(western)) return _addMinutes(45);

  // ─── 2) وقت محدد ──────────────────────────────────────────────────────────
  const isPM  = /مساء|مساءا|مساءً|pm|م\b/i.test(western);
  const isAM  = /صباح|صباحا|صباحاً|am|ص\b/i.test(western);

  const match = western.match(/(\d{1,2})(?::(\d{2}))?/);
  if (!match) return null;

  let hours   = parseInt(match[1], 10);
  let minutes = match[2] ? parseInt(match[2], 10) : 0;

  if (hours > 23 || minutes > 59) return null;

  // تحويل 12h → 24h
  if (isPM && hours < 12)  hours += 12;
  if (isAM && hours === 12) hours  = 0;

  const result = new Date();
  result.setHours(hours, minutes, 0, 0);

  // إذا مضى الوقت اليوم → غداً
  if (result <= new Date()) result.setDate(result.getDate() + 1);

  return result;
}

function _addMinutes(min) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + min);
  return d;
}

/**
 * يضيف طلباً للقائمة المجدولة
 * @returns {boolean} true إذا نجح تحليل الوقت
 */
function addScheduledOrder({ orderId, storeId, ownerPhone, scheduledStr, customerName, total, currency }) {
  const date = parseArabicTime(scheduledStr);
  if (!date) return false;

  queue.push({
    orderId,
    storeId,
    ownerPhone,
    scheduledMs:  date.getTime(),
    scheduledStr: scheduledStr.trim(),
    customerName,
    total,
    currency: currency || "ر.س",
    notified: false,
  });

  console.log(`⏰ [scheduler] طلب ${orderId} مجدول ${date.toLocaleTimeString("ar-SA")}`);
  return true;
}

// يفحص القائمة كل دقيقة
async function tick() {
  const now = Date.now();

  for (const order of queue) {
    if (order.notified) continue;
    const remaining = order.scheduledMs - now;

    // نُنبّه خلال نافذة من 6 دقائق قبل حتى 2 دقيقة بعد الموعد
    if (remaining <= 6 * 60_000 && remaining > -2 * 60_000) {
      order.notified = true;

      const label = remaining > 0
        ? `خلال ${Math.ceil(remaining / 60_000)} دقيقة`
        : "الآن";

      const msg =
        `⏰ *تنبيه — طلب مجدول*\n\n` +
        `رقم الطلب: *${order.orderId}*\n` +
        `العميل: *${order.customerName}*\n` +
        `وقت الاستلام: *${order.scheduledStr}* (${label})\n` +
        `الإجمالي: *${(order.total || 0).toFixed(2)} ${order.currency}*\n\n` +
        `⚡ الرجاء التجهيز!`;

      if (order.ownerPhone && waMgr.getStatus(order.storeId).status === "open") {
        const ownerJid = order.ownerPhone.replace(/\D/g, "") + "@s.whatsapp.net";
        try { await waMgr.sendMessage(order.storeId, ownerJid, msg); }
        catch (e) { console.error(`❌ [scheduler] فشل إرسال لـ ${order.storeId}:`, e.message); }
      }
    }
  }

  // تنظيف الطلبات المنتهية (أكثر من ساعتين بعد موعدها)
  const cutoff = now - 2 * 60 * 60_000;
  let i = queue.length;
  while (i--) {
    if (queue[i].notified && queue[i].scheduledMs < cutoff) queue.splice(i, 1);
  }
}

function start() {
  setInterval(() => tick().catch(console.error), 60_000);
  console.log("⏰ Order scheduler جاهز (فحص كل دقيقة)");
}

module.exports = { start, addScheduledOrder, parseArabicTime };
