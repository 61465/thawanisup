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
    matches:  ["كافيه","مطعم","مخبز","عصائر","برجر","بقالة","وجبات","حلويات"],
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
  },
};

// ─── Resolver: من store.storeType → business-type key ──────
window.resolveBusinessType = function (storeType) {
  if (!storeType) return window.BUSINESS_TYPES.food;
  const s = String(storeType).trim();
  for (const key of Object.keys(window.BUSINESS_TYPES)) {
    const bt = window.BUSINESS_TYPES[key];
    if (bt.matches.some(m => s.includes(m))) return bt;
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
  document.querySelectorAll('[data-biz-field]').forEach(el => {
    const field = el.getAttribute('data-biz-field');
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
    let bt;
    if (r.adminConfig && r.adminConfig.terms) {
      console.log("[biz] AI config loaded:", r.adminConfig.label, "|", r.adminConfig.tabs?.length, "tabs |", r.adminConfig.features?.length, "features");
      window.AI_CONFIG = r.adminConfig;
      bt = window.applyBusinessAdaption(r.adminConfig);
      // أظهر/أخفِ tab المخزون حسب طبيعة البيزنس
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
    el.style.cssText = "background:linear-gradient(135deg,#fafafa 0%,#fff 100%);border:1px solid #e5e7eb;border-radius:14px;padding:18px 22px;margin:14px 0;display:flex;align-items:center;gap:14px;box-shadow:0 1px 3px rgba(0,0,0,.04)";
    const main = document.getElementById("aiAdminContainer") || document.querySelector(".main") || document.body;
    main.insertBefore(el, main.firstChild);
  }
  el.innerHTML = `
    <div style="font-size:36px;line-height:1">${emoji||"✨"}</div>
    <div style="flex:1">
      <div style="font-size:11px;font-weight:700;color:${color||"#1b5e20"};letter-spacing:.5px;text-transform:uppercase;margin-bottom:2px">منصة ثواني | Thawani</div>
      <div style="font-size:18px;font-weight:900;color:#111827">${text}</div>
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
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.04);border-right:4px solid ${c.color||"#d4af37"}">
      <div style="font-size:28px;line-height:1;margin-bottom:8px">${c.emoji||"📊"}</div>
      <div style="font-size:12px;color:#6b7280;font-weight:600">${c.title}</div>
      <div style="font-size:22px;font-weight:900;color:${c.color||"#111827"};margin-top:4px" id="kpi_${c.key||c.metric}">—</div>
    </div>
  `).join("");
}

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
  container.innerHTML = `<div style="font-size:13px;font-weight:700;color:#374151;align-self:center;margin-left:6px">⚡ إجراءات سريعة:</div>` +
    actions.map(a => {
      let onclick = "";
      if (a.action === "openTab" && a.target)   onclick = `showTab('${a.target}')`;
      else if (a.action === "addItem")           onclick = `showTab('menu'); setTimeout(openProductModal, 200);`;
      else if (a.action === "broadcast")         onclick = `showTab('broadcast');`;
      return `<button onclick="${onclick}" style="background:#fff;border:1px solid #d1d5db;border-radius:999px;padding:8px 16px;font-size:13px;font-weight:700;color:#374151;cursor:pointer;transition:.15s;display:inline-flex;align-items:center;gap:6px" onmouseover="this.style.background='#f3f4f6';this.style.borderColor='#9ca3af'" onmouseout="this.style.background='#fff';this.style.borderColor='#d1d5db'">
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
const CORE_TABS = ["dash", "broadcast", "loyalty", "customers", "archive", "ratings", "rejections", "inventory", "accounting", "settings", "whatsapp"];

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

  // احفظ الحالة الأصلية للـ tabs المخفية بـ plan (مثل broadcast/customers في starter)
  const planHidden = {};
  allTabs.forEach(t => { planHidden[t.id] = t.style.display === "none"; });

  // إخفاء كل الـ tabs أولاً
  allTabs.forEach(t => t.style.display = "none");
  // إظهار حسب الترتيب — مع احترام إخفاء plan
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
    panel.style.cssText = "margin:16px 0;background:linear-gradient(135deg,#eff6ff,#dbeafe);border:1px solid #93c5fd;border-radius:14px;padding:16px 20px";
    const main = document.getElementById("aiAdminContainer") || document.querySelector(".main") || document.body;
    main.insertBefore(panel, main.firstChild);
  }
  const featureCards = featureIds.map(id => {
    const f = FEATURE_LABELS[id];
    if (!f) return "";
    return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:10px;min-width:180px">
      <span style="font-size:24px">${f.emoji}</span>
      <div><div style="font-weight:800;font-size:13px;color:#1e40af">${f.label}</div><div style="font-size:11px;color:#6b7280">${f.desc}</div></div>
    </div>`;
  }).join("");
  const tipsHtml = tips.length
    ? `<div style="margin-top:12px;font-size:12px;color:#1e3a8a;background:#dbeafe;padding:10px 14px;border-radius:8px;border-right:3px solid #2563eb"><strong>💡 نصائح للنجاح:</strong><ul style="margin:6px 18px 0;padding:0;line-height:1.7">${tips.map(t => `<li>${t}</li>`).join("")}</ul></div>` : "";
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px">
      <div>
        <div style="font-weight:900;font-size:15px;color:#1e3a8a">🤖 ميزات موصى بها لنشاطك (من AI)</div>
        <div style="font-size:12px;color:#3730a3">هذه الميزات اختارها الذكاء الاصطناعي بناء على تخصص متجرك</div>
      </div>
      <button onclick="this.parentElement.parentElement.style.display='none'" style="background:none;border:none;color:#6b7280;cursor:pointer;font-size:18px" title="إخفاء">✕</button>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:10px">${featureCards}</div>
    ${tipsHtml}
  `;
}
