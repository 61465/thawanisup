/**
 * AI Accountant — نصائح مالية ذكية حسب نوع البيزنس
 * يستخدم Groq Llama لتوليد توصيات تخفيض التكاليف + تحذيرات + اقتراحات نمو
 * كذلك يولّد توصيات نوع الفيديو الموصى به للمنتجات
 */

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL    = "llama-3.3-70b-versatile";

async function callGroq(messages, opts = {}) {
  if (!GROQ_KEY) throw new Error("GROQ_API_KEY missing");
  const body = {
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 1200,
    response_format: opts.json ? { type: "json_object" } : undefined,
  };
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(()=> "");
    throw new Error(`Groq HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

const BIZ_FOCUS = {
  cafe:        "تكاليف المكونات (food cost) عادة 25-35% من البيع. ركّز على المنتجات منخفضة الـ margin، تكلفة الـ wastage، توقيت إعداد الطلبات في الذروة.",
  restaurant:  "food cost = 28-35%، labor cost = 25-30%. ركّز على portion control، الـ wastage، أعلى المنتجات ربحاً، الأطباق التي تستهلك وقت طبخ طويل بربح قليل.",
  salon:       "تكاليف المنتجات + الوقت/الجلسة + عمولات المختصين. ركّز على متوسط الإنفاق/زبون، الجلسات التي تستهلك وقت ولا ترجع ربح كبير، الترقيات.",
  programming: "تكلفة الوقت أساساً. ركّز على الـ hourly rate، الـ utilization، المشاريع التي تستهلك ساعات أكثر من المتوقع، التسعير الثابت vs الساعي.",
  delivery:    "تكاليف التوصيل (سائق + بنزين + سيارة) + المنتجات. ركّز على متوسط مسافة التوصيل، رسوم التوصيل vs التكلفة الفعلية، المناطق غير الربحية.",
  retail:      "هامش الربح يجب > 35% للسلع، > 50% للماركة الخاصة. ركّز على المخزون البطيء، السلع منتهية الصلاحية، نسبة العائدات.",
  clinic:      "تكاليف المستلزمات + الكشف + الجلسات. ركّز على متوسط ربح الجلسة، نسبة العيادة الفارغة، الإجراءات الأكثر ربحاً.",
  generic:     "ركّز على هامش الربح/منتج، أكثر المصاريف، الإيرادات الشهرية، اتجاه الربح.",
};

/**
 * يحلل P&L الشهر ويعطي نصائح
 * @param {string} businessType
 * @param {object} pnl — output of calculateMonthlyPnL
 * @returns { summary, advice: [{ priority, type, title, detail }], warnings: [...] }
 */
async function analyzeMonthlyPnL(businessType, pnl) {
  const focus = BIZ_FOCUS[businessType] || BIZ_FOCUS.generic;

  const compactPnl = {
    revenue: pnl.revenue,
    cogs: pnl.cogs,
    grossProfit: pnl.grossProfit,
    grossMargin: pnl.grossMargin,
    totalExpenses: pnl.totalExpenses,
    netProfit: pnl.netProfit,
    netMargin: pnl.netMargin,
    ordersCount: pnl.ordersCount,
    avgOrderValue: pnl.avgOrderValue,
    topProducts: (pnl.topProducts || []).slice(0,5).map(p => ({ name: p.name, qty: p.qty, profit: p.profit, margin: p.revenue ? (p.profit/p.revenue*100).toFixed(1) : 0 })),
    worstProducts: (pnl.worstProducts || []).slice(0,3).map(p => ({ name: p.name, qty: p.qty, profit: p.profit })),
    expensesByType: pnl.expensesByType,
  };

  // angle عشوائي يجبر التنوع لكل استدعاء (مع نفس البيانات)
  const ANGLES = [
    "ركّز على المنتج الأقل ربحاً وكيف نحسّن هامشه",
    "ركّز على نسبة مصاريف ثابتة vs متغيرة",
    "ركّز على فرص رفع متوسط قيمة الطلب (AOV)",
    "ركّز على تحسين هامش الربح الإجمالي",
    "ركّز على المخاطر النقدية والسيولة",
    "ركّز على فرص جلب عملاء جدد",
    "ركّز على الاحتفاظ بالعملاء الحاليين",
    "ركّز على تحسين السرعة التشغيلية",
  ];
  const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
  const nonce = Math.random().toString(36).slice(2, 8);

  const prompt = `أنت محاسب خبير سعودي متخصص في تحليل المتاجر الصغيرة. حلّل البيانات المالية التالية لمتجر من نوع "${businessType}".

التركيز لهذا النوع: ${focus}

🎯 زاوية التركيز لهذه الجلسة: ${angle}
(رقم مرجعي: ${nonce})

البيانات:
${JSON.stringify(compactPnl, null, 2)}

أعطني تحليلاً عربياً موجزاً بصيغة JSON بالحقول التالية:
{
  "summary": "ملخص بجملتين عن الأداء العام للشهر — لا تكرر نفس صياغة المرة السابقة",
  "healthScore": <رقم 0-100 بناءً على: hamish > 30% = ممتاز، 15-30% = جيد، < 15% = ضعيف، خسارة = خطر>,
  "advice": [
    { "priority": "high|medium|low", "type": "cost|revenue|product|operational", "title": "عنوان قصير ومميز", "detail": "توصية محددة قابلة للتنفيذ — اذكر رقم محدد من بيانات المتجر" }
  ],
  "warnings": ["تحذيرات حرجة إن وجدت — اذكر الرقم المقلق"],
  "kudos": ["إيجابيات يستحق التهنئة عليها — اذكر الرقم المُبشِّر"]
}

قواعد:
- عملي ومحدد (لا عبارات عامة مثل "حسّن المبيعات")
- مرتبط بزاوية التركيز المطلوبة هذه المرة
- بلغة عربية مبسطة طبيعية، لا تكرّر نفس الجمل
- max: 5 نصائح، 3 تحذيرات، 2 إيجابيات
- العملة ر.س
- إذا كانت البيانات كلها أصفار → اعترف بقلة البيانات ولا تخترع تحليلاً`;

  try {
    const raw = await callGroq([{ role: "user", content: prompt }], { json: true, temperature: 0.75 });
    const parsed = JSON.parse(raw);
    return {
      summary:     parsed.summary || "",
      healthScore: Math.max(0, Math.min(100, Number(parsed.healthScore) || 50)),
      advice:      Array.isArray(parsed.advice) ? parsed.advice.slice(0, 6) : [],
      warnings:    Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 4) : [],
      kudos:       Array.isArray(parsed.kudos) ? parsed.kudos.slice(0, 3) : [],
    };
  } catch (e) {
    console.warn("[ai-accountant] analysis failed:", e.message);
    return {
      summary: "تعذّر تحليل البيانات حالياً، حاول لاحقاً.",
      healthScore: 50,
      advice: [],
      warnings: [],
      kudos: [],
      _error: e.message,
    };
  }
}

/**
 * يوصي بنوع الفيديو لمنتج/خدمة حسب نوع البيزنس
 */
async function recommendVideoType(businessType, productName, productDescription = "") {
  const prompt = `أنت خبير marketing بصري في السوق العربي. اقترح نوع الفيديو الأفضل للمنتج التالي:

نوع البيزنس: ${businessType}
اسم المنتج: ${productName}
${productDescription ? `وصف: ${productDescription}` : ""}

أعطني الرد بصيغة JSON:
{
  "videoType": "short_demo | tasting | before_after | tutorial | testimonial | showcase | unboxing | service_walkthrough",
  "videoTypeAr": "اسم نوع الفيديو بالعربية",
  "duration": "<ثوانٍ موصى بها، مثال: '15-30s'>",
  "scriptTemplate": "قالب نص قصير لما يقوله المقدم (3-4 جمل)",
  "tips": ["نصيحة 1", "نصيحة 2", "نصيحة 3"]
}

ركّز على ما يثير شهية/فضول العميل العربي لشراء هذا المنتج تحديداً.`;

  try {
    const raw = await callGroq([{ role: "user", content: prompt }], { json: true, temperature: 0.5, maxTokens: 600 });
    return JSON.parse(raw);
  } catch (e) {
    console.warn("[ai-accountant] video rec failed:", e.message);
    return {
      videoType: "short_demo",
      videoTypeAr: "فيديو قصير للمنتج",
      duration: "15-30s",
      scriptTemplate: "اعرض المنتج بزاوية واضحة، اذكر أهم 2 من مميزاته، ادعُ المشاهد للطلب.",
      tips: ["إضاءة طبيعية واضحة", "صوت نقي بدون ضوضاء", "تركيز على المنتج وليس الخلفية"],
    };
  }
}

/**
 * AI Ratings Analyzer — Groq يحلل بادج تقييمات + يرجع insights عملية
 * (مدمج هنا لتفادي ملف منفصل لكل Groq integration)
 */
async function analyzeRatings(businessType, ratings) {
  if (!ratings || ratings.length === 0) {
    return { summary: "لا توجد تقييمات بعد", healthScore: 0, sentiment: { positive: 0, neutral: 0, negative: 0 }, keywords: [], topComplaints: [], topPraise: [], actionableInsights: [], warnings: [], trend: "stable" };
  }
  const compact = ratings.slice(0, 60).map(r => ({
    rating: r.rating,
    comment: (r.comment || "").slice(0, 200),
    date: (r.timestamp || "").slice(0, 10),
  }));

  const prompt = `أنت خبير تحليل تقييمات العملاء. لديك ${ratings.length} تقييماً لمتجر سعودي/مصري من نوع "${businessType}".

التقييمات (آخر 60):
${JSON.stringify(compact, null, 2)}

أعطني تحليلاً عربياً بصيغة JSON صحيحة بالحقول التالية:
{
  "summary": "ملخص بجملتين عن صحة سمعة المتجر بناء على هذه البيانات",
  "healthScore": <رقم 0-100 بناء على: 80+ ممتاز، 60-80 جيد، 40-60 متوسط، أقل = خطر>,
  "sentiment": { "positive": <عدد>, "neutral": <عدد>, "negative": <عدد> },
  "keywords": [{ "term": "الكلمة العربية", "count": <عدد>, "sentiment": "positive|negative|neutral" }],
  "topComplaints": [{ "issue": "نص الشكوى", "frequency": <عدد>, "examples": ["مثال"] }],
  "topPraise": [{ "praise": "نص المدح", "frequency": <عدد> }],
  "actionableInsights": [{ "priority": "high|medium|low", "title": "عنوان قصير", "detail": "توصية محددة بأرقام", "potentialImpact": "أثر متوقع" }],
  "warnings": ["تحذيرات حرجة إن وجدت"],
  "trend": "improving|stable|declining"
}

قواعد:
- العربية الفصحى المبسطة
- ربط النصائح بنوع المتجر (${businessType})
- أرقام محددة في النصائح (مثل: "45% من التقييمات السلبية تذكر التأخير")
- max: 8 keywords، 5 complaints، 5 praise، 5 insights
- إذا كانت التقييمات < 5 → اعترف بقلة البيانات في summary`;

  try {
    const raw = await callGroq([{ role: "user", content: prompt }], { json: true, temperature: 0.5, maxTokens: 1500 });
    const parsed = JSON.parse(raw);
    return {
      summary: parsed.summary || "",
      healthScore: Math.max(0, Math.min(100, Number(parsed.healthScore) || 50)),
      sentiment: parsed.sentiment || { positive: 0, neutral: 0, negative: 0 },
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 10) : [],
      topComplaints: Array.isArray(parsed.topComplaints) ? parsed.topComplaints.slice(0, 5) : [],
      topPraise: Array.isArray(parsed.topPraise) ? parsed.topPraise.slice(0, 5) : [],
      actionableInsights: Array.isArray(parsed.actionableInsights) ? parsed.actionableInsights.slice(0, 6) : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 4) : [],
      trend: ["improving","stable","declining"].includes(parsed.trend) ? parsed.trend : "stable",
    };
  } catch (e) {
    console.warn("[ai-ratings] failed:", e.message);
    return { summary: "تعذّر التحليل حالياً", healthScore: 50, sentiment: {positive:0,neutral:0,negative:0}, keywords: [], topComplaints: [], topPraise: [], actionableInsights: [], warnings: [], trend: "stable", _error: e.message };
  }
}

module.exports = { analyzeMonthlyPnL, recommendVideoType, analyzeRatings };
