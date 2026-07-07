/**
 * 📅 Bookings — نظام حجوزات للصالونات والعيادات + تأجير العقارات (شاليهات/منازل)
 *
 * Schema (data/bookings_<storeId>.jsonl):
 *   { id, storeId, customerName, customerPhone, serviceId, serviceName,
 *     startAt: ISO,           // check-in للعقارات / موعد البداية للصالونات
 *     durationMin,            // للحجوزات اللحظية (صالون) — يبقى للتوافق
 *     endAt: ISO?,            // 🏠 check-out للعقارات (null للصالون)
 *     unitId, unitName?,      // 🏠 المنتج/الوحدة المحجوزة (للعقارات)
 *     pricePerNight?,         // 🏠 snapshot للسعر وقت الحجز
 *     nights?,                // 🏠 عدد الليالي (cached)
 *     guests?,                // 🏠 عدد الضيوف
 *     totalPrice?,            // 🏠 nights * pricePerNight
 *     staffId?, notes, status, createdAt }
 *
 * status: pending|confirmed|in_progress|completed|cancelled|no_show
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const atomicFs = require("./atomic-fs");

const DATA_DIR = path.join(__dirname, "..", "data");

function _file(storeId) {
  return path.join(DATA_DIR, `bookings_${storeId}.jsonl`);
}

function _read(storeId) {
  const f = _file(storeId);
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function _append(storeId, b) {
  fs.appendFileSync(_file(storeId), JSON.stringify(b) + "\n");
}

function _rewrite(storeId, all) {
  fs.writeFileSync(_file(storeId), all.map(b => JSON.stringify(b)).join("\n") + "\n");
}

/**
 * احجز موعداً جديداً
 * 🛡️ محمي من race — atomic check-then-write عبر withLock على ملف الحجوزات
 */
function createBooking(storeId, data) {
  return atomicFs.withLock(_file(storeId), () => _createBookingUnsafe(storeId, data));
}
function _createBookingUnsafe(storeId, data) {
  // 🏠 حساب nights/totalPrice تلقائياً لو endAt + pricePerNight موجودان
  let nights = null, totalPrice = null;
  if (data.endAt && data.pricePerNight != null) {
    const startMs = new Date(data.startAt).getTime();
    const endMs   = new Date(data.endAt).getTime();
    if (!isNaN(startMs) && !isNaN(endMs) && endMs > startMs) {
      nights = Math.ceil((endMs - startMs) / (24 * 3600_000));
      totalPrice = nights * Number(data.pricePerNight);
    }
  }

  const b = {
    id: "bk_" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
    storeId,
    customerName: String(data.customerName || "").trim().slice(0, 80),
    customerPhone: String(data.customerPhone || "").replace(/\D/g, "").slice(0, 15),
    serviceId: data.serviceId || null,
    serviceName: String(data.serviceName || "").trim().slice(0, 120),
    startAt: data.startAt,
    durationMin: parseInt(data.durationMin) || 30,
    staffId: data.staffId || null,
    notes: String(data.notes || "").trim().slice(0, 500),
    status: "pending",
    createdAt: new Date().toISOString(),
    // 🏠 حقول العقارات (اختيارية — null لباقي الأنواع)
    endAt:         data.endAt || null,
    unitId:        data.unitId || null,
    unitName:      data.unitName ? String(data.unitName).slice(0, 120) : null,
    pricePerNight: data.pricePerNight != null ? Number(data.pricePerNight) : null,
    nights,
    guests:        data.guests != null ? parseInt(data.guests) : null,
    totalPrice,
  };
  if (!b.customerName || !b.startAt) {
    return { ok: false, error: "اسم العميل + موعد البداية مطلوبان" };
  }
  // 🏠 لو حجز عقار (endAt + unitId) — افحص تعارض الفترة على نفس الوحدة
  if (b.endAt && b.unitId) {
    const conflictUnit = !isUnitAvailable(storeId, b.unitId, b.startAt, b.endAt);
    if (conflictUnit) {
      return { ok: false, error: "الوحدة محجوزة في الفترة المطلوبة", code: "UNIT_UNAVAILABLE" };
    }
  }
  // فحص تعارض موعد (نفس staffId في نفس الوقت) — للصالونات
  if (b.staffId) {
    const start = new Date(b.startAt).getTime();
    const end = start + b.durationMin * 60_000;
    const all = _read(storeId);
    const conflict = all.find(x =>
      x.staffId === b.staffId &&
      x.status !== "cancelled" && x.status !== "completed" &&
      ((new Date(x.startAt).getTime() < end) &&
       (new Date(x.startAt).getTime() + (x.durationMin || 30) * 60_000 > start))
    );
    if (conflict) return { ok: false, error: "الموعد متعارض مع حجز موجود لنفس الموظف" };
  }
  _append(storeId, b);
  return { ok: true, booking: b };
}

/**
 * 🏠 فحص توفّر وحدة عقارية في فترة (من ISO، إلى ISO)
 * الحجز المُلغى/المنتهي لا يعد تعارضاً.
 * تعارض = فترتان تشتركان في أي يوم.
 */
function isUnitAvailable(storeId, unitId, fromISO, toISO) {
  if (!unitId || !fromISO || !toISO) return false;
  const from = new Date(fromISO).getTime();
  const to   = new Date(toISO).getTime();
  if (isNaN(from) || isNaN(to) || to <= from) return false;
  const all = _read(storeId);
  for (const x of all) {
    if (x.unitId !== unitId) continue;
    if (["cancelled","completed","no_show"].includes(x.status)) continue;
    if (!x.endAt) continue; // ليس حجز عقار
    const xFrom = new Date(x.startAt).getTime();
    const xTo   = new Date(x.endAt).getTime();
    // تعارض لو الفترتان تتداخلان (open intervals)
    if (xFrom < to && xTo > from) return false;
  }
  return true;
}

/**
 * 🏠 حالة وحدة الآن: متاحة الآن؟ متى ينتهي الحجز الحالي؟ متى الحجز القادم؟
 */
function getUnitAvailability(storeId, unitId) {
  if (!unitId) return { available: true };
  const now = Date.now();
  const all = _read(storeId);
  const unitBookings = all.filter(b =>
    b.unitId === unitId &&
    b.endAt &&
    !["cancelled","completed","no_show"].includes(b.status)
  );
  if (!unitBookings.length) return { available: true };

  // ابحث عن الحجز النشط الآن (startAt <= now < endAt)
  const active = unitBookings.find(b => {
    const s = new Date(b.startAt).getTime();
    const e = new Date(b.endAt).getTime();
    return s <= now && now < e;
  });
  if (active) {
    // الحجز التالي (لو موجود) بعد endAt مباشرة
    const after = unitBookings
      .filter(b => new Date(b.startAt).getTime() >= new Date(active.endAt).getTime())
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0];
    return {
      available: false,
      currentBooking: { endAt: active.endAt, customerName: active.customerName },
      nextBooking: after ? { startAt: after.startAt } : null,
    };
  }
  // غير نشط الآن — متاح، لكن أرفق الحجز القادم
  const upcoming = unitBookings
    .filter(b => new Date(b.startAt).getTime() > now)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0];
  return {
    available: true,
    nextBooking: upcoming ? { startAt: upcoming.startAt, endAt: upcoming.endAt } : null,
  };
}

/**
 * 🏠 معدّل الإشغال الشهري للوحدة (نسبة الأيام المحجوزة من أيام الشهر الحالي)
 */
function getUnitOccupancyRate(storeId, unitId, yearMonth) {
  if (!unitId) return { rate: 0, bookedDays: 0, totalDays: 0 };
  const ym = yearMonth || new Date().toISOString().slice(0, 7);
  const [y, m] = ym.split("-").map(Number);
  const monthStart = new Date(Date.UTC(y, m - 1, 1)).getTime();
  const monthEnd   = new Date(Date.UTC(y, m, 1)).getTime();
  const totalDays  = Math.round((monthEnd - monthStart) / (24 * 3600_000));
  const all = _read(storeId);
  const days = new Set();
  for (const b of all) {
    if (b.unitId !== unitId) continue;
    if (["cancelled","no_show"].includes(b.status)) continue;
    if (!b.endAt) continue;
    const bStart = Math.max(new Date(b.startAt).getTime(), monthStart);
    const bEnd   = Math.min(new Date(b.endAt).getTime(),   monthEnd);
    if (bEnd <= bStart) continue;
    for (let t = bStart; t < bEnd; t += 24 * 3600_000) {
      const dayKey = new Date(t).toISOString().slice(0, 10);
      days.add(dayKey);
    }
  }
  return {
    rate: totalDays > 0 ? Math.round((days.size / totalDays) * 100) : 0,
    bookedDays: days.size,
    totalDays,
    yearMonth: ym,
  };
}

function listBookings(storeId, opts = {}) {
  let bookings = _read(storeId);
  if (opts.status) bookings = bookings.filter(b => b.status === opts.status);
  // 🆕 إخفاء الحجوزات المنتهية تلقائياً (endAt مضى) — تبقى في data + تظهر في صفحة العملاء فقط
  // includeExpired=true يعطّل هذا (للـ stats + التقارير)
  if (!opts.includeExpired) {
    const now = Date.now();
    bookings = bookings.filter(b => {
      // status صريح "completed"/"cancelled"/"rejected" → إخفاء
      if (["completed","cancelled","rejected"].includes(b.status)) return false;
      // endAt مضى أكثر من ساعة → تلقائياً منتهية
      const endTs = b.endAt ? new Date(b.endAt).getTime() : new Date(b.startAt).getTime() + (b.durationMin||30) * 60_000;
      if (!isNaN(endTs) && now > endTs + 3600_000) return false;
      return true;
    });
  }
  if (opts.from) {
    const from = new Date(opts.from).getTime();
    bookings = bookings.filter(b => new Date(b.startAt).getTime() >= from);
  }
  if (opts.to) {
    const to = new Date(opts.to).getTime();
    bookings = bookings.filter(b => new Date(b.startAt).getTime() <= to);
  }
  // الأحدث أولاً افتراضياً، أو الأقدم لو asked
  bookings.sort((a, b) => opts.asc
    ? new Date(a.startAt) - new Date(b.startAt)
    : new Date(b.startAt) - new Date(a.startAt));
  if (opts.limit) bookings = bookings.slice(0, opts.limit);
  return bookings;
}

function updateBookingStatus(storeId, bookingId, status, extra = {}) {
  const all = _read(storeId);
  const idx = all.findIndex(b => b.id === bookingId);
  if (idx === -1) return { ok: false, error: "الحجز غير موجود" };
  all[idx].status = status;
  all[idx].updatedAt = new Date().toISOString();
  Object.assign(all[idx], extra);
  _rewrite(storeId, all);
  return { ok: true, booking: all[idx] };
}

/**
 * المواعيد المتاحة في يوم معين (لمدة معينة، staff معين)
 */
function getAvailableSlots(storeId, date, options = {}) {
  const { durationMin = 30, slotMinutes = 30, workStart = "09:00", workEnd = "21:00", staffId = null } = options;
  const dayStart = new Date(date + "T" + workStart + ":00").getTime();
  const dayEnd = new Date(date + "T" + workEnd + ":00").getTime();
  if (isNaN(dayStart)) return [];

  const all = _read(storeId);
  const taken = all.filter(b =>
    b.status !== "cancelled" && b.status !== "completed" &&
    (!staffId || b.staffId === staffId) &&
    new Date(b.startAt).toISOString().slice(0, 10) === date
  );

  const slots = [];
  for (let t = dayStart; t + durationMin * 60_000 <= dayEnd; t += slotMinutes * 60_000) {
    const slotEnd = t + durationMin * 60_000;
    const isTaken = taken.some(b => {
      const bs = new Date(b.startAt).getTime();
      const be = bs + (b.durationMin || 30) * 60_000;
      return (bs < slotEnd) && (be > t);
    });
    if (!isTaken) slots.push({ startAt: new Date(t).toISOString(), durationMin });
  }
  return slots;
}

/**
 * إحصائيات سريعة (للداشبورد)
 */
function getStats(storeId) {
  const all = _read(storeId);
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  return {
    total: all.length,
    today: all.filter(b => b.startAt.slice(0, 10) === today && b.status !== "cancelled").length,
    tomorrow: all.filter(b => b.startAt.slice(0, 10) === tomorrow && b.status !== "cancelled").length,
    pending: all.filter(b => b.status === "pending").length,
    confirmed: all.filter(b => b.status === "confirmed").length,
    cancelled: all.filter(b => b.status === "cancelled").length,
  };
}

/**
 * يُرجع الحجوزات التي تستحق reminder (24h ± 30m قبل الموعد، لم يُرسل لها بعد)
 */
function getRemindersDue(storeId) {
  const now = Date.now();
  const in24h = now + 24 * 3600 * 1000;
  const window = 30 * 60_000; // نافذة 30 دقيقة
  return _read(storeId).filter(b => {
    if (b.reminderSent) return false;
    if (b.status !== "confirmed" && b.status !== "pending") return false;
    const ts = new Date(b.startAt).getTime();
    return ts > now && Math.abs(ts - in24h) <= window;
  });
}

function markReminderSent(storeId, bookingId) {
  const all = _read(storeId);
  const idx = all.findIndex(b => b.id === bookingId);
  if (idx === -1) return false;
  all[idx].reminderSent = true;
  all[idx].reminderSentAt = new Date().toISOString();
  _rewrite(storeId, all);
  return true;
}

function getBooking(storeId, bookingId) {
  return _read(storeId).find(b => b.id === bookingId) || null;
}

function deleteBooking(storeId, bookingId) {
  const all = _read(storeId);
  const filtered = all.filter(b => b.id !== bookingId);
  if (filtered.length === all.length) return false;
  _rewrite(storeId, filtered);
  return true;
}

module.exports = {
  createBooking, listBookings, updateBookingStatus, getAvailableSlots,
  getStats, getRemindersDue, markReminderSent, getBooking, deleteBooking,
  // 🏠 accommodation helpers
  isUnitAvailable, getUnitAvailability, getUnitOccupancyRate,
};
