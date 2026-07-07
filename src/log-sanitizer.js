/**
 * Log Sanitizer — يحجب الأسرار من logs/errors/audit
 *
 * يستخدم في:
 *   - error-monitor.js قبل كتابة الأخطاء لـ jsonl
 *   - audit-log.js قبل كتابة actions
 *   - console.* في الإنتاج (اختياري)
 *
 * الفلسفة: redact بصمت، لا تكسر الـ JSON، لا تخسر السياق.
 */

"use strict";

// مفاتيح env حساسة (مهما كانت قيمها)
const SECRET_ENV_KEYS = [
  "MASTER_PASSWORD", "JWT_SECRET", "GROQ_API_KEY", "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
  "FIREBASE_PRIVATE_KEY", "BACKUP_PASSPHRASE", "BACKUP_REMOTE_SSH",
  "TWOFA_SECRET", "PII_KEY", "PII_HMAC_KEY",
];

// أسماء حقول حساسة في objects (case-insensitive)
const SENSITIVE_FIELD_PATTERNS = [
  /pass(word)?/i, /secret/i, /token/i, /api[-_]?key/i, /credential/i,
  /authorization/i, /cookie/i, /x-store-token/i, /x-master-token/i,
  /jwt/i, /private[-_]?key/i, /^otp$/i, /^pin$/i,
];

// قيم تطابق patterns حساسة (JWT, bcrypt hash, hex secret)
const VALUE_PATTERNS = [
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
  /^\$2[aby]\$[0-9]{2}\$[A-Za-z0-9./]{53}$/,              // bcrypt
  /^sk_(test|live)_[A-Za-z0-9]{20,}$/,                    // Stripe
  /^gsk_[A-Za-z0-9]{40,}$/,                               // Groq
  /^[a-f0-9]{64,}$/,                                      // hex secret 64+
];

const REDACTED = "<redacted>";

function _redactString(s) {
  if (typeof s !== "string" || !s) return s;
  let out = s;
  // 1) قيم الـ env الفعلية
  for (const key of SECRET_ENV_KEYS) {
    const val = process.env[key];
    if (val && val.length >= 6) {
      // إن كانت القيمة كاملة في النص → استبدلها
      out = out.split(val).join(REDACTED);
    }
  }
  // 2) Authorization: Bearer ...
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, `$1${REDACTED}`);
  // 3) رقم جوال كامل (E.164) — نحتفظ بآخر 4 أرقام
  out = out.replace(/(\+?9\d{2,3})(\d{6,8})(\d{2})/g, (_m, cc, mid, tail) => `${cc}***${tail}`);
  return out;
}

function _looksLikeSecret(value) {
  if (typeof value !== "string" || value.length < 8) return false;
  return VALUE_PATTERNS.some(re => re.test(value));
}

/**
 * يُنظّف object/array deep → يرجع نسخة آمنة للـ logging
 */
function sanitize(input, depth = 0) {
  if (depth > 8) return "[deep]"; // لا حلقات لا نهائية
  if (input == null) return input;
  if (typeof input === "string") {
    return _looksLikeSecret(input) ? REDACTED : _redactString(input);
  }
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (Array.isArray(input)) return input.map(v => sanitize(v, depth + 1));
  if (typeof input === "object") {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      const isSensitive = SENSITIVE_FIELD_PATTERNS.some(re => re.test(key));
      if (isSensitive) {
        out[key] = REDACTED;
      } else if (typeof value === "string" && _looksLikeSecret(value)) {
        out[key] = REDACTED;
      } else {
        out[key] = sanitize(value, depth + 1);
      }
    }
    return out;
  }
  return input;
}

/**
 * يُنظّف stack trace من file paths فيها أسرار محتملة
 */
function sanitizeStack(stack) {
  if (typeof stack !== "string") return stack;
  return _redactString(stack);
}

module.exports = { sanitize, sanitizeStack, REDACTED };
