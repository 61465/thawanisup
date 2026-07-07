/**
 * Storage abstraction layer
 * - Local dev  → /data/images/ and /data/invoices/
 * - Firebase   → Firebase Storage (public URLs)
 */

const isFirebase = !!(process.env.FIREBASE_CONFIG || process.env.GCLOUD_PROJECT);

function getFirebaseBucket() {
  const admin = require("firebase-admin");
  if (!admin.apps.length) admin.initializeApp();
  return admin.storage().bucket();
}

// ─── Save image buffer → returns public URL ───────────────────────────────────
async function saveImage(buffer, filename, folder = "images") {
  if (isFirebase) {
    const bucket  = getFirebaseBucket();
    const dest    = `${folder}/${filename}`;
    const file    = bucket.file(dest);
    await file.save(buffer, { contentType: "image/png", public: true });
    return `https://storage.googleapis.com/${bucket.name}/${dest}`;
  } else {
    const fs   = require("fs");
    const path = require("path");
    const dir  = path.join(__dirname, "..", "data", folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buffer);
    const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
    return `${PUBLIC_URL}/${folder}/${filename}`;
  }
}

// ─── Save base64 image → returns public URL ───────────────────────────────────
async function saveBase64Image(base64, filename, folder = "images") {
  const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  return saveImage(buffer, filename, folder);
}

// ─── Get public URL for existing file ────────────────────────────────────────
function getPublicUrl(filename, folder = "images") {
  if (isFirebase) {
    const projectId = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || "{}").projectId;
    const bucket    = `${projectId}.appspot.com`;
    return `https://storage.googleapis.com/${bucket}/${folder}/${filename}`;
  }
  const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  return `${PUBLIC_URL}/${folder}/${filename}`;
}

module.exports = { saveImage, saveBase64Image, getPublicUrl };
