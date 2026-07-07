/**
 * bot-messages.js — مركز رسائل البوت القابلة للتخصيص
 *
 * كل رسالة يقولها البوت للعميل يمكن أن يعدلها المتجر من tab "أسئلة البوت"
 * الآلية:
 *   - كل رسالة لها key (مثلاً "cart.empty") + نص افتراضي + متغيرات مسموحة
 *   - المتجر يحفظ نصه المخصص في store.botMessages[key]
 *   - عند إرسال رسالة، نقرأ من store.botMessages[key] أو نستخدم الـ default
 *   - المتغيرات: {store} {phone} {orderId} إلخ — تُستبدل تلقائياً
 */

// 📋 السجل الكامل — كل رسالة: default + label + description + متغيرات مسموحة
const REGISTRY = {
  // ─── استلام طلب من المنيو ───
  "order.received_ack": {
    label: "✅ تأكيد استلام طلب المنيو",
    hint: "بعد أن يضغط العميل 'أرسل الطلب' من المنيو — يذكر أصناف السلة",
    default: "✅ *تم استلام طلبك بنجاح!*\n\n{items}{notes}",
    vars: ["items", "notes"],
    category: "order",
  },
  "order.received_silent": {
    label: "🤝 تأكيد الاستلام (وضع صامت)",
    hint: "لما البوت في وضع 'المالك يتحكم' — رسالة بعد المنيو مباشرة قبل ما يصمت",
    default: "✅ *وصل طلبك بنجاح!*\n\n{items}{notes}\n\n📞 سيتواصل معك المسؤول قريباً لتأكيد التفاصيل (العنوان + الوقت).\n\n🙏 شكراً لثقتك بـ {storeName}",
    vars: ["items", "notes", "storeName", "orderId"],
    category: "order",
  },

  // ─── سلة و طلب ───
  "cart.empty": {
    label: "🛒 السلة فارغة (بعد سلة)",
    hint: "عند كتابة العميل 'سلة' وهي فارغة",
    default: "🛒 السلة فارغة. اكتب طلبك أولاً.",
    vars: [],
    category: "cart",
  },
  "cart.empty_start": {
    label: "🛒 السلة فارغة (طلب بدء)",
    hint: "عند محاولة تأكيد وهي فارغة",
    default: "🛒 سلتك فارغة. اكتب 'ابدأ' لعرض القائمة.",
    vars: [],
    category: "cart",
  },
  "order.canceled": {
    label: "❌ إلغاء الطلب",
    hint: "عند إلغاء العميل للطلب",
    default: "تم إلغاء الطلب. نتمنى أن نخدمك مرة أخرى قريباً 😊",
    vars: [],
    category: "order",
  },
  "order.canceled_new": {
    label: "❌ إلغاء + دعوة لطلب جديد",
    hint: "بعد إلغاء الطلب مع دعوة لبدء طلب جديد",
    default: "تم إلغاء الطلب. اكتب أي رسالة لبداية جديدة 🌸",
    vars: [],
    category: "order",
  },
  "order.no_active_cancel": {
    label: "❌ لا يوجد طلب للإلغاء",
    hint: "عندما يكتب العميل إلغاء ولا يوجد طلب نشط",
    default: "ليس لديك طلبات نشطة للإلغاء.",
    vars: [],
    category: "order",
  },
  "order.no_previous": {
    label: "❌ لا يوجد طلب سابق",
    hint: "عند طلب إلغاء بلا أي طلب حتى القديم",
    default: "ليس لديك أي طلب سابق لإلغائه.\nاكتب أي رسالة لبدء طلب جديد 🌸",
    vars: [],
    category: "order",
  },

  // ─── منيو ───
  "menu.empty": {
    label: "📋 المنيو فارغ",
    hint: "لا توجد منتجات بعد",
    default: "عذراً، لا توجد منتجات متاحة حالياً. حاول لاحقاً.",
    vars: [],
    category: "menu",
  },
  "menu.category_empty": {
    label: "📋 صنف فارغ",
    hint: "عند اختيار العميل صنف بلا منتجات",
    default: "عذراً، لا توجد منتجات متاحة حالياً في هذا الصنف. اكتب 'رجوع' للقائمة.",
    vars: [],
    category: "menu",
  },
  "menu.load_failed": {
    label: "⚠️ فشل تحميل المنيو",
    hint: "عندما تفشل قراءة المنيو",
    default: "عذراً، تعذّر تحميل القائمة. حاول لاحقاً.",
    vars: [],
    category: "menu",
  },
  "menu.pdf_failed": {
    label: "📄 فشل إرسال PDF",
    hint: "عند فشل إنشاء PDF ونستخدم النص بدلاً منه",
    default: "تعذّر إرسال الـ PDF، نعرض القائمة نصياً 👇",
    vars: [],
    category: "menu",
  },

  // ─── طلب حر / AI ───
  "freetext.too_short": {
    label: "✏️ طلب قصير جداً",
    hint: "عندما يكتب العميل رسالة أقل من 5 أحرف كطلب حر",
    default: "✏️ من فضلك اكتب رسالة لا تقل عن 5 أحرف، أو اكتب 0 لإلغاء.",
    vars: [],
    category: "freetext",
  },
  "freetext.parse_failed": {
    label: "⚠️ فشل فهم الطلب الحر",
    hint: "عندما لا يستطيع الـ AI فهم طلب العميل",
    default: "⚠️ لم نتمكن من قراءة طلبك. اضغط رابط المنيو من جديد:\n{menuLink}",
    vars: ["menuLink"],
    category: "freetext",
  },

  // ─── موقع ───
  "location.no_active": {
    label: "📍 لا طلب لتعديل موقعه",
    hint: "عند طلب تعديل موقع بلا طلب نشط",
    default: "❌ لا يوجد طلب نشط يمكن تعديل موقعه.\nاكتب *تتبع* لرؤية حالة طلباتك.",
    vars: [],
    category: "location",
  },
  "location.edit_canceled": {
    label: "📍 إلغاء تعديل الموقع",
    hint: "عند إلغاء العميل لتعديل الموقع",
    default: "تم إلغاء تعديل الموقع.",
    vars: [],
    category: "location",
  },
  "location.invalid": {
    label: "📍 موقع غير مفهوم",
    hint: "عند إرسال موقع لا نستطيع قراءته",
    default: "❌ لم أفهم الموقع المشترك. حاول مجدداً أو اكتب عنواناً.",
    vars: [],
    category: "location",
  },
  "location.required": {
    label: "📍 مطلوب موقع صالح",
    hint: "عند إرسال شيء غير موقع",
    default: "❌ من فضلك أرسل موقعاً صالحاً (شارك موقعك أو اكتب عنواناً واضحاً).",
    vars: [],
    category: "location",
  },

  // ─── ولاء ───
  "loyalty.insufficient": {
    label: "🎁 نقاط ولاء غير كافية",
    hint: "عند طلب استبدال نقاط أقل من المطلوب",
    default: "❌ نقاطك غير كافية للاستبدال",
    vars: [],
    category: "loyalty",
  },
  "loyalty.redeem_failed": {
    label: "🎁 فشل استبدال النقاط",
    hint: "خطأ عام في الاستبدال",
    default: "❌ تعذّر استبدال النقاط",
    vars: [],
    category: "loyalty",
  },

  // ─── إدارة عامة ───
  "admin.no_undo": {
    label: "↩️ لا يوجد إجراء للتراجع",
    hint: "المسؤول يحاول التراجع بلا إجراء أخير",
    default: "❌ لا توجد عملية يمكن التراجع عنها (نافذة 30 ث انتهت)",
    vars: [],
    category: "admin",
  },
  "admin.no_pending_orders": {
    label: "📋 لا طلبات بانتظار التأكيد",
    hint: "المسؤول يستعرض pending وهي فارغة",
    default: "✅ لا توجد طلبات بانتظار التأكيد",
    vars: [],
    category: "admin",
  },
};

/**
 * جلب نص رسالة — يفضّل مخصّص المتجر، وإلا الافتراضي، مع استبدال المتغيرات
 * @param {object} store — كائن المتجر (بحاجة store.botMessages)
 * @param {string} key — مفتاح الرسالة (مثال: "cart.empty")
 * @param {object} vars — القيم المستبدلة داخل النص ({var} → القيمة)
 * @returns {string} النص النهائي
 */
function msg(store, key, vars = {}) {
  const entry = REGISTRY[key];
  if (!entry) return key; // مفتاح غير معرّف — نُرجع نفسه (يُظهر خطأ للمطور)
  const custom = store?.botMessages?.[key];
  let text = (custom && String(custom).trim()) || entry.default;
  // استبدال المتغيرات {name}
  if (vars && typeof vars === "object") {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll("{" + k + "}", String(v ?? ""));
    }
  }
  return text;
}

/** استرجاع كل رسائل السجل (للـ admin UI) */
function listAll() {
  return Object.entries(REGISTRY).map(([key, cfg]) => ({
    key,
    label: cfg.label,
    hint: cfg.hint,
    default: cfg.default,
    vars: cfg.vars || [],
    category: cfg.category || "other",
  }));
}

/** تحقق من صحة نص رسالة مخصصة (حد أقصى للطول) */
function sanitize(text) {
  if (text == null) return "";
  return String(text).slice(0, 800);
}

module.exports = { msg, listAll, sanitize, REGISTRY };
