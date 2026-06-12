/**
 * Firestore Auth — إدارة حسابات أصحاب المتاجر في Firestore
 * Collection: store_admins
 * Document ID: storeId
 */

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const admin  = require("./firebase-admin");

// Firestore instance (null if Firebase not configured)
let db = null;
try {
  if (admin.apps.length) {
    db = admin.firestore();
    console.log("✅ Firestore connected");
  }
} catch (e) {
  console.warn("⚠️  Firestore init failed:", e.message);
}

const COLLECTION = "store_admins";
const BCRYPT_ROUNDS = 12;
const BCRYPT_RE = /^\$2[aby]?\$\d{2}\$/;

// ─── Hash password (bcrypt; sha256 legacy compat للقراءة فقط) ──────────────
async function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_ROUNDS);
}

function legacySha256(password) {
  // للتحقق من الحسابات القديمة قبل migration فقط
  return crypto.createHash("sha256")
    .update("nexus_salt_2026:" + password)
    .digest("hex");
}

async function comparePassword(plain, stored) {
  if (!stored) return false;
  if (BCRYPT_RE.test(stored)) return bcrypt.compare(String(plain), stored);
  // legacy: قارن sha256
  return legacySha256(String(plain)) === stored;
}

// ─── Upsert store admin record ────────────────────────────────────────────────
async function upsertStoreAdmin({ storeId, phone, password, storeName, subscriptionStatus, active }) {
  if (!db) return false;
  const doc = {
    storeId,
    phone:              String(phone).trim(),
    storeName:          storeName || "",
    subscriptionStatus: subscriptionStatus || "active",
    active:             active !== false,
    updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
  };
  if (password) {
    doc.passwordHash = await hashPassword(password); // ⚠️ bcrypt الآن
  }
  await db.collection(COLLECTION).doc(storeId).set(doc, { merge: true });
  return true;
}

// ─── Login: phone + password → storeId (+ auto-migrate sha256 → bcrypt) ─────
async function loginStoreAdmin(phone, password) {
  if (!db) return null;

  const phoneClean = String(phone).trim();
  const snap = await db.collection(COLLECTION)
    .where("phone", "==", phoneClean)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const docRef = snap.docs[0].ref;
  const doc    = snap.docs[0].data();
  const stored = doc.passwordHash || "";

  const ok = await comparePassword(password, stored);
  if (!ok) return null;
  if (doc.active === false) return null;

  // Auto-migrate sha256 → bcrypt
  if (stored && !BCRYPT_RE.test(stored)) {
    try {
      const newHash = await hashPassword(password);
      await docRef.update({ passwordHash: newHash });
      console.log(`[firestore-auth] migrated sha256→bcrypt for ${doc.storeId}`);
    } catch (e) { console.warn("[firestore-auth] migrate failed:", e.message); }
  }

  return {
    storeId:            doc.storeId,
    storeName:          doc.storeName,
    subscriptionStatus: doc.subscriptionStatus || "active",
  };
}

// ─── Migrate existing stores from stores.json → Firestore (one-time) ─────────
async function migrateStores(stores) {
  if (!db || !stores?.length) return;
  let count = 0;
  for (const s of stores) {
    if (!s.id || !s.ownerPhone) continue;
    try {
      const existing = await db.collection(COLLECTION).doc(s.id).get();
      // Only set if document doesn't exist (preserve manual edits)
      if (!existing.exists) {
        await upsertStoreAdmin({
          storeId:            s.id,
          phone:              s.ownerPhone,
          password:           s.storePassword || "",
          storeName:          s.storeName || "",
          subscriptionStatus: s.subscriptionStatus || "active",
          active:             s.active !== false,
        });
        count++;
      }
    } catch (e) {
      console.warn(`⚠️  Firestore migrate [${s.id}]:`, e.message);
    }
  }
  if (count) console.log(`🔄 Firestore: migrated ${count} store(s)`);
}

// ─── Delete store admin record ────────────────────────────────────────────────
async function deleteStoreAdmin(storeId) {
  if (!db) return;
  await db.collection(COLLECTION).doc(storeId).delete();
}

// ─── List all store admins (for master panel) ─────────────────────────────────
async function listStoreAdmins() {
  if (!db) return [];
  const snap = await db.collection(COLLECTION).get();
  return snap.docs.map(d => {
    const { passwordHash, ...safe } = d.data();
    return safe;
  });
}

module.exports = {
  upsertStoreAdmin,
  loginStoreAdmin,
  migrateStores,
  deleteStoreAdmin,
  listStoreAdmins,
  isReady: () => !!db,
};
