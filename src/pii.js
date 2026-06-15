/**
 * PII Encryption Helper — AES-256-GCM للحقول الحساسة + HMAC lookup للبحث.
 *
 * الاستخدام المتوقع:
 *   const pii = require("./pii");
 *   if (pii.enabled()) {
 *     entry.phone_enc = pii.encrypt(entry.phone);
 *     entry.phone_hash = pii.hash(entry.phone); // للبحث/الـ key
 *     delete entry.phone; // أو احتفظ به مؤقتاً للقراءة backward-compat
 *   }
 *
 * تشغيل:
 *   1. أضف في .env: PII_ENC_KEY = 64 hex char (32 bytes) — ولّده مرة واحدة:
 *      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   2. لا تُغيّر المفتاح بعد التشغيل (يُكسر فك تشفير القديم).
 *
 * ملاحظة: هذا helper جاهز للاستخدام التدريجي. integration الكامل
 * (تشفير customers.json + orders + customers lookup) يتطلب migration plan
 * منفصل لأن phone مستخدم كـ composite key في عدة أماكن.
 */
const crypto = require("crypto");

const ALG = "aes-256-gcm";
let _key = null;
let _hmacKey = null;

function _loadKey() {
  if (_key !== null) return;
  const raw = process.env.PII_ENC_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) { _key = false; return; }
  _key = Buffer.from(raw, "hex");
  // HMAC key مشتق من المفتاح الرئيسي عبر HKDF بسيط — لا يحتاج env منفصل
  _hmacKey = crypto.createHmac("sha256", _key).update("pii-hmac-v1").digest();
}

function enabled() { _loadKey(); return _key instanceof Buffer; }

function encrypt(plain) {
  _loadKey();
  if (!(_key instanceof Buffer)) throw new Error("PII_ENC_KEY not set");
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, _key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: v1:base64(iv).base64(tag).base64(ct)
  return `v1:${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

function decrypt(blob) {
  _loadKey();
  if (!(_key instanceof Buffer)) throw new Error("PII_ENC_KEY not set");
  if (typeof blob !== "string" || !blob.startsWith("v1:")) return blob; // backward compat: نص خام
  const parts = blob.slice(3).split(".");
  if (parts.length !== 3) throw new Error("bad PII format");
  const iv  = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const ct  = Buffer.from(parts[2], "base64");
  const decipher = crypto.createDecipheriv(ALG, _key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * HMAC للقيمة — deterministic، يصلح كـ lookup index بدون كشف القيمة.
 */
function hash(plain) {
  _loadKey();
  if (!(_hmacKey instanceof Buffer)) throw new Error("PII_ENC_KEY not set");
  if (plain == null) return null;
  return "h1:" + crypto.createHmac("sha256", _hmacKey).update(String(plain)).digest("hex").slice(0, 32);
}

/**
 * يقرأ القيمة إن كانت مشفّرة، يرجع نص خام إن لم تكن. (read-safe)
 */
function readMaybe(value) {
  if (typeof value !== "string") return value;
  if (!value.startsWith("v1:")) return value;
  try { return decrypt(value); } catch { return null; }
}

module.exports = { enabled, encrypt, decrypt, hash, readMaybe };
