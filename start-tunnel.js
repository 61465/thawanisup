/**
 * Cloudflare Tunnel launcher — يبدأ النفق ويحدّث PUBLIC_URL تلقائياً
 */
const { spawn } = require("child_process");
const fs   = require("fs");
const path = require("path");

const ENV_FILE  = path.join(__dirname, ".env");
const CF_BIN    = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
const PORT      = process.env.PORT || 3003;

console.log("🌐 Starting Cloudflare Tunnel...");

const cf = spawn(CF_BIN, ["tunnel", "--url", `http://localhost:${PORT}`], {
  stdio: ["ignore", "pipe", "pipe"],
});

function updateEnv(url) {
  try {
    let env = fs.readFileSync(ENV_FILE, "utf8");
    env = env.replace(/^PUBLIC_URL=.*/m, `PUBLIC_URL=${url}`);
    fs.writeFileSync(ENV_FILE, env);
    console.log(`✅ PUBLIC_URL updated → ${url}`);
    // Restart the bot so it picks up the new URL
    const { execSync } = require("child_process");
    try { execSync("pm2 restart whatsapp-bot", { stdio: "ignore" }); } catch {}
  } catch (e) {
    console.error("Failed to update .env:", e.message);
  }
}

function extractUrl(line) {
  const m = line.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
  return m ? m[0] : null;
}

let urlFound = false;

cf.stderr.on("data", (d) => {
  const line = d.toString();
  process.stdout.write(line);
  if (!urlFound) {
    const url = extractUrl(line);
    if (url) { urlFound = true; updateEnv(url); }
  }
});

cf.stdout.on("data", (d) => {
  const line = d.toString();
  process.stdout.write(line);
  if (!urlFound) {
    const url = extractUrl(line);
    if (url) { urlFound = true; updateEnv(url); }
  }
});

cf.on("exit", (code) => {
  console.log(`⚠️  cloudflared exited (${code}) — PM2 will restart`);
  process.exit(code || 1);
});

process.on("SIGINT",  () => cf.kill());
process.on("SIGTERM", () => cf.kill());
