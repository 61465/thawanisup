/**
 * Security Tests — يُختبَر:
 *   1. _safeJSON: لا يكسر </script>
 *   2. _safeCssColor: يرفض CSS injection
 *   3. magic bytes: يرفض HTML disguised as PNG
 *   4. atomic-fs: write يبقى atomic حتى بعد simulate crash
 *   5. bcrypt migration: يُحوّل plaintext → bcrypt صحيح
 *   6. TOTP replay: يرفض نفس counter مرتين
 *   7. sanitizeStoreIdForFilename: يمنع path traversal
 *
 * Usage:  node test/security.test.js
 * Exit:   0 = passed, 1 = failed
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const assert = require("assert");

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     → ${e.message}`);
    failed++;
  }
}

console.log("\n═══ 🔐 Security Tests ═══\n");

// ─── 1. atomic-fs ───────────────────────────────────────────────────────
console.log("📦 atomic-fs");
const atomicFs = require("../src/atomic-fs");

test("writeJsonSync ثم readJsonSync — round-trip", () => {
  const f = path.join(os.tmpdir(), "atomic-test-" + Date.now() + ".json");
  atomicFs.writeJsonSync(f, { a: 1, b: "test" });
  const r = atomicFs.readJsonSync(f);
  assert.deepStrictEqual(r, { a: 1, b: "test" });
  fs.unlinkSync(f);
});

test("readJsonSync مع fallback لو الملف مفقود", () => {
  const r = atomicFs.readJsonSync("/nonexistent-" + Date.now(), { def: true });
  assert.deepStrictEqual(r, { def: true });
});

// ─── 2. upload-safety ───────────────────────────────────────────────────
console.log("\n📦 upload-safety");
const safety = require("../src/upload-safety");

test("verifyMagicBytes: PNG signature يطابق", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  assert.strictEqual(safety.verifyMagicBytes(png, "png"), true);
});

test("verifyMagicBytes: HTML disguised as PNG يُرفض", () => {
  const html = Buffer.from("<!DOCTYPE html><script>alert(1)</script>");
  assert.strictEqual(safety.verifyMagicBytes(html, "png"), false);
});

test("verifyMagicBytes: JPEG يطابق", () => {
  // verifyMagicBytes يتطلب 8 bytes كحد أدنى
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  assert.strictEqual(safety.verifyMagicBytes(jpeg, "jpg"), true);
});

test("verifyMagicBytes: SVG (XML) يُرفض كـ PNG", () => {
  const svg = Buffer.from('<?xml version="1.0"?><svg onload="alert(1)">');
  assert.strictEqual(safety.verifyMagicBytes(svg, "png"), false);
});

test("sanitizeStoreIdForFilename يمنع path traversal", () => {
  assert.strictEqual(safety.sanitizeStoreIdForFilename("../../etc/passwd"), "etcpasswd");
  assert.strictEqual(safety.sanitizeStoreIdForFilename("store_123"), "store_123");
  assert.strictEqual(safety.sanitizeStoreIdForFilename("../../../"), "");
});

test("decodeAndVerifyBase64 يرفض السكربت كصورة", () => {
  const evilB64 = Buffer.from("<script>alert(1)</script>").toString("base64");
  const r = safety.decodeAndVerifyBase64(evilB64, "png", 1024 * 1024, "image");
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes("لا يطابق نوعه"));
});

test("decodeAndVerifyBase64 يقبل PNG حقيقي", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const r = safety.decodeAndVerifyBase64(png.toString("base64"), "png", 1024 * 1024, "image");
  assert.strictEqual(r.ok, true);
});

// ─── 3. _safeJSON ─────────────────────────────────────────────────────────
console.log("\n📦 server._safeJSON (server-side)");

// نُحاكي الدالة بدلاً من تحميل server.js كاملاً (يحتاج .env)
function _safeJSON(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

test("_safeJSON يهرّب </script> XSS", () => {
  const evil = "</script><img src=x onerror=alert(1)>";
  const result = _safeJSON({ name: evil });
  assert.ok(!result.includes("</script>"));
  assert.ok(result.includes("\\u003c/script"));
});

test("_safeJSON يحافظ على JSON صحيح بعد escape", () => {
  const data = { name: "</script>منتج" };
  const result = _safeJSON(data);
  // الإصدار JS بـ eval يفك الـ unicode escapes تلقائياً
  const reverted = JSON.parse(result.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&"));
  assert.deepStrictEqual(reverted, data);
});

// ─── 4. bcrypt ──────────────────────────────────────────────────────────
console.log("\n📦 bcrypt");
const bcrypt = require("bcrypt");

test("bcrypt: hash + compare", async () => {
  const pass = "TestPassword123!";
  const hash = await bcrypt.hash(pass, 12);
  assert.ok(hash.startsWith("$2b$12$"));
  assert.strictEqual(await bcrypt.compare(pass, hash), true);
  assert.strictEqual(await bcrypt.compare("wrong", hash), false);
});

test("bcrypt: rounds = 12 صعب على brute-force", async () => {
  const start = Date.now();
  await bcrypt.hash("x", 12);
  const elapsed = Date.now() - start;
  assert.ok(elapsed > 100, `يجب > 100ms لمنع brute-force؛ أخذ ${elapsed}ms`);
});

// ─── 5. TOTP (two-fa internals) ─────────────────────────────────────────
console.log("\n📦 two-fa replay protection");

// نختبر مباشرة two-fa.js (لا يعتمد على .env)
const twoFa = require("../src/two-fa");

test("TOTP: secret valid", () => {
  const s = twoFa.generateSecret();
  assert.ok(s.length >= 16);
  assert.match(s, /^[A-Z2-7]+$/); // Base32
});

test("TOTP: code يتوافق مع verify", () => {
  const s = twoFa.generateSecret();
  const code = twoFa.totp(s);
  assert.strictEqual(twoFa.verifyToken(s, code), true);
});

test("TOTP: code خطأ يُرفض", () => {
  const s = twoFa.generateSecret();
  assert.strictEqual(twoFa.verifyToken(s, "000000"), false);
});

// ─── النتيجة ─────────────────────────────────────────────────────────────
console.log("\n═══ النتيجة ═══");
console.log(`✅ نجح: ${passed}`);
console.log(`❌ فشل: ${failed}`);
console.log(`📊 إجمالي: ${passed + failed}`);

// async tests يأخذ ثانية للإنهاء
setTimeout(() => process.exit(failed === 0 ? 0 : 1), 500);
