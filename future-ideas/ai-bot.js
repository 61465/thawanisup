/**
 * AI Bot — Groq/Llama 3.3 powered WhatsApp order assistant
 * يفهم العامية، يجمع الطلب، يرسل الفاتورة تلقائياً
 */

const axios            = require("axios");
const waMgr            = require("./whatsapp-manager");
const { logOrder }     = require("./orders");
const { upsertCustomer } = require("./customers");
const { addPoints }    = require("./loyalty");
const { hasFeature }   = require("./plans");
const { generateInvoiceImage } = require("./invoice-image");
const { generateMenuImage }    = require("./menu-image");

const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// storeId:from → [{ role, content }]
const convMap = new Map();

// ─── System Prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(store) {
  const currency = store.currency || "ر.س";
  const cats     = store.categories || [];
  const prods    = (store.products  || []).filter(p => p.available !== false);

  let menuText = "";
  if (cats.length > 0) {
    menuText = cats.map(cat => {
      const items = prods.filter(p => p.category === cat.id);
      if (!items.length) return null;
      return `${cat.emoji || "◆"} ${cat.name}:\n` +
        items.map(p => `  • ${p.name}: ${p.price} ${currency}${p.description ? ` — ${p.description}` : ""}`).join("\n");
    }).filter(Boolean).join("\n\n");
  } else {
    menuText = prods.map(p => `• ${p.name}: ${p.price} ${currency}`).join("\n");
  }

  const deliveryNote = store.businessType === "pickup"
    ? "الاستلام من المتجر فقط"
    : `توصيل متاح — رسوم التوصيل: ${store.deliveryFee || 0} ${currency}`;

  const hours = (store.workingHoursStart === 0 && store.workingHoursEnd === 24)
    ? "متاح 24 ساعة"
    : `${store.workingHoursStart}:00 — ${store.workingHoursEnd}:00`;

  const welcome = store.welcomeMessage ? `رسالة الترحيب: "${store.welcomeMessage}"\n` : "";

  const hasMenu = prods.length > 0;

  return `أنت مساعد طلبات واتساب لـ "${store.storeName}" — ${store.city || ""}.
${welcome}نوع النشاط: ${store.storeType || "متجر"} | ${deliveryNote} | ${hours}

📋 القائمة:
${menuText || "(لا توجد منتجات حالياً)"}

🎯 مهمتك بالترتيب:
١. عند أول رسالة: رحّب باسم المتجر ثم اعرض هذه الخيارات دائماً:
   "1️⃣ عرض القائمة
    2️⃣ تقديم طلب
    3️⃣ تتبع طلب
    اكتب الرقم أو اكتب طلبك مباشرة"
٢. إذا طلب القائمة: اعرض المنيو كاملاً بشكل جميل ${hasMenu ? "ثم استدعِ send_menu_image" : ""}
٣. ساعده في اختيار الأصناف والكميات
٤. اجمع اسمه الكامل وعنوان التوصيل
٥. لخّص الطلب مع الإجمالي واطلب التأكيد
٦. بعد تأكيد العميل فقط — استدعِ submit_order

⚠️ قواعد لا تُخالَف:
- تحدث بالعربية حصراً
- لا تختلق منتجات أو أسعار خارج القائمة
- ردود قصيرة ومباشرة (واتساب وليس بريد)
- لا تستدعِ submit_order إلا بعد تأكيد العميل الصريح`;
}

// ─── Tool definitions ──────────────────────────────────────────────────────────
const MENU_IMAGE_TOOL = {
  type: "function",
  function: {
    name: "send_menu_image",
    description: "Send the visual menu image to the customer when they ask to see the menu",
    parameters: { type: "object", properties: {} },
  },
};

const SUBMIT_TOOL = {
  type: "function",
  function: {
    name: "submit_order",
    description: "Call ONLY when the customer explicitly confirms the complete order",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name:  { type: "string" },
              qty:   { type: "number" },
              price: { type: "number" },
            },
            required: ["name", "qty", "price"],
          },
        },
        customerName: { type: "string" },
        address:      { type: "string", description: "Delivery address or 'استلام من المتجر'" },
        notes:        { type: "string" },
        deliveryFee:  { type: "number" },
        total:        { type: "number" },
      },
      required: ["items", "customerName", "address", "total"],
    },
  },
};

// ─── Groq API call ─────────────────────────────────────────────────────────────
async function callGroq(sysPrompt, history) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");

  const { data } = await axios.post(
    GROQ_URL,
    {
      model:       GROQ_MODEL,
      messages:    [{ role: "system", content: sysPrompt }, ...history],
      max_tokens:  600,
      temperature: 0.3,
      tools:       [MENU_IMAGE_TOOL, SUBMIT_TOOL],
      tool_choice: "auto",
    },
    {
      headers:  { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      timeout:  15000,
    }
  );
  return data;
}

// ─── Send menu as image ───────────────────────────────────────────────────────
async function _sendMenuImage(storeId, from, store) {
  try {
    const { filePath } = await generateMenuImage({
      storeId,
      storeName:      store.storeName,
      invoiceColor:   store.invoiceColor   || "#1b5e20",
      invoiceLogoUrl: store.invoiceLogoUrl || null,
      categories:     store.categories     || [],
      products:       (store.products      || []).filter(p => p.available !== false),
      currency:       store.currency       || "ر.س",
    });
    await waMgr.sendImage(storeId, from, filePath, `📋 قائمة ${store.storeName}`);
  } catch (e) {
    console.error("[ai-bot] generateMenuImage:", e.message);
  }
}

// ─── Process confirmed order (log + notify owner + invoice) ───────────────────
async function _processOrder(storeId, from, store, args) {
  const currency = store.currency || "ر.س";
  const orderId  = `ORD-${Date.now().toString().slice(-7)}`;
  const subtotal = args.items.reduce((s, i) => s + i.price * i.qty, 0);
  const fee      = args.deliveryFee ?? store.deliveryFee ?? 0;
  const total    = args.total || (subtotal + fee);

  const cartItems = args.items.map((item, idx) => ({
    id:    `ai-${idx}`,
    name:  item.name,
    qty:   item.qty,
    price: item.price,
  }));

  const phoneNum = from.replace(/@lid$/, "").replace(/@s\.whatsapp\.net$/, "");

  logOrder({
    orderId, storeId,
    storeName:        store.storeName,
    invoiceColor:     store.invoiceColor   || null,
    invoiceLogoUrl:   store.invoiceLogoUrl || null,
    customerName:     args.customerName,
    customerLocation: args.address,
    customerPhone:    phoneNum,
    items:            cartItems,
    subtotal, deliveryFee: fee, total, currency,
    coupon: null, discount: 0,
    date:   new Date().toISOString().slice(0, 10),
    status: "pending_confirmation",
    source: "ai-bot",
  });

  if (hasFeature(store.plan, "customerRegistry")) {
    upsertCustomer({ phone: phoneNum, name: args.customerName, location: args.address, total });
  }

  const earned    = addPoints(from, total, orderId);
  const itemLines = cartItems
    .map(i => `• ${i.name} ×${i.qty} — ${(i.price * i.qty).toFixed(2)} ${currency}`)
    .join("\n");

  // Confirmation to customer
  const confirmMsg =
    `✅ *تم استلام طلبك!*\n\n` +
    `رقم الطلب: *${orderId}*\n\n` +
    `${itemLines}\n` +
    (fee > 0 ? `🚚 توصيل: ${fee} ${currency}\n` : "") +
    `──────────\n` +
    `💰 الإجمالي: *${total.toFixed(2)} ${currency}*\n\n` +
    (args.notes ? `📝 ملاحظات: ${args.notes}\n\n` : "") +
    `🏆 كسبت *${earned.newPoints}* نقطة! رصيدك: *${earned.totalPoints}*\n\n` +
    `طلبك قيد المراجعة، سيتم التواصل معك قريباً 💚`;

  await waMgr.sendMessage(storeId, from, confirmMsg);

  // Owner notification
  const ownerPhone = store.ownerPhone;
  if (ownerPhone) {
    const ownerMsg =
      `🔔 *طلب جديد — ${store.storeName}*\n\n` +
      `رقم الطلب: *${orderId}*\n` +
      `العميل: *${args.customerName}*\n` +
      `الهاتف: ${phoneNum}\n` +
      `العنوان: ${args.address}\n\n` +
      `${itemLines}\n──────────\n` +
      `💰 الإجمالي: *${total.toFixed(2)} ${currency}*` +
      (args.notes ? `\n📝 ${args.notes}` : "");
    const ownerJid = ownerPhone.replace(/\D/g, "") + "@s.whatsapp.net";
    try { await waMgr.sendMessage(storeId, ownerJid, ownerMsg); } catch {}
  }

  // Invoice image
  if (hasFeature(store.plan, "invoiceImage")) {
    try {
      const { filePath } = await generateInvoiceImage({
        orderId, storeName: store.storeName,
        invoiceColor:     store.invoiceColor   || "#1b5e20",
        invoiceLogoUrl:   store.invoiceLogoUrl || null,
        customerName:     args.customerName,
        customerLocation: args.address,
        items: cartItems, subtotal, deliveryFee: fee, total, currency,
        date: new Date().toISOString().slice(0, 10),
      });
      await waMgr.sendImage(storeId, from, filePath, `🧾 فاتورتك — ${orderId}`);
    } catch (e) {
      console.error("[ai-bot] invoice:", e.message);
    }
  }
}

// ─── Main handler — called from server.js handleMessage ───────────────────────
// Returns: reply string to send   |   null = fall through to rule-based bot
async function handleAIMessage(storeId, from, text, store) {
  const key = `${storeId}:${from}`;
  if (!convMap.has(key)) convMap.set(key, []);
  const history = convMap.get(key);

  history.push({ role: "user", content: text });
  if (history.length > 24) history.splice(0, history.length - 24);

  const sysPrompt = buildSystemPrompt(store);

  try {
    const data   = await callGroq(sysPrompt, history);
    const choice = data.choices?.[0];
    const msg    = choice?.message;

    // ── Tool call ───────────────────────────────────────────────────────────
    if (msg?.tool_calls?.length) {
      const call     = msg.tool_calls[0];
      const toolName = call.function.name;

      // send_menu_image
      if (toolName === "send_menu_image") {
        history.push({ role: "assistant", content: null, tool_calls: msg.tool_calls });
        history.push({ role: "tool", tool_call_id: call.id, content: "image sent" });
        // Generate and send menu image async
        _sendMenuImage(storeId, from, store).catch(e =>
          console.error("[ai-bot] menu image:", e.message)
        );
        return null; // no text reply needed — image will arrive
      }

      // submit_order
      if (toolName === "submit_order") {
        let args;
        try { args = JSON.parse(call.function.arguments); } catch {
          return "عذراً، لم أتمكن من معالجة الطلب. أعد المحاولة.";
        }
        convMap.delete(key);
        _processOrder(storeId, from, store, args).catch(e =>
          console.error("[ai-bot] _processOrder:", e.message)
        );
        return null;
      }
    }

    // ── Regular reply ───────────────────────────────────────────────────────
    const reply = msg?.content?.trim();
    if (!reply) throw new Error("empty reply");
    history.push({ role: "assistant", content: reply });
    return reply;

  } catch (e) {
    console.error(`[ai-bot][${storeId}]`, e.message);
    history.pop(); // remove the user message that failed
    return null;   // fallback to rule-based
  }
}

function clearConversation(storeId, from) {
  convMap.delete(`${storeId}:${from}`);
}

module.exports = { handleAIMessage, clearConversation };
