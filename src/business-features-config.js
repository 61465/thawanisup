/**
 * 🏪 Business Features Config — خريطة ميزات لكل نوع بيزنس
 *
 * كل نوع لديه:
 *   - mandatoryFeatures: ميزات ضرورية (تُعرض دائماً)
 *   - recommendedFeatures: ميزات موصى بها (يمكن إخفاؤها)
 *   - hiddenTabs: tabs لا تظهر لهذا النوع
 *   - extraTabs: tabs خاصة بهذا النوع
 *   - productFields: حقول إضافية في نموذج المنتج
 *   - orderFlow: مراحل الطلب
 *   - aiImageSearch: هل يدعم البحث الذكي عن صور المنتج
 *
 * يُستخدم في:
 *   - GET /store/business-features → يُرجع config للأدمن
 *   - store-admin يُظهر/يخفي حسب الـ config
 */

const FEATURES = {
  food: {
    label: "🍽️ مطاعم/كافيهات",
    mandatoryFeatures: ["menu", "orders", "delivery"],
    recommendedFeatures: ["loyalty", "ratings", "broadcast"],
    extraTabs: [
      { id: "recipes", label: "📖 الوصفات والتكاليف", priority: "high" },
    ],
    productFields: {
      hasVariants: true,    // أحجام (صغير/كبير)
      hasIngredients: true, // مكونات (لحساب COGS)
      hasPrepTime: true,    // وقت التحضير بالدقائق
      hasSpiciness: true,   // درجة الحرارة
    },
    orderFlow: ["جديد", "قيد التحضير", "جاهز", "في الطريق", "تم التسليم"],
    aiImageSearch: true,
    avgDeliveryMin: 45,
  },

  grocery: {
    label: "🛒 بقالة/سوبرماركت",
    mandatoryFeatures: ["menu", "orders", "inventory"],
    recommendedFeatures: ["barcode", "ai_image_search", "loyalty", "broadcast"],
    extraTabs: [
      { id: "inventory_advanced", label: "📦 المخزون المتقدم", priority: "high" },
      { id: "barcode_scan", label: "📷 مسح الباركود", priority: "medium" },
    ],
    productFields: {
      hasBarcode: true,
      hasExpiryDate: false,
      hasShelfLocation: true, // رف A-3
      hasStock: true,
      lowStockThreshold: 5,
    },
    orderFlow: ["جديد", "قيد التجهيز", "جاهز للاستلام", "في الطريق", "تم التسليم"],
    aiImageSearch: true,
    avgDeliveryMin: 30,
  },

  pharmacy: {
    label: "💊 صيدليات",
    mandatoryFeatures: ["menu", "orders", "inventory", "expiry_tracking"],
    recommendedFeatures: ["ai_image_search", "prescription_flow", "alternatives"],
    extraTabs: [
      { id: "inventory_advanced", label: "📦 المخزون + الصلاحية", priority: "critical" },
      { id: "prescriptions", label: "📋 الوصفات الطبية", priority: "high" },
      { id: "alternatives", label: "🔄 البدائل والمكافئات", priority: "medium" },
    ],
    productFields: {
      hasBarcode: true,
      hasExpiryDate: true,        // ⚠️ حرج للأدوية
      hasActiveIngredient: true,  // المادة الفعالة
      hasDosage: true,
      hasPrescriptionRequired: true, // يحتاج روشتة طبية؟
      hasStock: true,
      lowStockThreshold: 3,
      expiryWarningDays: 90,
    },
    orderFlow: ["جديد", "مراجعة الروشتة", "قيد التجهيز", "جاهز للاستلام"],
    aiImageSearch: true,
    avgDeliveryMin: 20,
    hideFromStorefront: ["prescription"], // لا تعرض أدوية الروشتة علناً
  },

  bakery: {
    label: "🥖 مخابز/حلويات",
    mandatoryFeatures: ["menu", "orders", "preorder"],
    recommendedFeatures: ["dailyFresh", "delivery_window"],
    extraTabs: [
      { id: "preorder", label: "📅 الطلبات المسبقة", priority: "high" },
      { id: "daily_production", label: "🍞 إنتاج اليوم", priority: "medium" },
    ],
    productFields: {
      hasMinPrepTime: true,    // وقت إعداد أدنى (للكيك مثلاً 24 ساعة)
      hasCustomizable: true,    // كتابة على الكيك
      hasFreshDaily: true,
      hasStock: false,          // الخبز يُعد طلباً
    },
    orderFlow: ["جديد", "موعد التحضير", "قيد الخبز", "جاهز للاستلام"],
    aiImageSearch: true,
    avgDeliveryMin: 60,
    minPreorderHours: 2,
  },

  salon: {
    label: "💇 صالون/عناية",
    mandatoryFeatures: ["services", "booking", "calendar"],
    recommendedFeatures: ["staff_assignment", "reminders", "duration_tracking"],
    extraTabs: [
      { id: "calendar", label: "📅 تقويم الحجوزات", priority: "critical" },
      { id: "staff", label: "👥 الموظفون", priority: "high" },
      { id: "services_pricing", label: "💰 أسعار الخدمات", priority: "medium" },
    ],
    productFields: {
      hasDuration: true,       // مدة الخدمة بالدقائق
      hasStaffRequired: true,  // يحتاج موظف محدد؟
      hasGender: true,         // رجالي/نسائي
      hasStock: false,
    },
    orderFlow: ["محجوز", "تأكيد", "قيد التنفيذ", "مكتمل"],
    aiImageSearch: false,
    avgDeliveryMin: 0,         // خدمة في المكان، لا توصيل
    bookingSlotMinutes: 30,
    workingHoursRequired: true,
  },

  service: {
    label: "💻 خدمات/برمجة",
    mandatoryFeatures: ["services", "proposals", "billing"],
    recommendedFeatures: ["projects", "milestones", "hourly_billing"],
    extraTabs: [
      { id: "proposals", label: "📄 العروض والتسعير", priority: "high" },
      { id: "projects", label: "🏗️ المشاريع النشطة", priority: "high" },
    ],
    productFields: {
      hasHourly: true,         // سعر بالساعة
      hasComplexity: true,     // بسيط/متوسط/معقد
      hasDeliveryWeeks: true,
      hasStock: false,
    },
    orderFlow: ["جديد", "قيد المراجعة", "قيد التنفيذ", "قيد المراجعة من العميل", "تم التسليم"],
    aiImageSearch: false,
    avgDeliveryMin: 0,
  },

  home: {
    label: "🚗 خدمات منزلية/سيارات",
    mandatoryFeatures: ["services", "scheduling", "location"],
    recommendedFeatures: ["gps_tracking", "emergency_dispatch", "rate_per_visit"],
    extraTabs: [
      { id: "schedule", label: "📅 الجدولة والمواعيد", priority: "high" },
      { id: "technicians", label: "🔧 الفنيون", priority: "medium" },
    ],
    productFields: {
      hasDuration: true,
      hasHourly: true,
      hasOnSite: true,         // يحتاج زيارة موقع
      hasUrgency: true,        // طلب طارئ
      hasStock: false,
    },
    orderFlow: ["جديد", "تأكيد الموعد", "في الطريق", "قيد التنفيذ", "مكتمل"],
    aiImageSearch: false,
    avgDeliveryMin: 60,
    requiresAddress: true,
  },

  gaming_topup: {
    label: "🎮 شحن ألعاب",
    mandatoryFeatures: ["digital_products", "code_pool", "auto_delivery"],
    recommendedFeatures: ["multi_supplier", "supplier_links", "subscription_renewal"],
    extraTabs: [
      { id: "gaming_codes", label: "🎮 الأكواد الرقمية", priority: "critical" },
      { id: "gaming_links", label: "🔗 روابط الموردين", priority: "high" },
    ],
    productFields: {
      hasDigitalContent: true,  // كود/رابط/نص رقمي
      hasCodePool: true,
      hasDeliveryMode: true,    // auto/manual
      hasVipLink: true,
      hasSubscriptionDays: true,
      hasStock: false,           // المخزون = pool الأكواد
    },
    orderFlow: ["جديد", "قيد التأكيد", "تم التسليم"],
    aiImageSearch: false,
    avgDeliveryMin: 5,
    instantDelivery: true,
  },
};

/**
 * Get config for a businessType. Falls back to "food" if unknown.
 */
function getConfig(businessType) {
  return FEATURES[businessType] || FEATURES.food;
}

/**
 * List all business types with their labels (للماستر).
 */
function listAll() {
  return Object.entries(FEATURES).map(([id, cfg]) => ({
    id,
    label: cfg.label,
    extraTabs: cfg.extraTabs || [],
    aiImageSearch: !!cfg.aiImageSearch,
  }));
}

module.exports = { FEATURES, getConfig, listAll };
