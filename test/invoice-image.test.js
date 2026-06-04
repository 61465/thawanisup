/**
 * Invoice Image Test
 * يولّد فاتورة عينة ويتحقق أن الملف موجود + حجمه > 10KB
 */

const fs = require("fs");
const path = require("path");
const { generateInvoiceImage } = require("../src/invoice-image");

const sample = {
  orderId: "ORD-TEST01",
  storeName: "مقهى النخيل",
  customerName: "محمد العتيبي",
  customerLocation: "حي النخيل، شارع الأمير سلطان، الرياض",
  items: [
    { name: "قهوة عربية", qty: 2, price: 12 },
    { name: "كابتشينو", qty: 1, price: 18 },
    { name: "كرواسان زبدة", qty: 3, price: 15 },
    { name: "كيك الشوكولاته", qty: 1, price: 22 },
  ],
  subtotal: 109,
  deliveryFee: 10,
  total: 119,
  currency: "ر.س",
  date: "2026-06-04",
};

console.log("🎨 Generating sample invoice image…");
const result = generateInvoiceImage(sample);

const assert = (cond, msg) => {
  if (!cond) { console.error("❌ FAIL:", msg); process.exit(1); }
  console.log("✅", msg);
};

assert(fs.existsSync(result.filePath), `File created at ${result.filePath}`);
assert(result.sizeBytes > 10_000, `Size > 10KB (got ${(result.sizeBytes/1024).toFixed(1)} KB)`);
assert(result.fileName === "ORD-TEST01.png", "Filename correct");

console.log("\n📂 Open it to verify visually:");
console.log("   " + result.filePath);
console.log("\n🎉 Invoice image test passed!\n");
