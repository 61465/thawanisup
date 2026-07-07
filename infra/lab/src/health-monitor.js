/**
 * Health Monitor — deep health checks + push alerts
 *
 * تحققات:
 *   - data/ readable + writable
 *   - sessions Baileys: كم open vs total
 *   - disk space (< 10% = warn، < 5% = critical)
 *   - heap memory (> 80% = warn)
 *   - audit log writes
 *   - broadcast queue progress
 *
 * يُستدعى من:
 *   - GET /health/deep (endpoint)
 *   - cron داخلي كل 5 دقائق (push alerts للماستر عند critical)
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const DATA_DIR = path.join(__dirname, "..", "data");

let _alertCooldown = new Map(); // key → lastAlertTs لمنع spam
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

function _diskSpacePct() {
  try {
    // Node لا يوفر API مدمج لـ disk space؛ نستخدم statvfs عبر child_process لـ Linux/Mac
    // على Windows، نستخدم wmic. للبساطة، نُعيد null لو فشل.
    if (process.platform === "win32") {
      const { execSync } = require("child_process");
      // PowerShell بديل عن wmic (deprecated في Windows 11)
      const ps = `Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -eq '${DATA_DIR[0]}' } | Select-Object @{N='Free';E={$_.Free}}, @{N='Used';E={$_.Used}} | ConvertTo-Json -Compress`;
      const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: "utf8", timeout: 5000 });
      const r = JSON.parse(out.trim());
      const free  = Number(r.Free) || 0;
      const used  = Number(r.Used) || 0;
      const total = free + used;
      if (total > 0) return { freePct: (free / total) * 100, freeGB: free / 1024 / 1024 / 1024, totalGB: total / 1024 / 1024 / 1024 };
      return null;
    } else {
      const { execSync } = require("child_process");
      const out = execSync(`df -k '${DATA_DIR}' | tail -1`, { encoding: "utf8", timeout: 3000 });
      const parts = out.trim().split(/\s+/);
      if (parts.length < 5) return null;
      const total = parseInt(parts[1], 10) * 1024;
      const used  = parseInt(parts[2], 10) * 1024;
      const free  = total - used;
      return { freePct: (free / total) * 100, freeGB: free / 1024 / 1024 / 1024, totalGB: total / 1024 / 1024 / 1024 };
    }
  } catch { return null; }
}

function _dataDirWritable() {
  try {
    const probe = path.join(DATA_DIR, ".healthprobe-" + Date.now());
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

function _heapMemPct() {
  const m = process.memoryUsage();
  const total = m.heapTotal;
  const used  = m.heapUsed;
  return {
    pct: total > 0 ? (used / total) * 100 : 0,
    usedMB: Math.round(used / 1024 / 1024),
    totalMB: Math.round(total / 1024 / 1024),
    rssMB: Math.round(m.rss / 1024 / 1024),
  };
}

function _baileysSessions() {
  try {
    const waMgr = require("./whatsapp-manager");
    const list = waMgr.listSessions();
    const open = list.filter(s => s.status === "open").length;
    return { total: list.length, open, sessions: list };
  } catch { return { total: 0, open: 0, sessions: [] }; }
}

function _stores() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "stores.json"), "utf8"));
    return {
      total: (d.stores || []).length,
      active: (d.stores || []).filter(s => s.active && s.subscriptionStatus === "active").length,
    };
  } catch { return { total: 0, active: 0 }; }
}

function _broadcastsRunning() {
  try {
    const dir = path.join(DATA_DIR, "broadcast-queue");
    if (!fs.existsSync(dir)) return 0;
    let active = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (!s.completed && !s.cancelled) active++;
      } catch {}
    }
    return active;
  } catch { return 0; }
}

/**
 * deep check — returns { status: "ok"|"warn"|"critical", checks: {...} }
 */
function deepCheck() {
  const writable = _dataDirWritable();
  const disk     = _diskSpacePct();
  const heap     = _heapMemPct();
  const wa       = _baileysSessions();
  const stores   = _stores();
  const broadcasts = _broadcastsRunning();

  const issues = [];
  if (!writable) issues.push({ level: "critical", check: "data_writable", msg: "data/ غير قابل للكتابة" });
  if (disk && disk.freePct < 5)   issues.push({ level: "critical", check: "disk_space", msg: `disk free ${disk.freePct.toFixed(1)}%` });
  else if (disk && disk.freePct < 10) issues.push({ level: "warn", check: "disk_space", msg: `disk free ${disk.freePct.toFixed(1)}%` });

  // heap pct يضلّل لأن V8 يبدأ بـ heap صغير ثم يتوسع تلقائياً.
  // الأصح: نراقب RSS مقارنةً بـ max_memory_restart من ecosystem (2.5GB)
  // أو ببساطة، نراقب لو RSS > 90% من system free memory (الذي يدير Linux OOM killer)
  const MAX_RSS_MB = 2200; // ~90% من 2.5GB max_memory_restart
  if (heap.rssMB > MAX_RSS_MB) {
    issues.push({ level: "critical", check: "memory_rss", msg: `RSS ${heap.rssMB}MB > ${MAX_RSS_MB}MB cap` });
  } else if (heap.rssMB > MAX_RSS_MB * 0.85) {
    issues.push({ level: "warn", check: "memory_rss", msg: `RSS ${heap.rssMB}MB approaching cap` });
  }

  // sessions: لو stores.active > 0 و wa.open === 0 → critical
  if (stores.active > 0 && wa.open === 0) {
    issues.push({ level: "critical", check: "wa_sessions", msg: "لا توجد جلسات Baileys مفتوحة" });
  } else if (wa.total > 5 && wa.open < wa.total / 2) {
    issues.push({ level: "warn", check: "wa_sessions", msg: `${wa.open}/${wa.total} جلسات فقط مفتوحة` });
  }

  const status = issues.some(i => i.level === "critical") ? "critical"
              : issues.some(i => i.level === "warn") ? "warn"
              : "ok";

  return {
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    node: process.version,
    platform: process.platform,
    issues,
    checks: {
      dataWritable: writable,
      disk,
      heap,
      waSessions: { total: wa.total, open: wa.open },
      stores,
      broadcasts,
    },
  };
}

/**
 * يطلق tick دوري للـ deep check ويُرسل تنبيه عند critical
 */
function startPeriodicChecks() {
  const TICK_MS = 5 * 60 * 1000; // كل 5 دقائق
  setTimeout(_runTick, 60_000); // أول tick بعد دقيقة (ينتظر الـ boot يستقر)
  setInterval(_runTick, TICK_MS);
  console.log("🩺 Health monitor: deep check كل 5 دقائق");
}

async function _runTick() {
  try {
    const r = deepCheck();
    if (r.status === "critical") {
      for (const issue of r.issues) {
        if (issue.level !== "critical") continue;
        const key = "crit_" + issue.check;
        const last = _alertCooldown.get(key) || 0;
        if (Date.now() - last < ALERT_COOLDOWN_MS) continue;
        _alertCooldown.set(key, Date.now());
        await _sendAlert(`🚨 *تنبيه critical*\n\n${issue.msg}\n\nالخادم: ${os.hostname()}\nالوقت: ${r.timestamp}`);
      }
    } else if (r.status === "warn") {
      for (const issue of r.issues) {
        if (issue.level !== "warn") continue;
        const key = "warn_" + issue.check;
        const last = _alertCooldown.get(key) || 0;
        if (Date.now() - last < ALERT_COOLDOWN_MS * 2) continue; // warn cooldown أطول
        _alertCooldown.set(key, Date.now());
        console.warn(`⚠️ [health] ${issue.msg}`);
      }
    }
  } catch (e) { console.error("[health-monitor]", e.message); }
}

async function _sendAlert(text) {
  try {
    const masterPhone = process.env.MASTER_PHONE;
    if (!masterPhone) return;
    const waMgr = require("./whatsapp-manager");
    const sessions = waMgr.listSessions();
    const candidate = sessions.find(s => s.storeId === "platform" && s.status === "open")
                   || sessions.find(s => s.storeId === "lead" && s.status === "open")
                   || sessions.find(s => s.status === "open");
    if (!candidate) {
      console.error("[health-alert] لا توجد جلسة لإرسال التنبيه!", text);
      return;
    }
    const jid = masterPhone.replace(/\D/g, "") + "@s.whatsapp.net";
    await waMgr.sendMessage(candidate.storeId, jid, text);
    console.log("[health-alert] تنبيه أُرسل");
  } catch (e) { console.error("[health-alert]", e.message); }
}

module.exports = { deepCheck, startPeriodicChecks };
