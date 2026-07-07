/**
 * 📅 Arabic + Mixed Date Parser
 * يفهم: "اليوم"، "غداً"، "بعد ٣ أيام"، "24 يونيو"، "الخميس"، "2026-06-24"، "24/6"
 * بدون أي dependency خارجية.
 */

const AR_MONTHS = {
  // ميلادية شائعة
  "يناير":1,"كانون الثاني":1,"جانفي":1,
  "فبراير":2,"شباط":2,"فيفري":2,
  "مارس":3,"اذار":3,"آذار":3,
  "ابريل":4,"أبريل":4,"نيسان":4,"افريل":4,"إبريل":4,
  "مايو":5,"ايار":5,"أيار":5,
  "يونيو":6,"حزيران":6,"جوان":6,"يونية":6,
  "يوليو":7,"تموز":7,"جويلية":7,"يوليه":7,
  "اغسطس":8,"أغسطس":8,"اب":8,"آب":8,"اوت":8,
  "سبتمبر":9,"ايلول":9,"أيلول":9,
  "اكتوبر":10,"أكتوبر":10,"تشرين الاول":10,"تشرين الأول":10,
  "نوفمبر":11,"تشرين الثاني":11,
  "ديسمبر":12,"كانون الاول":12,"كانون الأول":12,
};

const AR_WEEKDAYS = {
  "الاحد":0,"الأحد":0,"احد":0,"أحد":0,"sunday":0,"sun":0,
  "الاثنين":1,"الإثنين":1,"اثنين":1,"إثنين":1,"monday":1,"mon":1,
  "الثلاثاء":2,"الثلثاء":2,"ثلاثاء":2,"تلاتاء":2,"tuesday":2,"tue":2,
  "الاربعاء":3,"الأربعاء":3,"اربعاء":3,"أربعاء":3,"wednesday":3,"wed":3,
  "الخميس":4,"خميس":4,"thursday":4,"thu":4,
  "الجمعة":5,"الجمعه":5,"جمعة":5,"جمعه":5,"friday":5,"fri":5,
  "السبت":6,"سبت":6,"saturday":6,"sat":6,
};

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const _toWestern = (s) => String(s || "").replace(/[٠-٩]/g, d => "0123456789"[AR_DIGITS.indexOf(d)]);

// أرقام منطوقة بالعربية
const AR_NUMBERS = {
  "صفر":0,"واحد":1,"احد":1,"اثنين":2,"اثنان":2,"تنين":2,"اتنين":2,
  "ثلاثة":3,"ثلاثه":3,"ثلاث":3,"تلاتة":3,"اربعة":4,"اربع":4,"أربعة":4,"أربع":4,
  "خمسة":5,"خمس":5,"ستة":6,"ست":6,"سبعة":7,"سبع":7,"ثمانية":8,"ثماني":8,
  "تسعة":9,"تسع":9,"عشرة":10,"عشره":10,"عشر":10,
};

function _normalize(s) {
  return _toWestern(String(s || ""))
    .toLowerCase()
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[،,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _atMidnight(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function _addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/**
 * يحلل نص عربي/إنجليزي/مختلط ويعيد Date (يوم بدون ساعة) أو null
 * @param {string} input
 * @returns {Date|null}
 */
function parseDate(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const s = _normalize(raw);
  if (!s) return null;
  const now = _atMidnight(new Date());

  // ─── 1) Relative ───
  if (/^(اليوم|اليومم|الان|now|today)$/.test(s)) return now;
  if (/^(غدا|غدً|غداً|بكره|بكرا|بكرة|tomorrow|tmrw)$/.test(s)) return _addDays(now, 1);
  if (/^(بعد غدا|بعد غد|بعد بكره|day after tomorrow)$/.test(s)) return _addDays(now, 2);
  if (/^(امس|البارح|البارحه|yesterday)$/.test(s)) return _addDays(now, -1);

  // "بعد X يوم/ايام/اسبوع/اسابيع/شهر"
  let m;
  if ((m = s.match(/^(?:بعد|خلال|after|in)\s+(\d+|واحد|اثنين|ثلاث(?:ة|ه)?|اربع(?:ة|ه)?|خمس(?:ة|ه)?|ست(?:ة|ه)?|سبع(?:ة|ه)?|ثماني(?:ة|ه)?|تسع(?:ة|ه)?|عشر(?:ة|ه)?)\s+(يوم|ايام|day|days)$/))) {
    const n = parseInt(m[1], 10) || AR_NUMBERS[m[1]] || 1;
    return _addDays(now, n);
  }
  if ((m = s.match(/^(?:بعد|خلال|in)\s+(\d+|واحد|اثنين|ثلاث(?:ة|ه)?)\s+(اسبوع|اسابيع|week|weeks)$/))) {
    const n = parseInt(m[1], 10) || AR_NUMBERS[m[1]] || 1;
    return _addDays(now, n * 7);
  }
  if ((m = s.match(/^(?:بعد|خلال|in)\s+(\d+)\s+(شهر|اشهر|month|months)$/))) {
    const n = parseInt(m[1], 10) || 1;
    const d = new Date(now);
    d.setMonth(d.getMonth() + n);
    return d;
  }

  // ─── 2) Weekday: "الخميس"، "الخميس القادم"، "next thursday" ───
  for (const [name, idx] of Object.entries(AR_WEEKDAYS)) {
    // يطابق "الخميس"، "الخميس القادم"، "يوم الخميس"
    const re = new RegExp(`^(?:يوم\\s+)?${name}(?:\\s+(?:القادم|الجاي|الجاية|الجايه|المقبل|next))?$`);
    if (re.test(s)) {
      const today = now.getDay();
      let diff = idx - today;
      if (diff <= 0) diff += 7;
      return _addDays(now, diff);
    }
  }

  // ─── 3) ISO format: "2026-06-24" ───
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    return _validDate(y, mo, d);
  }

  // ─── 4) "24/6/2026" أو "24-6-2026" أو "24.6.2026" (day-first) ───
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
    let d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    return _validDate(y, mo, d);
  }

  // ─── 5) "24/6" بدون سنة → السنة الحالية أو القادمة لو الموعد فات ───
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/))) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10);
    return _smartYear(d, mo);
  }

  // ─── 6) "24 يونيو" / "24 يونيو 2026" / "يونيو 24" ───
  for (const [name, num] of Object.entries(AR_MONTHS)) {
    // "24 يونيو" أو "24 يونيو 2026"
    const re1 = new RegExp(`^(\\d{1,2})\\s+${name}(?:\\s+(\\d{2,4}))?$`);
    if ((m = s.match(re1))) {
      const d = parseInt(m[1], 10);
      let y = m[2] ? parseInt(m[2], 10) : null;
      if (y && y < 100) y += 2000;
      if (y) return _validDate(y, num, d);
      return _smartYear(d, num);
    }
    // "يونيو 24" (less common)
    const re2 = new RegExp(`^${name}\\s+(\\d{1,2})(?:\\s+(\\d{2,4}))?$`);
    if ((m = s.match(re2))) {
      const d = parseInt(m[1], 10);
      let y = m[2] ? parseInt(m[2], 10) : null;
      if (y && y < 100) y += 2000;
      if (y) return _validDate(y, num, d);
      return _smartYear(d, num);
    }
  }

  // ─── 7) Native Date parse fallback (English) ───
  const native = new Date(raw);
  if (!isNaN(native.getTime()) && native.getFullYear() >= 2000 && native.getFullYear() < 2100) {
    return _atMidnight(native);
  }

  return null;
}

function _validDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d);
  // verify (لتفادي "31 فبراير" يصير 3 مارس)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return _atMidnight(date);
}

function _smartYear(d, mo) {
  const now = new Date();
  const y = now.getFullYear();
  const try1 = _validDate(y, mo, d);
  if (!try1) return null;
  // لو التاريخ في الماضي بأكثر من 30 يوم → السنة القادمة
  const diff = (try1 - _atMidnight(now)) / 86400000;
  if (diff < -30) return _validDate(y + 1, mo, d);
  return try1;
}

/**
 * يحول Date → "YYYY-MM-DD" (للحفظ/الإرسال)
 */
function toISODate(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * يحول Date → "24 يونيو 2026" (للعرض)
 */
function toArabicDate(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return null;
  const months = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

module.exports = { parseDate, toISODate, toArabicDate };
