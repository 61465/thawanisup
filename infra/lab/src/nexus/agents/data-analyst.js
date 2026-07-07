/**
 * 📊 Data Analyst Agent — يحلل أداء المتاجر ويعطي insights
 *
 * Input:  { storeId, period? } — period: today|week|month
 * Output: { kpis, insights, recommendations }
 */

const fs   = require("fs");
const path = require("path");

module.exports = async function dataAnalyst({ input, llm, reader, log }) {
  const { storeId, period = "week" } = input;
  if (!storeId) throw new Error("storeId required");

  // 1. اقرأ الطلبات
  const ordersFile = `data/orders_${storeId}.jsonl`;
  log(`reading orders for ${storeId}`);
  const ordersExist = await reader.exists(ordersFile);
  if (!ordersExist) {
    return { kpis: { totalOrders: 0 }, insights: ["لا توجد طلبات بعد"], recommendations: [] };
  }
  const allOrders = await reader.readJsonl(ordersFile);

  // فلتر حسب الفترة
  const cutoff = _periodCutoff(period);
  const orders = allOrders.filter(o => new Date(o.timestamp || 0).getTime() >= cutoff);

  if (orders.length === 0) {
    return { kpis: { totalOrders: 0 }, insights: [`لا توجد طلبات في فترة ${period}`], recommendations: [] };
  }

  // 2. احسب KPIs (deterministic — لا LLM)
  const confirmed = orders.filter(o => o.status === "confirmed" || o.status === "completed");
  const totalRevenue = confirmed.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const uniqueCustomers = new Set(orders.map(o => o.customerPhone).filter(Boolean)).size;
  const avgOrder = confirmed.length ? totalRevenue / confirmed.length : 0;

  const productCounts = {};
  confirmed.forEach(o => (o.items || []).forEach(it => {
    productCounts[it.name] = (productCounts[it.name] || 0) + (it.qty || 1);
  }));
  const topProducts = Object.entries(productCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const hourCounts = {};
  orders.forEach(o => {
    const h = new Date(o.timestamp || 0).getHours();
    hourCounts[h] = (hourCounts[h] || 0) + 1;
  });
  const peakHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

  const kpis = {
    period,
    totalOrders: orders.length,
    confirmedOrders: confirmed.length,
    totalRevenue: Number(totalRevenue.toFixed(2)),
    avgOrder: Number(avgOrder.toFixed(2)),
    uniqueCustomers,
    topProducts: topProducts.map(([name, qty]) => ({ name, qty })),
    peakHour: peakHour != null ? Number(peakHour) : null,
  };

  // 3. اطلب من LLM يولّد insights + recommendations
  const system = `أنت Data Analyst لمتاجر صغيرة على واتساب. تحول الأرقام لـ insights عملية بالعربية.
رد بـ JSON فقط:
{
  "insights": ["استنتاج 1", "استنتاج 2"],
  "recommendations": ["اقتراح 1", "اقتراح 2"]
}
ركّز على ما هو قابل للتنفيذ. تجنب العموميات.`;

  const user = `بيانات متجر "${storeId}" خلال ${period}:\n${JSON.stringify(kpis, null, 2)}`;

  const result = await llm.call("summarize", { system, user, json: true, maxTokens: 1500 });

  let parsed;
  try { parsed = JSON.parse(result.text); }
  catch { parsed = { insights: [], recommendations: [], _raw: result.text }; }

  return { kpis, ...parsed, provider: result.provider, model: result.model };
};

function _periodCutoff(period) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (period === "today") return now - day;
  if (period === "week")  return now - 7 * day;
  if (period === "month") return now - 30 * day;
  return 0; // all
}
