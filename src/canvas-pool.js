/**
 * Canvas Pool — مجموعة worker_threads لتوليد الفواتير بدون حجب event-loop
 *
 * - opt-in: يُفعَّل عبر CANVAS_WORKERS=2 في env. بدونه نعمل sync كالعادة.
 * - VPS صغير (950MB): الافتراضي عند التفعيل = 2 workers (~80MB لكل واحد)
 * - timeout 15s لكل task — لو تجاوز، نرفض الـ promise ولا نحجب
 * - fallback آمن: لو الـ worker مات، نرجع لـ sync mode
 */

"use strict";

const path = require("path");
const { Worker } = require("worker_threads");

const POOL_SIZE = Math.max(0, parseInt(process.env.CANVAS_WORKERS || "0", 10));
const TASK_TIMEOUT_MS = parseInt(process.env.CANVAS_TASK_TIMEOUT_MS || "15000", 10);

let _pool = [];      // [{ worker, busy }]
let _queue = [];     // pending tasks waiting for a free worker
let _nextId = 1;
let _initialized = false;

function _spawnWorker() {
  const w = new Worker(path.join(__dirname, "canvas-worker.js"));
  const entry = { worker: w, busy: false, pending: new Map() };

  w.on("message", (msg) => {
    if (msg.ready) return;
    const cb = entry.pending.get(msg.id);
    if (!cb) return;
    entry.pending.delete(msg.id);
    clearTimeout(cb.timer);
    entry.busy = false;
    if (msg.ok) cb.resolve(msg.result);
    else        cb.reject(new Error(msg.error || "canvas worker error"));
    _drainQueue();
  });

  w.on("error", (err) => {
    console.warn("[canvas-pool] worker error:", err.message);
    // reject all pending
    for (const cb of entry.pending.values()) {
      clearTimeout(cb.timer);
      cb.reject(new Error("worker crashed: " + err.message));
    }
    entry.pending.clear();
    // أزل من الـ pool
    _pool = _pool.filter(e => e !== entry);
    // أنشئ بديل تلقائي بعد ثانية
    setTimeout(() => {
      if (_pool.length < POOL_SIZE) {
        try { _pool.push(_spawnWorker()); } catch (e) { console.warn("[canvas-pool] respawn failed", e.message); }
      }
    }, 1000);
  });

  w.on("exit", (code) => {
    if (code !== 0) console.warn(`[canvas-pool] worker exited with code ${code}`);
  });

  return entry;
}

function _ensureInit() {
  if (_initialized) return;
  _initialized = true;
  if (POOL_SIZE <= 0) return; // disabled
  for (let i = 0; i < POOL_SIZE; i++) {
    try { _pool.push(_spawnWorker()); }
    catch (e) { console.warn("[canvas-pool] spawn failed:", e.message); }
  }
  console.log(`🎨 Canvas pool: ${_pool.length} worker(s)`);
}

function _drainQueue() {
  while (_queue.length > 0) {
    const free = _pool.find(e => !e.busy);
    if (!free) break;
    const task = _queue.shift();
    _runOn(free, task);
  }
}

function _runOn(entry, task) {
  entry.busy = true;
  const id = _nextId++;
  const timer = setTimeout(() => {
    if (entry.pending.has(id)) {
      entry.pending.delete(id);
      entry.busy = false;
      task.reject(new Error("canvas task timeout"));
      _drainQueue();
    }
  }, TASK_TIMEOUT_MS);
  entry.pending.set(id, { resolve: task.resolve, reject: task.reject, timer });
  entry.worker.postMessage({ id, op: task.op, payload: task.payload });
}

function _runInPool(op, payload) {
  return new Promise((resolve, reject) => {
    const task = { op, payload, resolve, reject };
    const free = _pool.find(e => !e.busy);
    if (free) _runOn(free, task);
    else _queue.push(task);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────
const invoiceImage = require("./invoice-image");

async function generateInvoiceImage(payload) {
  _ensureInit();
  if (POOL_SIZE > 0 && _pool.length > 0) {
    try { return await _runInPool("invoice", payload); }
    catch (e) {
      console.warn("[canvas-pool] fallback to sync invoice:", e.message);
      return await invoiceImage.generateInvoiceImage(payload);
    }
  }
  return await invoiceImage.generateInvoiceImage(payload);
}

async function generateSummaryImage(payload) {
  _ensureInit();
  if (POOL_SIZE > 0 && _pool.length > 0) {
    try { return await _runInPool("summary", payload); }
    catch (e) {
      console.warn("[canvas-pool] fallback to sync summary:", e.message);
      return await invoiceImage.generateSummaryImage(payload);
    }
  }
  return await invoiceImage.generateSummaryImage(payload);
}

function stats() {
  return {
    poolSize: _pool.length,
    targetSize: POOL_SIZE,
    busy: _pool.filter(e => e.busy).length,
    queued: _queue.length,
    enabled: POOL_SIZE > 0,
  };
}

module.exports = {
  generateInvoiceImage,
  generateSummaryImage,
  stats,
};
