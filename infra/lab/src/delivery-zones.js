/**
 * 🚚 delivery-zones — يحدّد رسوم التوصيل حسب موقع العميل
 *
 * كل متجر يحدد deliveryZones: [{name, fee}] في الأدمن.
 * لما العميل يبعث الموقع، البوت يطابقه بأقرب منطقة:
 *   1) لو أرسل موقع GPS (📍|lat|lng) → geocoding عكسي → يقارن اسم المدينة/الحي
 *   2) لو كتب عنوان نصي → keyword match مع أسماء المناطق
 *   3) لو ما تم مطابقة → default (أول منطقة، أو deliveryFee العادي)
 *
 * @param {Object} store — بيانات المتجر (يحوي deliveryZones + deliveryFee)
 * @param {Object} sessionOrOrder — يحوي customerLocation + customerLocationName + Lat + Lng
 * @returns {{ zoneName: string|null, fee: number, matched: boolean }}
 */
function resolveDeliveryZone(store, sessionOrOrder) {
  const zones = Array.isArray(store?.deliveryZones)
    ? store.deliveryZones.filter(z => z && z.name && typeof z.fee === "number")
    : [];
  // لا مناطق معرّفة → استخدم deliveryFee العادي
  if (zones.length === 0) {
    return {
      zoneName: null,
      fee: Number(store?.deliveryFee) || 0,
      matched: false,
    };
  }
  // نبني نص للبحث فيه (اسم الموقع + العنوان الكامل)
  const searchText = _normalizeArabic(String(
    (sessionOrOrder?.customerLocationName || "") + " " +
    (sessionOrOrder?.customerLocation || "") + " " +
    (sessionOrOrder?.customerLocationAddress || "") + " " +
    (sessionOrOrder?.customerLocationCity || "")
  ).toLowerCase().trim());

  if (!searchText) {
    // لا موقع → نأخذ أول منطقة (كـ default)
    return {
      zoneName: zones[0].name,
      fee: Number(zones[0].fee) || 0,
      matched: false,
    };
  }
  // 🎯 ترتيب المطابقة: (1) اسم المنطقة كـ full word match، (2) partial
  // نُقيّم كل منطقة، ونختار الأقوى
  let bestMatch = null;
  let bestScore = 0;
  for (const zone of zones) {
    const zoneName = _normalizeArabic(String(zone.name || "").toLowerCase().trim());
    if (!zoneName) continue;
    // تقسيم اسم المنطقة لكلمات (لدعم "خارج الرياض" = خارج + الرياض)
    const zoneWords = zoneName.split(/\s+/).filter(w => w.length >= 2);
    let score = 0;
    for (const word of zoneWords) {
      // 🎯 أوزان: full match أعلى من partial
      const regex = new RegExp(`(^|\\s|،|,)${_escapeRegex(word)}(\\s|،|,|$)`, "i");
      if (regex.test(searchText)) {
        score += 3; // full word match
      } else if (searchText.includes(word)) {
        score += 1; // partial match
      }
    }
    // 🎯 لو المنطقة تحوي "خارج" أو "outside" → نطبقها فقط لو لا يوجد match على منطقة داخلية
    const isOutsideZone = /خارج|outside|بعيد/i.test(zoneName);
    if (isOutsideZone) {
      score = score * 0.5; // نضعف وزنها كي لا تفوز عرضياً
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = zone;
    }
  }
  if (bestMatch && bestScore > 0) {
    return {
      zoneName: bestMatch.name,
      fee: Number(bestMatch.fee) || 0,
      matched: true,
    };
  }
  // 🎯 لم تُطابق أي منطقة → نبحث عن "خارج" كـ fallback ذكي
  const outsideZone = zones.find(z => /خارج|outside/i.test(String(z.name || "")));
  if (outsideZone) {
    return {
      zoneName: outsideZone.name,
      fee: Number(outsideZone.fee) || 0,
      matched: false, // false لأننا اخترناها كـ fallback مو match مباشر
    };
  }
  // fallback نهائي: أرخص منطقة (أو أول منطقة)
  const fallback = zones.slice().sort((a, b) => a.fee - b.fee)[0];
  return {
    zoneName: fallback.name,
    fee: Number(fallback.fee) || 0,
    matched: false,
  };
}

// helper: normalize Arabic (يوحد الألف والتاء المربوطة وغيرها لمطابقة أفضل)
function _normalizeArabic(s) {
  return String(s || "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[ً-ٟ]/g, "") // remove diacritics
    .replace(/\s+/g, " ");
}

function _escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { resolveDeliveryZone };
