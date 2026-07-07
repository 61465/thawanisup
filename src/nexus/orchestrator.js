/**
 * NEXUS Orchestrator — الـ Maestro
 *
 * أي استدعاء لـ NEXUS يمر من هنا:
 *   nexus.run('debugger', { task: '...', context: {...} })
 *
 * يفعل:
 *   1. يبني context للوكيل (يقرأ الملفات اللي يحتاجها)
 *   2. يستدعي الوكيل
 *   3. يسجّل النتيجة في logs + memory
 *   4. يرجع للمستدعي
 */

const fs   = require("fs");
const path = require("path");
const fileReader = require("./file-reader");
const llm     = require("./llm-router");
const memory  = require("./memory");

const DATA_DIR = path.join(__dirname, "..", "..", "data", "nexus");
const LOG_FILE = path.join(DATA_DIR, "runs.jsonl");

// ─── Agent registry ────────────────────────────────────────────────────
const AGENTS = {};

function registerAgent(name, handler) {
  AGENTS[name] = handler;
  console.log(`[nexus] registered agent: ${name}`);
}

// ─── Run ───────────────────────────────────────────────────────────────
async function run(agentName, input = {}) {
  const agent = AGENTS[agentName];
  if (!agent) throw new Error(`Unknown NEXUS agent: ${agentName}`);

  const runId = `nx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  console.log(`🧠 [nexus] start ${agentName} (${runId})`);

  try {
    // كل وكيل يستلم نفس الـ API
    const result = await agent({
      input,
      runId,
      llm,
      reader: fileReader,
      memory,
      log: (msg) => console.log(`   [${agentName}] ${msg}`),
    });

    const duration = Date.now() - startedAt;
    _writeLog({ runId, agent: agentName, ok: true, duration, input, result });
    console.log(`✅ [nexus] ${agentName} done in ${duration}ms`);
    return result;
  } catch (e) {
    const duration = Date.now() - startedAt;
    _writeLog({ runId, agent: agentName, ok: false, duration, error: e.message, input });
    console.error(`❌ [nexus] ${agentName} failed: ${e.message}`);
    throw e;
  }
}

// ─── Auto-load agents from agents/ ────────────────────────────────────
function loadAgents() {
  const dir = path.join(__dirname, "agents");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".js"));
  for (const f of files) {
    const name = f.replace(".js", "");
    try {
      const mod = require(path.join(dir, f));
      const handler = typeof mod === "function" ? mod : mod.handler;
      if (typeof handler !== "function") {
        console.warn(`[nexus] agent ${name} has no handler export`);
        continue;
      }
      registerAgent(name, handler);
    } catch (e) {
      console.warn(`[nexus] failed to load agent ${name}:`, e.message);
    }
  }
}

// ─── Log writer ────────────────────────────────────────────────────────
function _writeLog(entry) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

// ─── Public API ────────────────────────────────────────────────────────
function listAgents() { return Object.keys(AGENTS); }

function getStats() {
  return {
    agents: listAgents(),
    llm: llm.getStats(),
    memory: { /* future */ },
  };
}

// Auto-load on require
loadAgents();

module.exports = {
  run,
  listAgents,
  registerAgent,
  getStats,
};
