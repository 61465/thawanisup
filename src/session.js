/**
 * Session Manager
 * Stores in-memory session state per WhatsApp number.
 * Sessions expire after 30 minutes of inactivity.
 */

const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

const store = new Map();

function get(from) {
  const entry = store.get(from);
  if (!entry) return defaultSession();
  if (Date.now() - entry.lastActive > EXPIRY_MS) {
    store.delete(from);
    return defaultSession();
  }
  entry.lastActive = Date.now();
  return entry.data;
}

function set(from, data) {
  store.set(from, { data, lastActive: Date.now() });
}

function update(from, patch) {
  const current = get(from);
  set(from, { ...current, ...patch });
}

function reset(from) {
  store.delete(from);
}

function defaultSession() {
  return { step: "WELCOME", cart: [] };
}

// Clean expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (now - val.lastActive > EXPIRY_MS) store.delete(key);
  }
}, 10 * 60 * 1000);

module.exports = {
  sessionManager: { get, set, update, reset },
};
