/**
 * End-to-End Flow Test
 * يتحقق أن شجرة المحادثة تعمل من البداية للنهاية بدون أخطاء.
 * التشغيل: node test/flow.test.js
 */

require("dotenv").config();
process.env.WHATSAPP_TOKEN = "test";
process.env.WHATSAPP_PHONE_ID = "test";
process.env.OWNER_PHONE = "966500000000";
process.env.STORE_NAME = "اختبار";
process.env.WORKING_HOURS_START = "0";
process.env.WORKING_HOURS_END = "24";

const Module = require("module");
const captured = [];
const original = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "axios") {
    return {
      post: async (_, payload) => { captured.push(payload); return { data: {} }; },
      get: async () => ({ data: "" }),
    };
  }
  return original.apply(this, arguments);
};

const path = require("path");
const { handleMessage } = require(path.join(__dirname, "..", "src", "server.js"));
Module.prototype.require = original;

const USER = "966512345678";

function assert(cond, msg) {
  if (!cond) { console.error("❌ FAIL:", msg); process.exit(1); }
  console.log("✅", msg);
}

function lastInteractive() {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].type === "interactive") return captured[i];
  }
  return null;
}

function lastText() {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].type === "text") return captured[i].text.body;
  }
  return "";
}

async function run() {
  console.log("\n🧪 Running E2E flow test…\n");

  await handleMessage(USER, "");
  const welcome = lastInteractive();
  assert(welcome && welcome.interactive.type === "button", "Welcome shows buttons");
  assert(welcome.interactive.action.buttons.length === 3, "Welcome has 3 buttons");

  captured.length = 0;
  await handleMessage(USER, "SEE_MENU");
  const cats = lastInteractive();
  assert(cats && cats.interactive.type === "list", "Categories shown as list");

  captured.length = 0;
  await handleMessage(USER, "CAT_HOT");
  const products = lastInteractive();
  assert(products && products.interactive.type === "list", "Products shown as list");
  const rows = products.interactive.action.sections[0].rows;
  assert(rows.length > 0, "At least one product row");
  assert(rows.length <= 10, "Row count respects WhatsApp limit (≤10)");

  captured.length = 0;
  const firstProductId = rows.find((r) => r.id.startsWith("PROD_")).id;
  await handleMessage(USER, firstProductId);
  const qty = lastInteractive();
  assert(qty && qty.interactive.type === "button", "Quantity prompt shown");
  assert(qty.interactive.action.buttons.length === 3, "Quantity has 3 buttons");

  captured.length = 0;
  await handleMessage(USER, "QTY_2");
  const cartConfirm = lastInteractive();
  assert(cartConfirm && /تمت الإضافة/.test(cartConfirm.interactive.body.text), "Add-to-cart confirmation");

  captured.length = 0;
  await handleMessage(USER, "CHECKOUT");
  assert(/اسمك/.test(lastText()), "Asks for customer name");

  captured.length = 0;
  await handleMessage(USER, "محمد");
  assert(/عنوان/.test(lastText()), "Asks for location");

  captured.length = 0;
  await handleMessage(USER, "حي النخيل، الرياض");
  const invoice = lastInteractive();
  assert(invoice && /الإجمالي/.test(invoice.interactive.body.text), "Invoice summary shown");
  assert(/تأكيد/.test(invoice.interactive.action.buttons[0].reply.title), "Confirm button present");

  captured.length = 0;
  await handleMessage(USER, "CONFIRM_YES");
  const successMsg = captured.find((p) => p.type === "text" && /تم استلام طلبك/.test(p.text.body));
  assert(successMsg, "Success message sent to customer");

  const ownerNotif = captured.find(
    (p) => p.to === process.env.OWNER_PHONE && /طلب جديد/.test(p.text?.body || "")
  );
  assert(ownerNotif, "Owner notification sent");

  console.log("\n🎉 All tests passed!\n");
}

run().catch((e) => { console.error("❌ Test crashed:", e); process.exit(1); });
