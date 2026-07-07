/**
 * Audit Log — يسجّل كل عملية حساسة (login, password change, admin actions, data access)
 * Format: JSONL (newline-delimited JSON) — قابل للقراءة بـ jq وللإلحاق الذرّي
 * Retention: 90 يوم (تدوير شهري). Files: data/audit/{YYYY-MM}.jsonl
 */
const fs = require("fs");
const path = require("path");
const { sanitize } = require("./log-sanitizer");

const AUDIT_DIR = path.join(__dirname, "..", "data", "audit");
if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });

// نستخدم sanitizer الموحّد الآن — يحجب env values + JWT + bcrypt + قيم باسم حساس
function redact(obj) {
  return sanitize(obj);
}

function currentFile() {
  const d = new Date();
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return path.join(AUDIT_DIR, `${ym}.jsonl`);
}

/**
 * @param {object} entry
 *   - actor: { type: 'master'|'store'|'customer'|'system', id?: string }
 *   - action: string (e.g. 'login.success', 'login.fail', 'password.change', 'order.complete')
 *   - target: { type: string, id?: string } (e.g. {type:'store', id:'XYZ'})
 *   - meta: object (extra context — will be redacted automatically)
 *   - req: Express req (optional — extracts IP, UA)
 */
function audit(entry, req) {
  try {
    const line = {
      ts: new Date().toISOString(),
      // trace_id يربط audit events بنفس الـ HTTP request — مفيد لـ debugging سلسلة الأحداث
      trace_id: entry.trace_id || req?.traceId || null,
      actor: entry.actor || { type: "system" },
      action: entry.action,
      target: entry.target || null,
      ok: entry.ok !== false,
      ip: req ? (req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || req.connection?.remoteAddress || null) : null,
      ua: req ? (req.headers["user-agent"]?.slice(0, 200) || null) : null,
      meta: entry.meta ? redact(entry.meta) : null,
    };
    fs.appendFileSync(currentFile(), JSON.stringify(line) + "\n", "utf8");
  } catch (e) {
    console.error("[audit] failed:", e.message);
  }
}

function listAuditFiles() {
  if (!fs.existsSync(AUDIT_DIR)) return [];
  return fs.readdirSync(AUDIT_DIR).filter(f => f.endsWith(".jsonl")).sort().reverse();
}

function readAuditMonth(yearMonth, opts = {}) {
  const f = path.join(AUDIT_DIR, `${yearMonth}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
  let entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (opts.action) entries = entries.filter(e => e.action.startsWith(opts.action));
  if (opts.actor) entries = entries.filter(e => e.actor?.id === opts.actor || e.actor?.type === opts.actor);
  if (opts.failedOnly) entries = entries.filter(e => e.ok === false);
  if (opts.limit) entries = entries.slice(-opts.limit);
  return entries;
}

function cleanOldAuditFiles(retentionMonths = 6) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);
  const cutoffStr = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}`;
  const removed = [];
  for (const f of listAuditFiles()) {
    const ym = f.replace(".jsonl", "");
    if (ym < cutoffStr) {
      fs.unlinkSync(path.join(AUDIT_DIR, f));
      removed.push(ym);
    }
  }
  return removed;
}

module.exports = { audit, listAuditFiles, readAuditMonth, cleanOldAuditFiles };
