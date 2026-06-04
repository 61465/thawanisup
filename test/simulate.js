/**
 * Local Simulator — اختبار شجرة المحادثة بدون Meta
 *
 * كيف يعمل: يُحمّل نفس handleMessage من server.js،
 * يعترض دوال WhatsApp API ويطبع الرسائل في الـ terminal بدل إرسالها.
 *
 * التشغيل:
 *   node test/simulate.js
 *
 * ثم اكتب رسائل كأنك العميل (مثل: "ابدأ" أو "SEE_MENU" أو "1").
 */

require("dotenv").config();
process.env.WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "test-token";
process.env.WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "test-phone";

const readline = require("readline");
const Module = require("module");
const path = require("path");

const captured = [];
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "axios") {
    return {
      post: async (url, payload) => {
        captured.push(payload);
        return { data: { messages: [{ id: "sim_" + Date.now() }] } };
      },
      get: async () => ({ data: "" }),
    };
  }
  return originalRequire.apply(this, arguments);
};

const { handleMessage } = require(path.join(__dirname, "..", "src", "server.js"));
Module.prototype.require = originalRequire;

const FAKE_USER = "966500000000";

function renderMessage(payload) {
  const t = payload.type;
  console.log("\n┌─── 📱 رسالة من البوت ────────────────");
  if (t === "text") {
    console.log("│ نص:\n" + indent(payload.text.body));
  } else if (t === "image") {
    console.log("│ 🖼️  صورة: " + payload.image.link);
    if (payload.image.caption) console.log("│ تعليق:\n" + indent(payload.image.caption));
  } else if (t === "interactive") {
    const it = payload.interactive;
    console.log("│ نص:\n" + indent(it.body.text));
    if (it.type === "button") {
      console.log("│\n│ 🔘 أزرار:");
      it.action.buttons.forEach((b, i) => {
        console.log(`│   [${i + 1}] ${b.reply.title}    (id: ${b.reply.id})`);
      });
    } else if (it.type === "list") {
      console.log(`│\n│ 📋 قائمة (زر: ${it.action.button}):`);
      it.action.sections.forEach((s) => {
        console.log(`│   ── ${s.title} ──`);
        s.rows.forEach((r, i) => {
          console.log(`│   [${i + 1}] ${r.title}    (id: ${r.id})`);
          if (r.description) console.log(`│       ↳ ${r.description}`);
        });
      });
    }
    if (it.footer) console.log("│\n│ Footer: " + it.footer.text);
  }
  console.log("└──────────────────────────────────────\n");
}

function indent(s) {
  return s.split("\n").map((l) => "│   " + l).join("\n");
}

async function main() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║  🤖 محاكي WhatsApp — اختبار البوت محلياً  ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("اكتب رسالة كأنك العميل.");
  console.log("أمثلة: 'ابدأ' / 'SEE_MENU' / 'CAT_HOT' / '2' / 'CHECKOUT'");
  console.log("اكتب 'خروج' أو Ctrl+C للإنهاء.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  await handleMessage(FAKE_USER, "");
  while (captured.length) renderMessage(captured.shift());

  const prompt = () => {
    rl.question("👤 أنت> ", async (input) => {
      const text = input.trim();
      if (!text) return prompt();
      if (text === "خروج" || text === "exit") {
        console.log("👋 وداعاً!");
        rl.close();
        return;
      }
      try {
        await handleMessage(FAKE_USER, text);
        while (captured.length) renderMessage(captured.shift());
      } catch (err) {
        console.error("❌ خطأ:", err.message);
      }
      prompt();
    });
  };
  prompt();
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
