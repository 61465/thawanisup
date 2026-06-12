/**
 * Invoice Image Generator — with product thumbnails + store logo
 */

const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const fs   = require("fs");
const path = require("path");

const FONT_DIR     = path.join(__dirname, "..", "assets", "fonts");
const FONT_REGULAR = path.join(FONT_DIR, "Tajawal-Regular.ttf");
const FONT_BOLD    = path.join(FONT_DIR, "Tajawal-Bold.ttf");
const DATA_DIR     = path.join(__dirname, "..", "data");
const INVOICE_DIR  = path.join(DATA_DIR, "invoices");
const IMAGES_DIR   = path.join(DATA_DIR, "images");

let _fontsLoaded = false;
function loadFonts() {
  if (_fontsLoaded) return;
  if (fs.existsSync(FONT_REGULAR)) GlobalFonts.registerFromPath(FONT_REGULAR, "Tajawal");
  if (fs.existsSync(FONT_BOLD))    GlobalFonts.registerFromPath(FONT_BOLD,    "TajawalBold");
  _fontsLoaded = true;
}

// 4 قوالب فاتورة جاهزة + الألوان قابلة للتخصيص من المتجر
const TEMPLATES = {
  // 🏛️ كلاسيكي ذهبي (الافتراضي) — header ملوّن + كارد أبيض + ذهبي
  classic: {
    bg:       "#FAF7F2",
    card:     "#FFFFFF",
    gold:     "#C9A24B",
    green:    "#1B5E20",
    textDark: "#1F2937",
    textMid:  "#4B5563",
    textLite: "#9CA3AF",
    divider:  "#E5E7EB",
    accent:   "#FFF8E7",
    altRow:   "#FAFAFA",
    headerTextLight: "#E6E0CC",
  },
  // ⚪ بسيط أنيق — أبيض كامل، خطوط رفيعة، بدون header غامق
  minimal: {
    bg:       "#FFFFFF",
    card:     "#FFFFFF",
    gold:     "#000000",
    green:    "#000000",
    textDark: "#000000",
    textMid:  "#52525b",
    textLite: "#a1a1aa",
    divider:  "#e4e4e7",
    accent:   "#f4f4f5",
    altRow:   "#fafafa",
    headerTextLight: "#71717a",
  },
  // ⬛ غامق فخم — header كامل غامق + نصوص بيضاء + لمسة ذهبية
  bold: {
    bg:       "#0a0a0a",
    card:     "#171717",
    gold:     "#D4AF37",
    green:    "#0a0a0a",
    textDark: "#f5f5f5",
    textMid:  "#a3a3a3",
    textLite: "#525252",
    divider:  "#262626",
    accent:   "#262626",
    altRow:   "#1f1f1f",
    headerTextLight: "#D4AF37",
  },
  // 💎 أنيق مونوكروم — أسود/أبيض كامل، لون واحد للأسعار فقط
  elegant: {
    bg:       "#FFFFFF",
    card:     "#FFFFFF",
    gold:     "#1f2937",
    green:    "#111827",
    textDark: "#111827",
    textMid:  "#374151",
    textLite: "#9ca3af",
    divider:  "#d1d5db",
    accent:   "#f9fafb",
    altRow:   "#f9fafb",
    headerTextLight: "#d1d5db",
  },
};

// Default fallback
const COLORS = TEMPLATES.classic;

function resolveTemplate(data) {
  const key = data?.invoiceTemplate;
  return TEMPLATES[key] || TEMPLATES.classic;
}

// Resolve a /store-images/filename URL to an absolute file path
function resolveImagePath(url) {
  if (!url) return null;
  if (url.startsWith("/store-images/")) {
    const filename = path.basename(url);
    // path traversal block — basename يُزيل .. لكن تأكيد مضاعف
    const full = path.join(IMAGES_DIR, filename);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(IMAGES_DIR) + path.sep)) return null;
    return full;
  }
  // absolute file path passed directly
  if (path.isAbsolute(url) && fs.existsSync(url)) return url;
  return null;
}

// SSRF protection: whitelist domains فقط لـ external image loading
const ALLOWED_IMAGE_HOSTS = new Set([
  "i.imgur.com", "imgur.com",
  "res.cloudinary.com",
  "lh3.googleusercontent.com", "lh4.googleusercontent.com", "lh5.googleusercontent.com", "lh6.googleusercontent.com",
  "drive.google.com",
  "raw.githubusercontent.com",
  "61465.github.io",
]);

function _isAllowedExternalImage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    // منع private/internal IPs
    const host = u.hostname.toLowerCase();
    if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.|::1|localhost)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    return ALLOWED_IMAGE_HOSTS.has(host);
  } catch { return false; }
}

async function tryLoadImage(url) {
  try {
    const filePath = resolveImagePath(url);
    if (filePath && fs.existsSync(filePath)) {
      return await loadImage(fs.readFileSync(filePath));
    }
    // external URL — whitelist فقط (SSRF protection)
    if (url && /^https?:\/\//i.test(url)) {
      if (!_isAllowedExternalImage(url)) {
        console.warn(`[invoice-image] blocked SSRF attempt: ${url}`);
        return null;
      }
      // fetch مع timeout صارم لمنع DoS
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 5 * 1024 * 1024) return null; // 5MB cap
        return await loadImage(buf);
      } finally { clearTimeout(timer); }
    }
  } catch {}
  return null;
}

// Draw rounded clipping mask then image inside it
function drawRoundedImage(ctx, img, x, y, w, h, r) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

// Draw colored placeholder with first letter when no image
function drawPlaceholder(ctx, label, x, y, w, h, r) {
  const colors = ["#2e7d32","#1565c0","#6a1b9a","#c62828","#e65100","#00695c","#4527a0"];
  const hue = colors[(label || "م").charCodeAt(0) % colors.length];
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = hue;
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.round(w * 0.45)}px TajawalBold`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText((label || "م")[0], x + w / 2, y + h / 2);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

async function generateInvoiceImage(data) {
  loadFonts();
  if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });

  // ── اختر قالب الفاتورة (classic | minimal | bold | elegant) ──
  const tpl = resolveTemplate(data);
  // أعرّف COLORS محلياً للقالب المختار (يحجب الـ default)
  const COLORS = tpl;

  const W       = 820;
  const pad     = 40;
  const IMG_SZ  = 56;   // product thumbnail size
  const ROW_H   = 70;   // item row height (fits thumbnail)
  const hasImages = (data.items || []).some(i => i.imageUrl);
  const itemsHeight = (data.items || []).length * ROW_H;
  const H = 800 + itemsHeight;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  // ─── Background ──────────────────────────────────────────────
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // ─── Card ───────────────────────────────────────────────
  ctx.fillStyle = COLORS.card;
  roundRect(ctx, pad, pad, W - pad * 2, H - pad * 2, 18);
  ctx.fill();
  ctx.strokeStyle = COLORS.gold;
  ctx.lineWidth = data.invoiceTemplate === "minimal" ? 1 : 2;
  ctx.stroke();

  // ─── Header band ─────────────────────────────────────────────
  const headerColor = data.invoiceColor || COLORS.green;
  ctx.fillStyle = headerColor;
  roundRect(ctx, pad + 4, pad + 4, W - pad * 2 - 8, 120, 14);
  ctx.fill();

  // Logo (if provided)
  const logoImg = data.invoiceLogoUrl ? await tryLoadImage(data.invoiceLogoUrl) : null;
  if (logoImg) {
    const lh = 80, lw = 80;
    const lx = pad + 24, ly = pad + 20;
    drawRoundedImage(ctx, logoImg, lx, ly, lw, lh, 10);
  }

  // Store name — لون النص يتغير حسب القالب
  // minimal/elegant لها header فاتح فنحتاج نصاً غامقاً
  const headerTextMain = (data.invoiceTemplate === "minimal" || data.invoiceTemplate === "elegant")
    ? COLORS.textDark : "#FFFFFF";
  ctx.fillStyle = headerTextMain;
  ctx.font = "bold 36px TajawalBold";
  ctx.textAlign = "center";
  ctx.fillText(data.storeName || "متجرنا", W / 2, pad + 65);
  ctx.font = "19px Tajawal";
  ctx.fillStyle = COLORS.headerTextLight;
  ctx.fillText("فاتورة طلب", W / 2, pad + 100);

  // ─── Order metadata ──────────────────────────────────────────
  let y = pad + 168;
  ctx.fillStyle = COLORS.textMid;
  ctx.font = "17px Tajawal";
  ctx.textAlign = "right";
  ctx.fillText(`رقم الطلب: ${data.orderId}`, W - pad - 30, y);
  ctx.textAlign = "left";
  ctx.fillText(`التاريخ: ${data.date}`, pad + 30, y);

  // ─── Customer box ────────────────────────────────────────────
  y += 28;
  ctx.fillStyle = COLORS.accent;
  roundRect(ctx, pad + 30, y, W - pad * 2 - 60, 90, 10);
  ctx.fill();

  ctx.fillStyle = COLORS.textDark;
  ctx.font = "bold 18px TajawalBold";
  ctx.textAlign = "right";
  ctx.fillText("بيانات العميل", W - pad - 50, y + 28);

  ctx.font = "17px Tajawal";
  ctx.fillStyle = COLORS.textMid;
  ctx.fillText(`الاسم: ${data.customerName}`, W - pad - 50, y + 54);
  ctx.fillText(`العنوان: ${truncate(data.customerLocation, 48)}`, W - pad - 50, y + 78);

  // ─── Items table ─────────────────────────────────────────────
  y += 118;

  // Divider + header row
  ctx.fillStyle = COLORS.divider;
  ctx.fillRect(pad + 30, y, W - pad * 2 - 60, 2);
  y += 22;

  ctx.font = "bold 16px TajawalBold";
  ctx.fillStyle = COLORS.textMid;
  ctx.textAlign = "right";
  ctx.fillText("المنتج", W - pad - 60, y);
  ctx.textAlign = "center";
  ctx.fillText("الكمية × السعر", W / 2, y);
  ctx.textAlign = "left";
  ctx.fillText("المجموع", pad + 50, y);
  y += 10;
  ctx.fillStyle = COLORS.divider;
  ctx.fillRect(pad + 30, y, W - pad * 2 - 60, 1);

  // Load all product images in parallel
  const itemImages = await Promise.all(
    (data.items || []).map(item => tryLoadImage(item.imageUrl))
  );

  // Item rows
  (data.items || []).forEach((item, idx) => {
    y += ROW_H;
    const rowY = y - ROW_H + 8;

    // Alternating row background
    if (idx % 2 === 0) {
      ctx.fillStyle = COLORS.altRow;
      ctx.fillRect(pad + 30, rowY, W - pad * 2 - 60, ROW_H);
    }

    // Thumbnail — right side (RTL)
    const imgX = W - pad - 50 - IMG_SZ;
    const imgY = rowY + (ROW_H - IMG_SZ) / 2;
    const img  = itemImages[idx];
    if (img) {
      drawRoundedImage(ctx, img, imgX, imgY, IMG_SZ, IMG_SZ, 8);
    } else {
      drawPlaceholder(ctx, item.name, imgX, imgY, IMG_SZ, IMG_SZ, 8);
    }

    const textY = rowY + ROW_H / 2 + 6;

    // Product name (right of thumbnail)
    ctx.fillStyle = COLORS.textDark;
    ctx.font = "bold 16px TajawalBold";
    ctx.textAlign = "right";
    ctx.fillText(truncate(item.name, 22), imgX - 12, textY);

    // Qty × price (center)
    ctx.font = "16px Tajawal";
    ctx.fillStyle = COLORS.textMid;
    ctx.textAlign = "center";
    ctx.fillText(`${item.qty} × ${item.price}`, W / 2, textY);

    // Total (left)
    ctx.fillStyle = COLORS.textDark;
    ctx.font = "bold 16px TajawalBold";
    ctx.textAlign = "left";
    ctx.fillText(`${(item.qty * item.price).toFixed(2)}`, pad + 50, textY);
  });

  // ─── Totals ───────────────────────────────────────────────────
  y += 30;
  ctx.fillStyle = COLORS.divider;
  ctx.fillRect(pad + 30, y, W - pad * 2 - 60, 2);
  y += 32;

  ctx.font = "17px Tajawal";
  ctx.fillStyle = COLORS.textMid;
  ctx.textAlign = "right";
  ctx.fillText("المجموع الفرعي", W - pad - 50, y);
  ctx.textAlign = "left";
  ctx.fillText(`${data.subtotal.toFixed(2)} ${data.currency}`, pad + 50, y);

  y += 30;
  ctx.textAlign = "right";
  ctx.fillText("رسوم التوصيل", W - pad - 50, y);
  ctx.textAlign = "left";
  ctx.fillText(`${data.deliveryFee.toFixed(2)} ${data.currency}`, pad + 50, y);

  y += 44;
  ctx.fillStyle = headerColor;
  roundRect(ctx, pad + 30, y - 28, W - pad * 2 - 60, 58, 12);
  ctx.fill();

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 22px TajawalBold";
  ctx.textAlign = "right";
  ctx.fillText("الإجمالي الكلي", W - pad - 50, y + 8);
  ctx.textAlign = "left";
  ctx.fillText(`${data.total.toFixed(2)} ${data.currency}`, pad + 50, y + 8);

  // ─── Footer ───────────────────────────────────────────────────
  y = H - pad - 72;
  ctx.font = "16px Tajawal";
  ctx.fillStyle = COLORS.textMid;
  ctx.textAlign = "center";
  ctx.fillText("طريقة الدفع: نقداً عند الاستلام 💵", W / 2, y);
  y += 28;
  ctx.font = "14px Tajawal";
  ctx.fillStyle = COLORS.textLite;
  ctx.fillText(`شكراً لاختياركم ${data.storeName}`, W / 2, y);

  // ─── Save ─────────────────────────────────────────────────────
  const buffer   = canvas.toBuffer("image/png");
  const fileName = `${data.orderId}.png`;
  const { saveImage } = require("./storage");
  const publicUrl = await saveImage(buffer, fileName, "invoices");
  const filePath  = path.join(INVOICE_DIR, fileName);
  if (!process.env.FIREBASE_CONFIG) {
    if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });
    fs.writeFileSync(filePath, buffer);
  }
  return { filePath, fileName, publicUrl, sizeBytes: buffer.length };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Cart summary card — shown before order confirmation.
 * Shows product images + names + qty×price + total.
 */
async function generateSummaryImage(data) {
  loadFonts();
  if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });

  const W       = 700;
  const pad     = 32;
  const IMG_SZ  = 72;
  const ROW_H   = 90;
  const items   = data.items || [];
  const H       = 160 + items.length * ROW_H + 120;
  const headerColor = data.invoiceColor || COLORS.green;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  // Background
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // Card
  ctx.fillStyle = COLORS.card;
  roundRect(ctx, pad, pad, W - pad * 2, H - pad * 2, 16);
  ctx.fill();
  ctx.strokeStyle = COLORS.gold;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Header band
  ctx.fillStyle = headerColor;
  roundRect(ctx, pad + 4, pad + 4, W - pad * 2 - 8, 88, 12);
  ctx.fill();

  // Logo
  const logoImg = data.invoiceLogoUrl ? await tryLoadImage(data.invoiceLogoUrl) : null;
  if (logoImg) drawRoundedImage(ctx, logoImg, pad + 16, pad + 12, 64, 64, 8);

  // Title
  ctx.fillStyle = "#fff";
  ctx.font = "bold 28px TajawalBold";
  ctx.textAlign = "center";
  ctx.fillText(data.storeName || "متجرنا", W / 2, pad + 46);
  ctx.font = "16px Tajawal";
  ctx.fillStyle = "#ddd";
  ctx.fillText("🛒 ملخص طلبك — يرجى المراجعة والتأكيد", W / 2, pad + 74);

  // Load images in parallel
  const itemImages = await Promise.all(items.map(i => tryLoadImage(i.imageUrl)));

  let y = pad + 108;

  for (let idx = 0; idx < items.length; idx++) {
    const item  = items[idx];
    const img   = itemImages[idx];
    const rowY  = y;

    // Alternating background
    if (idx % 2 === 0) {
      ctx.fillStyle = "#F9F9F9";
      ctx.fillRect(pad + 8, rowY, W - pad * 2 - 16, ROW_H - 4);
    }

    // Product image (right side, RTL)
    const imgX = W - pad - 16 - IMG_SZ;
    const imgY = rowY + (ROW_H - IMG_SZ) / 2;
    if (img) {
      drawRoundedImage(ctx, img, imgX, imgY, IMG_SZ, IMG_SZ, 10);
    } else {
      drawPlaceholder(ctx, item.name, imgX, imgY, IMG_SZ, IMG_SZ, 10);
    }

    const midY = rowY + ROW_H / 2;

    // Product name
    ctx.fillStyle = COLORS.textDark;
    ctx.font = "bold 17px TajawalBold";
    ctx.textAlign = "right";
    ctx.fillText(truncate(item.name, 20), imgX - 14, midY - 10);

    // Qty × price
    ctx.font = "15px Tajawal";
    ctx.fillStyle = COLORS.textMid;
    ctx.fillText(`${item.qty} × ${Number(item.price).toFixed(2)} ${data.currency || ""}`, imgX - 14, midY + 14);

    // Item total (left)
    ctx.font = "bold 16px TajawalBold";
    ctx.fillStyle = headerColor;
    ctx.textAlign = "left";
    ctx.fillText(`${(item.qty * item.price).toFixed(2)}`, pad + 20, midY + 6);

    y += ROW_H;
  }

  // Divider
  y += 6;
  ctx.fillStyle = COLORS.divider;
  ctx.fillRect(pad + 16, y, W - pad * 2 - 32, 2);
  y += 18;

  // Delivery fee
  ctx.font = "16px Tajawal";
  ctx.fillStyle = COLORS.textMid;
  ctx.textAlign = "right";
  ctx.fillText("رسوم التوصيل", W - pad - 20, y);
  ctx.textAlign = "left";
  ctx.fillText(`${Number(data.deliveryFee).toFixed(2)}`, pad + 20, y);

  y += 10;

  // Total band
  ctx.fillStyle = headerColor;
  roundRect(ctx, pad + 8, y, W - pad * 2 - 16, 52, 10);
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.font = "bold 20px TajawalBold";
  ctx.textAlign = "right";
  ctx.fillText("الإجمالي الكلي", W - pad - 20, y + 32);
  ctx.textAlign = "left";
  ctx.fillText(`${Number(data.total).toFixed(2)} ${data.currency || ""}`, pad + 20, y + 32);

  const buffer   = canvas.toBuffer("image/png");
  const fileName = `summary_${data.sessionId || Date.now()}.png`;
  const { saveImage } = require("./storage");
  const publicUrl = await saveImage(buffer, fileName, "invoices");
  const filePath  = path.join(INVOICE_DIR, fileName);
  if (!process.env.FIREBASE_CONFIG) {
    if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });
    fs.writeFileSync(filePath, buffer);
  }
  return { filePath, fileName, publicUrl, sizeBytes: buffer.length };
}

module.exports = { generateInvoiceImage, generateSummaryImage };
