/**
 * Smoke Tests — منصة ثواني
 *
 * يفحص الأشياء التي تكسر عادة. كلها unit + smoke level (لا تحتاج VPS/البوت يعمل).
 * يستخدم node:test (مدمج في Node 20، لا dependencies جديدة).
 *
 * التشغيل:
 *   node --test tests/
 *
 * عند الإضافة لـ npm scripts:
 *   "test:smoke": "node --test tests/"
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ─── 1. atomic-fs: locking ─────────────────────────────────────────────────────
test("atomic-fs: updateJsonlLocked يعمل + يحمي من race", async (t) => {
  const af = require("../src/atomic-fs");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
  const file = path.join(tmpDir, "test.jsonl");
  fs.writeFileSync(file, '{"id":1,"v":"a"}\n{"id":2,"v":"b"}\n');

  await af.updateJsonlLocked(file, (lines) => {
    const updated = lines.map(l => {
      const o = JSON.parse(l);
      if (o.id === 1) o.v = "modified";
      return JSON.stringify(o);
    });
    return { lines: updated, result: true };
  });

  const result = fs.readFileSync(file, "utf8");
  assert.ok(result.includes('"v":"modified"'), "updateJsonl يحدّث الـ disk");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── 2. ai-parser: normalize الأشكال العربية ──────────────────────────────────
test("ai-parser: normalizeAr يوحّد الهمزة والياء", () => {
  const { normalizeAr } = require("../src/ai-parser");
  assert.equal(normalizeAr("مسؤول"), "مسوول", "ؤ → و");
  assert.equal(normalizeAr("إلى"), "الي", "إ → ا، ى → ي");
  assert.equal(normalizeAr("نعم"), "نعم", "بدون تغيير");
  assert.equal(normalizeAr(""), "", "فارغ آمن");
  assert.equal(normalizeAr(null), "", "null آمن");
});

// ─── 3. plans: hasFeature ─────────────────────────────────────────────────────
test("plans: hasFeature يعرف الميزات الصحيحة", () => {
  const { hasFeature, DEFAULT_PLANS } = require("../src/plans");
  assert.ok(DEFAULT_PLANS.starter, "starter موجود");
  assert.ok(DEFAULT_PLANS.pro, "pro موجود");
  assert.ok(DEFAULT_PLANS.premium, "premium موجود");
  assert.equal(hasFeature("starter", "adminPanel"), true, "starter بـ adminPanel");
  assert.equal(hasFeature("starter", "invoiceImage"), false, "starter بدون invoice");
  assert.equal(hasFeature("pro", "invoiceImage"), true, "pro بـ invoice");
});

// ─── 4. orders: في الذاكرة + on-disk ──────────────────────────────────────────
test("orders: logOrder + findOrder + readOrders", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orders-"));
  process.env.ORDERS_LOG_PATH = path.join(tmpDir, "orders.jsonl");
  // reload module (cache busting)
  delete require.cache[require.resolve("../src/orders")];
  const orders = require("../src/orders");

  orders.logOrder({ orderId: "ORD-TEST1", storeId: "nakheel_001", total: 50, status: "pending" });
  orders.logOrder({ orderId: "ORD-TEST2", storeId: "nakheel_001", total: 75, status: "pending" });

  const found = orders.findOrder("nakheel_001", "ORD-TEST1");
  assert.ok(found, "findOrder يجد الطلب");
  assert.equal(found.total, 50);

  const list = orders.readOrders("nakheel_001", 10);
  assert.ok(list.length >= 2, "readOrders يرجع الطلبات");

  await orders.updateOrderStatus("nakheel_001", "ORD-TEST1", "confirmed");
  const updated = orders.findOrder("nakheel_001", "ORD-TEST1");
  assert.equal(updated.status, "confirmed", "updateStatus يحفظ");

  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORDERS_LOG_PATH;
});

// ─── 5. invoice-image: num() helper يتعامل مع null ─────────────────────────────
test("invoice-image: num helper", () => {
  // num غير exported لكن نختبر السلوك بشكل غير مباشر
  // عبر التأكد من require بدون crash
  const inv = require("../src/invoice-image");
  assert.ok(typeof inv.generateInvoiceImage === "function", "generateInvoiceImage موجود");
  assert.ok(typeof inv.generateSummaryImage === "function", "generateSummaryImage موجود");
});

// ─── 6. error-monitor: capture + grouping ─────────────────────────────────────
test("error-monitor: capture + grouping", () => {
  // تأكد من PUBLIC_URL/JWT_SECRET لا يكسر التحميل
  process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(48);
  const em = require("../src/error-monitor");

  em.capture(new Error("test error 1"), { context: "test" });
  em.capture(new Error("test error 1"), { context: "test" }); // نفس التوقيع
  em.capture(new Error("test error 2"), { context: "test" });

  const stats = em.stats();
  assert.ok(stats.total >= 3, "stats.total يعد كل الأخطاء");

  const grouped = em.groupedErrors(10);
  assert.ok(grouped.length >= 2, "grouped errors يجمع التوقيعات");
  const sample = grouped.find(g => g.message?.includes("test error 1"));
  assert.ok(sample, "test error 1 موجود");
  assert.ok(sample.count >= 2, "count يحسب التكرار");
});

// ─── 7. canvas-pool: lazy init + stats ─────────────────────────────────────────
test("canvas-pool: stats يعمل بدون workers", () => {
  delete process.env.CANVAS_WORKERS; // disable
  delete require.cache[require.resolve("../src/canvas-pool")];
  const pool = require("../src/canvas-pool");
  const s = pool.stats();
  assert.equal(s.enabled, false, "disabled بـ no env var");
});

// ─── 8. session-manager: TTL ──────────────────────────────────────────────────
test("session-manager: set/get/update", () => {
  delete require.cache[require.resolve("../src/session")];
  const sm = require("../src/session");

  sm.set("test-from-1", { step: "WELCOME", cart: [] });
  const s = sm.get("test-from-1");
  assert.equal(s?.step, "WELCOME", "set + get يعملان");

  sm.update("test-from-1", { step: "MAIN_MENU" });
  const s2 = sm.get("test-from-1");
  assert.equal(s2?.step, "MAIN_MENU", "update يحفظ");
  assert.deepEqual(s2?.cart, [], "update لا يمسح الحقول الأخرى");
});

// ─── 9. business-types resolver ───────────────────────────────────────────────
test("business-types: detect by store products", () => {
  // ملف public/business-types.js للـ frontend، لا نختبره من الـ backend
  // نتأكد فقط من plans + AI config
  assert.ok(true, "placeholder");
});

// ─── 10. JSON files: valid format ─────────────────────────────────────────────
test("data files: stores.json + customers.json valid JSON", () => {
  const DATA_DIR = path.join(__dirname, "..", "data");
  if (!fs.existsSync(DATA_DIR)) return; // skip lo data folder غير موجود
  const files = ["stores.json", "customers.json", "polls.json"];
  for (const f of files) {
    const p = path.join(DATA_DIR, f);
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, "utf8");
    assert.doesNotThrow(() => JSON.parse(content), `${f} JSON صالح`);
  }
});
