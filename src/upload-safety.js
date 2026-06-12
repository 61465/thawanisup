/**
 * Upload Safety — magic-byte detection + path sanitization
 * يُستخدم في كل endpoint رفع صور/فيديو لمنع:
 *   - upload disguised SVG (XSS via embedded JS)
 *   - upload .html as .png (browser MIME sniffing)
 *   - path traversal عبر storeId خبيث في الـ filename
 */

// رؤوس الملفات (magic bytes) للصور المسموح بها
const SIGNATURES = {
  jpg:  [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  png:  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  gif:  [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  webp: [[0x52, 0x49, 0x46, 0x46]], // RIFF — مع check إضافي
  // فيديو
  mp4:  [[0x66, 0x74, 0x79, 0x70]], // عند offset 4
  webm: [[0x1a, 0x45, 0xdf, 0xa3]],
  mov:  [[0x66, 0x74, 0x79, 0x70]], // QuickTime — عند offset 4
  m4v:  [[0x66, 0x74, 0x79, 0x70]],
};

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

function _matchSig(buf, sig, offset = 0) {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

/**
 * يتحقق أن الـ buffer هو فعلاً من النوع المُدّعى
 * @returns true لو match، false لو لا
 */
function verifyMagicBytes(buffer, claimedExt) {
  if (!buffer || buffer.length < 8) return false;
  const ext = String(claimedExt || "").toLowerCase();
  const sigs = SIGNATURES[ext];
  if (!sigs) return false;

  // الفيديوهات mp4/mov/m4v تبدأ بـ ftyp عند offset 4
  if (VIDEO_EXTS.has(ext) && (ext === "mp4" || ext === "mov" || ext === "m4v")) {
    return sigs.some(s => _matchSig(buffer, s, 4));
  }

  // webp: RIFF + WEBP عند offset 8
  if (ext === "webp") {
    const riff = _matchSig(buffer, sigs[0], 0);
    const webp = buffer.length >= 12 &&
                 buffer[8]  === 0x57 && // 'W'
                 buffer[9]  === 0x45 && // 'E'
                 buffer[10] === 0x42 && // 'B'
                 buffer[11] === 0x50;   // 'P'
    return riff && webp;
  }

  return sigs.some(s => _matchSig(buffer, s, 0));
}

/**
 * يُنظّف storeId لاستخدامه في filename — يمنع path traversal
 * مسموح: a-z, A-Z, 0-9, _, -
 */
function sanitizeStoreIdForFilename(storeId) {
  return String(storeId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

/**
 * يفك base64 ويُحقّق magic bytes + الحجم
 * @returns { ok: true, buffer } أو { ok: false, error }
 */
function decodeAndVerifyBase64(base64, ext, maxBytes, kind /* "image" | "video" */) {
  if (!base64 || typeof base64 !== "string") return { ok: false, error: "بيانات مفقودة" };
  const cleaned = base64.replace(/^data:(image|video)\/\w+;base64,/, "");
  let buffer;
  try { buffer = Buffer.from(cleaned, "base64"); }
  catch { return { ok: false, error: "صيغة base64 غير صحيحة" }; }

  if (buffer.length === 0) return { ok: false, error: "الملف فارغ" };
  if (buffer.length > maxBytes) {
    return { ok: false, error: `الحجم أكبر من ${(maxBytes / 1024 / 1024).toFixed(1)}MB` };
  }

  const safeExt = String(ext || "").toLowerCase();
  const allowed = kind === "video" ? VIDEO_EXTS : IMAGE_EXTS;
  if (!allowed.has(safeExt)) {
    return { ok: false, error: "صيغة الملف غير مدعومة" };
  }

  if (!verifyMagicBytes(buffer, safeExt)) {
    return { ok: false, error: "محتوى الملف لا يطابق نوعه — مرفوض لأسباب أمنية" };
  }

  return { ok: true, buffer, ext: safeExt };
}

module.exports = {
  verifyMagicBytes,
  sanitizeStoreIdForFilename,
  decodeAndVerifyBase64,
  IMAGE_EXTS,
  VIDEO_EXTS,
};
