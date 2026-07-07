/**
 * Database abstraction layer
 * - Local dev  → JSON files (no Firebase needed)
 * - Firebase   → Firestore (auto-detected via FIREBASE_CONFIG env)
 */

const isFirebase = !!(process.env.FIREBASE_CONFIG || process.env.FIRESTORE_EMULATOR_HOST || process.env.GCLOUD_PROJECT);

// ─── Firestore backend ────────────────────────────────────────────────────────
function firestoreBackend() {
  const admin = require("firebase-admin");
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  async function getStores() {
    const snap = await db.collection("stores").get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function getStore(id) {
    const doc = await db.collection("stores").doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  }

  async function saveStore(id, data) {
    await db.collection("stores").doc(id).set({ ...data, id }, { merge: true });
    return { id, ...data };
  }

  async function updateStore(id, updates) {
    const ref = db.collection("stores").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return null;
    await ref.update(updates);
    return { id, ...doc.data(), ...updates };
  }

  async function deleteStore(id) {
    await db.collection("stores").doc(id).delete();
  }

  async function getOrders(storeId, limit = 100) {
    let q = db.collection("orders").where("storeId", "==", storeId)
              .orderBy("timestamp", "desc").limit(limit);
    const snap = await q.get();
    return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
  }

  async function addOrder(orderData) {
    const ref = await db.collection("orders").add({
      ...orderData,
      timestamp: orderData.timestamp || new Date().toISOString(),
    });
    return ref.id;
  }

  async function updateOrderStatus(storeId, orderId, status) {
    const snap = await db.collection("orders")
      .where("storeId", "==", storeId)
      .where("orderId", "==", orderId)
      .limit(1).get();
    if (snap.empty) return false;
    await snap.docs[0].ref.update({ status });
    return true;
  }

  async function getAllOrdersStats(storeId) {
    const snap = await db.collection("orders").where("storeId", "==", storeId).get();
    return snap.docs.map(d => d.data());
  }

  return { getStores, getStore, saveStore, updateStore, deleteStore, getOrders, addOrder, updateOrderStatus, getAllOrdersStats };
}

// ─── JSON file backend ────────────────────────────────────────────────────────
function jsonBackend() {
  const fs   = require("fs");
  const path = require("path");
  const DATA_DIR    = path.join(__dirname, "..", "data");
  const STORES_FILE = path.join(DATA_DIR, "stores.json");

  function readStoresSync() {
    try { return JSON.parse(fs.readFileSync(STORES_FILE, "utf8")); }
    catch { return { stores: [] }; }
  }
  function writeStoresSync(data) {
    fs.writeFileSync(STORES_FILE, JSON.stringify(data, null, 2));
  }
  function ordersFile(storeId) {
    return storeId === "nakheel_001"
      ? path.join(DATA_DIR, "orders.jsonl")
      : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
  }

  async function getStores() {
    return readStoresSync().stores;
  }
  async function getStore(id) {
    return readStoresSync().stores.find(s => s.id === id) || null;
  }
  async function saveStore(id, data) {
    const d = readStoresSync();
    const idx = d.stores.findIndex(s => s.id === id);
    const store = { ...data, id };
    if (idx === -1) d.stores.push(store); else d.stores[idx] = store;
    writeStoresSync(d);
    return store;
  }
  async function updateStore(id, updates) {
    const d = readStoresSync();
    const idx = d.stores.findIndex(s => s.id === id);
    if (idx === -1) return null;
    d.stores[idx] = { ...d.stores[idx], ...updates, id };
    writeStoresSync(d);
    return d.stores[idx];
  }
  async function deleteStore(id) {
    const d = readStoresSync();
    d.stores = d.stores.filter(s => s.id !== id);
    writeStoresSync(d);
  }
  async function getOrders(storeId, limit = 100) {
    const file = ordersFile(storeId);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8")
      .split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse()
      .slice(0, limit);
  }
  async function addOrder(orderData) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const record = { ...orderData, timestamp: orderData.timestamp || new Date().toISOString() };
    fs.appendFileSync(ordersFile(orderData.storeId || "nakheel_001"), JSON.stringify(record) + "\n", "utf8");
    return record.orderId;
  }
  async function updateOrderStatus(storeId, orderId, status) {
    const file = ordersFile(storeId);
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const updated = lines.map(l => {
      try { const o = JSON.parse(l); if (o.orderId === orderId) o.status = status; return JSON.stringify(o); }
      catch { return l; }
    });
    fs.writeFileSync(file, updated.join("\n") + "\n", "utf8");
    return true;
  }
  async function getAllOrdersStats(storeId) {
    return getOrders(storeId, 10000);
  }

  return { getStores, getStore, saveStore, updateStore, deleteStore, getOrders, addOrder, updateOrderStatus, getAllOrdersStats };
}

const db = isFirebase ? firestoreBackend() : jsonBackend();
module.exports = db;
