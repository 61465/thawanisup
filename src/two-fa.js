/**
 * 2FA (TOTP) — RFC 6238 implementation بدون dependencies خارجية
 * متوافق مع Google Authenticator / Authy / Microsoft Authenticator
 * يستخدم Base32 + HMAC-SHA1 + 30s window
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TWOFA_FILE = path.join(__dirname, "..", "data", "twofa.json");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let out = "";
  let bits = 0, value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function base32Decode(str) {
  const clean = str.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  const bytes = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) |
               ((hmac[offset + 1] & 0xff) << 16) |
               ((hmac[offset + 2] & 0xff) << 8) |
                (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

function totp(secret, time = Date.now()) {
  const counter = Math.floor(time / 30_000);
  return hotp(secret, counter);
}

// returns: { ok: boolean, counter?: number }
function verifyTokenWithCounter(secret, token, window = 1) {
  if (!/^\d{6}$/.test(String(token || "").trim())) return { ok: false };
  const t = Math.floor(Date.now() / 30_000);
  // ندور دائماً على كل القيم لمنع timing leakage
  let matchedCounter = -1;
  for (let i = -window; i <= window; i++) {
    const candidate = hotp(secret, t + i);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(String(token).trim()))) {
      matchedCounter = t + i;
    }
  }
  if (matchedCounter < 0) return { ok: false };
  return { ok: true, counter: matchedCounter };
}

// legacy boolean-returning API
function verifyToken(secret, token, window = 1) {
  return verifyTokenWithCounter(secret, token, window).ok;
}

function otpAuthURL(secret, label, issuer = "ThawaniPlatform") {
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params.toString()}`;
}

function loadTwoFA() {
  if (!fs.existsSync(TWOFA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(TWOFA_FILE, "utf8")); } catch { return {}; }
}

function saveTwoFA(data) {
  fs.writeFileSync(TWOFA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function isEnabled(userId) {
  const data = loadTwoFA();
  return !!(data[userId] && data[userId].enabled);
}

function getSecret(userId) {
  const data = loadTwoFA();
  return data[userId]?.secret || null;
}

function setupSecret(userId, label) {
  const data = loadTwoFA();
  const secret = generateSecret();
  data[userId] = { secret, enabled: false, createdAt: new Date().toISOString(), label };
  saveTwoFA(data);
  return { secret, url: otpAuthURL(secret, label) };
}

function enableForUser(userId, token) {
  const data = loadTwoFA();
  if (!data[userId] || !data[userId].secret) return { ok: false, error: "No secret setup" };
  if (!verifyToken(data[userId].secret, token)) return { ok: false, error: "Invalid token" };
  data[userId].enabled = true;
  data[userId].enabledAt = new Date().toISOString();
  // 8 bytes hex = 64-bit entropy — أصعب بكثير من 32-bit
  data[userId].backupCodes = Array.from({ length: 8 }, () => crypto.randomBytes(8).toString("hex"));
  saveTwoFA(data);
  return { ok: true, backupCodes: data[userId].backupCodes };
}

function disableForUser(userId, token) {
  const data = loadTwoFA();
  if (!data[userId] || !data[userId].enabled) return { ok: false, error: "Not enabled" };
  if (!verifyToken(data[userId].secret, token) && !consumeBackupCode(userId, token)) {
    return { ok: false, error: "Invalid token" };
  }
  delete data[userId];
  saveTwoFA(data);
  return { ok: true };
}

function verifyLogin(userId, token) {
  const data = loadTwoFA();
  const entry = data[userId];
  if (!entry || !entry.enabled) return true;

  const r = verifyTokenWithCounter(entry.secret, token);
  if (r.ok) {
    // ⚠️ Replay protection: ارفض إعادة استخدام نفس counter
    if (entry.lastUsedCounter && r.counter <= entry.lastUsedCounter) {
      return false; // counter قديم — replay attempt
    }
    data[userId].lastUsedCounter = r.counter;
    saveTwoFA(data);
    return true;
  }
  return consumeBackupCode(userId, token);
}

function consumeBackupCode(userId, code) {
  const data = loadTwoFA();
  const entry = data[userId];
  if (!entry || !Array.isArray(entry.backupCodes)) return false;
  const idx = entry.backupCodes.indexOf(String(code).trim().toLowerCase());
  if (idx < 0) return false;
  entry.backupCodes.splice(idx, 1);
  saveTwoFA(data);
  return true;
}

module.exports = {
  generateSecret, totp, verifyToken, otpAuthURL,
  isEnabled, getSecret, setupSecret, enableForUser, disableForUser, verifyLogin,
};
