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
const MAX_RECONNECT_ATTEMPTS = 20;
const RECONNECT_BASE_MS      = 5_000;
const RECONNECT_MAX_MS       = 5 * 60_000;

const DATA_DIR    = path.join(__dirname, "..", "data");
const SESSION_DIR = path.join(DATA_DIR, "sessions");

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
const shortTokens = new Map(); // slug → { jwt, exp }
const SHORT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SHORT_SLUG_LEN     = 4; // 62^4 = 14.7M، يكفي لآلاف الطلبات النشطة في نفس الوقت

function _makeShortSlug() {
  // base62: حروف+أرقام
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  const buf = randomBytes(SHORT_SLUG_LEN);
  for (let i = 0; i < SHORT_SLUG_LEN; i++) s += chars[buf[i] % chars.length];
  return s;
}

function createWebOrderToken(storeId, from) {
  const sess     = sessions.get(storeId);
  const botPhone = jidNormalizedUser(sess?.sock?.user?.id || "").split("@")[0];
  // JWT signed — expires in 24 hours (was 15m, too short for real customers)
  const jwtToken = jwt.sign({ storeId, from, botPhone }, JWT_SECRET, { expiresIn: "24h" });
  // أنشئ slug قصير وحفظه
  let slug;
  do { slug = _makeShortSlug(); } while (shortTokens.has(slug));
  shortTokens.set(slug, { jwt: jwtToken, exp: Date.now() + SHORT_TOKEN_TTL_MS });
  // نظافة دورية كل دقيقة
  if (!_shortTokenSweeper) {
    _shortTokenSweeper = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of shortTokens.entries()) {
        if (v.exp < now) shortTokens.delete(k);
      }
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
      return null;
    }
    token = entry.jwt;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return { storeId: payload.storeId, from: payload.from, botPhone: payload.botPhone };
  } catch {
    return null;
  }
}

function clearWebOrderSession(slugOrJwt) {
  shortTokens.delete(slugOrJwt);
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
async function initSession(storeId) {
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
    keepAliveIntervalMs:  30_000,
    connectTimeoutMs:     60_000,
    retryRequestDelayMs:  500,
    markOnlineOnConnect:  true,
    getMessage:           async () => ({ conversation: "" }),
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
      scheduleTryTTL(storeId);
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`⚠️  [${storeId}] Disconnected — reason: ${statusCode}`);
      if (statusCode === DisconnectReason.loggedOut) {
        session.status            = "disconnected";
        session.reconnectAttempts = 0;
        try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(sessionPath, { recursive: true });
        console.log(`🗑️  [${storeId}] Session wiped (logged out)`);
      } else {
        session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
        if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          session.status = "paused";
          console.log(`⏸️  [${storeId}] paused after ${MAX_RECONNECT_ATTEMPTS} failed attempts — call initSession to resume`);
        } else {
          const delay = Math.min(
            RECONNECT_BASE_MS * 2 ** Math.min(session.reconnectAttempts - 1, 8),
            RECONNECT_MAX_MS,
          );
          session.status = "reconnecting";
          session.reconnectTimer = setTimeout(() => initSession(storeId), delay);
        }
      }
    }
  });

  // ── Incoming messages ─────────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") {
      log.debug(`[${storeId}] upsert type="${type}" (skipped) msgs=${messages.length}`);
      return;
    }

    for (const msg of messages) {
      try {
        log.debug(`[${storeId}] raw msg: fromMe=${msg.key.fromMe} jid=${msg.key.remoteJid} types=${Object.keys(msg.message || {}).join(",")}`);
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

  let session = sessions.get(storeId);
  if (!session || session.status === "disconnected") {
    await initSession(storeId);
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

  // ── 1: pollMessage — FIRST (guaranteed tap-to-select on all personal accounts) ──
  try {
    const valueToId  = Object.fromEntries(safe.map(b => [b.title, b.id]));
    const pollSecret = randomBytes(32);  // generate secret ourselves so we always have it
    const result     = await session.sock.sendMessage(jid, {
      poll: {
        name:            body,
        values:          safe.map(b => b.title),
        selectableCount: 1,
        messageSecret:   pollSecret,  // Baileys: messageSecret || randomBytes(32)
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

  // ── pollMessage FIRST — guaranteed interactive on all personal accounts ──
  try {
    const allRows   = sections.flatMap(s => s.rows || []);
    const pollRows  = allRows.slice(0, 12);
    const valueToId = Object.fromEntries(pollRows.map(r => [r.title, r.id]));

    const pollSecret = randomBytes(32);  // generate secret ourselves so we always have it
    const result     = await session.sock.sendMessage(jid, {
      poll: {
        name:            body,
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
    await session.sock.sendMessage(jid, msgObj);
    log.debug(`[ext-ad] ✅ ${to} → "${buttonText}"`);
    return true;
  } catch (e) {
    console.warn("[ext-ad] ✗", e.message);
  }

  // ── Fallback: رابط نصي فقط إذا فشل ext-ad ──
  try {
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

  await session.sock.sendMessage(jid, {
    text: `${body}\n\n👆 اضغط للاختيار:\n${url}${footer ? "\n\n" + footer : ""}`,
  });
}

// ─── Send a text message ──────────────────────────────────────────────────────
async function sendMessage(storeId, to, text, opts = {}) {
  const session = sessions.get(storeId);
  if (!session) throw new Error(`No session for store: ${storeId}`);
  if (session.status !== "open") throw new Error(`Store ${storeId} not connected (${session.status})`);
  const jid     = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  const msgOpts = opts.noPreview ? { linkPreview: false } : {};
  await session.sock.sendMessage(jid, { text }, msgOpts);
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
  await session.sock.sendMessage(jid, { image: buffer, caption });
}

// ─── Session utilities ────────────────────────────────────────────────────────
function getStatus(storeId) {
  const s = sessions.get(storeId);
  if (!s) return { status: "disconnected", phone: null, pairingCode: null, qr: null };
  const code = s.pairingCode && s.pairingCodeExp > Date.now() ? s.pairingCode : null;
  return { status: s.status, phone: s.phone, pairingCode: code, qr: s.qr || null };
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
  await initSession(storeId);
}

async function disconnectSession(storeId) {
  const session = sessions.get(storeId);
  if (!session) return;
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  if (session.ttlTimer)       clearTimeout(session.ttlTimer);
  try { await session.sock?.logout(); } catch {}
  sessions.delete(storeId);
  try { fs.rmSync(path.join(SESSION_DIR, storeId), { recursive: true, force: true }); } catch {}
  console.log(`🔌 [${storeId}] Session disconnected and wiped`);
}

async function bootAllSessions(storesJson) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const storeIds = storesJson
    .filter(s => s.active && s.subscriptionStatus === "active")
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
      if (i < ordered.length - 1) await new Promise(r => setTimeout(r, 500));
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

module.exports = {
  initSession,
  requestPairingCode,
  resetSession,
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
  clearWebOrderSession,
};
