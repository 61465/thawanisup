/**
 * Broadcast Queue — persistent FIFO queue للبث
 * يحلّ المشاكل التالية مقارنة بـ broadcast.js الحالي:
 *   1. لو السيرفر مات أثناء البث → resume من حيث توقف
 *   2. لو 5 متاجر بثّوا معاً → serialize لا تخنق Baileys ولا تستفز حظر
 *   3. تتبع progress للستور (10/50 مُرسَلة)
 *   4. cancel مع cleanup
 *
 * State on disk: data/broadcast-queue/{storeId}.json
 *   { storeId, message, recipients: [{phone, name, status}], startedAt, total, sent, failed }
 *
 * يعتمد على broadcast.js للـ low-level send + anti-ban delays.
 */
const fs   = require("fs");
const path = require("path");
const atomicFs = require("./atomic-fs");
const waMgr    = require("./whatsapp-manager");

const DATA_DIR  = path.join(__dirname, "..", "data");
const QUEUE_DIR = path.join(DATA_DIR, "broadcast-queue");

const DELAY_MIN_MS   = 8_000;
const DELAY_MAX_MS   = 15_000;
const MAX_FAILURES   = 3;
const COOLDOWN_HOURS = 6;
const COOLDOWN_FILE  = path.join(DATA_DIR, "broadcast-cooldown.json");

function _ensureDir() {
  if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function _qFile(storeId) {
  const safe = String(storeId).replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(QUEUE_DIR, `${safe}.json`);
}

function getState(storeId) {
  return atomicFs.readJsonSync(_qFile(storeId), null);
}

function _saveState(state) {
  _ensureDir();
  atomicFs.writeJsonSync(_qFile(state.storeId), state);
}

function _removeState(storeId) {
  try { fs.unlinkSync(_qFile(storeId)); } catch {}
}

function _loadCooldown() {
  return atomicFs.readJsonSync(COOLDOWN_FILE, {});
}

function _saveCooldown(d) {
  atomicFs.writeJsonSync(COOLDOWN_FILE, d);
}

function checkCooldown(storeId) {
  const d = _loadCooldown();
  const last = d[storeId]?.lastBroadcast;
  if (!last) return { ok: true };
  const hoursPassed = (Date.now() - new Date(last).getTime()) / 3600_000;
  if (hoursPassed >= COOLDOWN_HOURS) return { ok: true };
  return { ok: false, hoursLeft: Math.ceil(COOLDOWN_HOURS - hoursPassed) };
}

function _markCooldown(storeId, count) {
  const d = _loadCooldown();
  d[storeId] = { lastBroadcast: new Date().toISOString(), lastCount: count };
  _saveCooldown(d);
}

function _personalize(template, recipient) {
  const name = recipient.name && recipient.name.length > 1 ? recipient.name : "عميلنا الكريم";
  let msg = String(template || "").replace(/\{\{\s*name\s*\}\}/gi, name);
  if (!/إيقاف|stop|توقف/i.test(msg)) msg += "\n\n_للإيقاف: اكتب stop_";
  return msg;
}

// running queues (in-memory tracker لتجنّب double-start بعد resume)
const _running = new Set();

/**
 * enqueue — يبدأ البث (أو resume إذا كان مكسوراً)
 * @param {string} storeId
 * @param {string} messageTemplate
 * @param {Array<{phone, name}>} recipients - بعد فلتر anti-ban
 * @returns {{ ok, queued, willSend }}
 */
function enqueue(storeId, messageTemplate, recipients) {
  if (_running.has(storeId)) return { ok: false, error: "بث يعمل بالفعل لهذا المتجر" };

  const cd = checkCooldown(storeId);
  if (!cd.ok) return { ok: false, error: `cooldown ${cd.hoursLeft}h`, cooldownHoursLeft: cd.hoursLeft };

  const state = {
    storeId,
    message:    String(messageTemplate || ""),
    recipients: recipients.map(r => ({ phone: r.phone, name: r.name || "", status: "pending" })),
    startedAt:  new Date().toISOString(),
    total:      recipients.length,
    sent:       0,
    failed:     0,
    completed:  false,
  };
  _saveState(state);
  _process(storeId).catch(e => console.error("[broadcast-queue] processor error:", e.message));
  return { ok: true, queued: recipients.length, willSend: recipients.length };
}

async function _process(storeId) {
  if (_running.has(storeId)) return;
  _running.add(storeId);
  try {
    let state = getState(storeId);
    if (!state) return;

    // wa session check
    const status = waMgr.getStatus(storeId);
    if (status.status !== "open") {
      state.error = "wa_session_closed";
      state.completed = true;
      _saveState(state);
      return;
    }

    let consecutiveFails = 0;
    for (let i = 0; i < state.recipients.length; i++) {
      const r = state.recipients[i];
      if (r.status !== "pending") continue;

      // قبل كل send، أعد تحميل state لقبول cancel
      const fresh = getState(storeId);
      if (!fresh || fresh.cancelled) {
        if (state) { state.cancelled = true; state.completed = true; _saveState(state); }
        break;
      }
      state = fresh;

      const personalized = _personalize(state.message, r);
      const jid = r.phone + "@s.whatsapp.net";
      try {
        await waMgr.sendMessage(storeId, jid, personalized);
        r.status = "sent";
        state.sent++;
        consecutiveFails = 0;
      } catch (e) {
        r.status = "failed";
        r.error  = e.message;
        state.failed++;
        consecutiveFails++;
        console.warn(`[broadcast-queue] ${storeId}: ${r.phone}: ${e.message}`);
        if (consecutiveFails >= MAX_FAILURES) {
          state.error = "consecutive_failures";
          state.completed = true;
          _saveState(state);
          break;
        }
      }
      _saveState(state);

      // human-like delay (نتخطّى لو آخر رسالة)
      if (i < state.recipients.length - 1) {
        const delay = DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
        await new Promise(r => setTimeout(r, delay));
      }
    }

    state.completed = true;
    state.completedAt = new Date().toISOString();
    _saveState(state);
    _markCooldown(storeId, state.sent);
    console.log(`[broadcast-queue] ${storeId}: completed ${state.sent}/${state.total}`);
  } finally {
    _running.delete(storeId);
  }
}

function cancel(storeId) {
  const state = getState(storeId);
  if (!state) return { ok: false, error: "لا توجد رسالة قيد البث" };
  state.cancelled = true;
  _saveState(state);
  return { ok: true };
}

function getProgress(storeId) {
  const state = getState(storeId);
  if (!state) return null;
  return {
    storeId:     state.storeId,
    total:       state.total,
    sent:        state.sent,
    failed:      state.failed,
    pending:     state.recipients.filter(r => r.status === "pending").length,
    completed:   !!state.completed,
    cancelled:   !!state.cancelled,
    error:       state.error || null,
    startedAt:   state.startedAt,
    completedAt: state.completedAt || null,
  };
}

// Resume — يُستدعى عند startup السيرفر
async function resumeAll() {
  _ensureDir();
  const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith(".json"));
  let resumed = 0;
  for (const f of files) {
    const storeId = f.replace(/\.json$/, "");
    const state = getState(storeId);
    if (!state) continue;
    if (state.completed || state.cancelled) {
      // نظف القديم بعد 24h
      const age = Date.now() - new Date(state.startedAt).getTime();
      if (age > 24 * 60 * 60 * 1000) _removeState(storeId);
      continue;
    }
    resumed++;
    console.log(`[broadcast-queue] resuming ${storeId} (${state.sent}/${state.total})`);
    _process(storeId).catch(e => console.error(`resume ${storeId}:`, e.message));
  }
  if (resumed > 0) console.log(`[broadcast-queue] resumed ${resumed} queue(s)`);
  return resumed;
}

module.exports = {
  enqueue, cancel, getProgress, getState, resumeAll, checkCooldown,
  COOLDOWN_HOURS,
};
