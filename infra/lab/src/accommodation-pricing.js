/**
 * 🏖️ Accommodation Pricing — تسعير شاليهات سعودي
 *
 * يدعم:
 * - سعر يوم عادي / weekend (الجمعة + السبت) / إجازات رسمية
 * - extras اختيارية (صالة مناسبات / مبيت / BBQ ...)
 * - check-in 3pm → check-out 3am (الـ checkout قبل 3 صباحاً = نفس الليلة السابقة)
 *
 * Schema unit.accommodation:
 * {
 *   priceWeekday: 700,
 *   priceWeekend: 900,
 *   priceHoliday: 900,         // optional — fallback to priceWeekend
 *   holidays: ["2026-09-23"],  // ISO date strings
 *   extras: [
 *     { key: "hall",     label: "صالة المناسبات", price: 400 },
 *     { key: "overnight",label: "مبيت إضافي",     price: 200 },
 *     { key: "bbq",      label: "BBQ + فحم",      price: 100 }
 *   ]
 * }
 */

const SAUDI_WEEKEND_DAYS = new Set([5, 6]); // الجمعة، السبت

function isWeekend(date) {
  return SAUDI_WEEKEND_DAYS.has(new Date(date).getDay());
}

function isHoliday(date, holidays) {
  if (!Array.isArray(holidays) || !holidays.length) return false;
  const iso = new Date(date).toISOString().slice(0, 10);
  return holidays.includes(iso);
}

function _atMidnight(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * يحسب عدد الليالي مع اعتبار قاعدة "checkout قبل 3 صباحاً = نفس الليلة"
 */
function _countNights(checkIn, checkOut) {
  const ci = new Date(checkIn);
  const co = new Date(checkOut);
  // لو checkout < 3am → الليلة تُحسب لليوم السابق
  if (co.getHours() < 3) co.setDate(co.getDate() - 1);
  const ciMid = _atMidnight(ci);
  const coMid = _atMidnight(co);
  return Math.max(1, Math.round((coMid - ciMid) / 86400000));
}

/**
 * calculatePrice({ unit, checkIn, checkOut, extras })
 * @returns { total, breakdown: [{ day, label, price }], nights }
 */
function calculatePrice({ unit, checkIn, checkOut, extras = [] }) {
  if (!unit || typeof unit !== "object") throw new Error("unit مطلوب");
  if (!checkIn || !checkOut) throw new Error("checkIn + checkOut مطلوبان");

  const a = unit.accommodation || unit;
  const pw  = Number(a.priceWeekday) || 0;
  const pwk = Number(a.priceWeekend) || pw;
  const ph  = Number(a.priceHoliday) || pwk;
  const holidays = a.holidays || [];
  const allowedExtras = a.extras || [];

  const nights = _countNights(checkIn, checkOut);
  const breakdown = [];
  let total = 0;

  const cur = new Date(checkIn);
  cur.setHours(0, 0, 0, 0);
  for (let i = 0; i < nights; i++) {
    let label, price;
    if (isHoliday(cur, holidays))   { label = "إجازة رسمية"; price = ph; }
    else if (isWeekend(cur))        { label = "ويكند";       price = pwk; }
    else                            { label = "يوم عادي";    price = pw; }
    const dayISO = cur.toISOString().slice(0, 10);
    breakdown.push({ day: dayISO, label, price });
    total += price;
    cur.setDate(cur.getDate() + 1);
  }

  // الإضافات
  const selectedKeys = Array.isArray(extras) ? extras : [];
  for (const key of selectedKeys) {
    const def = allowedExtras.find(e => e.key === key);
    if (def && Number(def.price) > 0) {
      breakdown.push({ day: "extra", label: def.label || key, price: Number(def.price) });
      total += Number(def.price);
    }
  }

  return { total, nights, breakdown };
}

/**
 * يحوّل breakdown إلى نص عربي للعرض في الـ summary للعميل
 */
function formatBreakdown(breakdown, currency = "ر.س") {
  return breakdown.map(b => {
    if (b.day === "extra") return `• ${b.label}: +${b.price} ${currency}`;
    return `• ${b.day} (${b.label}): ${b.price} ${currency}`;
  }).join("\n");
}

module.exports = { calculatePrice, isWeekend, isHoliday, formatBreakdown };
