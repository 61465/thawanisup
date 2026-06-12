#!/usr/bin/env node
/**
 * Migration: تحويل كل storePassword الـ plaintext في data/stores.json إلى bcrypt hash
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage:  node scripts/migrate-plaintext-passwords.js
 *
 * 🛡️ ينشئ نسخة احتياطية data/stores.json.before-migration-<TIMESTAMP>.json قبل التعديل
 *    ويعرض الكلمات الأصلية مرة واحدة فقط على الـ terminal (لإرسالها للملاك إن لزم).
 *
 * 🔁 idempotent: لو الـ field bcrypt-hashed بالفعل، يتركها.
 */

const fs    = require("fs");
const path  = require("path");
const bcrypt = require("bcrypt");

const BCRYPT_ROUNDS = 12;
const BCRYPT_RE = /^\$2[aby]?\$\d{2}\$/;

const STORES_FILE = path.join(__dirname, "..", "data", "stores.json");

async function main() {
  if (!fs.existsSync(STORES_FILE)) {
    console.error("❌ stores.json غير موجود:", STORES_FILE);
    process.exit(1);
  }

  const raw = fs.readFileSync(STORES_FILE, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.stores)) { console.error("❌ stores.json تالف"); process.exit(1); }

  const stamp  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1);
  const backup = STORES_FILE + `.before-migration-${stamp}.json`;
  fs.writeFileSync(backup, raw, "utf8");
  console.log(`✅ نسخة احتياطية: ${backup}`);

  let migrated = 0;
  const report = [];
  for (const store of data.stores) {
    const pw = store.storePassword;
    if (!pw) continue;
    if (BCRYPT_RE.test(pw)) continue; // already bcrypt
    const hashed = await bcrypt.hash(pw, BCRYPT_ROUNDS);
    report.push({ id: store.id, name: store.storeName, phone: store.ownerPhone, originalPassword: pw });
    store.storePassword = hashed;
    migrated++;
  }

  if (migrated === 0) {
    console.log("✓ كل كلمات المرور مُشفّرة مسبقاً — لا حاجة للتشغيل.");
    return;
  }

  fs.writeFileSync(STORES_FILE, JSON.stringify(data, null, 2), "utf8");
  console.log(`\n🎉 تم تشفير ${migrated} كلمة مرور إلى bcrypt.\n`);

  console.log("📋 الكلمات الأصلية (احفظها مرة واحدة فقط لإرسالها لأصحاب المتاجر):");
  console.log("─".repeat(80));
  for (const r of report) {
    console.log(`  ${r.name || r.id}  |  ${r.phone || "—"}  |  ${r.originalPassword}`);
  }
  console.log("─".repeat(80));
  console.log("\n⚠️  بعد إرسال الكلمات، احذف الـ terminal output ولا تحفظه في أي مكان.");
}

main().catch(e => { console.error("❌ فشلت الـ migration:", e.message); process.exit(1); });
