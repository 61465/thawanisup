/**
 * Entry point — dual mode:
 *  • Local (PM2/node):  starts Express server directly
 *  • Firebase Functions: exports Cloud Function "api"
 */

const isFirebase = !!(process.env.FIREBASE_CONFIG || process.env.GCLOUD_PROJECT);

if (isFirebase) {
  // ── Firebase Cloud Functions mode ─────────────────────────────────────────
  const functions = require("firebase-functions");
  const admin     = require("firebase-admin");

  if (!admin.apps.length) admin.initializeApp();

  // Map Firebase Functions config → process.env
  try {
    const cfg = functions.config().bot || {};
    const MAP = {
      whatsapp_token:      "WHATSAPP_TOKEN",
      whatsapp_phone_id:   "WHATSAPP_PHONE_ID",
      verify_token:        "VERIFY_TOKEN",
      owner_phone:         "OWNER_PHONE",
      store_name:          "STORE_NAME",
      currency:            "CURRENCY",
      delivery_fee:        "DELIVERY_FEE",
      public_url:          "PUBLIC_URL",
      master_password:     "MASTER_PASSWORD",
      master_token:        "MASTER_TOKEN",
      stripe_secret_key:   "STRIPE_SECRET_KEY",
      stripe_webhook:      "STRIPE_WEBHOOK_SECRET",
      meta_app_secret:     "META_APP_SECRET",
    };
    for (const [fKey, envKey] of Object.entries(MAP)) {
      if (cfg[fKey]) process.env[envKey] = cfg[fKey];
    }
  } catch {}

  const { app } = require("./src/server");

  exports.api = functions
    .runWith({ memory: "512MB", timeoutSeconds: 60 })
    .https.onRequest(app);

} else {
  // ── Local mode ────────────────────────────────────────────────────────────
  require("dotenv").config();
  require("./src/server");
}
