// ════════════════════════════════════════════════════════════
//  Business Types Configuration — Adaptive store-admin
//  يُحمَّل في store-admin.html ويحدد النصوص/الأيقونات حسب نوع المتجر
// ════════════════════════════════════════════════════════════

window.BUSINESS_TYPES = {
  // ─── Food & Beverages (الأطعمة والمشروبات) ─────────────────
  food: {
    label:    "أطعمة ومشروبات",
    emoji:    "🍽️",
    accent:   "#d4af37",
    matches:  ["كافيه","مطعم","مخبز","عصائر","برجر","وجبات","حلويات"],
    terms: {
      item:        "منتج",
      items:       "المنتجات",
      itemAdd:     "إضافة منتج",
      catalog:     "📋 القائمة",
      order:       "طلب",
      orders:      "الطلبات",
      orderInbox:  "📦 الطلبات الواردة",
      customer:    "عميل",
      cart:        "🛒 السلة",
      delivery:    "توصيل",
    },
    fields: {
      hasStock:    true,    // عرض حقل المخزون
      hasSize:     true,    // أحجام (صغير/كبير)
      hasDuration: false,
      hasHourly:   false,
    },
    orderStatusFlow: ["جديد","قيد التحضير","جاهز للاستلام","تم التسليم"],
    defaultCategories: [
      { name: "المقبلات",       emoji: "🥗" },
      { name: "الأطباق الرئيسية", emoji: "🍛" },
      { name: "المشاوي",         emoji: "🍢" },
      { name: "الوجبات السريعة",  emoji: "🍔" },
      { name: "المشروبات",       emoji: "🥤" },
      { name: "الحلويات",        emoji: "🍰" },
    ],
  },

  // ─── Grocery (البقالة / السوبر ماركت) ────────────────────────
  grocery: {
    label:    "بقالة / سوبرماركت",
    emoji:    "🛒",
    accent:   "#16a34a",
    matches:  ["بقالة","سوبرماركت","سوبر ماركت","تموينات","ميني ماركت","مينى ماركت","هايبر"],
    terms: {
      item:        "منتج",
      items:       "المنتجات",
      itemAdd:     "إضافة منتج",
      catalog:     "🛒 الأصناف",
      order:       "طلب",
      orders:      "الطلبات",
      orderInbox:  "📦 الطلبات الواردة",
      customer:    "عميل",
      cart:        "🛒 السلة",
      delivery:    "توصيل",
    },
    fields: { hasStock: true, hasSize: true, hasDuration: false, hasHourly: false },
    orderStatusFlow: ["جديد","قيد التجهيز","خرج للتوصيل","تم التسليم"],
    defaultCategories: [
      { name: "ألبان وأجبان",   emoji: "🥛", subCategories: [
        { name: "حليب",       emoji: "🥛" },
        { name: "أجبان",      emoji: "🧀" },
        { name: "زبادي ولبن", emoji: "🍶" },
        { name: "زبدة وقشدة",  emoji: "🧈" },
      ]},
      { name: "خبز ومخبوزات",  emoji: "🥖", subCategories: [
        { name: "خبز عربي",   emoji: "🥖" },
        { name: "خبز توست",    emoji: "🍞" },
        { name: "كرواسون ومعجنات", emoji: "🥐" },
      ]},
      { name: "مشروبات",       emoji: "🥤", subCategories: [
        { name: "مياه",        emoji: "💧" },
        { name: "عصائر",      emoji: "🧃" },
        { name: "مشروبات غازية", emoji: "🥤" },
        { name: "شاي وقهوة",   emoji: "☕" },
      ]},
      { name: "أرز ومعكرونة",   emoji: "🍚", subCategories: [
        { name: "أرز",         emoji: "🍚" },
        { name: "معكرونة",     emoji: "🍝" },
        { name: "بقوليات",     emoji: "🫘" },
      ]},
      { name: "زيوت وتوابل",   emoji: "🫒", subCategories: [
        { name: "زيت طبخ",    emoji: "🫒" },
        { name: "بهارات",     emoji: "🧂" },
        { name: "صلصات",      emoji: "🍯" },
      ]},
      { name: "خضار وفواكه",   emoji: "🥬" },
      { name: "لحوم ودواجن",    emoji: "🍗", subCategories: [
        { name: "دجاج",       emoji: "🍗" },
        { name: "لحم",        emoji: "🥩" },
        { name: "أسماك",      emoji: "🐟" },
        { name: "مجمدات",     emoji: "❄️" },
      ]},
      { name: "حلويات وشوكولاتة", emoji: "🍫" },
      { name: "وجبات خفيفة",    emoji: "🍿" },
      { name: "منظفات",        emoji: "🧴", subCategories: [
        { name: "غسيل ملابس",  emoji: "🧺" },
        { name: "تنظيف منزل",  emoji: "🧹" },
        { name: "صحون",       emoji: "🍽️" },
      ]},
      { name: "عناية شخصية",   emoji: "🧴", subCategories: [
        { name: "شامبو وصابون", emoji: "🧴" },
        { name: "معجون أسنان",  emoji: "🪥" },
        { name: "مناديل",      emoji: "🧻" },
      ]},
      { name: "احتياجات الطفل",  emoji: "🍼" },
    ],
  },

  // ─── Pharmacy (الصيدلية) ──────────────────────────────────
  pharmacy: {
    label:    "صيدلية",
    emoji:    "💊",
    accent:   "#0ea5e9",
    matches:  ["صيدلية","صيدليه","فارما","ادوية","أدوية"],
    terms: {
      item:        "منتج",
      items:       "المنتجات",
      itemAdd:     "إضافة منتج",
      catalog:     "💊 المنتجات",
      order:       "طلب",
      orders:      "الطلبات",
      orderInbox:  "💊 الطلبات الواردة",
      customer:    "مريض",
      cart:        "🛒 السلة",
      delivery:    "توصيل",
    },
    fields: { hasStock: true, hasSize: true, hasDuration: false, hasHourly: false },
    orderStatusFlow: ["جديد","قيد التجهيز","جاهز للاستلام","تم التسليم"],
    defaultCategories: [
      { name: "مسكنات وخافضات حرارة", emoji: "💊", subCategories: [
        { name: "صداع وألم",  emoji: "🤕" },
        { name: "حرارة وبرد", emoji: "🌡️" },
      ]},
      { name: "أدوية الجهاز الهضمي",  emoji: "💊", subCategories: [
        { name: "حموضة",      emoji: "🔥" },
        { name: "إسهال وإمساك", emoji: "💊" },
      ]},
      { name: "أدوية البرد والحساسية", emoji: "🤧", subCategories: [
        { name: "نزلات برد",  emoji: "🤧" },
        { name: "حساسية",     emoji: "🌸" },
        { name: "سعال",       emoji: "😷" },
      ]},
      { name: "فيتامينات ومكملات",  emoji: "🍊", subCategories: [
        { name: "متعدد فيتامين", emoji: "🌿" },
        { name: "فيتامين C",    emoji: "🍊" },
        { name: "فيتامين D",    emoji: "☀️" },
        { name: "حديد",        emoji: "🩸" },
        { name: "كالسيوم",     emoji: "🦴" },
      ]},
      { name: "عناية شخصية",  emoji: "🧴", subCategories: [
        { name: "شامبو وعناية الشعر", emoji: "🧴" },
        { name: "صابون وغسول",       emoji: "🧼" },
        { name: "كريمات الوجه",      emoji: "🧴" },
        { name: "إزالة شعر",         emoji: "🪒" },
        { name: "عطور ومزيلات عرق",   emoji: "🌸" },
      ]},
      { name: "عناية بالأطفال",  emoji: "🍼", subCategories: [
        { name: "حفاضات",     emoji: "🍼" },
        { name: "حليب أطفال",  emoji: "🥛" },
        { name: "مرطبات",     emoji: "🧴" },
        { name: "بودرة",      emoji: "🧂" },
      ]},
      { name: "العناية بالفم والأسنان", emoji: "🦷" },
      { name: "مستلزمات طبية",  emoji: "🩹", subCategories: [
        { name: "ضمادات وشاش",  emoji: "🩹" },
        { name: "ميزان حرارة",   emoji: "🌡️" },
        { name: "جهاز ضغط/سكر",  emoji: "🩺" },
        { name: "كمامات وقفازات", emoji: "😷" },
      ]},
      { name: "العناية بالبشرة", emoji: "✨" },
      { name: "أعشاب وطب بديل",  emoji: "🌿" },
    ],
  },

  // ─── Bakery (المخابز والحلويات) ──────────────────────────────
  bakery: {
    label:    "مخبز / حلويات",
    emoji:    "🥖",
    accent:   "#f59e0b",
    matches:  ["مخبز","فرن","معجنات","حلواني","حلويات","بسبوسة","كنافة","شوكولاتة"],
    terms: {
      item: "منتج", items: "المنتجات", itemAdd: "إضافة منتج",
      catalog: "🥖 المنتجات", order: "طلب", orders: "الطلبات",
      orderInbox: "🥖 الطلبات الواردة", customer: "عميل", cart: "🛒 السلة", delivery: "توصيل",
    },
    fields: { hasStock: true, hasSize: true, hasDuration: false, hasHourly: false },
    orderStatusFlow: ["جديد","قيد التحضير","جاهز للاستلام","تم التسليم"],
    defaultCategories: [
      { name: "الخبز",            emoji: "🥖" },
      { name: "المعجنات المالحة",  emoji: "🥐" },
      { name: "الحلويات الشرقية",   emoji: "🍯" },
      { name: "الكيك والتورتات",   emoji: "🎂" },
      { name: "البسكويت والكوكيز",  emoji: "🍪" },
      { name: "الشوكولاتة",        emoji: "🍫" },
      { name: "المشروبات",         emoji: "🥤" },
    ],
  },

  // ─── Salons & Beauty (صالونات وعناية) ──────────────────────
  salon: {
    label:    "صالون / عناية",
    emoji:    "💇",
    accent:   "#ec4899",
    matches:  ["صالون","حلاقة","تجميل","سبا","مساج","عيادة"],
    terms: {
      item:        "خدمة",
      items:       "الخدمات",
      itemAdd:     "إضافة خدمة",
      catalog:     "💆 قائمة الخدمات",
      order:       "حجز",
      orders:      "الحجوزات",
      orderInbox:  "📅 الحجوزات الواردة",
      customer:    "عميل",
      cart:        "📋 جلستك المختارة",
      delivery:    "موعد",
    },
    fields: {
      hasStock:    false,
      hasSize:     false,
      hasDuration: true,    // مدة الخدمة بالدقائق
      hasHourly:   false,
    },
    orderStatusFlow: ["محجوز","قيد التنفيذ","مكتمل"],
    defaultCategories: [
      { name: "قص وتسريح",   emoji: "✂️" },
      { name: "صبغة وألوان",  emoji: "🎨" },
      { name: "علاجات شعر",   emoji: "💆" },
      { name: "ميكب ومناسبات", emoji: "💄" },
      { name: "العناية بالأظافر", emoji: "💅" },
      { name: "العناية بالبشرة", emoji: "✨" },
    ],
  },

  // ─── Services & Tech (خدمات تقنية / برمجة) ────────────────
  service: {
    label:    "خدمات / تقنية",
    emoji:    "💻",
    accent:   "#3b82f6",
    matches:  ["برمجة","تقنية","استشارات","تصميم","ترجمة","تسويق","محاسبة"],
    terms: {
      item:        "خدمة",
      items:       "الخدمات",
      itemAdd:     "إضافة خدمة",
      catalog:     "🛠️ قائمة الخدمات",
      order:       "مشروع",
      orders:      "المشاريع",
      orderInbox:  "📂 المشاريع الواردة",
      customer:    "عميل",
      cart:        "📋 طلبك",
      delivery:    "تسليم",
    },
    fields: {
      hasStock:    false,
      hasSize:     false,
      hasDuration: false,
      hasHourly:   true,    // سعر بالساعة
    },
    orderStatusFlow: ["جديد","قيد التنفيذ","قيد المراجعة","تم التسليم"],
    defaultCategories: [
      { name: "تطوير ويب",        emoji: "💻" },
      { name: "تطبيقات جوال",     emoji: "📱" },
      { name: "تصميم جرافيك",     emoji: "🎨" },
      { name: "تصميم UI/UX",      emoji: "✨" },
      { name: "كتابة محتوى",      emoji: "✍️" },
      { name: "ترجمة",            emoji: "🌐" },
      { name: "تسويق رقمي",       emoji: "📢" },
      { name: "محاسبة واستشارات",  emoji: "📊" },
    ],
  },

  // ─── Car & Home Services (سيارات/خدمات منزلية) ─────────────
  home: {
    label:    "خدمات منزلية وسيارات",
    emoji:    "🚗",
    accent:   "#10b981",
    matches:  ["غسيل سيارات","تنظيف منازل","سباكة","كهرباء","نقل عفش"],
    terms: {
      item:        "خدمة",
      items:       "الخدمات",
      itemAdd:     "إضافة خدمة",
      catalog:     "🛠️ قائمة الخدمات",
      order:       "طلب",
      orders:      "الطلبات",
      orderInbox:  "🛎️ الطلبات الواردة",
      customer:    "عميل",
      cart:        "📋 طلبك",
      delivery:    "موعد",
    },
    fields: {
      hasStock:    false,
      hasSize:     false,
      hasDuration: true,
      hasHourly:   true,
    },
    orderStatusFlow: ["جديد","في الطريق","قيد التنفيذ","مكتمل"],
    defaultCategories: [
      { name: "غسيل سيارات",      emoji: "🚗" },
      { name: "صيانة سيارات",     emoji: "🔧" },
      { name: "تنظيف منازل",      emoji: "🧹" },
      { name: "سباكة",            emoji: "🚿" },
      { name: "كهرباء",           emoji: "⚡" },
      { name: "تكييف",            emoji: "❄️" },
      { name: "نقل عفش",          emoji: "📦" },
      { name: "نجارة",            emoji: "🪚" },
    ],
  },

  // ─── Gaming Topup (شحن ألعاب، أكواد رقمية، اشتراكات) ──────
  gaming_topup: {
    label:    "شحن الألعاب",
    emoji:    "🎮",
    accent:   "#8b5cf6",
    matches:  ["شحن","توب أب","topup","gaming","ببجي","فري فاير","فورتنايت"],
    terms: {
      item:        "حزمة",
      items:       "الحزم",
      itemAdd:     "➕ إضافة حزمة",
      catalog:     "🎮 الحزم المتاحة",
      order:       "طلب شحن",
      orders:      "طلبات الشحن",
      orderInbox:  "🎮 طلبات الشحن",
      customer:    "لاعب",
      cart:        "🛒 سلتك",
      delivery:    "تسليم الكود",
    },
    fields: {
      hasStock:    true,    // المخزون = مخزون أكواد رقمية
      hasSize:     false,
      hasDuration: false,
      hasHourly:   false,
    },
    orderStatusFlow: ["جديد","قيد التأكيد","تم التسليم"],
    defaultCategories: [
      { name: "PUBG Mobile",         emoji: "🎮" },
      { name: "Free Fire",           emoji: "🔥" },
      { name: "Fortnite",            emoji: "🏗️" },
      { name: "Mobile Legends",      emoji: "⚔️" },
      { name: "Call of Duty Mobile", emoji: "🎯" },
      { name: "بطاقات Steam",         emoji: "🎮" },
      { name: "بطاقات Google Play",   emoji: "📱" },
      { name: "بطاقات iTunes",        emoji: "🍎" },
      { name: "بطاقات PlayStation",   emoji: "🎮" },
      { name: "بطاقات Xbox",          emoji: "🎮" },
      { name: "اشتراكات Netflix",     emoji: "🎬" },
      { name: "اشتراكات Spotify",     emoji: "🎵" },
    ],
  },

  // ─── Events (تنظيم مناسبات) ───────────────────────────────
  event: {
    label:    "تنظيم مناسبات",
    emoji:    "🎉",
    accent:   "#a855f7",
    matches:  ["مناسبات","حفلات","تنظيم","فعاليات","قاعة","event"],
    terms: {
      item: "باقة", items: "الباقات", itemAdd: "إضافة باقة",
      catalog: "🎉 الباقات", order: "حجز", orders: "الحجوزات",
      orderInbox: "🎉 الحجوزات الواردة", customer: "عميل", cart: "📋 طلبك", delivery: "تاريخ المناسبة",
    },
    fields: { hasStock: false, hasSize: false, hasDuration: false, hasHourly: false },
    orderStatusFlow: ["جديد","مؤكد","قيد التنفيذ","مكتمل"],
    defaultCategories: [
      { name: "أعراس",              emoji: "💒" },
      { name: "أعياد ميلاد",        emoji: "🎂" },
      { name: "تخرج",               emoji: "🎓" },
      { name: "حفلات شركات",        emoji: "🏢" },
      { name: "حفلات أطفال",        emoji: "🎈" },
      { name: "تنسيق قاعات",         emoji: "🏛️" },
      { name: "كيك مناسبات",         emoji: "🍰" },
      { name: "ضيافة وتقديم",        emoji: "☕" },
    ],
  },

  // ─── Rental (تأجير) ─────────────────────────────────────────
  rental: {
    label:    "تأجير",
    emoji:    "🔑",
    accent:   "#0891b2",
    matches:  ["تأجير","ايجار","إيجار","rental","rent"],
    terms: {
      item: "وحدة", items: "الوحدات", itemAdd: "إضافة وحدة",
      catalog: "🔑 الوحدات المتاحة", order: "حجز", orders: "الحجوزات",
      orderInbox: "🔑 الحجوزات الواردة", customer: "مستأجر", cart: "📋 حجزك", delivery: "موعد التسليم",
    },
    fields: { hasStock: true, hasSize: false, hasDuration: true, hasHourly: false },
    orderStatusFlow: ["جديد","مؤكد","تم التسليم","تم الاسترجاع"],
    defaultCategories: [
      { name: "سيارات",            emoji: "🚗" },
      { name: "شقق ومنازل",         emoji: "🏠" },
      { name: "قاعات ومكاتب",       emoji: "🏛️" },
      { name: "معدات وأدوات",       emoji: "🛠️" },
      { name: "كاميرات وتصوير",      emoji: "📷" },
      { name: "أثاث",              emoji: "🛋️" },
      { name: "أزياء (فساتين/بدلات)", emoji: "👗" },
    ],
  },

  // ─── Florist (ورد وهدايا) ────────────────────────────────────
  florist: {
    label:    "محل ورد وهدايا",
    emoji:    "🌹",
    accent:   "#ec4899",
    matches:  ["ورد","ورود","زهور","بوكيه","gift","هدايا","تنسيق"],
    terms: {
      item: "منتج", items: "المنتجات", itemAdd: "إضافة منتج",
      catalog: "🌹 المنتجات", order: "طلب", orders: "الطلبات",
      orderInbox: "🌹 الطلبات الواردة", customer: "عميل", cart: "🛒 السلة", delivery: "توصيل",
    },
    fields: { hasStock: true, hasSize: true, hasDuration: false, hasHourly: false },
    orderStatusFlow: ["جديد","قيد التجهيز","خرج للتوصيل","تم التسليم"],
    defaultCategories: [
      { name: "بوكيهات الورد",      emoji: "💐" },
      { name: "ورد فردي",          emoji: "🌹" },
      { name: "تنسيقات صناديق",     emoji: "📦" },
      { name: "هدايا أعياد ميلاد",   emoji: "🎂" },
      { name: "هدايا عرسان",        emoji: "💍" },
      { name: "هدايا تخرج",         emoji: "🎓" },
      { name: "هدايا الذكرى السنوية", emoji: "💕" },
      { name: "نباتات داخلية",       emoji: "🌱" },
      { name: "شيكولاتة وحلويات",    emoji: "🍫" },
      { name: "بالونات",            emoji: "🎈" },
    ],
  },

  // ─── Clothing (ملابس وأزياء) ─────────────────────────────────
  clothing: {
    label:    "ملابس وأزياء",
    emoji:    "👕",
    accent:   "#8b5cf6",
    matches:  ["ملابس","أزياء","موضة","عبايات","فستان","تي شيرت","بنطلون","fashion"],
    terms: {
      item: "منتج", items: "المنتجات", itemAdd: "إضافة منتج",
      catalog: "👕 المنتجات", order: "طلب", orders: "الطلبات",
      orderInbox: "👕 الطلبات الواردة", customer: "عميل", cart: "🛒 السلة", delivery: "توصيل",
    },
    fields: { hasStock: true, hasSize: true, hasDuration: false, hasHourly: false },
    orderStatusFlow: ["جديد","قيد التجهيز","خرج للشحن","تم التسليم"],
    defaultCategories: [
      { name: "رجالي",             emoji: "👔", subCategories: [
        { name: "قمصان",          emoji: "👔" },
        { name: "بناطيل",          emoji: "👖" },
        { name: "ثوب وشماغ",       emoji: "🤵" },
        { name: "أحذية رجالي",     emoji: "👞" },
      ]},
      { name: "نسائي",             emoji: "👗", subCategories: [
        { name: "فساتين",          emoji: "👗" },
        { name: "عبايات",          emoji: "🧕" },
        { name: "بلوزات",          emoji: "👚" },
        { name: "حقائب",          emoji: "👜" },
        { name: "أحذية نسائي",     emoji: "👠" },
      ]},
      { name: "أطفال",             emoji: "🧒", subCategories: [
        { name: "بنات",            emoji: "👧" },
        { name: "أولاد",           emoji: "👦" },
        { name: "رضع",             emoji: "🍼" },
      ]},
      { name: "إكسسوارات",         emoji: "💎" },
      { name: "ساعات",             emoji: "⌚" },
      { name: "نظارات",            emoji: "👓" },
    ],
  },

  // ─── Electronics (إلكترونيات) ───────────────────────────────
  electronics: {
    label:    "إلكترونيات",
    emoji:    "📱",
    accent:   "#0ea5e9",
    matches:  ["إلكترونيات","جوال","موبايل","كمبيوتر","لابتوب","تابلت","سماعات","شاحن"],
    terms: {
      item: "منتج", items: "المنتجات", itemAdd: "إضافة منتج",
      catalog: "📱 المنتجات", order: "طلب", orders: "الطلبات",
      orderInbox: "📱 الطلبات الواردة", customer: "عميل", cart: "🛒 السلة", delivery: "توصيل",
    },
    fields: { hasStock: true, hasSize: false, hasDuration: false, hasHourly: false },
    orderStatusFlow: ["جديد","قيد التجهيز","خرج للشحن","تم التسليم"],
    defaultCategories: [
      { name: "الجوالات",          emoji: "📱" },
      { name: "اللابتوبات",         emoji: "💻" },
      { name: "التابلت",            emoji: "📲" },
      { name: "السماعات",           emoji: "🎧" },
      { name: "الساعات الذكية",     emoji: "⌚" },
      { name: "شواحن وكابلات",       emoji: "🔌" },
      { name: "حافظات وملحقات",     emoji: "📦" },
      { name: "أجهزة منزلية",       emoji: "🏠" },
      { name: "ألعاب وكونسولات",    emoji: "🎮" },
    ],
  },
};

// ─── Resolver: من store.storeType → business-type key ──────
window.resolveBusinessType = function (storeType) {
  if (!storeType) return window.BUSINESS_TYPES.food;
  const s = String(storeType).trim();
  const sLower = s.toLowerCase();
  // 1. مطابقة key مباشرة (food/grocery/pharmacy/bakery/salon/service/home/gaming_topup/florist/clothing/electronics)
  if (window.BUSINESS_TYPES[s]) return window.BUSINESS_TYPES[s];
  if (window.BUSINESS_TYPES[sLower]) return window.BUSINESS_TYPES[sLower];
  // 2. مطابقة لـ businessType من store admin (delivery/pickup/walkin/booking/...)
  const STORE_TO_BIZ = {
    delivery: "food", pickup: "food", dineIn: "food",
    walkin: "salon", booking: "salon",
    homeService: "home", onSite: "home", remote: "service", projectBased: "service",
    courses: "service", oneOnOne: "service",
    "متجر عام": "grocery", subscription: "gaming_topup", اشتراكات: "gaming_topup",
    مطعم: "food", كافيه: "food", مخبز: "bakery", بقالة: "grocery",
    حلويات: "bakery", "صيدلية": "pharmacy", "صالون حلاقة": "salon",
    "صالون تجميل": "salon", "سبا": "salon", "عيادة": "salon",
    "غسيل سيارات": "home", "صيانة": "home", "خدمات منزلية": "home",
    "ملابس": "clothing", "إلكترونيات": "electronics", "gift_shop": "florist",
    "event": "event", "rental": "rental", "أحداث": "event", "مناسبات": "event",
    "تأجير": "rental",
  };
  if (STORE_TO_BIZ[s]) return window.BUSINESS_TYPES[STORE_TO_BIZ[s]];
  // 3. مطابقة بـ matches[]
  for (const key of Object.keys(window.BUSINESS_TYPES)) {
    const bt = window.BUSINESS_TYPES[key];
    if (bt.matches && bt.matches.some(m => s.includes(m))) return bt;
  }
  return window.BUSINESS_TYPES.food; // افتراضي
};

// ─── Apply adaptive labels to DOM ──────────────────────────
window.applyBusinessAdaption = function (configOrType) {
  // قبول كلا: AI config مباشرة، أو storeType string (يحلّ تلقائياً)
  const bt = (typeof configOrType === "object" && configOrType?.terms)
    ? configOrType
    : window.resolveBusinessType(configOrType);

  if (bt.accent) document.documentElement.style.setProperty('--biz-accent', bt.accent);
  // استبدل النصوص في كل العناصر مع data-biz="termKey"
  document.querySelectorAll('[data-biz]').forEach(el => {
    const key = el.getAttribute('data-biz');
    if (bt.terms && bt.terms[key]) el.textContent = bt.terms[key];
  });
  // إخفاء/إظهار حقول
  // 🛡️ الأحجام/الخيارات (hasSize) دائماً مرئية لكل الأنشطة — اختيارية، لو فاضية لا تظهر للعميل
  const ALWAYS_ON = new Set(["hasSize"]);
  document.querySelectorAll('[data-biz-field]').forEach(el => {
    const field = el.getAttribute('data-biz-field');
    if (ALWAYS_ON.has(field)) { el.style.display = ""; return; }
    el.style.display = bt.fields && bt.fields[field] ? "" : "none";
  });
  // إشعار visual بنوع النشاط في الـ topbar
  const bizBadge = document.getElementById('bizTypeBadge');
  if (bizBadge && bt.emoji && bt.label) {
    bizBadge.textContent = `${bt.emoji} ${bt.label}`;
    if (bt.accent) {
      bizBadge.style.background = bt.accent + "22";
      bizBadge.style.color = bt.accent;
      bizBadge.style.borderColor = bt.accent + "55";
    }
  }
  return bt;
};

// ─── Load + apply: AI config أولاً، fallback للـ defaults ────
window.AI_CONFIG = null; // exposed للاستخدام في store-admin

window.loadBusinessAdaption = async function () {
  try {
    const r = await api("GET", "/store/admin-config");
    // 🧹 امسح أي عناصر AI سابقة (حتى لو رجع config جديد فارغ — لا تتراكم)
    ["aiTagline","aiDashboardCards","aiQuickActions","aiFeaturesPanel"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    let bt;
    if (r.adminConfig && r.adminConfig.terms) {
      console.log("[biz] AI config loaded:", r.adminConfig.label, "|", r.adminConfig.tabs?.length, "tabs |", r.adminConfig.features?.length, "features");
      window.AI_CONFIG = r.adminConfig;
      bt = window.applyBusinessAdaption(r.adminConfig);
      const invTab = document.getElementById("tabInventory");
      if (invTab) invTab.style.display = r.adminConfig.hasInventory ? "" : "none";
      if (Array.isArray(r.adminConfig.tabs))     applyTabsOrder(r.adminConfig.tabs);
      if (Array.isArray(r.adminConfig.dashboardCards) && r.adminConfig.dashboardCards.length) renderDashboardCards(r.adminConfig.dashboardCards);
      if (Array.isArray(r.adminConfig.quickActions) && r.adminConfig.quickActions.length) renderQuickActions(r.adminConfig.quickActions);
      if (r.adminConfig.tagline) renderTagline(r.adminConfig.tagline, r.adminConfig.emoji, r.adminConfig.accent);
      if (Array.isArray(r.adminConfig.features) && r.adminConfig.features.length) {
        renderFeaturesPanel(r.adminConfig.features, r.adminConfig.tips || []);
      }
      applyEmptyStates(r.adminConfig.emptyStates || {});
    } else {
      console.log("[biz] using static defaults for", r.storeType);
      window.AI_CONFIG = null;
      bt = window.applyBusinessAdaption(r.storeType);
    }
    return bt;
  } catch (e) {
    console.warn("[biz] load failed:", e.message);
    return window.applyBusinessAdaption("");
  }
};

// ─── Tagline (يظهر في الـ dashboard) ──────────────────────
function renderTagline(text, emoji, color) {
  let el = document.getElementById("aiTagline");
  if (!el) {
    el = document.createElement("div");
    el.id = "aiTagline";
    el.style.cssText = "background:#0e1a14;border:1px solid rgba(201,162,75,0.25);border-radius:14px;padding:18px 22px;margin:14px 0;display:flex;align-items:center;gap:14px;box-shadow:0 4px 14px rgba(0,0,0,.3)";
    const main = document.getElementById("aiAdminContainer") || document.querySelector(".main") || document.body;
    main.insertBefore(el, main.firstChild);
  }
  el.innerHTML = `
    <div style="font-size:36px;line-height:1">${emoji||"✨"}</div>
    <div style="flex:1">
      <div style="font-size:11px;font-weight:700;color:#e0b85f;letter-spacing:.5px;text-transform:uppercase;margin-bottom:3px">منصة ثواني | Thawani</div>
      <div style="font-size:18px;font-weight:900;color:#f1f5f4">${text}</div>
    </div>
  `;
}

// ─── Dashboard cards (KPIs) ────────────────────────────────
function renderDashboardCards(cards) {
  let container = document.getElementById("aiDashboardCards");
  if (!container) {
    container = document.createElement("div");
    container.id = "aiDashboardCards";
    container.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:14px 0";
    const main = document.getElementById("aiAdminContainer") || document.querySelector(".main") || document.body;
    // insert after tagline if exists
    const tagline = document.getElementById("aiTagline");
    if (tagline && tagline.parentNode === main) {
      tagline.insertAdjacentElement("afterend", container);
    } else {
      main.insertBefore(container, main.firstChild);
    }
  }
  container.innerHTML = cards.map(c => `
    <div style="background:#0e1a14;border:1px solid rgba(201,162,75,0.18);border-radius:12px;padding:14px;box-shadow:0 2px 8px rgba(0,0,0,.3);border-right:4px solid ${c.color||"#e0b85f"}">
      <div style="font-size:28px;line-height:1;margin-bottom:8px">${c.emoji||"📊"}</div>
      <div style="font-size:12px;color:#cfd8d4;font-weight:600">${c.title}</div>
      <div style="font-size:22px;font-weight:900;color:#f1f5f4;margin-top:4px" id="kpi_${c.metric||c.key}" data-metric="${c.metric||c.key}">—</div>
    </div>
  `).join("");
  // اجلب البيانات الحقيقية
  hydrateDashboardKPIs();
}

async function hydrateDashboardKPIs() {
  try {
    const kpi = await api("GET", "/store/kpi");
    document.querySelectorAll("[data-metric]").forEach(el => {
      const m = el.getAttribute("data-metric");
      let v = kpi[m];
      if (v === undefined || v === null) v = 0;
      if (typeof v === "number" && !Number.isInteger(v)) v = v.toFixed(1);
      el.textContent = v;
    });
  } catch (e) { console.warn("[kpi] hydrate failed:", e.message); }
}
window.hydrateDashboardKPIs = hydrateDashboardKPIs;

// ─── Quick actions (chip buttons) ──────────────────────────
function renderQuickActions(actions) {
  let container = document.getElementById("aiQuickActions");
  if (!container) {
    container = document.createElement("div");
    container.id = "aiQuickActions";
    container.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin:14px 0";
    const main = document.getElementById("aiAdminContainer") || document.querySelector(".main") || document.body;
    const cards = document.getElementById("aiDashboardCards");
    if (cards && cards.parentNode === main) {
      cards.insertAdjacentElement("afterend", container);
    } else {
      main.insertBefore(container, main.firstChild);
    }
  }
  container.innerHTML = `<div style="font-size:13px;font-weight:700;color:#e0b85f;align-self:center;margin-left:6px">⚡ إجراءات سريعة:</div>` +
    actions.map(a => {
      let onclick = "";
      if (a.action === "openTab" && a.target)   onclick = `showTab('${a.target}')`;
      else if (a.action === "addItem")           onclick = `showTab('menu'); setTimeout(openProductModal, 200);`;
      else if (a.action === "broadcast")         onclick = `showTab('broadcast');`;
      return `<button onclick="${onclick}" style="background:#0e1a14;border:1px solid rgba(201,162,75,0.3);border-radius:999px;padding:8px 16px;font-size:13px;font-weight:700;color:#f1f5f4;cursor:pointer;transition:.15s;display:inline-flex;align-items:center;gap:6px" onmouseover="this.style.background='rgba(201,162,75,0.15)';this.style.borderColor='#e0b85f'" onmouseout="this.style.background='#0e1a14';this.style.borderColor='rgba(201,162,75,0.3)'">
        <span style="font-size:16px">${a.emoji||"⚡"}</span>${a.label}
      </button>`;
    }).join("");
}

// ─── Empty states ──────────────────────────────────────────
function applyEmptyStates(map) {
  // store-admin يستخدم data-empty-state="menu" على عناصر "لا توجد"
  document.querySelectorAll("[data-empty-state]").forEach(el => {
    const k = el.getAttribute("data-empty-state");
    if (map[k]) el.textContent = map[k];
  });
  // expose للاستخدام في render-functions
  window.AI_EMPTY_STATES = map;
}

// ─── Tabs ordering + hiding ────────────────────────────────
// خريطة: AI tab IDs → HTML tab IDs (الـ alias)
const TAB_ALIAS = {
  // AI رجع → نستخدم نفس الـ HTML tab مع label مختلف
  projects:  "orders",  // مشاريع → tab الطلبات
  bookings:  "orders",  // حجوزات → tab الطلبات
};

// Core tabs — تظهر دائماً بصرف النظر عن AI config (إن كانت متاحة لباقة المتجر)
const CORE_TABS = ["dash", "inbox", "tickets", "support", "botq", "broadcast", "loyalty", "customers", "archive", "ratings", "rejections", "inventory", "accounting", "toolkit", "tablechat", "settings", "whatsapp"];

function applyTabsOrder(orderedTabIds) {
  const tabContainer = document.querySelector(".tabs");
  if (!tabContainer) return;
  const allTabs = Array.from(tabContainer.querySelectorAll(".tab"));
  const tabMap = {};
  allTabs.forEach(t => {
    const id = t.id.replace(/^tab/, "").toLowerCase();
    tabMap[id] = t;
  });
  // resolve aliases من AI IDs → HTML IDs
  const htmlTabIds = (orderedTabIds || []).map(id => TAB_ALIAS[id] || id);
  // dash أولاً، ثم AI tabs المرتبة، ثم core tabs غير المذكورة
  const aiSet = new Set(htmlTabIds);
  const coreExtras = CORE_TABS.filter(id => !aiSet.has(id) && id !== "dash");
  const finalOrder = ["dash", ...htmlTabIds.filter(id => id !== "dash"), ...coreExtras];

  // 🔒 احفظ featureGated الأصلي:
  // - tabs بـ data-feature-gated="1" = مخفية بسبب plan/biz (لا نلمسها)
  // - tabs بدون featureGated أو ="0" = نظهرها (حتى لو style="display:none" أولياً)
  // هذا يصلح bug: toolkit/tableChat كانتا display:none في HTML فكانت تُعتبر مخفية للأبد
  const planHidden = {};
  allTabs.forEach(t => { planHidden[t.id] = t.dataset.featureGated === "1"; });

  // أعد ترتيب فقط (لا تخفي tabs غير feature-gated)
  finalOrder.forEach(id => {
    const t = tabMap[id];
    if (t && !planHidden[t.id]) {
      t.style.display = "";
      tabContainer.appendChild(t);
    }
  });
}

// ─── Features recommendations panel ────────────────────────
const FEATURE_LABELS = {
  inventory:   { emoji: "📦", label: "تتبع المخزون",   desc: "راقب الكميات تلقائياً" },
  staffSched:  { emoji: "👨‍💼", label: "جدولة الموظفين", desc: "نظّم مواعيد فريقك" },
  timeTracker: { emoji: "⏱️", label: "تتبع الساعات",   desc: "احسب ساعات العمل بدقة" },
  hourlyBill:  { emoji: "💰", label: "فواتير بالساعة",  desc: "اصدر فواتير حسب الوقت" },
  appointBook: { emoji: "🗓️", label: "حجز مواعيد",     desc: "العميل يحجز بنفسه" },
  routePlan:   { emoji: "🗺️", label: "خطط التوصيل",    desc: "حدد طرق الوصول" },
  invoices:    { emoji: "🧾", label: "فواتير صور",      desc: "فاتورة PNG احترافية" },
  gallery:     { emoji: "🖼️", label: "معرض صور",       desc: "اعرض أعمالك السابقة" },
  reviews:     { emoji: "⭐", label: "التقييمات",       desc: "اجمع آراء العملاء" },
};
function renderFeaturesPanel(featureIds, tips) {
  let panel = document.getElementById("aiFeaturesPanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "aiFeaturesPanel";
    panel.style.cssText = "margin:16px 0;background:#0e1a14;border:1px solid rgba(201,162,75,0.2);border-radius:14px;padding:16px 20px;box-shadow:0 4px 14px rgba(0,0,0,.3)";
    const main = document.getElementById("aiAdminContainer") || document.querySelector(".main") || document.body;
    main.insertBefore(panel, main.firstChild);
  }
  const featureCards = featureIds.map(id => {
    const f = FEATURE_LABELS[id];
    if (!f) return "";
    return `<div style="background:rgba(0,0,0,0.3);border:1px solid rgba(201,162,75,0.15);border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:10px;min-width:180px">
      <span style="font-size:24px">${f.emoji}</span>
      <div><div style="font-weight:800;font-size:13px;color:#e0b85f">${f.label}</div><div style="font-size:11px;color:#cfd8d4">${f.desc}</div></div>
    </div>`;
  }).join("");
  const tipsHtml = tips.length
    ? `<div style="margin-top:12px;font-size:12px;color:#cfd8d4;background:rgba(201,162,75,0.08);padding:10px 14px;border-radius:8px;border-right:3px solid #e0b85f"><strong style="color:#e0b85f">💡 نصائح للنجاح:</strong><ul style="margin:6px 18px 0;padding:0;line-height:1.8;color:#cfd8d4">${tips.map(t => `<li>${t}</li>`).join("")}</ul></div>` : "";
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:10px">
      <div style="flex:1">
        <div style="font-weight:900;font-size:15px;color:#e0b85f">🤖 ميزات موصى بها لنشاطك (من AI)</div>
        <div style="font-size:12px;color:#cfd8d4;margin-top:3px">هذه الميزات اختارها الذكاء الاصطناعي بناء على تخصص متجرك</div>
      </div>
      <button onclick="this.parentElement.parentElement.style.display='none'" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#cfd8d4;cursor:pointer;font-size:1.1rem;width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center" title="إخفاء">✕</button>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:10px">${featureCards}</div>
    ${tipsHtml}
  `;
}
