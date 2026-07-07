/**
 * 🎫 Support Tickets — store ↔ master communication
 * Storage:
 *   data/tickets/<ticketId>.json       — full ticket + thread
 *   data/tickets-index.jsonl           — append-only index for fast list
 */
const fs   = require("fs");
const path = require("path");
const atomicFs = require("./atomic-fs");

const DATA_DIR    = path.join(__dirname, "..", "data");
const TICKETS_DIR = path.join(DATA_DIR, "tickets");
const INDEX_FILE  = path.join(DATA_DIR, "tickets-index.jsonl");

if (!fs.existsSync(TICKETS_DIR)) fs.mkdirSync(TICKETS_DIR, { recursive: true });

const STATUSES   = ["open", "in_progress", "resolved", "closed"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const CATEGORIES = ["technical", "billing", "general", "feature_request", "bug"];

function _ticketFile(id) { return path.join(TICKETS_DIR, `${id}.json`); }
function _readTicket(id) {
  try { return JSON.parse(fs.readFileSync(_ticketFile(id), "utf8")); }
  catch { return null; }
}
function _writeTicket(t) { atomicFs.writeJsonSync(_ticketFile(t.id), t); }
function _appendIndex(entry) {
  atomicFs.appendJsonlSync(INDEX_FILE, entry);
}

function _readIndex() {
  if (!fs.existsSync(INDEX_FILE)) return [];
  return fs.readFileSync(INDEX_FILE, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function createTicket(storeId, { subject, body, priority, category }) {
  const id = "tk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = new Date().toISOString();
  const ticket = {
    id, storeId,
    subject:  String(subject || "").trim().slice(0, 200),
    category: CATEGORIES.includes(category) ? category : "general",
    priority: PRIORITIES.includes(priority) ? priority : "medium",
    status:   "open",
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id:    "m_" + Date.now().toString(36),
        from:  "store",
        body:  String(body || "").trim().slice(0, 4000),
        ts:    now,
      },
    ],
    lastReplyAt: now,
    lastReplyBy: "store",
  };
  _writeTicket(ticket);
  _appendIndex({ id, storeId, subject: ticket.subject, status: "open", priority: ticket.priority, category: ticket.category, createdAt: now, updatedAt: now });
  return ticket;
}

async function getTicket(id) {
  const t = _readTicket(id);
  if (!t) return null;
  try {
    const db = require("./db");
    const s = await db.getStore(t.storeId);
    if (s) {
      t.storeName  = s.storeName || s.name || "";
      t.ownerPhone = s.ownerPhone || "";
    }
  } catch (e) {
    console.error("[support-tickets] getTicket fetch store failed:", e);
  }
  return t;
}

function listForStore(storeId, { status = null, limit = 100 } = {}) {
  const idx = _readIndex();
  // First, find the latest state of each ticket for the given store
  const latest = new Map();
  for (const row of idx) {
    if (row.storeId !== storeId) continue;
    latest.set(row.id, row);
  }
  // Second, filter by status
  const filtered = [];
  for (const row of latest.values()) {
    if (status && row.status !== status) continue;
    filtered.push(row);
  }
  return filtered
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, limit);
}

async function listAll({ status = null, priority = null, storeId = null, limit = 200 } = {}) {
  const idx = _readIndex();
  // First, find the latest state of each ticket
  const latest = new Map();
  for (const row of idx) {
    latest.set(row.id, row);
  }
  // Second, filter by status, priority, and storeId
  const filtered = [];
  for (const row of latest.values()) {
    if (status   && row.status !== status)   continue;
    if (priority && row.priority !== priority) continue;
    if (storeId  && row.storeId !== storeId)   continue;
    filtered.push(row);
  }
  const items = filtered
    .sort((a, b) => {
      // الأولوية: urgent>high>medium>low ثم الأقدم أولاً
      const pri = { urgent: 0, high: 1, medium: 2, low: 3 };
      const pa = pri[a.priority] ?? 4, pb = pri[b.priority] ?? 4;
      if (pa !== pb) return pa - pb;
      return (a.updatedAt || "").localeCompare(b.updatedAt || "");
    })
    .slice(0, limit);

  // إضافة storeName وownerPhone من قاعدة البيانات (متوافق مع Firestore والملفات المحلية)
  try {
    const db = require("./db");
    const stores = await db.getStores();
    const storeMap = new Map((stores || []).map(s => [s.id, s]));
    for (const item of items) {
      const s = storeMap.get(item.storeId);
      if (s) {
        item.storeName  = s.storeName || s.name || "";
        item.ownerPhone = s.ownerPhone || "";
      }
    }
  } catch (e) {
    console.error("[support-tickets] listAll fetch stores failed:", e);
  }

  return items;
}

function replyToTicket(ticketId, { from, message }) {
  const t = _readTicket(ticketId);
  if (!t) return null;
  const now = new Date().toISOString();
  t.messages.push({
    id:   "m_" + Date.now().toString(36),
    from: from === "master" ? "master" : "store",
    body: String(message || "").trim().slice(0, 4000),
    ts:   now,
  });
  t.updatedAt   = now;
  t.lastReplyAt = now;
  t.lastReplyBy = from === "master" ? "master" : "store";
  // لو ماستر يرد، التذكرة تتحول in_progress تلقائياً
  if (from === "master" && t.status === "open") t.status = "in_progress";
  _writeTicket(t);
  _appendIndex({ id: t.id, storeId: t.storeId, subject: t.subject, status: t.status, priority: t.priority, category: t.category, createdAt: t.createdAt, updatedAt: now });
  return t;
}

function updateStatus(ticketId, newStatus) {
  if (!STATUSES.includes(newStatus)) throw new Error("حالة غير صحيحة");
  const t = _readTicket(ticketId);
  if (!t) return null;
  const now = new Date().toISOString();
  t.status    = newStatus;
  t.updatedAt = now;
  if (newStatus === "resolved" || newStatus === "closed") t.resolvedAt = now;
  _writeTicket(t);
  _appendIndex({ id: t.id, storeId: t.storeId, subject: t.subject, status: newStatus, priority: t.priority, category: t.category, createdAt: t.createdAt, updatedAt: now });
  return t;
}

async function getStats() {
  const all = await listAll({ limit: 1000 });
  const today = new Date().toISOString().slice(0, 10);
  const open = all.filter(t => t.status === "open").length;
  const inProgress = all.filter(t => t.status === "in_progress").length;
  const resolvedToday = all.filter(t => t.status === "resolved" && (t.updatedAt || "").slice(0, 10) === today).length;
  // متوسط زمن أول رد للماستر (لـ tickets resolved في آخر 30 يوم)
  // (تقدير سريع من الفهرس فقط)
  return { open, inProgress, resolvedToday, total: all.length };
}

module.exports = {
  STATUSES, PRIORITIES, CATEGORIES,
  createTicket, getTicket, listForStore, listAll, replyToTicket, updateStatus, getStats,
};
