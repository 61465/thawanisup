/**
 * 📈 Analytics — نمو المنصة، MRR، churn، LTV
 */
const fs   = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

function _readStores() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "stores.json"), "utf8")).stores || []; }
  catch { return []; }
}

function _ym(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function _ordersFile(storeId) {
  return storeId === "nakheel_001" ? path.join(DATA_DIR, "orders.jsonl")
                                   : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
}

function _readOrders(storeId) {
  const f = _ordersFile(storeId);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function getGrowthAnalytics(months = 12) {
  const stores = _readStores();
  const now = new Date();
  const monthsList = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthsList.push(_ym(d));
  }

  // لكل شهر: المتاجر النشطة، الجديدة، المنتهية، MRR
  const monthData = monthsList.map(ym => {
    const newStores = stores.filter(s => {
      if (!s.createdAt) return false;
      return _ym(s.createdAt) === ym;
    }).length;

    const churnedStores = stores.filter(s => {
      if (s.subscriptionStatus !== "expired" && s.subscriptionStatus !== "cancelled") return false;
      const endDate = s.subscriptionEndedAt || s.updatedAt;
      if (!endDate) return false;
      return _ym(endDate) === ym;
    }).length;

    // المتاجر النشطة في نهاية ذلك الشهر
    const monthEnd = new Date(ym + "-01"); monthEnd.setMonth(monthEnd.getMonth() + 1);
    const activeStores = stores.filter(s => {
      const created = new Date(s.createdAt || 0);
      if (created >= monthEnd) return false;
      // لو منتهي قبل أو خلال الشهر، لا يعد
      if (s.subscriptionStatus === "expired" || s.subscriptionStatus === "cancelled") {
        const endDate = new Date(s.subscriptionEndedAt || s.updatedAt || 0);
        if (endDate < monthEnd) return false;
      }
      return true;
    }).length;

    // MRR: مجموع subscriptionFee للمتاجر النشطة في نهاية الشهر
    const mrr = stores.reduce((sum, s) => {
      const created = new Date(s.createdAt || 0);
      if (created >= monthEnd) return sum;
      if (s.subscriptionStatus !== "active") return sum;
      return sum + (Number(s.subscriptionFee) || 0);
    }, 0);

    return { ym, newStores, churnedStores, activeStores, mrr: Number(mrr.toFixed(2)) };
  });

  // إجماليات حالية
  const activeNow = stores.filter(s => s.subscriptionStatus === "active");
  const mrrNow = activeNow.reduce((s, x) => s + (Number(x.subscriptionFee) || 0), 0);
  const arr = mrrNow * 12;

  // معدل النمو الشهري
  const last = monthData[monthData.length - 1];
  const prev = monthData[monthData.length - 2];
  const growthRate = prev && prev.mrr > 0 ? Math.round(((last.mrr - prev.mrr) / prev.mrr) * 100) : 0;

  // معدل الـ churn (آخر 30 يوم) — % من المتاجر النشطة بداية الشهر التي خرجت
  const monthAgo = new Date(); monthAgo.setMonth(monthAgo.getMonth() - 1);
  const churned30 = stores.filter(s => {
    if (s.subscriptionStatus !== "expired" && s.subscriptionStatus !== "cancelled") return false;
    return new Date(s.subscriptionEndedAt || s.updatedAt || 0) >= monthAgo;
  }).length;
  const activeStartOfMonth = (prev?.activeStores || activeNow.length);
  const churnRate = activeStartOfMonth > 0 ? +(((churned30 / activeStartOfMonth) * 100).toFixed(1)) : 0;

  // متوسط الإيراد لكل متجر (من الاشتراك + من commission على الطلبات لو في)
  const avgRevPerStore = activeNow.length > 0 ? Number((mrrNow / activeNow.length).toFixed(2)) : 0;

  // LTV = ARPU × (1 / churn) → بشهور
  const ltv_months = churnRate > 0 ? Math.round(100 / churnRate) : 24; // افتراضي 24 شهر لو لا churn
  const ltv = Number((avgRevPerStore * ltv_months).toFixed(2));

  return {
    months:        monthData,
    totals: {
      mrrNow:           Number(mrrNow.toFixed(2)),
      mrrPrev:          prev?.mrr || 0,
      arr:              Number(arr.toFixed(2)),
      growthRate,
      churnRate,
      avgRevPerStore,
      ltvMonths:        ltv_months,
      ltv,
      activeStores:     activeNow.length,
      totalStores:      stores.length,
    },
  };
}

module.exports = { getGrowthAnalytics };
