/**
 * Accounting — مدير الحسابات لكل متجر
 * ─────────────────────────────────────────────────────────────
 * Tracks:
 *   - Product costs (with versioned history)
 *   - Monthly P&L (revenue, COGS, gross/net profit)
 *   - Operating expenses (fixed + variable)
 *   - Discounts, refunds, VAT
 *   - Top profitable products ranking
 *   - Year-end closing snapshot
 *
 * Data files (per-store):
 *   data/accounting/{storeId}/product-costs.json   — current cost per product (with history)
 *   data/accounting/{storeId}/expenses.jsonl       — operating expenses
 *   data/accounting/{storeId}/monthly/{YM}.json    — monthly P&L (closed once finalized)
 *   data/accounting/{storeId}/yearly/{YYYY}.json   — year-end closing
 */

const fs   = require("fs");
const path = require("path");
const { audit } = require("./audit-log");

const DATA_DIR = path.join(__dirname, "..", "data");
const ACC_DIR  = path.join(DATA_DIR, "accounting");

function ensureStoreDir(storeId) {
  const d = path.join(ACC_DIR, storeId);
  if (!fs.existsSync(d))                fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(path.join(d,"monthly"))) fs.mkdirSync(path.join(d,"monthly"));
  if (!fs.existsSync(path.join(d,"yearly")))  fs.mkdirSync(path.join(d,"yearly"));
  return d;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ─── Product Costs (with history) ──────────────────────────────────────────────

function _costsFile(storeId) {
  return path.join(ensureStoreDir(storeId), "product-costs.json");
}

/** يرجع جميع التكاليف الحالية: { productId: { cost, updatedAt, history: [...] } } */
function getAllProductCosts(storeId) {
  return readJson(_costsFile(storeId), {});
}

/** التكلفة الحالية لمنتج (أو 0 إذا غير موجود) */
function getProductCost(storeId, productId) {
  const all = getAllProductCosts(storeId);
  return all[productId]?.cost ?? 0;
}

/** يحدّث تكلفة منتج مع حفظ التاريخ */
function setProductCost(storeId, productId, newCost, actor, req) {
  if (newCost < 0 || !Number.isFinite(newCost)) {
    throw new Error("التكلفة يجب أن تكون رقم موجب");
  }
  const all = getAllProductCosts(storeId);
  const prev = all[productId];
  const now  = new Date().toISOString();

  const entry = {
    cost: Number(newCost),
    updatedAt: now,
    history: prev?.history || [],
  };

  if (prev && prev.cost !== Number(newCost)) {
    entry.history.unshift({
      cost: prev.cost,
      from: prev.updatedAt,
      to: now,
      changedBy: actor?.id || "store",
    });
    entry.history = entry.history.slice(0, 20); // keep last 20 changes
  }

  all[productId] = entry;
  writeJson(_costsFile(storeId), all);

  audit({
    actor: actor || { type: "store", id: storeId },
    action: "accounting.cost.change",
    target: { type: "product", id: productId },
    meta: { storeId, oldCost: prev?.cost ?? null, newCost: Number(newCost) },
  }, req);

  return entry;
}

/** التكلفة الفعلية بتاريخ معين (للحسابات التاريخية) */
function getProductCostAtDate(storeId, productId, dateISO) {
  const all = getAllProductCosts(storeId);
  const entry = all[productId];
  if (!entry) return 0;
  if (entry.updatedAt <= dateISO) return entry.cost;
  // ابحث في الـ history عن آخر تكلفة قبل التاريخ
  for (const h of (entry.history || [])) {
    if (h.from <= dateISO) return h.cost;
  }
  return entry.cost;
}

// ─── Operating Expenses ────────────────────────────────────────────────────────

function _expensesFile(storeId) {
  return path.join(ensureStoreDir(storeId), "expenses.jsonl");
}

const EXPENSE_TYPES = {
  rent:      { ar: "إيجار",          fixed: true  },
  salaries:  { ar: "رواتب",          fixed: true  },
  utilities: { ar: "كهرباء/ماء",     fixed: true  },
  internet:  { ar: "إنترنت/اتصالات", fixed: true  },
  marketing: { ar: "تسويق",          fixed: false },
  supplies:  { ar: "مستلزمات",       fixed: false },
  delivery:  { ar: "توصيل",          fixed: false },
  refund:    { ar: "مرتجعات",        fixed: false },
  other:     { ar: "أخرى",           fixed: false },
};

function addExpense(storeId, expense, actor, req) {
  const { type, amount, note, date } = expense;
  if (!EXPENSE_TYPES[type]) throw new Error("نوع المصروف غير صحيح");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("المبلغ غير صحيح");

  const entry = {
    id:        Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    type,
    amount:    Number(amount),
    note:      String(note || "").slice(0, 200),
    date:      date || new Date().toISOString(),
    createdAt: new Date().toISOString(),
    fixed:     EXPENSE_TYPES[type].fixed,
  };
  fs.appendFileSync(_expensesFile(storeId), JSON.stringify(entry) + "\n");

  audit({
    actor: actor || { type: "store", id: storeId },
    action: "accounting.expense.add",
    meta: { storeId, type, amount: entry.amount },
  }, req);

  return entry;
}

function listExpenses(storeId, opts = {}) {
  const file = _expensesFile(storeId);
  if (!fs.existsSync(file)) return [];
  let list = fs.readFileSync(file, "utf8").trim().split("\n")
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  if (opts.yearMonth) list = list.filter(e => (e.date || "").slice(0, 7) === opts.yearMonth);
  if (opts.year)      list = list.filter(e => (e.date || "").slice(0, 4) === opts.year);
  return list;
}

function deleteExpense(storeId, expenseId, actor, req) {
  const file = _expensesFile(storeId);
  if (!fs.existsSync(file)) return false;
  const list = listExpenses(storeId);
  const idx = list.findIndex(e => e.id === expenseId);
  if (idx < 0) return false;
  const removed = list.splice(idx, 1)[0];
  fs.writeFileSync(file, list.map(e => JSON.stringify(e)).join("\n") + (list.length ? "\n" : ""));

  audit({
    actor: actor || { type: "store", id: storeId },
    action: "accounting.expense.delete",
    meta: { storeId, expenseId, type: removed.type, amount: removed.amount },
  }, req);

  return true;
}

// ─── Order helpers ─────────────────────────────────────────────────────────────

function _ordersFile(storeId) {
  return storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
}

function _archiveFile(storeId, yearMonth) {
  return path.join(DATA_DIR, "archives", storeId, `${yearMonth}.jsonl`);
}

function readOrdersForMonth(storeId, yearMonth) {
  // ابحث في current + archive
  const orders = [];
  const archive = _archiveFile(storeId, yearMonth);
  if (fs.existsSync(archive)) {
    for (const l of fs.readFileSync(archive, "utf8").split("\n")) {
      if (!l) continue;
      try { orders.push(JSON.parse(l)); } catch {}
    }
  }
  const current = _ordersFile(storeId);
  if (fs.existsSync(current)) {
    for (const l of fs.readFileSync(current, "utf8").split("\n")) {
      if (!l) continue;
      try {
        const o = JSON.parse(l);
        if ((o.timestamp || o.createdAt || "").slice(0, 7) === yearMonth) orders.push(o);
      } catch {}
    }
  }
  return orders;
}

// ─── Monthly P&L Calculation ───────────────────────────────────────────────────

const VAT_RATE = 0.15; // السعودية

/**
 * يحسب P&L لشهر معين
 * @param {string} storeId
 * @param {string} yearMonth — "YYYY-MM"
 * @param {object} [opts] — { vatRate, includePending }
 * @returns كائن P&L كامل
 */
// 📊 يحدد businessType للطلب حسب تاريخه + businessHistory للمتجر
// businessHistory = [{ type, fromDate, toDate, reason }] للأنواع السابقة
// store.businessType = النوع الحالي (toDate = الآن لا يوجد)
function _getBizTypeForOrder(store, orderDate) {
  if (!store) return "غير محدد";
  const orderTs = new Date(orderDate || Date.now()).getTime();
  const history = Array.isArray(store.businessHistory) ? store.businessHistory : [];
  for (const seg of history) {
    const from = new Date(seg.fromDate || 0).getTime();
    const to   = new Date(seg.toDate || Date.now()).getTime();
    if (orderTs >= from && orderTs < to) return seg.type || "غير محدد";
  }
  // الطلب لا يقع في أي segment سابق → النوع الحالي
  return store.businessType || "غير محدد";
}

function _loadStoreForBiz(storeId) {
  try {
    const p = path.join(DATA_DIR, "stores.json");
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return (data.stores || []).find(s => s.id === storeId) || null;
  } catch { return null; }
}

function calculateMonthlyPnL(storeId, yearMonth, opts = {}) {
  const vatRate = opts.vatRate ?? VAT_RATE;
  const includePending = !!opts.includePending;

  const orders = readOrdersForMonth(storeId, yearMonth);
  const expenses = listExpenses(storeId, { yearMonth });
  const storeMeta = _loadStoreForBiz(storeId);

  let revenue = 0;
  let cogs = 0;
  let discounts = 0;
  let ordersCount = 0;
  let completedCount = 0;
  const productAgg = new Map(); // productId → { qty, revenue, cogs, profit, name }
  const customers = new Set();
  const bizAgg = new Map();     // businessType → { revenue, cogs, profit, ordersCount }

  for (const order of orders) {
    const status = order.status || "completed";
    if (["rejected", "cancelled", "pending_confirmation"].includes(status)) continue;
    const isCompleted = ["completed", "delivered", "done", "tasleem"].includes(status);
    if (isCompleted) completedCount++;
    ordersCount++;

    if (order.customerPhone) customers.add(order.customerPhone);

    const orderTotal = Number(order.total || order.grandTotal || 0);
    const orderDiscount = Number(order.discount || order.discountAmount || 0);
    revenue += orderTotal;
    discounts += orderDiscount;

    // 🏢 حدد بيزنس type لهذا الطلب (الحالي أو من History)
    const orderDate = order.timestamp || order.createdAt || new Date().toISOString();
    const bizType = order.businessType || _getBizTypeForOrder(storeMeta, orderDate);
    const bizEntry = bizAgg.get(bizType) || { businessType: bizType, revenue: 0, cogs: 0, profit: 0, ordersCount: 0 };
    bizEntry.revenue += orderTotal;
    bizEntry.ordersCount += 1;

    const items = order.items || order.cart || [];
    let orderCogs = 0;
    for (const item of items) {
      const pid = item.id || item.productId || "unknown";
      const qty = Number(item.qty || item.quantity || 1);
      const price = Number(item.price || 0);
      const unitCost = getProductCostAtDate(storeId, pid, orderDate);
      const itemRevenue = price * qty;
      const itemCogs = unitCost * qty;
      cogs += itemCogs;
      orderCogs += itemCogs;

      const agg = productAgg.get(pid) || { id: pid, name: item.name || pid, qty: 0, revenue: 0, cogs: 0, profit: 0 };
      agg.qty += qty;
      agg.revenue += itemRevenue;
      agg.cogs += itemCogs;
      agg.profit = agg.revenue - agg.cogs;
      productAgg.set(pid, agg);
    }
    bizEntry.cogs += orderCogs;
    bizEntry.profit = bizEntry.revenue - bizEntry.cogs;
    bizAgg.set(bizType, bizEntry);
  }

  const grossProfit = revenue - cogs;
  const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

  const fixedExpenses    = expenses.filter(e => e.fixed).reduce((s, e) => s + e.amount, 0);
  const variableExpenses = expenses.filter(e => !e.fixed).reduce((s, e) => s + e.amount, 0);
  const totalExpenses    = fixedExpenses + variableExpenses;

  // VAT على الإيرادات (output VAT) — للسعودية، يجب على المتجر تحصيله من العميل وإرساله للهيئة
  const vatOutput = revenue * vatRate / (1 + vatRate); // assuming prices VAT-inclusive

  const netProfitBeforeVAT = grossProfit - totalExpenses;
  const netProfit = netProfitBeforeVAT; // الـ VAT pass-through، لا يطرح من الربح

  const netMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  // ترتيب المنتجات الأكثر ربحية
  const topProducts = [...productAgg.values()]
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 10);

  const worstProducts = [...productAgg.values()]
    .filter(p => p.qty > 0)
    .sort((a, b) => (a.profit / Math.max(1, a.qty)) - (b.profit / Math.max(1, b.qty)))
    .slice(0, 5);

  return {
    storeId,
    yearMonth,
    generatedAt: new Date().toISOString(),
    revenue: round2(revenue),
    cogs: round2(cogs),
    grossProfit: round2(grossProfit),
    grossMargin: round2(grossMargin),
    fixedExpenses: round2(fixedExpenses),
    variableExpenses: round2(variableExpenses),
    totalExpenses: round2(totalExpenses),
    discounts: round2(discounts),
    vatOutput: round2(vatOutput),
    netProfit: round2(netProfit),
    netMargin: round2(netMargin),
    ordersCount,
    completedCount,
    uniqueCustomers: customers.size,
    avgOrderValue: ordersCount > 0 ? round2(revenue / ordersCount) : 0,
    topProducts,
    worstProducts,
    expensesByType: groupExpensesByType(expenses),
    // 🏢 تفصيل الأرباح حسب نوع البيزنس (مفيد للمتاجر التي غيّرت نشاطها)
    byBusinessType: [...bizAgg.values()]
      .map(b => ({
        ...b,
        revenue: round2(b.revenue),
        cogs:    round2(b.cogs),
        profit:  round2(b.profit),
        grossMargin: b.revenue > 0 ? round2((b.profit / b.revenue) * 100) : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue),
  };
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// ─── 📊 1. Compare with previous month ────────────────────────────────────────
function compareWithPrevMonth(storeId, yearMonth) {
  const cur = calculateMonthlyPnL(storeId, yearMonth);
  // احسب الشهر السابق
  const [y, m] = yearMonth.split("-").map(Number);
  const prevDate = new Date(y, m - 2, 1);
  const prevYM = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;
  const prev = calculateMonthlyPnL(storeId, prevYM);
  const pct = (a, b) => b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / Math.abs(b)) * 100);
  return {
    current: cur,
    previous: prev,
    previousMonth: prevYM,
    change: {
      revenue:       { value: round2(cur.revenue - prev.revenue),     pct: pct(cur.revenue, prev.revenue) },
      cogs:          { value: round2(cur.cogs - prev.cogs),           pct: pct(cur.cogs, prev.cogs) },
      grossProfit:   { value: round2(cur.grossProfit - prev.grossProfit), pct: pct(cur.grossProfit, prev.grossProfit) },
      netProfit:     { value: round2(cur.netProfit - prev.netProfit), pct: pct(cur.netProfit, prev.netProfit) },
      totalExpenses: { value: round2(cur.totalExpenses - prev.totalExpenses), pct: pct(cur.totalExpenses, prev.totalExpenses) },
      ordersCount:   { value: cur.ordersCount - prev.ordersCount,     pct: pct(cur.ordersCount, prev.ordersCount) },
      avgOrderValue: { value: round2(cur.avgOrderValue - prev.avgOrderValue), pct: pct(cur.avgOrderValue, prev.avgOrderValue) },
    },
  };
}

// ─── 🔮 2. Forecast — توقّع نهاية الشهر بناءً على معدل الأيام ─────────────────
function forecastMonthEnd(storeId, yearMonth) {
  const pnl = calculateMonthlyPnL(storeId, yearMonth);
  const [y, m] = yearMonth.split("-").map(Number);
  const now = new Date();
  const isCurrentMonth = (now.getFullYear() === y && (now.getMonth() + 1) === m);
  if (!isCurrentMonth) {
    // شهر ماضٍ → النتائج الفعلية = التوقع
    return { isCurrent: false, daysElapsed: 0, daysInMonth: 0, daysLeft: 0, forecast: pnl, runRatePerDay: 0 };
  }
  const daysInMonth = new Date(y, m, 0).getDate();
  const daysElapsed = now.getDate();
  const daysLeft = daysInMonth - daysElapsed;
  const runRateRevenue = daysElapsed > 0 ? pnl.revenue / daysElapsed : 0;
  const runRateExpenses = daysElapsed > 0 ? pnl.totalExpenses / daysElapsed : 0;
  const projectedRevenue = round2(pnl.revenue + runRateRevenue * daysLeft);
  // المصاريف الثابتة قد لا تتغير، المتغيرة تنمو بالـ rate
  const projectedExpenses = round2(pnl.fixedExpenses + (pnl.variableExpenses / Math.max(1, daysElapsed)) * daysInMonth);
  const projectedCogs = round2(daysElapsed > 0 ? (pnl.cogs / daysElapsed) * daysInMonth : pnl.cogs);
  const projectedGross = round2(projectedRevenue - projectedCogs);
  const projectedNet = round2(projectedGross - projectedExpenses);
  return {
    isCurrent: true,
    daysInMonth,
    daysElapsed,
    daysLeft,
    runRatePerDay: round2(runRateRevenue),
    actual: { revenue: pnl.revenue, netProfit: pnl.netProfit, ordersCount: pnl.ordersCount, totalExpenses: pnl.totalExpenses },
    forecast: {
      revenue: projectedRevenue,
      cogs: projectedCogs,
      grossProfit: projectedGross,
      totalExpenses: projectedExpenses,
      netProfit: projectedNet,
      ordersCount: Math.round(daysElapsed > 0 ? (pnl.ordersCount / daysElapsed) * daysInMonth : pnl.ordersCount),
    },
  };
}

// ─── ⚖️ 3. Break-even — كم بيع تحتاج لتغطية المصاريف ─────────────────────────
function calculateBreakEven(storeId, yearMonth) {
  const pnl = calculateMonthlyPnL(storeId, yearMonth);
  if (pnl.revenue === 0 || pnl.grossMargin <= 0) {
    return {
      breakEvenRevenue: pnl.totalExpenses,
      breakEvenOrders: null,
      breakEvenPct: 100,
      message: "لا يمكن الحساب — لا توجد إيرادات أو هامش ربح موجب",
    };
  }
  const contributionMargin = pnl.grossMargin / 100; // كنسبة عشرية
  const breakEvenRevenue = pnl.totalExpenses / contributionMargin;
  const breakEvenOrders = pnl.avgOrderValue > 0 ? Math.ceil(breakEvenRevenue / pnl.avgOrderValue) : null;
  const breakEvenPct = pnl.revenue > 0 ? Math.round((pnl.revenue / breakEvenRevenue) * 100) : 0;
  return {
    breakEvenRevenue:  round2(breakEvenRevenue),
    breakEvenOrders,
    currentRevenue:    pnl.revenue,
    currentOrders:     pnl.ordersCount,
    breakEvenPct:      Math.min(200, breakEvenPct), // cap للعرض
    ordersRemaining:   breakEvenOrders ? Math.max(0, breakEvenOrders - pnl.ordersCount) : null,
    revenueRemaining:  round2(Math.max(0, breakEvenRevenue - pnl.revenue)),
    avgOrderValue:     pnl.avgOrderValue,
    isReached:         pnl.revenue >= breakEvenRevenue,
  };
}

// ─── 🚨 4. Smart Alerts ────────────────────────────────────────────────────────
function detectSmartAlerts(storeId, yearMonth) {
  const alerts = [];
  const pnl = calculateMonthlyPnL(storeId, yearMonth);
  const compare = compareWithPrevMonth(storeId, yearMonth);
  const allCosts = getAllProductCosts(storeId);

  // 🚩 ربح صاف سالب
  if (pnl.netProfit < 0) {
    alerts.push({ level: "danger", icon: "📉", title: "خسارة الشهر", message: `ربحك الصافي حالياً ${pnl.netProfit.toFixed(2)} — مصاريفك أعلى من ربحك الإجمالي. راجع المصاريف الكبيرة.` });
  }
  // 🚩 هامش الربح الإجمالي ضعيف
  if (pnl.revenue > 0 && pnl.grossMargin < 15) {
    alerts.push({ level: "danger", icon: "⚠️", title: "هامش ربح ضعيف جداً", message: `هامش الربح ${pnl.grossMargin.toFixed(1)}% فقط. حاول رفع الأسعار أو خفض التكاليف.` });
  } else if (pnl.revenue > 0 && pnl.grossMargin < 30) {
    alerts.push({ level: "warning", icon: "⚠️", title: "هامش ربح متوسط", message: `هامش الربح ${pnl.grossMargin.toFixed(1)}%. النسبة الصحية للكافيهات/المطاعم 40-60%.` });
  }
  // 🚩 المصاريف زادت > 30% عن السابق
  if (compare.change.totalExpenses.pct > 30 && compare.previous.totalExpenses > 0) {
    alerts.push({ level: "warning", icon: "📈", title: "المصاريف ارتفعت", message: `مصاريفك زادت ${compare.change.totalExpenses.pct}% عن الشهر السابق (${compare.change.totalExpenses.value.toFixed(2)}). راجع البنود الجديدة.` });
  }
  // 🚩 الإيرادات نقصت > 20%
  if (compare.change.revenue.pct < -20 && compare.previous.revenue > 0) {
    alerts.push({ level: "warning", icon: "📉", title: "الإيرادات انخفضت", message: `إيراداتك أقل بـ ${Math.abs(compare.change.revenue.pct)}% عن الشهر السابق. حاول حملة بث أو كوبون.` });
  }
  // 🟢 الأرباح زادت
  if (compare.change.netProfit.pct > 30 && compare.previous.netProfit > 0) {
    alerts.push({ level: "success", icon: "🎉", title: "نمو ممتاز!", message: `ربحك زاد ${compare.change.netProfit.pct}% عن الشهر السابق. أنت تتقدم بقوة.` });
  }
  // 🚩 منتجات بهامش سالب
  const lossProducts = (pnl.worstProducts || []).filter(p => p.profit < 0 && p.qty > 0);
  if (lossProducts.length > 0) {
    alerts.push({
      level: "danger",
      icon: "💸",
      title: `${lossProducts.length} منتج يخسر مالاً`,
      message: `أكبر خسارة: "${lossProducts[0].name}" (${lossProducts[0].profit.toFixed(2)}). راجع أسعار البيع أو تكلفة المنتج.`,
      products: lossProducts.slice(0, 3).map(p => ({ id: p.id, name: p.name, profit: round2(p.profit), qty: p.qty })),
    });
  }
  // 🚩 منتجات بدون تكلفة مسجلة (يمنع حساب الربح الصحيح)
  // allCosts شكلها { productId: { cost, updatedAt, history } } — ليست array
  const productsWithoutCost = (pnl.topProducts || []).filter(p => {
    const c = allCosts?.[p.id];
    return !c || !c.cost;
  });
  if (productsWithoutCost.length > 0) {
    alerts.push({
      level: "info",
      icon: "💡",
      title: `${productsWithoutCost.length} منتج بدون تكلفة مسجلة`,
      message: `سجّل تكلفة هذه المنتجات لتحصل على هامش ربح دقيق.`,
    });
  }
  return alerts;
}

// ─── 🔁 5. Recurring expenses ─────────────────────────────────────────────────
function _recurringFile(storeId) {
  return path.join(ensureStoreDir(storeId), "recurring-expenses.json");
}

function listRecurringExpenses(storeId) {
  return readJson(_recurringFile(storeId), { items: [] }).items;
}

function addRecurringExpense(storeId, { type, amount, note, dayOfMonth, fixed }, actor, req) {
  const data = readJson(_recurringFile(storeId), { items: [] });
  const item = {
    id: "rec_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type,
    amount: Number(amount) || 0,
    note: String(note || "").slice(0, 200),
    dayOfMonth: Math.max(1, Math.min(28, Number(dayOfMonth) || 1)),
    fixed: !!fixed,
    active: true,
    createdAt: new Date().toISOString(),
    lastAppliedYM: null,
  };
  data.items.push(item);
  writeJson(_recurringFile(storeId), data);
  return item;
}

function deleteRecurringExpense(storeId, id) {
  const data = readJson(_recurringFile(storeId), { items: [] });
  data.items = data.items.filter(i => i.id !== id);
  writeJson(_recurringFile(storeId), data);
}

function toggleRecurringExpense(storeId, id) {
  const data = readJson(_recurringFile(storeId), { items: [] });
  const i = data.items.find(x => x.id === id);
  if (!i) return null;
  i.active = !i.active;
  writeJson(_recurringFile(storeId), data);
  return i;
}

// يُستدعى يومياً للتحقق من تطبيق المصاريف المتكررة
function applyDueRecurringExpenses(storeId) {
  const data = readJson(_recurringFile(storeId), { items: [] });
  const today = new Date();
  const yearMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const day = today.getDate();
  let applied = 0;
  for (const item of data.items) {
    if (!item.active) continue;
    if (item.lastAppliedYM === yearMonth) continue; // مطبّق هذا الشهر
    if (day < item.dayOfMonth) continue;
    addExpense(storeId, {
      type: item.type,
      amount: item.amount,
      note: `${item.note} (تلقائي: ${item.id})`,
      fixed: item.fixed,
      date: new Date().toISOString(),
      source: "recurring",
      recurringId: item.id,
    });
    item.lastAppliedYM = yearMonth;
    applied++;
  }
  if (applied > 0) writeJson(_recurringFile(storeId), data);
  return applied;
}


function groupExpensesByType(expenses) {
  const out = {};
  for (const e of expenses) {
    if (!out[e.type]) out[e.type] = { type: e.type, ar: EXPENSE_TYPES[e.type]?.ar || e.type, total: 0, count: 0 };
    out[e.type].total = round2(out[e.type].total + e.amount);
    out[e.type].count++;
  }
  return Object.values(out).sort((a, b) => b.total - a.total);
}

// ─── Closing (Month + Year) ────────────────────────────────────────────────────

function _monthlyFile(storeId, yearMonth) {
  return path.join(ensureStoreDir(storeId), "monthly", `${yearMonth}.json`);
}

function _yearlyFile(storeId, year) {
  return path.join(ensureStoreDir(storeId), "yearly", `${year}.json`);
}

function getStoredMonthlyPnL(storeId, yearMonth) {
  return readJson(_monthlyFile(storeId, yearMonth), null);
}

function closeMonth(storeId, yearMonth, actor, req) {
  const existing = getStoredMonthlyPnL(storeId, yearMonth);
  if (existing?.closed) throw new Error("هذا الشهر مُقفل بالفعل");

  const pnl = calculateMonthlyPnL(storeId, yearMonth);
  const closed = { ...pnl, closed: true, closedAt: new Date().toISOString(), closedBy: actor?.id || "store" };
  writeJson(_monthlyFile(storeId, yearMonth), closed);

  audit({
    actor: actor || { type: "store", id: storeId },
    action: "accounting.month.close",
    target: { type: "month", id: yearMonth },
    meta: { storeId, netProfit: closed.netProfit, revenue: closed.revenue },
  }, req);

  return closed;
}

function isMonthClosed(storeId, yearMonth) {
  return !!getStoredMonthlyPnL(storeId, yearMonth)?.closed;
}

function listMonthlyReports(storeId) {
  const d = path.join(ensureStoreDir(storeId), "monthly");
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(f => f.endsWith(".json")).map(f => f.replace(".json","")).sort().reverse();
}

function calculateYearlySummary(storeId, year) {
  const yearStr = String(year);
  const months = [];
  let revenue = 0, cogs = 0, grossProfit = 0, totalExpenses = 0, netProfit = 0, vatOutput = 0;
  let ordersCount = 0;

  for (let m = 1; m <= 12; m++) {
    const ym = `${yearStr}-${String(m).padStart(2,"0")}`;
    const stored = getStoredMonthlyPnL(storeId, ym);
    const data = stored || calculateMonthlyPnL(storeId, ym);
    months.push({ month: ym, closed: !!stored?.closed, ...data });
    revenue += data.revenue;
    cogs += data.cogs;
    grossProfit += data.grossProfit;
    totalExpenses += data.totalExpenses;
    netProfit += data.netProfit;
    vatOutput += data.vatOutput;
    ordersCount += data.ordersCount;
  }

  // Top products across the year
  const agg = new Map();
  for (const m of months) {
    for (const p of (m.topProducts || [])) {
      const cur = agg.get(p.id) || { id: p.id, name: p.name, qty: 0, revenue: 0, cogs: 0, profit: 0 };
      cur.qty += p.qty;
      cur.revenue += p.revenue;
      cur.cogs += p.cogs;
      cur.profit = cur.revenue - cur.cogs;
      agg.set(p.id, cur);
    }
  }
  const topProducts = [...agg.values()].sort((a,b)=>b.profit-a.profit).slice(0,10);

  return {
    storeId,
    year: yearStr,
    revenue: round2(revenue),
    cogs: round2(cogs),
    grossProfit: round2(grossProfit),
    grossMargin: revenue > 0 ? round2((grossProfit/revenue)*100) : 0,
    totalExpenses: round2(totalExpenses),
    netProfit: round2(netProfit),
    netMargin: revenue > 0 ? round2((netProfit/revenue)*100) : 0,
    vatOutput: round2(vatOutput),
    ordersCount,
    monthsClosedCount: months.filter(m=>m.closed).length,
    months,
    topProducts,
  };
}

function closeYear(storeId, year, actor, req) {
  const yearly = calculateYearlySummary(storeId, year);
  // كل الأشهر يجب أن تكون مُقفلة
  const open = yearly.months.filter(m => !m.closed);
  if (open.length > 0) {
    throw new Error(`لا يمكن تقفيل السنة — ${open.length} شهر مفتوح بعد. أقفل الأشهر أولاً.`);
  }
  const closed = { ...yearly, closed: true, closedAt: new Date().toISOString(), closedBy: actor?.id || "store" };
  writeJson(_yearlyFile(storeId, year), closed);

  audit({
    actor: actor || { type: "store", id: storeId },
    action: "accounting.year.close",
    target: { type: "year", id: String(year) },
    meta: { storeId, netProfit: closed.netProfit, revenue: closed.revenue },
  }, req);

  return closed;
}

// ─── Dashboard KPIs ────────────────────────────────────────────────────────────

function getDashboardKPIs(storeId) {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}`;
  const lastMonth = new Date(now); lastMonth.setUTCMonth(lastMonth.getUTCMonth()-1);
  const lastYm = `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth()+1).padStart(2,"0")}`;

  const current = calculateMonthlyPnL(storeId, ym);
  const previous = calculateMonthlyPnL(storeId, lastYm);

  return {
    currentMonth: ym,
    revenue: { current: current.revenue, previous: previous.revenue, change: pctChange(current.revenue, previous.revenue) },
    netProfit: { current: current.netProfit, previous: previous.netProfit, change: pctChange(current.netProfit, previous.netProfit) },
    grossMargin: { current: current.grossMargin, previous: previous.grossMargin, change: round2(current.grossMargin - previous.grossMargin) },
    orders: { current: current.ordersCount, previous: previous.ordersCount, change: pctChange(current.ordersCount, previous.ordersCount) },
    topProduct: current.topProducts[0] || null,
    worstProduct: current.worstProducts[0] || null,
    expensesByType: current.expensesByType,
    // 🏢 توزيع الأرباح حسب البيزنس (مفيد للمتاجر التي بدلت نشاطها)
    byBusinessType: current.byBusinessType || [],
  };
}

function pctChange(curr, prev) {
  if (!prev) return null;
  return round2(((curr - prev) / prev) * 100);
}

// ─── Auto monthly P&L cron (runs on 1st of month) ──────────────────────────────

function startMonthlyAccountingCron() {
  // يفحص يومياً، يحسب P&L تلقائياً لكل المتاجر إذا 1st of month
  // + يطبّق المصاريف المتكررة المستحقة
  setInterval(() => {
    const now = new Date();
    if (!fs.existsSync(ACC_DIR)) return;
    const stores = fs.readdirSync(ACC_DIR);
    // 🔁 تطبيق المصاريف المتكررة (يومياً)
    for (const sid of stores) {
      try {
        const applied = applyDueRecurringExpenses(sid);
        if (applied > 0) console.log(`[accounting] applied ${applied} recurring expenses for ${sid}`);
      } catch (e) { console.warn(`[recurring] failed ${sid}:`, e.message); }
    }
    // 📊 snapshot شهري (1st of month فقط)
    if (now.getUTCDate() !== 1) return;
    const lastMonth = new Date(now); lastMonth.setUTCDate(0);
    const ym = `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth()+1).padStart(2,"0")}`;
    for (const sid of stores) {
      try {
        if (!getStoredMonthlyPnL(sid, ym)) {
          const pnl = calculateMonthlyPnL(sid, ym);
          writeJson(_monthlyFile(sid, ym), { ...pnl, closed: false });
          console.log(`[accounting] auto-snapshot ${sid} ${ym}: net=${pnl.netProfit}`);
        }
      } catch (e) { console.warn(`[accounting] snapshot failed ${sid}:`, e.message); }
    }
  }, 6 * 60 * 60 * 1000); // كل 6 ساعات
}

module.exports = {
  EXPENSE_TYPES,
  getAllProductCosts, getProductCost, setProductCost, getProductCostAtDate,
  addExpense, listExpenses, deleteExpense,
  calculateMonthlyPnL, getStoredMonthlyPnL, closeMonth, isMonthClosed, listMonthlyReports,
  calculateYearlySummary, closeYear,
  getDashboardKPIs,
  startMonthlyAccountingCron,
  // 🆕 v2
  compareWithPrevMonth, forecastMonthEnd, calculateBreakEven, detectSmartAlerts,
  listRecurringExpenses, addRecurringExpense, deleteRecurringExpense,
  toggleRecurringExpense, applyDueRecurringExpenses,
};
