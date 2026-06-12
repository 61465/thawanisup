const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const CLOUDFLARED = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
const URL_FILE = path.join(__dirname, "data", "tunnel-url.txt");

const proc = spawn(CLOUDFLARED, ["tunnel", "--url", "http://localhost:3000"], {
  stdio: ["ignore", "pipe", "pipe"],
});

function capture(data) {
  const text = data.toString();
  process.stdout.write(text);
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match) {
    const url = match[0];
    console.log("\n✅ Tunnel URL:", url);
    fs.writeFileSync(URL_FILE, url, "utf8");
  }
}

proc.stdout.on("data", capture);
proc.stderr.on("data", capture);

proc.on("exit", (code) => {
  console.log("cloudflared exited with code", code);
  process.exit(code || 0);
});
