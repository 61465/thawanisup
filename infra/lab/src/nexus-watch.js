/**
 * 🧠 NEXUS Watch — صيانة ذكية مستمرة للمنصة
 *
 * يقدّم 3 خدمات تُستدعى من لوحة الماستر:
 *
 *   1. healthDigest() — تحليل alerts/errors آخر 24 ساعة + توصيات
 *   2. codeReview(files) — مراجعة ملفات معينة قبل النشر
 *   3. businessInsights(storeId) — تحليل أداء متجر + اقتراح تحسينات
 *
 * كلها تعمل عبر NEXUS orchestrator، فتستفيد من routing الذكي بين Groq/Claude/Gemini.
 */

const fs   = require("fs");
const path = require("path");
const DATA_DIR = path.join(__dirname, "..", "data");

function _safeRequire() {
  try { return require("./nexus/orchestrator"); }
  catch { return null; }
}

// ─── 1. Health Digest ──────────────────────────────────────────────
async function healthDigest() {
  const nexus = _safeRequire();
  if (!nexus) return { ok: false, error: "NEXUS not available" };

  // اقرأ آخر 200 alert + errors اليوم
  const today = new Date().toISOString().slice(0, 10);
  const ym    = today.slice(0, 7);
  const alertsFile = path.join(DATA_DIR, "alerts", `${today}.jsonl`);
  const errorsFile = path.join(DATA_DIR, `errors-${ym}.jsonl`);

  const readTail = (f, n = 200) => {
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).slice(-n);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };
  const alerts = readTail(alertsFile, 100);
  const errors = readTail(errorsFile, 100);

  if (!alerts.length && !errors.length) {
    return { ok: true, summary: "✅ لا alerts أو errors في الـ 24 ساعة الماضية", findings: [], recommendations: [] };
  }

  // استخدم debugger agent الموجود
  try {
    const result = await nexus.run("debugger", {
      task: "تحليل صحة المنصة",
      alerts: alerts.slice(-30),
      errors: errors.slice(-30),
      context: "آخر 24 ساعة من تشغيل thawani-v2 production",
    });
    return { ok: true, ...result, alertsCount: alerts.length, errorsCount: errors.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── 2. Code Review ────────────────────────────────────────────────
async function codeReview(files = []) {
  const nexus = _safeRequire();
  if (!nexus) return { ok: false, error: "NEXUS not available" };
  if (!files.length) return { ok: false, error: "أرسل قائمة ملفات للمراجعة" };

  try {
    const result = await nexus.run("code-reviewer", { files });
    return { ok: true, ...result };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ─── 3. Business Insights ──────────────────────────────────────────
async function businessInsights(storeId) {
  const nexus = _safeRequire();
  if (!nexus) return { ok: false, error: "NEXUS not available" };
  if (!storeId) return { ok: false, error: "storeId مطلوب" };

  try {
    const result = await nexus.run("data-analyst", { storeId });
    return { ok: true, ...result };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ─── 4. Available Agents ───────────────────────────────────────────
function getAgents() {
  const nexus = _safeRequire();
  if (!nexus) return [];
  try { return nexus.listAgents(); } catch { return []; }
}

function getStats() {
  const nexus = _safeRequire();
  if (!nexus) return { available: false };
  try { return { available: true, ...nexus.getStats() }; }
  catch (e) { return { available: false, error: e.message }; }
}

module.exports = {
  healthDigest,
  codeReview,
  businessInsights,
  getAgents,
  getStats,
};
