/**
 * 🤖 Bot Intent Agent — عقل البوت الذكي
 *
 * يستخدم متعدد المزودين (Groq السريع + Claude للحالات المعقدة + Gemini للسياق الطويل)
 * بدل Groq وحده. يعطي البوت قدرات:
 *   - فهم النصوص الطبيعية حتى مع أخطاء إملائية
 *   - اكتشاف نية متعددة في رسالة واحدة (طلب + سؤال + شكوى)
 *   - search ذكي للمنتجات بالوصف ("شيكولاتة كبيرة بدون مكسرات")
 *   - sentiment detection (غاضب/مهتم/متردد) لتعديل الرد
 *
 * Input:
 *   {
 *     message: "نص العميل",
 *     storeContext: {
 *       storeName, businessType,
 *       products: [{id, name, description, price, category}],
 *       categories: [{id, name}],
 *       recentOrders: [...] // last 5 by customer
 *     },
 *     sessionContext: {
 *       step: "WELCOME|MENU|CART|...",
 *       cart: [...],
 *       history: [...] // last 3 messages
 *     }
 *   }
 *
 * Output:
 *   {
 *     intent: "browse|add_to_cart|remove|checkout|cancel|question|complaint|...",
 *     confidence: 0.95,
 *     entities: { productIds: ["p1","p3"], quantities: {p1: 2}, ... },
 *     sentiment: "positive|neutral|negative|frustrated",
 *     reply: "نص مقترح للرد (إن كان البوت سيرد مباشرة)",
 *     handoff: false  // true إذا يحتاج إنساناً
 *   }
 */

module.exports = async function botIntent({ input, llm, log }) {
  const { message = "", storeContext = {}, sessionContext = {} } = input;
  if (!message.trim()) {
    return { intent: "unknown", confidence: 0, entities: {}, sentiment: "neutral", reply: null, handoff: false };
  }

  // ── Build compact context ────────────────────────────────────
  const products = (storeContext.products || []).slice(0, 30).map(p => ({
    id: p.id, name: p.name, price: p.price,
    cat: storeContext.categories?.find(c => c.id === p.category)?.name || "",
    digital: p.productType === "digital" || undefined,
  }));

  const history = (sessionContext.history || []).slice(-3).map(h =>
    typeof h === "string" ? h : (h?.message || JSON.stringify(h).slice(0, 80))
  );

  const system = `أنت محلل نوايا (intent classifier) لبوت متجر واتساب عربي اسمه "${storeContext.storeName || "المتجر"}".
نوع المتجر: ${storeContext.businessType || "عام"}.
الخطوة الحالية: ${sessionContext.step || "WELCOME"}.

مهمتك:
1. فهم نية العميل (intent) — حتى لو فيها أخطاء إملائية أو لهجة محلية
2. استخراج entities (منتجات، كميات، رقم طلب)
3. كشف المشاعر (sentiment)
4. اقتراح رد طبيعي بالعربية الفصحى المبسطة (إن أمكن)
5. تحديد إن كان يحتاج تدخل إنسان (handoff)

الـ intents المتاحة:
- browse: يتصفح/يستفسر عن منتج
- add_to_cart: يريد إضافة منتج للسلة
- remove: حذف من السلة
- checkout: يريد إكمال الطلب
- cancel: إلغاء طلب
- track: استفسار عن حالة طلب
- question: سؤال عام (ساعات العمل، التوصيل)
- complaint: شكوى
- praise: مدح/شكر
- greeting: تحية
- unknown: غير واضح

رد بـ JSON فقط:
{
  "intent": "...",
  "confidence": 0.0-1.0,
  "entities": {
    "productNames": ["..."],
    "productIds": ["..."],
    "quantities": {"productId": N},
    "orderId": "...",
    "phone": "..."
  },
  "sentiment": "positive|neutral|negative|frustrated",
  "reply": "نص الرد المقترح (15 كلمة كحد أقصى)" ,
  "handoff": false,
  "reason": "سبب الـ handoff إن كان true"
}`;

  const user = `رسالة العميل: "${message}"

سياق الجلسة:
- المرحلة: ${sessionContext.step || "WELCOME"}
- السلة الحالية: ${JSON.stringify(sessionContext.cart || [])}
- آخر 3 رسائل: ${history.join(" | ") || "(لا توجد)"}

كتالوج المتجر (أول 30 منتج):
${JSON.stringify(products, null, 2)}

الفئات: ${(storeContext.categories || []).map(c => c.name).join("، ")}

حلّل النية بدقة.`;

  log(`analyzing message (${message.length} chars, ${products.length} products in context)`);

  // 🧠 routing: استخدم claude للحالات المعقدة (شكوى/handoff)، Groq للباقي
  const isComplex = /شكو|مشكل|غاضب|سيء|أسوأ|ضائع|مفقود|خسر|رفض/i.test(message);
  const task = isComplex ? "complex_intent" : "intent_classification";

  const result = await llm.call(task, {
    system, user, json: true, maxTokens: 800,
  });

  let parsed;
  try { parsed = JSON.parse(result.text); }
  catch {
    parsed = {
      intent: "unknown", confidence: 0.3,
      entities: {}, sentiment: "neutral",
      reply: null, handoff: false,
      _raw: (result.text || "").slice(0, 200),
    };
  }

  return {
    ...parsed,
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
  };
};
