/**
 * Migrate local JSON/JSONL data → Firestore
 * تشغيل: node scripts/migrate-to-firestore.js
 * (يتطلب firebase login + firebase use PROJECT_ID أولاً)
 */

const admin = require("firebase-admin");
const fs    = require("fs");
const path  = require("path");

admin.initializeApp();
const db      = admin.firestore();
const DATA_DIR = path.join(__dirname, "..", "data");

async function migrateStores() {
  const storesFile = path.join(DATA_DIR, "stores.json");
  if (!fs.existsSync(storesFile)) { console.log("⚠️  stores.json غير موجود"); return; }
  const { stores } = JSON.parse(fs.readFileSync(storesFile, "utf8"));
  console.log(`📦 ترحيل ${stores.length} متجر...`);
  const batch = db.batch();
  for (const store of stores) {
    batch.set(db.collection("stores").doc(store.id), store);
  }
  await batch.commit();
  console.log(`✅ تم ترحيل ${stores.length} متجر`);
}

async function migrateOrders() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".jsonl"));
  let total = 0;
  for (const file of files) {
    const storeId = file === "orders.jsonl" ? "nakheel_001" : file.replace("orders_", "").replace(".jsonl", "");
    const lines = fs.readFileSync(path.join(DATA_DIR, file), "utf8")
      .split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    console.log(`📦 ترحيل ${lines.length} طلب من ${file}...`);
    for (const order of lines) {
      await db.collection("orders").add({ ...order, storeId: order.storeId || storeId });
      total++;
    }
  }
  console.log(`✅ تم ترحيل ${total} طلب`);
}

(async () => {
  console.log("🚀 بدء الترحيل...\n");
  await migrateStores();
  await migrateOrders();
  console.log("\n🎉 اكتمل الترحيل! يمكنك الآن نشر المشروع على Firebase.");
  process.exit(0);
})().catch(e => { console.error("❌", e.message); process.exit(1); });
