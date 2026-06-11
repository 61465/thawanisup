#!/usr/bin/env node
/**
 * Token Auto-Refresh
 * ─────────────────────────────────────────────────────────────────
 * يجدّد WHATSAPP_TOKEN في .env باستخدام Graph API قبل انتهائه.
 * - يفحص متى ينتهي Token الحالي عبر debug_token
 * - إذا بقي أقل من 7 أيام → يستبدله بـ Long-Lived جديد (60 يوماً)
 * - يُعيد كتابة .env بحفظ كل المتغيرات الأخرى
 *
 * استخدام:
 *   node scripts/refresh-token.js          ← فحص + تجديد إن لزم
 *   node scripts/refresh-token.js --force  ← تجديد فوري
 *
 * جدولة (موصى به): شغّله مرة كل أسبوع عبر Task Scheduler / cron
 *   Windows: schtasks /create /tn "BotTokenRefresh" /tr "node D:\path\refresh-token.js" /sc weekly
 *   Linux:   0 3 * * 0 cd /path && node scripts/refresh-token.js
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const ENV_PATH = path.join(__dirname, "..", ".env");

function readEnv() {
  const text = fs.readFileSync(ENV_PATH, "utf8");
  const map = {};
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) map[m[1]] = m[2];
  });
  return { text, map };
}

function writeEnv(originalText, key, newValue) {
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(originalText)
    ? originalText.replace(re, `${key}=${newValue}`)
    : originalText + `\n${key}=${newValue}\n`;
  fs.writeFileSync(ENV_PATH, next, "utf8");
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function main() {
  const force = process.argv.includes("--force");
  const { text, map } = readEnv();
  const token = map.WHATSAPP_TOKEN;
  const appId = process.env.APP_ID || "1690853381951579";
  const appSecret = process.env.APP_SECRET || map.META_APP_SECRET || "8e3316bd80dafa3fc16653aa5d300044";

  if (!token) {
    console.error("ERROR: WHATSAPP_TOKEN not found in .env");
    process.exit(1);
  }

  // Check current token expiration
  console.log("[*] Checking current token status...");
  const debug = await get(
    `https://graph.facebook.com/v19.0/debug_token?input_token=${token}&access_token=${appId}|${appSecret}`
  );

  if (!debug.data) {
    console.error("ERROR: Cannot inspect token:", JSON.stringify(debug).slice(0, 200));
    process.exit(1);
  }

  const expiresAt = debug.data.expires_at; // unix seconds, 0 = never
  const isValid = debug.data.is_valid;
  const now = Math.floor(Date.now() / 1000);

  if (!isValid) {
    console.error("ERROR: Token is invalid. Please generate a new short-lived token from Meta API Setup.");
    process.exit(1);
  }

  if (expiresAt === 0) {
    console.log("[OK] Token is permanent (no expiration). No refresh needed.");
    return;
  }

  const daysLeft = Math.floor((expiresAt - now) / 86400);
  console.log(`[*] Token expires in ${daysLeft} day(s) (${new Date(expiresAt * 1000).toISOString()})`);

  if (!force && daysLeft > 7) {
    console.log("[OK] Token still has >7 days. Skipping refresh. (use --force to refresh anyway)");
    return;
  }

  // Refresh: exchange for new long-lived token
  console.log("[*] Refreshing token (exchange for new Long-Lived)...");
  const refresh = await get(
    `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${token}`
  );

  if (!refresh.access_token) {
    console.error("ERROR: Refresh failed:", JSON.stringify(refresh).slice(0, 300));
    process.exit(1);
  }

  const newToken = refresh.access_token;
  const newExpiresIn = refresh.expires_in || 5184000; // ~60 days
  const newExpiryDate = new Date((now + newExpiresIn) * 1000).toISOString().slice(0, 10);

  // Write back
  writeEnv(text, "WHATSAPP_TOKEN", newToken);
  console.log(`[OK] Token refreshed successfully. New expiry: ~${newExpiryDate} (${Math.floor(newExpiresIn / 86400)} days)`);
  console.log("[!] Restart the bot server to load the new token.");
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
