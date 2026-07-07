/**
 * WhatsApp Manager — إدارة جلسات Baileys لجميع المتاجر
 * كل متجر = جلسة منفصلة محفوظة في data/sessions/{storeId}/
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  jidNormalizedUser,
  getAggregateVotesInPollMessage,
  decryptPollVote,
} = require("@whiskeysockets/baileys");
const log = require("./logger");
const { Boom }       = require("@hapi/boom");
const pino           = require("pino");
const fs             = require("fs");
const path           = require("path");
const banProtection  = require("./ban-protection");
const { randomUUID, randomBytes, createHash } = require("crypto");
const jwt = require("jsonwebtoken");

if (!process.env.JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET missing in .env — refusing to start with insecure default");
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 48) {
  console.error("[FATAL] JWT_SECRET must be at least 48 chars (use crypto.randomBytes(64).toString('hex'))");
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

// DEBUG_POLLS=1 لإظهار تفاصيل فشل فك تشفير الاستطلاعات (طبيعي يفشل كثيراً)
const DEBUG_POLLS = process.env.DEBUG_POLLS === "1";

// حد محاولات إعادة الاتصال قبل إيقاف الجلسة (تجنب QR-loop لانهائي)
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS      = 5_000;
const RECONNECT_MAX_MS       = 5 * 60_000;
// بعد paused، لا تُحاول إعادة الـ boot قبل هذه المدة (يحمي event-loop من
// متاجر معلّقة لم تربط واتساب عند كل pm2 restart بسبب cf-tunnel)
const PAUSE_COOLDOWN_MS      = 6 * 60 * 60 * 1000;

const DATA_DIR    = path.join(__dirname, "..", "data");
const SESSION_DIR = path.join(DATA_DIR, "sessions");
const PAUSE_FILE  = path.join(DATA_DIR, "session-pause.json");

// storeId → timestamp UNTIL which boot should skip (مستديم عبر restarts)
const pausedUntil = new Map();

// ─── Sent-Message Cache (للـ Baileys getMessage callback) ─────────────────────
// Baileys يطلب الرسالة الأصلية عند فشل decryption لإعادة التشفير.
// لو أعدنا فارغ → الرسالة عالقة في retry loop → تأخر دقائق (السبب الجذري للتأخر)
// لذا نحفظ آخر 500 رسالة مرسلة لكل متجر مع TTL 24h
const _sentMessages = new Map(); // storeId → Map<msgId, messageContent>
const _SENT_MAX = 500;

// 🛡️ tracker لآخر إرسال بوت لكل JID لكل متجر — يمنع owner-reply-handoff من رد البوت نفسه
// مفتاح "storeId|jid" → timestamp آخر send
// (يحل race condition: fromMe event يفيرها قبل ما نلحق نـcache الـID)
const _lastBotSendTo = new Map();
const _BOT_ECHO_WINDOW_MS = 8_000; // 8 ثواني بعد أي bot send، أي fromMe لنفس الـJID = echo
function _markBotSent(storeId, jid) {
  if (!storeId || !jid) return;
  _lastBotSendTo.set(storeId + "|" + String(jid), Date.now());
  // cleanup دوري (كل 100 إضافة)
  if (_lastBotSendTo.size > 500) {
    const cutoff = Date.now() - 60_000;
    for (const [k, ts] of _lastBotSendTo) if (ts < cutoff) _lastBotSendTo.delete(k);
  }
}
function _isRecentBotEcho(storeId, jid) {
  const t = _lastBotSendTo.get(storeId + "|" + String(jid));
  return t && (Date.now() - t < _BOT_ECHO_WINDOW_MS);
}

function _cacheSentMessage(storeId, msgId, content) {
  if (!msgId || !content) return;
  let store = _sentMessages.get(storeId);
  if (!store) { store = new Map(); _sentMessages.set(storeId, store); }
  store.set(msgId, content);
  // tracker للحجم — احذف الأقدم لو تجاوز الحد
  if (store.size > _SENT_MAX) {
    const firstKey = store.keys().next().value;
    store.delete(firstKey);
  }
}

function _getCachedSentMessage(storeId, msgId) {
  return _sentMessages.get(storeId)?.get(msgId);
}
try {
  if (fs.existsSync(PAUSE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(PAUSE_FILE, "utf8"));
    const now   = Date.now();
    for (const [id, ts] of Object.entries(saved)) {
      if (typeof ts === "number" && ts > now) pausedUntil.set(id, ts);
    }
  }
} catch {}

function _savePauseMap() {
  try {
    const obj = {};
    const now = Date.now();
    pausedUntil.forEach((ts, id) => { if (ts > now) obj[id] = ts; });
    fs.writeFileSync(PAUSE_FILE, JSON.stringify(obj), "utf8");
  } catch {}
}

function _setPause(storeId, durationMs = PAUSE_COOLDOWN_MS) {
  pausedUntil.set(storeId, Date.now() + durationMs);
  _savePauseMap();
}

function _clearPause(storeId) {
  if (pausedUntil.delete(storeId)) _savePauseMap();
}

const logger = pino({ level: "silent" });

// storeId → { sock, status, phone, pairingCode, pairingCodeExp, reconnectTimer, ttlTimer, reconnectAttempts }
const sessions = new Map();

// ─── Web Button Sessions ───────────────────────────────────────────────────────
// token → { storeId, userFrom, options:[{id,title,description?}], color, exp }
const buttonSessions = new Map();

// ─── Web Order Sessions — JWT-based (survives restarts, no in-memory state) ───

// ─── Poll Vote Map ─────────────────────────────────────────────────────────────
// pollMsgId → { storeId, from, options:[{optionName}], valueToId:{text→btnId}, secretB64 }
const POLL_MAP_FILE = path.join(DATA_DIR, "polls.json");
const pollVoteMap   = new Map();

// Load persisted polls on startup (survive server restarts)
try {
  if (fs.existsSync(POLL_MAP_FILE)) {
    const saved = JSON.parse(fs.readFileSync(POLL_MAP_FILE, "utf8"));
    const now   = Date.now();
    for (const [id, entry] of Object.entries(saved)) {
      if (entry.exp > now) pollVoteMap.set(id, entry);
    }
  }
} catch {}

function _savePollMap() {
  try {
    const obj = {};
    pollVoteMap.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(POLL_MAP_FILE, JSON.stringify(obj), "utf8");
  } catch {}
}

// ─── Short Token Map: slug 5 حرف → JWT (لأقصر URL ممكن) ──────────────────────
// 4 chars base62 = 62^4 ≈ 14.7 مليون تركيبة → آمن جداً مع TTL 24h
// الـ slug يجعل الرابط ~37 char بدل ~285 char لو استخدمنا JWT مباشرة
// ⭐ Persisted في data/web-order-tokens.json — يبقى عبر pm2 reload/restart
const shortTokens = new Map(); // slug → { jwt, exp }
const SHORT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// 🛡️ زدنا الطول من 4 لـ 6 → 62^6 = 56.8 مليار احتمال (يزيل خطر التصادم بين متاجر)
const SHORT_SLUG_LEN     = 6;
const SHORT_TOKENS_FILE  = path.join(DATA_DIR, "web-order-tokens.json");

// Load persisted tokens on startup (survive pm2 reload/restart)
try {
  if (fs.existsSync(SHORT_TOKENS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(SHORT_TOKENS_FILE, "utf8"));
    const now   = Date.now();
    let loaded = 0, dropped = 0;
    for (const [slug, entry] of Object.entries(saved)) {
      if (entry && entry.exp && entry.exp > now && entry.jwt) {
        shortTokens.set(slug, entry);
        loaded++;
      } else {
        dropped++;
      }
    }
    if (loaded || dropped) console.log(`[short-tokens] loaded ${loaded}, dropped ${dropped} expired`);
  }
} catch (e) { console.warn("[short-tokens] load failed:", e.message); }

// Debounced save to avoid I/O spam under heavy load
let _shortTokensSaveTimer = null;
function _saveShortTokens() {
  if (_shortTokensSaveTimer) return;
  _shortTokensSaveTimer = setTimeout(() => {
    _shortTokensSaveTimer = null;
    try {
      const obj = {};
      shortTokens.forEach((v, k) => { obj[k] = v; });
      const tmp = SHORT_TOKENS_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
      fs.renameSync(tmp, SHORT_TOKENS_FILE);
    } catch (e) { console.warn("[short-tokens] save failed:", e.message); }
  }, 300);
}

function _makeShortSlug() {
  // base62: حروف+أرقام
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  const buf = randomBytes(SHORT_SLUG_LEN);
  for (let i = 0; i < SHORT_SLUG_LEN; i++) s += chars[buf[i] % chars.length];
  return s;
}

function createWebOrderToken(storeId, from, extra) {
  const sess     = sessions.get(storeId);
  const botPhone = jidNormalizedUser(sess?.sock?.user?.id || "").split("@")[0];
  // امتداد الـ TTL لـ dine-in: ثابتة لمدة 90 يوم (طاولة مطعم لا تتغير)
  const isDineIn = !!(extra && extra.dine_in);
  const ttlMs    = isDineIn ? 90 * 24 * 60 * 60 * 1000 : SHORT_TOKEN_TTL_MS;
  const expiresIn = isDineIn ? "90d" : "24h";
  const payload  = { storeId, from, botPhone, ...(extra || {}) };
  const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn });
  // 🛡️ أنشئ slug قصير — حماية collision: نتحقق أن الـ slug ليس مأخوذاً + ليس منتهي الصلاحية
  let slug;
  let attempts = 0;
  do {
    slug = _makeShortSlug();
    attempts++;
    // لو الـ slug موجود لكن منتهي → احذفه وأعد استخدامه
    const existing = shortTokens.get(slug);
    if (existing && existing.exp < Date.now()) {
      shortTokens.delete(slug);
      break; // نستخدم الـ slug (لأنه منتهي بأمان)
    }
    if (attempts > 20) {
      // fallback نادر: أضف timestamp للـ slug لضمان uniqueness
      slug = _makeShortSlug() + Date.now().toString(36).slice(-3);
      break;
    }
  } while (shortTokens.has(slug));
  shortTokens.set(slug, { jwt: jwtToken, exp: Date.now() + ttlMs, storeId }); // 🛡️ storeId مخزّن للتحقق
  _saveShortTokens();
  // نظافة دورية كل دقيقة
  if (!_shortTokenSweeper) {
    _shortTokenSweeper = setInterval(() => {
      const now = Date.now();
      let removed = 0;
      for (const [k, v] of shortTokens.entries()) {
        if (v.exp < now) { shortTokens.delete(k); removed++; }
      }
      if (removed) _saveShortTokens();
    }, 60_000).unref?.();
  }
  return slug;
}
let _shortTokenSweeper = null;

function getWebOrderSession(slugOrJwt) {
  // ادعم الاثنين: JWT الكامل (legacy) أو slug القصير
  let token = slugOrJwt;
  const entry = shortTokens.get(slugOrJwt);
  if (entry) {
    if (entry.exp < Date.now()) {
      shortTokens.delete(slugOrJwt);
      _saveShortTokens();
      return null;
    }
    token = entry.jwt;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return {
      storeId: payload.storeId,
      from: payload.from,
      botPhone: payload.botPhone,
      dine_in: !!payload.dine_in,
      table: payload.table || null,
      tableLabel: payload.tableLabel || null,
      section:    payload.section    || "",
      area:       payload.area       || "",
      tableNote:  payload.tableNote  || "",
    };
  } catch {
    return null;
  }
}

function clearWebOrderSession(slugOrJwt) {
  if (shortTokens.delete(slugOrJwt)) _saveShortTokens();
  // JWT tokens cannot be revoked otherwise — expiry handles it
}

function makeButtonToken(storeId, userFrom, options, color) {
  return _makeButtonToken(storeId, userFrom, options, color);
}

function _makeButtonToken(storeId, userFrom, options, color) {
  const token = randomUUID().replace(/-/g, "").slice(0, 20);
  const exp   = Date.now() + 10 * 60 * 1000; // 10 minutes
  buttonSessions.set(token, { storeId, userFrom, options, color: color || "#25d366", exp });
  setTimeout(() => buttonSessions.delete(token), 10 * 60 * 1000);
  return token;
}

function getButtonSession(token) {
  const sess = buttonSessions.get(token);
  if (!sess || sess.exp < Date.now()) return null;
  return sess;
}

function clearButtonSession(token) {
  buttonSessions.delete(token);
}

// ─── Action Sessions (one-shot link triggers) ─────────────────────────────────
// token → { storeId, from, buttonId, exp }
const actionSessions = new Map();

function makeActionToken(storeId, from, buttonId) {
  const token = randomUUID().replace(/-/g, "").slice(0, 16);
  const exp   = Date.now() + 10 * 60 * 1000;
  actionSessions.set(token, { storeId, from, buttonId, exp });
  setTimeout(() => actionSessions.delete(token), 10 * 60 * 1000);
  return token;
}

function getActionSession(token) {
  const sess = actionSessions.get(token);
  if (!sess || sess.exp < Date.now()) return null;
  return sess;
}

function clearActionSession(token) {
  actionSessions.delete(token);
}

// ─── Try-slot lifecycle ───────────────────────────────────────────────────────
const TRY_SLOT_PATTERN = /^(try_\d+|owner_try)$/;
const TRY_TTL_MS       = 45 * 60 * 1000;

function scheduleTryTTL(storeId) {
  if (!TRY_SLOT_PATTERN.test(storeId)) return;
  const session = sessions.get(storeId);
  if (!session) return;
  if (session.ttlTimer) clearTimeout(session.ttlTimer);
  session.ttlTimer = setTimeout(async () => {
    console.log(`⏰ [${storeId}] TTL expired — clearing slot`);
    const s = sessions.get(storeId);
    if (!s) return;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    try { await s.sock?.logout(); } catch {}
    try { fs.rmSync(path.join(SESSION_DIR, storeId), { recursive: true, force: true }); } catch {}
    sessions.delete(storeId);
  }, TRY_TTL_MS);
}

// ─── Global message handler (set by server.js) ───────────────────────────────
let globalMessageHandler = null;
let globalPollFallback   = null;   // async (storeId, from, pollData) → btnId | null

function setMessageHandler(fn) { globalMessageHandler = fn; }
function setPollFallback(fn)   { globalPollFallback   = fn; }

// ─── Poll vote decoder ────────────────────────────────────────────────────────
function _sha256(buf) {
  return createHash("sha256").update(buf).digest();
}

function _matchSelectedToOptions(selectedHashes, options) {
  for (const opt of options) {
    const name    = opt.optionName || "";
    const nameHash = _sha256(Buffer.from(name, "utf8"));
    for (const sel of selectedHashes) {
      const s = Buffer.isBuffer(sel) ? sel : Buffer.from(sel);
      if (s.equals(nameHash) || s.toString() === nameHash.toString()) return name;
    }
  }
  return null;
}

function _decodePollVote(pollData, vote, voterJidFull) {
  const pollMsgId   = pollData.pollMsgId;
  const creatorJid  = pollData.creatorJid || "";
  const creatorLid  = pollData.creatorLid  || "";
  const pollEncKey  = pollData.secretB64 ? Buffer.from(pollData.secretB64, "base64") : null;

  // ── Strategy 1: decryptPollVote — جرب كل تركيبة (creator × voter) ────────────
  const encPayload = vote?.encPayload;
  const encIv      = vote?.encIv;
  if (encPayload && encIv && pollEncKey && pollMsgId) {
    // voter: جرب LID وs.whatsapp.net
    const voterJids = new Set([voterJidFull]);
    if (voterJidFull?.includes("@lid"))
      voterJids.add(voterJidFull.replace("@lid", "@s.whatsapp.net"));
    else
      voterJids.add(voterJidFull.replace("@s.whatsapp.net", "@lid"));

    // creator: جرب رقم الهاتف واللـ LID
    const creatorJids = new Set([creatorJid]);
    if (creatorLid) creatorJids.add(creatorLid);

    for (const cJid of creatorJids) {
      for (const vJid of voterJids) {
        try {
          const decoded = decryptPollVote(
            { encPayload, encIv },
            { pollCreatorJid: cJid, pollMsgId, pollEncKey, voterJid: vJid }
          );
          const hashes = decoded?.selectedOptions || [];
          if (hashes.length) {
            const name = _matchSelectedToOptions(hashes, pollData.options);
            if (name) {
              log.debug(`[poll-decrypt] ✅ matched "${name}" (creator=${cJid} voter=${vJid})`);
              return name;
            }
            if (DEBUG_POLLS) console.warn(`[poll-decrypt] hashes found no option match (creator=${cJid} voter=${vJid})`);
          }
        } catch (e) {
          if (DEBUG_POLLS) console.warn(`[poll-decrypt] failed (creator=${cJid} voter=${vJid}): ${e.message}`);
        }
      }
    }
    log.debug(`[poll-decrypt] tried ${creatorJids.size}×${voterJids.size} combos — all failed`);
  }

  // ── Strategy 2: direct sha256 matching (plain selectedOptions, older format) ─
  const selected = vote?.selectedOptions || [];
  if (selected.length) {
    const name = _matchSelectedToOptions(selected, pollData.options);
    if (name) {
      log.debug(`[poll-decrypt] ✅ direct sha256 matched "${name}"`);
      return name;
    }
  }

  log.debug(`[poll-decrypt] ✗ no match — encPayload=${!!encPayload} encIv=${!!encIv} secret=${!!pollEncKey} selected=${selected.length}`);
  return null;
}

// ─── Init / connect a session ─────────────────────────────────────────────────
// opts.force=true يتجاوز cooldown (للاستخدام من resetSession / pairing يدوي)
async function initSession(storeId, opts = {}) {
  // إذا الجلسة معلّقة بسبب فشل متكرر، لا تستهلك CPU على QR-loop
  // (إلا إذا طلب admin يدوياً عبر force)
  if (!opts.force) {
    const pausedTs = pausedUntil.get(storeId);
    if (pausedTs && pausedTs > Date.now()) {
      const minsLeft = Math.ceil((pausedTs - Date.now()) / 60000);
      console.log(`⏸️  [${storeId}] init skipped — paused for ${minsLeft} more min (ربط واتساب يدوياً لاستئناف)`);
      sessions.set(storeId, { ...(sessions.get(storeId) || {}), status: "paused", sock: null });
      return;
    }
  } else {
    _clearPause(storeId);
  }

  const existing = sessions.get(storeId);
  if (existing?.reconnectTimer) clearTimeout(existing.reconnectTimer);

  const sessionPath = path.join(SESSION_DIR, storeId);
  fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth:                 state,
    logger,
    printQRInTerminal:    false,
    browser:              ["NexusBot", "Chrome", "1.0.0"],
    // 🚀 إعدادات اتصال محسّنة (تقلل disconnections + تسرّع التعافي)
    keepAliveIntervalMs:  15_000,   // كان 30s → 15s، يكشف الانقطاع أسرع
    connectTimeoutMs:     45_000,   // كان 60s → 45s، fail-fast على الاتصالات السيئة
    qrTimeout:            45_000,   // مهلة QR (تجنب الانتظار 60s الافتراضية)
    defaultQueryTimeoutMs: 30_000,  // مهلة قصوى للـ queries
    retryRequestDelayMs:  300,      // كان 500ms → 300ms، أسرع في retry
    maxMsgRetryCount:     3,        // 3 محاولات للرسالة قبل الاستسلام
    markOnlineOnConnect:  true,
    syncFullHistory:      false,    // لا نحتاج history كاملاً → boot أسرع
    fireInitQueries:      true,
    generateHighQualityLinkPreview: false, // يوفر CPU
    // 🔑 getMessage — يحل re-encryption requests من WhatsApp
    // عند فشل decryption عند المتلقي، WhatsApp يطلب re-encryption.
    // إن أعدنا فارغ → الرسالة عالقة في retry loop (السبب الرئيسي للتأخر دقائق)
    getMessage: async (key) => {
      const cached = _getCachedSentMessage(storeId, key.id);
      if (cached) return cached;
      // fallback: empty conversation (أفضل من crash)
      return { conversation: "" };
    },
  });

  sessions.set(storeId, {
    sock,
    status:             "connecting",
    phone:              existing?.phone || null,
    pairingCode:        null,
    pairingCodeExp:     null,
    reconnectTimer:     null,
    reconnectAttempts:  existing?.reconnectAttempts || 0,
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Connection lifecycle ──────────────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const session = sessions.get(storeId);
    if (!session) return;

    if (qr) {
      session.qr     = qr;
      session.status = "qr";
      console.log(`📱 [${storeId}] QR code ready`);
    }

    if (connection === "open") {
      session.status            = "open";
      session.pairingCode       = null;
      session.qr                = null;
      session.reconnectAttempts = 0;
      console.log(`✅ [${storeId}] WhatsApp connected`);
      try { require("./maintenance-alerts").recordWhatsAppConnect(storeId); } catch {}
      // 🔐 زامن store.ownerPhone مع الرقم الفعلي للجلسة (المصدر الموثوق)
      try {
        const realPhone = jidNormalizedUser(session.sock?.user?.id || "").split("@")[0].split(":")[0];
        if (realPhone) {
          const safeStore = require("./safe-json-store");
          const storesFile = require("path").join(__dirname, "..", "data", "stores.json");
          safeStore.update(storesFile, (data) => {
            const idx = (data.stores || []).findIndex(s => s.id === storeId);
            if (idx === -1) return undefined;
            if (data.stores[idx].ownerPhone === realPhone) return undefined;
            console.log(`🔄 [${storeId}] syncing ownerPhone: ${data.stores[idx].ownerPhone || "(empty)"} → ${realPhone}`);
            data.stores[idx].ownerPhone = realPhone;
            return data;
          }, { stores: [] }).catch(() => {});
        }
      } catch (e) { /* غير حرج */ }
      scheduleTryTTL(storeId);
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`⚠️  [${storeId}] Disconnected — reason: ${statusCode}`);
      try { require("./maintenance-alerts").recordWhatsAppDisconnect(storeId); } catch {}
      if (statusCode === DisconnectReason.loggedOut) {
        session.status            = "disconnected";
        session.reconnectAttempts = 0;
        try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(sessionPath, { recursive: true });
        console.log(`🗑️  [${storeId}] Session wiped (logged out)`);
      } else {
        // ⚠️ 428 = WhatsApp flood/spam detection — توقف عن إعادة المحاولة فوراً
        // كل reconnect جديد يزيد الـ ban → نتوقف بعد محاولتين فقط لرقم 428
        const isFloodFlag = statusCode === 428;
        session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
        const limit = isFloodFlag ? 2 : MAX_RECONNECT_ATTEMPTS;
        if (session.reconnectAttempts > limit) {
          session.status = "paused";
          _setPause(storeId);
          console.log(`⏸️  [${storeId}] paused after ${session.reconnectAttempts} failed attempts (reason=${statusCode}) — cooldown ${PAUSE_COOLDOWN_MS/3600000}h. ${isFloodFlag ? "⚠️ FLOOD-FLAG: انتظر 30-60 دقيقة قبل أي اختبار جديد." : "استأنف يدوياً عبر اللوحة."}`);
        } else {
          // delay أطول لـ 428 (60s ثابت) لإعطاء واتس فرصة للتهدئة
          const delay = isFloodFlag
            ? 60_000
            : Math.min(RECONNECT_BASE_MS * 2 ** Math.min(session.reconnectAttempts - 1, 8), RECONNECT_MAX_MS);
          session.status = "reconnecting";
          session.reconnectTimer = setTimeout(() => initSession(storeId), delay);
        }
      }
    }
  });

  // ── Incoming messages ─────────────────────────────────────────────────────
  // 🚫 Dedup للأوامر fromMe (Baileys قد يستدعي upsert مرتين: notify + append لنفس msg.key.id)
  const _seenFromMeIds = new Map();
  function _isFromMeDuplicate(msgId) {
    if (!msgId) return false;
    if (_seenFromMeIds.has(msgId)) return true;
    _seenFromMeIds.set(msgId, Date.now());
    // نظف القديم (>5 دقائق)
    if (_seenFromMeIds.size > 200) {
      const cutoff = Date.now() - 5 * 60_000;
      for (const [k, ts] of _seenFromMeIds) if (ts < cutoff) _seenFromMeIds.delete(k);
    }
    return false;
  }

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // notify = رسائل واردة عادية
    // append = رسائل مرسلة من نفس الجهاز (Note to Self أو رسائل المالك من واتساب المتجر)
    if (type !== "notify" && type !== "append") {
      log.debug(`[${storeId}] upsert type="${type}" (skipped) msgs=${messages.length}`);
      return;
    }

    for (const msg of messages) {
      try {
        log.debug(`[${storeId}] raw msg: fromMe=${msg.key.fromMe} jid=${msg.key.remoteJid} types=${Object.keys(msg.message || {}).join(",")}`);
        // 🚫 dedup: fromMe قد يحدث notify+append لنفس msg.id → تكرار رسائل التأكيد
        if (msg.key.fromMe && _isFromMeDuplicate(msg.key.id)) {
          log.debug(`[${storeId}] fromMe duplicate skipped: ${msg.key.id}`);
          continue;
        }
        // 🎯 رسائل من المالك (fromMe=true) — معالجتان مُبسّطتان:
        //   1) "قبول" أو "رفض [سبب]" → يطبق على آخر طلب لعميل الـ chat الحالي
        //   2) رسالة عادية لعميل في handoff → auto-resume
        if (msg.key.fromMe && msg.key.remoteJid) {
          // 🔑 LID resolution — remoteJid قد يكون @lid (معرّف داخلي وليس رقم هاتف)
          // نحلّه لرقم هاتف حقيقي قبل البحث عن طلب
          let resolvedJidFM = jidNormalizedUser(msg.key.remoteJid || "");
          if (resolvedJidFM.endsWith("@lid")) {
            const _sp = msg.key.senderPn || msg.key.participantPn || null;
            if (_sp) resolvedJidFM = jidNormalizedUser(_sp);
            else {
              try {
                const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(resolvedJidFM);
                if (pn) resolvedJidFM = jidNormalizedUser(pn);
              } catch {}
            }
          }
          const targetPhone = resolvedJidFM
            .replace("@s.whatsapp.net", "")
            .replace("@lid", "")
            .replace(/\D/g, "");
          const fmText = (msg.message?.conversation
                       || msg.message?.extendedTextMessage?.text
                       || "").trim();
          // قبول/رفض/جاهز/مندوب/تم/منيو — مرتبط بالعميل في الـ chat الحالي
          const inlineMatch = fmText.match(/^(قبول|اكد|أكد|confirm|رفض|reject|جاهز|ready|مندوب|delivery|خرج|تم|completed|تسليم|done|منيو|قاءمه|قاءمة|menu)\s*(.*)$/i);
          // فلتر LID غير محلولة (LIDs أرقامها 15+ خانة عادة)
          const looksLikePhone = targetPhone && targetPhone.length >= 8 && targetPhone.length <= 14;
          if (inlineMatch) {
            if (!looksLikePhone) {
              console.warn(`[${storeId}] inline owner-cmd: targetPhone غير صالح (${targetPhone}) — raw remoteJid=${msg.key.remoteJid} senderPn=${msg.key.senderPn || ""}`);
            } else {
              const cmd   = inlineMatch[1];
              const extra = (inlineMatch[2] || "").trim();
              console.log(`[${storeId}] inline owner-cmd: "${cmd}" target=${targetPhone}`);
              if (global.handleInlineOwnerCmd) {
                try {
                  const handled = await global.handleInlineOwnerCmd(storeId, targetPhone, cmd, extra);
                  if (handled) { console.log(`[${storeId}] ✅ inline cmd handled`); continue; }
                  else         { console.log(`[${storeId}] ⚠️ no matching order for ${targetPhone}`); }
                } catch (e) { console.warn(`[inline-owner-cmd] failed:`, e.message); }
              }
            }
          }
          // 🔇 رسالة من المالك للعميل → البوت يصمت 15 دقيقة (لتفادي التداخل)
          // ⚡ استثناءات ذكية:
          //   0) 🛡️ رسالة من البوت نفسه (cached في _sentMessages) → تجاهل تماماً (كانت بق حرج!)
          //   1) inline commands (قبول/رفض/...) → تعمل بدون handoff
          //   2) رسائل قصيرة جداً (≤ 3 حروف) → لا handoff (احتمال ضغطة خاطئة)
          //   3) كلمة "بوت" أو "استئناف" → تُلغي الـ handoff فوراً (إذن للـ bot بالعمل)
          try {
            // 🚫 CRITICAL: تجاهل رسائل البوت نفسه (fromMe لكن أرسلها البوت لا المالك)
            // check #1: cache ID (لو البوت لحّق يـcache قبل الـevent)
            // check #2: recent-send tracker (يحل race — mark قبل الإرسال بدل بعده)
            if (msg.key.id && _getCachedSentMessage(storeId, msg.key.id)) {
              log.debug(`[${storeId}] fromMe=bot own message via cache-id: ${msg.key.id}`);
              continue;
            }
            if (_isRecentBotEcho(storeId, msg.key.remoteJid)) {
              log.debug(`[${storeId}] fromMe=bot own message via recent-send tracker: ${msg.key.remoteJid}`);
              continue;
            }
            const cleanText = String(fmText || "").trim();
            const RESUME_KW = /^(بوت|استئناف|استانف|resume|bot|شغل\s*البوت|فعل\s*البوت)$/i;
            if (targetPhone && targetPhone.length >= 8 && !inlineMatch) {
              const fs   = require("fs");
              const path = require("path");
              const atomicFs = require("./atomic-fs");
              const handoffFile = path.join(__dirname, "..", "data", "handoffs.json");
              let handoffs = {};
              try { handoffs = JSON.parse(fs.readFileSync(handoffFile, "utf8") || "{}"); } catch {}
              const hkey = storeId + "|" + (targetPhone + "@s.whatsapp.net");

              // 🔓 إستئناف صريح
              if (RESUME_KW.test(cleanText)) {
                if (handoffs[hkey]) {
                  delete handoffs[hkey];
                  atomicFs.writeJsonSync(handoffFile, handoffs);
                  console.log(`[owner-resume] [${storeId}] ${targetPhone} — البوت مُستأنف بواسطة المالك`);
                }
                continue;
              }
              // 🎯 تجاهل الرسائل القصيرة (احتمال ضغطة خاطئة أو ردود سريعة "ok" "👍")
              if (cleanText.length <= 3) {
                continue;
              }
              const existing = handoffs[hkey];
              // 🕐 لو الـ handoff موجود ومازال طرياً (< 5 دقائق) → لا تجدد، تفادي reset مستمر
              if (existing && existing.startedAt) {
                const age = Date.now() - new Date(existing.startedAt).getTime();
                if (age < 5 * 60_000) {
                  continue; // نفس الـ handoff الحالي، بلا تجديد
                }
              }
              handoffs[hkey] = {
                storeId,
                phone:     targetPhone + "@s.whatsapp.net",
                startedAt: new Date().toISOString(),
                lastMsg:   cleanText.slice(0, 200),
                reason:    "owner_replied_to_customer",
                autoStarted: true,
                complaintTtlMs: 15 * 60 * 1000, // 15 دقيقة (بدلاً من ساعة)
              };
              atomicFs.writeJsonSync(handoffFile, handoffs);
              console.log(`[owner-reply-handoff] [${storeId}] ${targetPhone} — البوت صامت 15 دقيقة (${existing ? "تجديد" : "جديد"})`);
            }
          } catch (e) { log.debug(`[owner-reply-handoff] failed: ${e.message}`); }
          continue;
        }
        if (msg.key.fromMe)                      continue;
        if (!msg.key.remoteJid)                  continue;
        if (isJidBroadcast(msg.key.remoteJid))   continue;
        // 👥 Group detection — لا نرد في groups (المستخدم لا يريد البوت يرد في group)
        if (msg.key.remoteJid.endsWith("@g.us")) {
          console.log(`[group-skip] [${storeId}] ignoring group message from ${msg.key.remoteJid}`);
          continue;
        }
        // أيضاً newsletter/channel
        if (msg.key.remoteJid.endsWith("@newsletter") || msg.key.remoteJid.endsWith("@broadcast")) continue;

        // jidNormalizedUser يحذف device suffix (مثل :1)
        // إذا remoteJid هو @lid، نحاول الحصول على phone عبر:
        //   1) senderPn في msg.key (متوفر أحياناً)
        //   2) signalRepository.lidMapping.getPNForLID (Baileys 7+ — async lookup)
        // إذا فشلت الطرق، نُبقي @lid في الـ from (الإرسال يعود إلى @lid)
        const normalizedJid = jidNormalizedUser(msg.key.remoteJid || "");
        const senderPn      = msg.key.senderPn || msg.key.participantPn || null;
        const isLid         = normalizedJid.endsWith("@lid");
        let resolvedJid     = normalizedJid;
        if (isLid) {
          if (senderPn) {
            resolvedJid = jidNormalizedUser(senderPn);
          } else {
            try {
              const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(normalizedJid);
              if (pn) resolvedJid = jidNormalizedUser(pn);
            } catch (e) {
              console.warn(`[lid-fix] getPNForLID failed: ${e.message}`);
            }
          }
        }
        // from = phone بدون @ إذا حُلَّت إلى @s.whatsapp.net، وإلا يبقى مع @lid
        const from = resolvedJid.endsWith("@lid")
          ? resolvedJid
          : resolvedJid.replace("@s.whatsapp.net", "");
        if (isLid) {
          log.debug(`[lid-fix] [${storeId}] @lid=${normalizedJid} senderPn=${senderPn} resolved=${resolvedJid} → from=${from}`);
        }

        const m = msg.message || {};
        let interactiveId = "";
        try {
          const raw = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
          if (raw) interactiveId = JSON.parse(raw)?.id || "";
        } catch {}

        const text =
          m.conversation ||
          m.extendedTextMessage?.text ||
          m.buttonsResponseMessage?.selectedButtonId ||
          m.listResponseMessage?.singleSelectReply?.selectedRowId ||
          m.listResponseMessage?.title ||
          m.templateButtonReplyMessage?.selectedId ||
          interactiveId ||
          "";

        console.log(`📨 [${storeId}] from=${from} text="${text}"`);

        // 🛡️ Ban protection: سجّل أن العميل بدأ محادثة (يفتح نافذة 24h للرد عليه)
        try { banProtection.recordIncoming(storeId, from); } catch {}

        // ── Poll vote ────────────────────────────────────────────────────────
        if (!text && m.pollUpdateMessage) {
          const pollId      = m.pollUpdateMessage.pollCreationMessageKey?.id;
          const voterJidFull = jidNormalizedUser(msg.key.remoteJid || "");  // normalize for decryption
          const pollData = pollVoteMap.get(pollId);
          // أضف pollMsgId للـ pollData من المفتاح (نفس pollId)
          if (pollData && !pollData.pollMsgId) pollData.pollMsgId = pollId;
          // DEBUG: print full vote object and message key
          const _v = m.pollUpdateMessage.vote;
          log.debug(`[vote-dbg] key=${JSON.stringify({remoteJid:msg.key.remoteJid,fromMe:msg.key.fromMe,participant:msg.key.participant})} vote=${JSON.stringify({encPayload:!!_v?.encPayload,encIv:!!_v?.encIv,keys:Object.keys(_v||{}).join(",")})}`);
          log.debug(`[vote-dbg] pollData=${JSON.stringify({pollMsgId:pollData?.pollMsgId,creatorJid:pollData?.creatorJid,hasSecret:!!pollData?.secretB64})}`);
          if (pollData) {
            const votedName = _decodePollVote(pollData, m.pollUpdateMessage.vote, voterJidFull);
            console.log(`🗳️  [${storeId}] poll vote decoded="${votedName || "?"}" options=${pollData.options.map(o=>o.optionName).join("|")}`);
            if (votedName) {
              const btnId = pollData.valueToId[votedName];
              if (btnId && globalMessageHandler) {
                await globalMessageHandler(pollData.storeId, from, btnId, msg);
              }
            } else if (globalPollFallback) {
              // AI fallback — مساعد لكسر الـ loop عند فشل التشفير
              const btnId = await globalPollFallback(storeId, from, pollData);
              if (btnId && globalMessageHandler) {
                await globalMessageHandler(pollData.storeId, from, btnId, msg);
              }
            }
          } else if (globalMessageHandler) {
            await globalMessageHandler(storeId, from, "MAIN_MENU", msg);
          }
          continue;
        }

        // Skip non-interactive system messages
        if (!text && (m.reactionMessage || m.protocolMessage)) continue;

        if (!text && (m.locationMessage || m.liveLocationMessage)) {
          const loc = m.locationMessage || m.liveLocationMessage;
          const { degreesLatitude: lat, degreesLongitude: lng, name, address } = loc;
          // نمرّر صيغة موحّدة تبدأ بـ "📍|" — server.js يكتشفها ويحوّلها لاسم عبر reverse geocoding
          const directLabel = (name || address || "").trim();
          const payload = directLabel
            ? `📍|${lat},${lng}|${directLabel}`
            : `📍|${lat},${lng}|`;
          if (globalMessageHandler) await globalMessageHandler(storeId, from, payload, msg);
          continue;
        }

        // 📷 صور/فيديو/صوت/ملصقات/مستندات — نمرّر payload خاص ليرد البوت بطلب نص
        if (!text) {
          let mediaKind = null;
          if (m.imageMessage)    mediaKind = "image";
          else if (m.videoMessage)    mediaKind = "video";
          else if (m.audioMessage)    mediaKind = "audio";
          else if (m.stickerMessage)  mediaKind = "sticker";
          else if (m.documentMessage) mediaKind = "document";

          if (mediaKind && globalMessageHandler) {
            await globalMessageHandler(storeId, from, `📎|${mediaKind}`, msg);
          }
          continue;
        }

        if (globalMessageHandler) {
          await globalMessageHandler(storeId, from, text.trim(), msg);
        }
      } catch (err) {
        console.error(`❌ [${storeId}] Error processing message:`, err.message);
      }
    }
  });

  return sock;
}

// ─── Request pairing code ─────────────────────────────────────────────────────
async function requestPairingCode(storeId, phoneNumber) {
  const phone = phoneNumber.replace(/[\s\+\-\(\)]/g, "");

  // طلب يدوي من اللوحة = استئناف فوري حتى لو في cooldown
  let session = sessions.get(storeId);
  if (!session || !session.sock || session.status === "disconnected" || session.status === "paused") {
    await initSession(storeId, { force: true });
    session = sessions.get(storeId);
    await new Promise(r => setTimeout(r, 2_000));
  }

  const { sock } = session;
  if (!sock) throw new Error("Socket not initialized");

  const code = await sock.requestPairingCode(phone);
  session.phone          = phone;
  session.pairingCode    = code;
  session.pairingCodeExp = Date.now() + 60_000;
  session.status         = "pairing";

  return code;
}

// ─── Native quick-reply buttons (cascade: buttonsMessage → template → interactive) ──
async function sendNativeButtons(storeId, to, { body, buttons, footer = "", header = "" }) {
  const session = sessions.get(storeId);
  if (!session || session.status !== "open") return false;
  const jid  = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  const safe = buttons.slice(0, 12);

  // ⚡ poll messages لا تدعم footer — نُدمج في body
  const fullBody = footer ? `${body}\n\n${footer}` : body;

  // ── 1: pollMessage — FIRST (guaranteed tap-to-select on all personal accounts) ──
  try {
    const valueToId  = Object.fromEntries(safe.map(b => [b.title, b.id]));
    const pollSecret = randomBytes(32);
    _markBotSent(storeId, jid);
    const result     = await session.sock.sendMessage(jid, {
      poll: {
        name:            fullBody,
        values:          safe.map(b => b.title),
        selectableCount: 1,
        messageSecret:   pollSecret,
      },
    });
    if (result?.key?.id) {
      const secretB64  = pollSecret.toString("base64");
      const creatorJid = jidNormalizedUser(session.sock?.user?.id || "");
      const creatorLid = session.sock?.authState?.creds?.me?.lid
                          ? jidNormalizedUser(session.sock.authState.creds.me.lid)
                          : "";
      const options    = safe.map(b => ({ optionName: b.title }));
      const exp        = Date.now() + 30 * 60 * 1000;
      pollVoteMap.set(result.key.id, { storeId, from: to, options, valueToId, secretB64, creatorJid, creatorLid, pollMsgId: result.key.id, body, exp });
      setTimeout(() => { pollVoteMap.delete(result.key.id); _savePollMap(); }, 30 * 60 * 1000);
      _savePollMap();
      log.debug(`[poll-btn] ✅ ${to} — id=${result.key.id} secret=✓ creator=${creatorJid} lid=${creatorLid||"none"}`);
    }
    return true;
  } catch (e) {
    console.warn("[poll-btn] ✗", e.message);
  }

  return false;
}

// ─── Native list message (pollMessage — guaranteed tap-to-select) ────────────
async function sendNativeList(storeId, to, { body, sections, footer = "", buttonText = "📋 عرض الخيارات" }) {
  const session = sessions.get(storeId);
  if (!session || session.status !== "open") return false;
  const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;

  // ⚡ poll messages لا تدعم footer — نُدمج في body
  const fullBody = footer ? `${body}\n\n${footer}` : body;

  // ── pollMessage FIRST — guaranteed interactive on all personal accounts ──
  try {
    const allRows   = sections.flatMap(s => s.rows || []);
    const pollRows  = allRows.slice(0, 12);
    const valueToId = Object.fromEntries(pollRows.map(r => [r.title, r.id]));

    const pollSecret = randomBytes(32);
    _markBotSent(storeId, jid);
    const result     = await session.sock.sendMessage(jid, {
      poll: {
        name:            fullBody,
        values:          pollRows.map(r => r.title),
        selectableCount: 1,
        messageSecret:   pollSecret,
      },
    });

    if (result?.key?.id) {
      const secretB64  = pollSecret.toString("base64");
      const creatorJid = jidNormalizedUser(session.sock?.user?.id || "");
      const creatorLid = session.sock?.authState?.creds?.me?.lid
                          ? jidNormalizedUser(session.sock.authState.creds.me.lid)
                          : "";
      const options    = pollRows.map(r => ({ optionName: r.title }));
      const exp        = Date.now() + 30 * 60 * 1000;
      pollVoteMap.set(result.key.id, { storeId, from: to, options, valueToId, secretB64, creatorJid, creatorLid, pollMsgId: result.key.id, body, exp });
      setTimeout(() => { pollVoteMap.delete(result.key.id); _savePollMap(); }, 30 * 60 * 1000);
      _savePollMap();
      log.debug(`[poll-list] ✅ ${to} — id=${result.key.id} secret=✓ creator=${creatorJid}`);
    }
    return true;
  } catch (e) {
    console.warn("[poll-list] ✗", e.message);
  }

  return false;
}

// ─── CTA بطاقة غنية (ExternalAdReply) — تفتح URL داخل واتساب بدون رابط مرئي ──
// DISABLE_EXTAD=1 يعطل ext-ad ويرسل text plain فقط (للتشخيص أو التوافق مع واتساب أقدم)
async function sendCtaButton(storeId, to, { body, buttonText, url, footer = "", thumbnailUrl = "" }) {
  const session = sessions.get(storeId);
  if (!session || session.status !== "open") return false;
  const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;

  const DISABLE_EXTAD = process.env.DISABLE_EXTAD === "1";

  // ── Strategy 0 (إذا DISABLE_EXTAD): text plain فقط ──
  if (DISABLE_EXTAD) {
    try {
      _markBotSent(storeId, jid);
      await session.sock.sendMessage(jid, {
        text: `🛍️ *${buttonText}*\n\n${body}\n\n🔗 ${url}\n\n_اضغط الرابط لفتح قائمة الطلب_`,
      });
      log.debug(`[txt-only] ✅ ${jid}`);
      return true;
    } catch (e) {
      console.warn(`[txt-only] ✗ ${e.message}`);
      return false;
    }
  }

  // ── Strategy 1: ExternalAdReplyInfo (rich card — يفتح الرابط داخل واتساب) ──
  try {
    let thumbBuf = null;
    if (thumbnailUrl) {
      try {
        const res = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(4000) });
        if (res.ok) thumbBuf = Buffer.from(await res.arrayBuffer());
      } catch {}
    }
    // URL مدمج في النص — يضمن ظهور رابط قابل للنقر حتى لو لم يُعرض الكارد
    const msgObj = {
      text: `${body}\n\n${url}`,
      contextInfo: {
        externalAdReply: {
          title:                 buttonText,
          body:                  footer || "",
          sourceUrl:             url,
          mediaType:             thumbBuf ? 1 : 0,
          renderLargerThumbnail: !!thumbBuf,
          ...(thumbBuf ? { thumbnail: thumbBuf } : {}),
        },
      },
    };
    _markBotSent(storeId, jid);
    await session.sock.sendMessage(jid, msgObj);
    log.debug(`[ext-ad] ✅ ${to} → "${buttonText}"`);
    return true;
  } catch (e) {
    console.warn("[ext-ad] ✗", e.message);
  }

  // ── Fallback: رابط نصي فقط إذا فشل ext-ad ──
  try {
    _markBotSent(storeId, jid);
    await session.sock.sendMessage(jid, {
      text: `🛍️ *${buttonText}*\n\n${url}\n\n_اضغط الرابط لفتح قائمة الطلب_ ⏰`,
    });
    log.debug(`[txt-url] ✅ ${to}`);
    return true;
  } catch (e) {
    console.warn("[txt-url] ✗", e.message);
  }

  return false;
}

// ─── Send interactive buttons (web mini-page fallback) ────────────────────────
async function sendButtons(storeId, to, { body, buttons, footer, color }) {
  const session = sessions.get(storeId);
  if (!session || session.status !== "open") return;

  const jid     = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  const safe    = buttons.slice(0, 12);
  const options = safe.map(b => ({ id: b.id, title: b.title }));
  const token   = _makeButtonToken(storeId, to, options, color);
  const url     = `${process.env.PUBLIC_URL}/c/${token}`;

  _markBotSent(storeId, jid);
  await session.sock.sendMessage(jid, {
    text: `${body}\n\n👆 اضغط للاختيار:\n${url}${footer ? "\n\n" + footer : ""}`,
  });
}

// ─── Send list message (web mini-page) ───────────────────────────────────────
async function sendList(storeId, to, { body, sections, footer, color }) {
  const session = sessions.get(storeId);
  if (!session || session.status !== "open") return;

  const jid     = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  const options = sections.flatMap(s =>
    s.rows.slice(0, 12).map(r => ({ id: r.id, title: r.title, description: r.description || "" }))
  ).slice(0, 12);
  const token = _makeButtonToken(storeId, to, options, color);
  const url   = `${process.env.PUBLIC_URL}/c/${token}`;

  _markBotSent(storeId, jid);
  await session.sock.sendMessage(jid, {
    text: `${body}\n\n👆 اضغط للاختيار:\n${url}${footer ? "\n\n" + footer : ""}`,
  });
}

// ─── Per-store send queue ─────────────────────────────────────────────────────
// يضمن ترتيب الرسائل + يمنع flood على Baileys + يكشف backpressure
// كل متجر له queue مستقلة، الـ drain يحدث بـ Promise chain (لا CPU spin)
const _sendQueues = new Map(); // storeId → Promise (آخر مهمة)

// timeout 15s — لو فشل، أغلب الأحيان جلسة مفصولة (لا فائدة من انتظار 60s)
const SEND_TASK_TIMEOUT_MS = 15_000;

// 🛡️ Circuit breaker: لو متجر فشل 3 مرات متتالية → نمنع المحاولات لمدة 5 دقائق
const _storeFailures = new Map(); // storeId → { count, blockedUntil }
const FAIL_THRESHOLD = 3;
const BLOCK_DURATION_MS = 5 * 60_000;

function _enqueueSend(storeId, fn, label = "send") {
  // Circuit breaker check
  const fail = _storeFailures.get(storeId);
  if (fail && fail.blockedUntil > Date.now()) {
    return Promise.reject(new Error(`${label} blocked: store ${storeId} circuit open until ${new Date(fail.blockedUntil).toISOString()}`));
  }

  const prev = _sendQueues.get(storeId) || Promise.resolve();
  const fnWithTimeout = () => Promise.race([
    fn(),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout >${SEND_TASK_TIMEOUT_MS/1000}s`)), SEND_TASK_TIMEOUT_MS)),
  ]);
  const next = prev.catch(() => {}).then(async () => {
    const t0 = Date.now();
    try {
      const r = await fnWithTimeout();
      const dt = Date.now() - t0;
      if (dt > 3000) console.warn(`[wa-queue] [${storeId}] ${label} slow: ${dt}ms`);
      // 🟢 نجح → reset عداد الفشل
      _storeFailures.delete(storeId);
      return r;
    } catch (e) {
      console.warn(`[wa-queue] [${storeId}] ${label} failed after ${Date.now()-t0}ms: ${e.message}`);
      // 🔴 فشل → زد العداد
      const f = _storeFailures.get(storeId) || { count: 0, blockedUntil: 0 };
      f.count++;
      if (f.count >= FAIL_THRESHOLD) {
        f.blockedUntil = Date.now() + BLOCK_DURATION_MS;
        f.count = 0;
        console.warn(`[wa-queue] [${storeId}] circuit OPENED for ${BLOCK_DURATION_MS/60_000}min after ${FAIL_THRESHOLD} failures`);
      }
      _storeFailures.set(storeId, f);
      throw e;
    }
  });
  _sendQueues.set(storeId, next);
  next.finally(() => {
    if (_sendQueues.get(storeId) === next) _sendQueues.delete(storeId);
  });
  return next;
}

// ─── 🛡️ Burst Detection — يبطّئ تلقائياً إذا 5+ رسائل في 10 ثوانٍ لنفس العميل
// يحمي من bot-pattern detection بدون قتل سرعة الردود الطبيعية
const _burstCounter = new Map(); // "storeId|phone" → [timestamps]
const BURST_WINDOW_MS = 10000;
const BURST_THRESHOLD = 5;
function _checkBurst(storeId, phone) {
  const key = storeId + "|" + phone;
  const now = Date.now();
  let arr = _burstCounter.get(key) || [];
  // نظف القديم
  arr = arr.filter(t => now - t < BURST_WINDOW_MS);
  arr.push(now);
  _burstCounter.set(key, arr);
  // cleanup عام كل ~100 entry
  if (_burstCounter.size > 500) {
    for (const [k, v] of _burstCounter.entries()) {
      if (!v.length || now - v[v.length - 1] > BURST_WINDOW_MS * 6) _burstCounter.delete(k);
    }
  }
  return arr.length; // عدد الرسائل في النافذة الحالية
}

// ─── Send a text message ──────────────────────────────────────────────────────
async function sendMessage(storeId, to, text, opts = {}) {
  const session = sessions.get(storeId);
  if (!session) throw new Error(`No session for store: ${storeId}`);
  if (session.status !== "open") throw new Error(`Store ${storeId} not connected (${session.status})`);
  const jid     = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  const phone   = jid.split("@")[0];

  // 🛡️ Ban protection: تحقق + تأخير بشري + سجل الإرسال
  // skipBanCheck للحالات الخاصة (مثل ردود instant على رسائل واردة من system)
  if (!opts.skipBanCheck) {
    const check = banProtection.canSend(storeId, phone, {
      allowCold: opts.allowCold === true,
      reason:    opts.reason || "general",
    });
    if (!check.ok) {
      const err = new Error(`ban-protection: ${check.reason}`);
      err.code = "BAN_PROTECTION";
      err.details = check;
      throw err;
    }
    // محاكاة typing/human delay قبل الإرسال
    // للحالات النظامية: delay 2-4s لتفادي spam-flag من واتس (reason 428)
    // ⚠️ ملاحظة: الـ flood detection يضرب بعد ~5 رسائل سريعة متتالية
    const SYSTEM_REASONS = new Set([
      "order_ack","order_accepted","order_rejected","order_completed","order_notification",
      "status_update","order_status","rating_request","owner_archive","owner_report_for_owner",
      "delivery_assigned","digital_delivery","booking_reminder",
    ]);
    if (!opts.instant) {
      // 🛡️ Burst detection: لو 5+ رسائل في 10 ثوانٍ لنفس العميل → إبطاء تلقائي
      // يحمي من bot-pattern detection مع إبقاء الردود الطبيعية سريعة
      const burstCount = _checkBurst(storeId, phone);
      const burstPenalty = burstCount > BURST_THRESHOLD
        ? Math.min(3000, (burstCount - BURST_THRESHOLD) * 800)
        : 0;
      if (burstPenalty > 0) {
        console.log(`[burst-guard] ${storeId.slice(-10)}|${phone}: ${burstCount} msgs/10s → +${burstPenalty}ms`);
      }

      // ⚡ Fast reply: لرسالة تأتي مباشرة بعد رسالة واردة من العميل (low ban risk)
      // واتس يعتبر هذا "normal reply" — لا يحتاج delay كبير
      if (opts.fastReply) {
        // 200-500ms + burst penalty (لو موجود)
        await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random() * 300) + burstPenalty));
      } else if (SYSTEM_REASONS.has(opts.reason)) {
        // ⚡ Optimized: 600-1400ms للنظامية (كان 2-4s)
        await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random() * 800) + burstPenalty));
      } else {
        const baseDelay = await banProtection.humanDelay(text?.length || 0);
        if (burstPenalty > 0) await new Promise(r => setTimeout(r, burstPenalty));
      }
    }
  }

  const msgOpts = opts.noPreview ? { linkPreview: false } : {};
  return _enqueueSend(storeId, async () => {
    // 🛡️ mark BEFORE send — يحل race condition مع fromMe event
    _markBotSent(storeId, jid);
    const sent = await session.sock.sendMessage(jid, { text }, msgOpts);
    if (sent?.key?.id) _cacheSentMessage(storeId, sent.key.id, { conversation: text });
    if (!opts.skipBanCheck) banProtection.recordSent(storeId, phone, "text");
    return sent;
  }, "text");
}

// ─── Send image ───────────────────────────────────────────────────────────────
async function sendImage(storeId, to, source, caption = "") {
  const session = sessions.get(storeId);
  if (!session || session.status !== "open") throw new Error("Not connected");

  const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  let buffer;
  if (Buffer.isBuffer(source)) {
    buffer = source;
  } else if (source && source.startsWith("http")) {
    const https = require("https");
    const http  = require("http");
    buffer = await new Promise((resolve, reject) => {
      const mod = source.startsWith("https") ? https : http;
      mod.get(source, { timeout: 10000 }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }).on("error", reject);
    });
  } else {
    buffer = fs.readFileSync(source);
  }
  return _enqueueSend(storeId, async () => {
    _markBotSent(storeId, jid);
    const sent = await session.sock.sendMessage(jid, { image: buffer, caption });
    if (sent?.key?.id) _cacheSentMessage(storeId, sent.key.id, { imageMessage: { caption } });
    return sent;
  }, "image");
}

// ─── Session utilities ────────────────────────────────────────────────────────
function getStatus(storeId) {
  const s = sessions.get(storeId);
  const pausedTs = pausedUntil.get(storeId);
  const pausedUntilMs = (pausedTs && pausedTs > Date.now()) ? pausedTs : null;
  if (!s) return { status: pausedUntilMs ? "paused" : "disconnected", phone: null, pairingCode: null, qr: null, pausedUntil: pausedUntilMs };
  const code = s.pairingCode && s.pairingCodeExp > Date.now() ? s.pairingCode : null;
  return { status: s.status, phone: s.phone, pairingCode: code, qr: s.qr || null, pausedUntil: pausedUntilMs };
}

// مسح cooldown يدوياً (للوحة الادمن لو احتاج)
function clearSessionPause(storeId) {
  _clearPause(storeId);
}

async function resetSession(storeId) {
  const session = sessions.get(storeId);
  if (session) {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.ttlTimer)       clearTimeout(session.ttlTimer);
    try { await session.sock?.logout(); } catch {}
    try { fs.rmSync(path.join(SESSION_DIR, storeId), { recursive: true, force: true }); } catch {}
    sessions.delete(storeId);
  }
  await initSession(storeId, { force: true });
}

/**
 * يقطع جلسة Baileys للمتجر:
 *   - opts.keepCreds = true (افتراضي): يُغلق الـ socket فقط، يبقي creds للتفعيل لاحقاً
 *   - opts.keepCreds = false: logout كامل + مسح creds (لـ unpair نهائي)
 */
async function disconnectSession(storeId, opts = {}) {
  const keepCreds = opts.keepCreds !== false; // default: keep
  const session = sessions.get(storeId);
  if (!session) return;
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  if (session.ttlTimer)       clearTimeout(session.ttlTimer);
  if (keepCreds) {
    // soft disconnect — احتفظ بالـ creds، فقط أغلق socket
    try { session.sock?.end?.(undefined); } catch {}
    try { session.sock?.ws?.close?.(); } catch {}
  } else {
    // hard logout — يمسح الـ pairing من WhatsApp
    try { await session.sock?.logout(); } catch {}
    try { fs.rmSync(path.join(SESSION_DIR, storeId), { recursive: true, force: true }); } catch {}
  }
  sessions.delete(storeId);
  console.log(`🔌 [${storeId}] Session ${keepCreds ? "disconnected (creds kept)" : "disconnected and wiped"}`);
}

async function bootAllSessions(storesJson) {
  // SKIP_NONCREDS_v1 — 2026-07-07 fix
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const storeIds = storesJson
    .filter(s => s.active && s.subscriptionStatus === "active")
    .filter(s => fs.existsSync(path.join(SESSION_DIR, s.id, "creds.json")))
    .map(s => s.id);

  for (const special of ["platform", "lead", "owner_try", "try_1", "try_2", "try_3", "try_4", "try_5"]) {
    if (!storeIds.includes(special) && fs.existsSync(path.join(SESSION_DIR, special, "creds.json"))) {
      storeIds.push(special);
    }
  }

  console.log(`🚀 Booting ${storeIds.length} WhatsApp session(s) with stagger...`);

  // Stagger: 500ms بين كل session لتجنب reconnect storm + CPU spike + WA detection
  // 50 متجر × 500ms = 25 ثانية للـ boot كامل (مقبول)
  // الـ platform/lead تأخذ priority (أولى ليصبحا متاحين للتنبيهات)
  const priority = ["platform", "lead"];
  const ordered = [
    ...priority.filter(id => storeIds.includes(id)),
    ...storeIds.filter(id => !priority.includes(id)),
  ];

  for (let i = 0; i < ordered.length; i++) {
    const id = ordered[i];
    try {
      await initSession(id);
      // stagger — لا تنتظر الاتصال الكامل، فقط init ثم انتقل
      if (i < ordered.length - 1) await new Promise(r => setTimeout(r, 8000));
    } catch (e) {
      console.error(`❌ Failed to boot session [${id}]:`, e.message);
    }
  }
  console.log(`✅ كل الـ ${ordered.length} session بدأت — انتظر 30-60s للاتصال الكامل`);
}

function listSessions() {
  return [...sessions.entries()].map(([id, s]) => ({
    storeId: id,
    status:  s.status,
    phone:   s.phone,
  }));
}

/**
 * يعيد رقم المتجر الفعلي المتصل بواتس (بدون device suffix)
 * هذا هو "المصدر الوحيد للحقيقة" — store.ownerPhone قد يكون قديماً/خاطئاً
 * @returns {string|null} رقم نظيف (digits only) أو null لو الجلسة غير متصلة
 */
function getOwnPhone(storeId) {
  const sess = sessions.get(storeId);
  const uid = sess?.sock?.user?.id;
  if (!uid) return null;
  const normalized = jidNormalizedUser(uid);
  const phone = normalized.split("@")[0].split(":")[0];
  return phone || null;
}

/**
 * يقارن رقمين (يطبع كلا الرقمين قبل المقارنة) — يكشف "العميل والمتجر نفس الرقم"
 */
function isSamePhone(a, b) {
  if (!a || !b) return false;
  const na = String(a).replace(/\D/g, "");
  const nb = String(b).replace(/\D/g, "");
  if (!na || !nb) return false;
  // قارن آخر 10 أرقام (تجاهل country code variations)
  return na.slice(-10) === nb.slice(-10);
}

module.exports = {
  getOwnPhone,
  isSamePhone,
  initSession,
  requestPairingCode,
  resetSession,
  clearSessionPause,
  sendMessage,
  sendButtons,
  sendNativeButtons,
  sendNativeList,
  sendCtaButton,
  makeButtonToken,
  sendList,
  sendImage,
  getStatus,
  disconnectSession,
  bootAllSessions,
  listSessions,
  setMessageHandler,
  setPollFallback,
  getButtonSession,
  clearButtonSession,
  makeActionToken,
  getActionSession,
  clearActionSession,
  createWebOrderToken,
  getWebOrderSession,
  pausedUntil,
  clearWebOrderSession,
};
