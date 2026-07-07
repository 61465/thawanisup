/**
 * Order helpers shared between server.js و store-router.js
 */

/**
 * يبني سطر "الموقع المسجّل" لرسالة التأكيد.
 * إن كانت إحداثيات GPS فعلية → يستخدم الرابط الحقيقي.
 * إن كان نصاً يدوياً من العميل → لا يضع رابطاً (لا نخلق رابط بحث "وهمي").
 */
// يرجع URL إن كان حقيقي فقط — لا نولّد search URL من النص اليدوي
function _resolveMapsUrl(existingUrl, lat, lng) {
  if (existingUrl) return existingUrl;
  if (lat != null && lng != null) return `https://maps.google.com/?q=${lat},${lng}`;
  return null; // عنوان نصي يدوي → لا رابط
}

function _cleanLocationName(name) {
  // نظّف من رابط مدمج قديم بصيغة "name (📍 url)"
  return String(name || "").replace(/\s*\(📍\s*https?:\/\/[^)]+\)\s*/g, "").trim() || String(name || "");
}

/**
 * بعد تأكيد المالك — يحوي تنويه "تعديل الموقع".
 */
function buildLocationLine(order, store) {
  const rawName = order?.customerLocationName || order?.customerLocation || "";
  if (!rawName) return "";
  const cleanName = _cleanLocationName(rawName);
  const mapsUrl = _resolveMapsUrl(order?.customerLocationMapsUrl, order?.customerLocationLat, order?.customerLocationLng);
  const mapLine = mapsUrl ? `🗺️ ${mapsUrl}\n` : "";
  return (
    `\n📍 *الموقع المسجّل:* ${cleanName}\n` +
    mapLine +
    `_⚠️ إن لم يكن الموقع صحيحاً، اكتب: *تعديل الموقع*_\n`
  );
}

/**
 * ملخص قبل التأكيد — رابط بدون تنويه (العميل لا يزال في checkout).
 * يقبل session/order — أي object فيه customerLocationName/MapsUrl.
 */
function buildSummaryLocationLine(sessionOrOrder, store) {
  const rawName = sessionOrOrder?.customerLocationName
    || (sessionOrOrder?.customerLocation && !String(sessionOrOrder.customerLocation).startsWith("📍|") ? sessionOrOrder.customerLocation : "");
  if (!rawName) return "";
  const cleanName = _cleanLocationName(rawName);
  const mapsUrl = _resolveMapsUrl(sessionOrOrder?.customerLocationMapsUrl, sessionOrOrder?.customerLocationLat, sessionOrOrder?.customerLocationLng);
  const mapLine = mapsUrl ? `🗺️ ${mapsUrl}\n` : "";
  return `📍 *العنوان:* ${cleanName}\n${mapLine}`;
}

module.exports = { buildLocationLine, buildSummaryLocationLine };
