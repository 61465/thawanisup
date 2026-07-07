/**
 * 📢 Broadcast Templates Library — قوالب جاهزة للبث
 *
 * 12 قالب شائع، يدعم placeholders:
 *   {storeName}, {customerName}, {productName}, {price}, {date}, {time}
 *
 * UI: المالك يختار قالب → يعدّل المتغيرات → يبث.
 */

const TEMPLATES = [
  {
    id: "welcome",
    category: "ترحيب",
    name: "ترحيب بالعملاء الجدد",
    icon: "👋",
    body: "أهلاً وسهلاً بك في *{storeName}* 🌟\n\nسعداء بانضمامك إلينا! لطلب جديد، اكتب *قائمة* أو *menu*.",
    placeholders: ["storeName"],
  },
  {
    id: "new_product",
    category: "تسويق",
    name: "إعلان عن منتج جديد",
    icon: "🆕",
    body: "📣 *منتج جديد لدينا!*\n\n✨ {productName}\n💰 السعر: {price}\n\nاطلب الآن عبر *قائمة* أو زر متجرنا 🛍️",
    placeholders: ["productName", "price"],
  },
  {
    id: "discount",
    category: "تسويق",
    name: "عرض خصم محدود",
    icon: "🏷️",
    body: "🎁 *عرض خاص لعملائنا*\n\nخصم {percent}% على كل المنتجات!\n⏰ ينتهي العرض: {date}\n\nلا تفوّت الفرصة 🔥",
    placeholders: ["percent", "date"],
  },
  {
    id: "weekend_sale",
    category: "تسويق",
    name: "تخفيضات نهاية الأسبوع",
    icon: "🎉",
    body: "🛍️ *تخفيضات نهاية الأسبوع*\n\n📌 على المنتجات المختارة\n📅 الجمعة + السبت فقط\n\nاطلب الآن قبل نفاد الكمية!",
    placeholders: [],
  },
  {
    id: "ramadan",
    category: "مناسبات",
    name: "تهنئة بالرمضان",
    icon: "🌙",
    body: "🌙 *رمضان كريم*\n\nمن أسرة *{storeName}* نتمنى لك صياماً مقبولاً وكل عام وأنت بخير.\n\nاطلباتنا متاحة طوال الشهر الفضيل 🌟",
    placeholders: ["storeName"],
  },
  {
    id: "eid",
    category: "مناسبات",
    name: "تهنئة بالعيد",
    icon: "🎊",
    body: "🎊 *كل عام وأنتم بخير*\n\nعيدكم مبارك من *{storeName}*\nشكراً لثقتكم بنا طوال العام 💚",
    placeholders: ["storeName"],
  },
  {
    id: "new_hours",
    category: "إعلانات",
    name: "تحديث ساعات العمل",
    icon: "🕐",
    body: "🕐 *تحديث ساعات العمل*\n\nنعمل من *{from}* إلى *{to}* يومياً.\n\nسعداء بخدمتكم 🙏",
    placeholders: ["from", "to"],
  },
  {
    id: "closed",
    category: "إعلانات",
    name: "إعلان إغلاق مؤقت",
    icon: "🚧",
    body: "🚧 *إعلان مهم*\n\nسيكون المتجر مغلقاً من {from} حتى {to}.\n\nنعتذر عن الإزعاج، نراكم قريباً ❤️",
    placeholders: ["from", "to"],
  },
  {
    id: "reminder_order",
    category: "متابعة",
    name: "تذكير بالطلب المتروك",
    icon: "🛒",
    body: "مرحباً {customerName} 👋\n\nسلتك ما زالت بانتظارك في *{storeName}* 🛒\n\nهل تريد إكمال الطلب؟ نوفر لك خصم {percent}% بكود: {code}",
    placeholders: ["customerName", "storeName", "percent", "code"],
  },
  {
    id: "thank_you",
    category: "متابعة",
    name: "شكر بعد الطلب",
    icon: "🙏",
    body: "شكراً لك {customerName} 🌟\n\nاستلمنا طلبك وسنحضّره فوراً.\n\nهل لديك ملاحظات؟ راسلنا في أي وقت 💬",
    placeholders: ["customerName"],
  },
  {
    id: "feedback",
    category: "متابعة",
    name: "طلب تقييم",
    icon: "⭐",
    body: "مرحباً {customerName} 🌟\n\nكيف كانت تجربتك مع *{storeName}*؟\n\nقيّمنا من 1 إلى 5 ⭐\nنحبّ سماع رأيك!",
    placeholders: ["customerName", "storeName"],
  },
  {
    id: "vip",
    category: "VIP",
    name: "عرض حصري للعملاء المميزين",
    icon: "👑",
    body: "👑 *عرض VIP حصري*\n\n{customerName}، لأنك من أعزّ عملائنا:\n\n🎁 خصم {percent}% خاص لك\n⏰ ينتهي خلال 48 ساعة\n\nاطلب الآن!",
    placeholders: ["customerName", "percent"],
  },
];

function listTemplates() {
  return TEMPLATES.map(t => ({ id: t.id, name: t.name, icon: t.icon, category: t.category, placeholders: t.placeholders }));
}

function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}

function renderTemplate(id, vars = {}) {
  const tpl = getTemplate(id);
  if (!tpl) return null;
  let body = tpl.body;
  for (const [k, v] of Object.entries(vars)) {
    body = body.split(`{${k}}`).join(String(v || ""));
  }
  // أزل أي placeholder غير مُعبّأ (يصبح فراغ)
  body = body.replace(/\{[a-z_]+\}/gi, "—");
  return { id: tpl.id, name: tpl.name, body };
}

function listCategories() {
  return [...new Set(TEMPLATES.map(t => t.category))];
}

module.exports = { listTemplates, getTemplate, renderTemplate, listCategories };
