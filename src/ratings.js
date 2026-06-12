/**
 * Post-Order Rating System — تقييم ما بعد الطلب + AI analysis + service recovery
 * يُرسل للعميل طلب تقييم بعد إنهاء الطلب
 * يدعم: رد المالك، حافز ولاء، AI sentiment، keywords، تذكير 24h
 */
const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

const RATINGS_FILE = path.join(__dirname, "..", "data", "ratings.jsonl");

const STARS = { "1": "⭐", "2": "⭐⭐", "3": "⭐⭐⭐", "4": "⭐⭐⭐⭐", "5": "⭐⭐⭐⭐⭐" };

function _ensureFile() {
  if (!fs.existsSync(RATINGS_FILE)) {
    fs.mkdirSync(path.dirname(RATINGS_FILE), { recursive: true });
    fs.writeFileSync(RATINGS_FILE, "");
  }
}

// حفظ تقييم جديد (id فريد للسماح بالـ respond لاحقاً)
function saveRating({ storeId, phone, orderId, rating, comment, source = "bot", lang = "ar" }) {
  _ensureFile();
  const entry = {
    id: "r_" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
    storeId, phone, orderId,
    rating: parseInt(rating),
    comment: String(comment || "").trim().slice(0, 600),
    timestamp: new Date().toISOString(),
    source,                  // bot | web
    lang,                    // ar | en
    response: null,          // رد المالك
    respondedAt: null,
  };
  fs.appendFileSync(RATINGS_FILE, JSON.stringify(entry) + "\n");
  return entry;
}

function _readAll() {
  _ensureFile();
  try {
    return fs.readFileSync(RATINGS_FILE, "utf8")
      .split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// قراءة تقييمات متجر
function getStoreRatings(storeId) {
  return _readAll().filter(r => r.storeId === storeId);
}

// متوسط التقييم (legacy compat)
function getAverageRating(storeId) {
  const ratings = getStoreRatings(storeId);
  if (!ratings.length) return null;
  const avg = ratings.reduce((s, r) => s + (r.rating || 0), 0) / ratings.length;
  return { average: Number(avg.toFixed(2)), count: ratings.length, stars: STARS[String(Math.round(avg))] || "⭐⭐⭐" };
}

// ملخص شامل + توزيع + 5 آخر تعليقات
function getStoreSummary(storeId) {
  const ratings = getStoreRatings(storeId);
  if (!ratings.length) return { average: 0, count: 0, distribution: { 1:0,2:0,3:0,4:0,5:0 } };
  const distribution = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  let sum = 0;
  for (const r of ratings) {
    const n = parseInt(r.rating);
    if (n >= 1 && n <= 5) { distribution[n]++; sum += n; }
  }
  const average = Number((sum / ratings.length).toFixed(2));
  const recentComments = ratings
    .filter(r => r.comment && r.comment.trim())
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
    .slice(0, 5);
  const fiveStarCount = distribution[5];
  const positivePercent = ((distribution[4] + distribution[5]) / ratings.length) * 100;
  const negativePercent = ((distribution[1] + distribution[2]) / ratings.length) * 100;
  // NPS approximation: promoters (5) - detractors (1+2) / total * 100
  const nps = Math.round(((distribution[5] - distribution[1] - distribution[2]) / ratings.length) * 100);
  return {
    average, count: ratings.length, distribution, recentComments,
    fiveStarCount,
    positivePercent: Math.round(positivePercent),
    negativePercent: Math.round(negativePercent),
    nps,
    stars: STARS[String(Math.round(average))] || "",
  };
}

// تقييمات مفلترة بحسب N آخر يوم
function getRecentRatings(storeId, days = 30) {
  const cutoff = Date.now() - days * 86400_000;
  return getStoreRatings(storeId).filter(r => new Date(r.timestamp || 0).getTime() >= cutoff);
}

// trend: قارن أول نصف فترة بثاني نصف
function getTrend(storeId, days = 30) {
  const list = getRecentRatings(storeId, days).sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  if (list.length < 4) return "stable";
  const half = Math.floor(list.length / 2);
  const first = list.slice(0, half);
  const second = list.slice(half);
  const avgFirst  = first.reduce((s, r) => s + r.rating, 0)  / first.length;
  const avgSecond = second.reduce((s, r) => s + r.rating, 0) / second.length;
  if (avgSecond - avgFirst > 0.3) return "improving";
  if (avgFirst - avgSecond > 0.3) return "declining";
  return "stable";
}

// رد المالك على تقييم
function respondToRating(ratingId, response) {
  const all = _readAll();
  const idx = all.findIndex(r => r.id === ratingId);
  if (idx < 0) return null;
  all[idx].response = String(response).slice(0, 800);
  all[idx].respondedAt = new Date().toISOString();
  fs.writeFileSync(RATINGS_FILE, all.map(r => JSON.stringify(r)).join("\n") + "\n");
  return all[idx];
}

// رسالة طلب التقييم (تُرسل بعد إنهاء الطلب)
function ratingRequestMessage(storeName, orderId, loyaltyBonus = 5) {
  const bonusLine = loyaltyBonus > 0
    ? `🎁 _مكافأة: ستحصل على ${loyaltyBonus} نقاط ولاء إضافية عند التقييم!_\n\n`
    : "";
  return (
    `شكراً لطلبك من *${storeName}* 🌟\n\n` +
    `كيف تقيّم تجربتك معنا؟\n\n` +
    `1️⃣ — سيء\n2️⃣ — مقبول\n3️⃣ — جيد\n4️⃣ — ممتاز\n5️⃣ — رائع جداً 🔥\n\n` +
    bonusLine +
    `_أرسل الرقم للتقييم_`
  );
}

// رسالة تذكير بعد 24h لو لم يقيم
function reminderMessage(storeName) {
  return (
    `مرحباً 🌸\n\nتجربتك مع *${storeName}* تهمنا — لو ما لقيتها وقت بالأمس، احنا منتظرين رأيك:\n\n` +
    `1️⃣ — سيء\n2️⃣ — مقبول\n3️⃣ — جيد\n4️⃣ — ممتاز\n5️⃣ — رائع جداً 🔥\n\n` +
    `كل تقييم بيساعدنا نقدّم لك أفضل في المرة الجاية 💚`
  );
}

// رسالة اعتذار + كوبون لـ تقييم سلبي
function serviceRecoveryMessage(storeName, couponCode) {
  return (
    `🙏 *نعتذر بشدة*\n\n` +
    `تجربتك مع *${storeName}* ما كانت بالمستوى الذي نطمح إليه، وهذا غير مقبول من جهتنا.\n\n` +
    `🎁 *كوبون اعتذار:* ${couponCode}\n` +
    `_خصم 20% على طلبك القادم_\n\n` +
    `لو حابب تكتب لنا تفاصيل أكثر، نحن نقرأ كل رسالة باهتمام. اكتب *مسؤول* للتواصل المباشر معنا.`
  );
}

// رسالة بعد تقييم 5★ — referral
function fiveStarFollowUp(storeName) {
  return (
    `🔥 *شكراً من القلب!*\n\n` +
    `تقييمك الرائع لـ *${storeName}* يعني لنا الكثير 🌟\n\n` +
    `لو حابب تساعدنا أكثر:\n` +
    `✨ شاركنا تجربتك مع صديق/قريب\n` +
    `📲 احكي عننا في حالة الواتساب\n\n` +
    `ولأنك من عملائنا المميزين، خصم 10% على طلبك القادم 💚`
  );
}

// هل هذه الرسالة تقييم؟
function isRatingInput(text) {
  return /^[1-5]$/.test((text || "").trim());
}

module.exports = {
  saveRating, getStoreRatings, getAverageRating, getStoreSummary,
  getRecentRatings, getTrend, respondToRating,
  ratingRequestMessage, reminderMessage, serviceRecoveryMessage, fiveStarFollowUp,
  isRatingInput, STARS,
};
