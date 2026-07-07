/**
 * Menu Card Image Generator
 * Generates a full PNG menu card for a store, grouped by category.
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

const COLORS = {
  bg:       "#fafafa",
  card:     "#FFFFFF",
  gold:     "#C9A24B",
  textDark: "#1F2937",
  textMid:  "#4B5563",
  textLite: "#9CA3AF",
  divider:  "#E5E7EB",
};

// Resolve a /store-images/filename URL to an absolute file path
function resolveImagePath(url) {
  if (!url) return null;
  if (url.startsWith("/store-images/")) {
    return path.join(IMAGES_DIR, path.basename(url));
  }
  if (path.isAbsolute(url) && fs.existsSync(url)) return url;
  return null;
}

async function tryLoadImage(url) {
  try {
    const filePath = resolveImagePath(url);
    if (filePath && fs.existsSync(filePath)) {
      return await loadImage(fs.readFileSync(filePath));
    }
    if (url && url.startsWith("http")) {
      return await loadImage(url);
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

// Draw circular clipping mask (for logo)
function drawCircleImage(ctx, img, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

// Draw colored placeholder with first letter when no product image
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

// Parse a hex color and return rgba string with given alpha
function hexAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Generate a full menu card image.
 *
 * @param {Object} opts
 * @param {string}   opts.storeId
 * @param {string}   opts.storeName
 * @param {string}   [opts.invoiceColor]    - Hex color for store brand
 * @param {string}   [opts.invoiceLogoUrl]  - Logo URL or /store-images/… path
 * @param {Array}    opts.categories        - [{ id, name, emoji }]
 * @param {Array}    opts.products          - [{ id, name, description, price, category, imageUrl, available }]
 * @param {string}   [opts.currency]        - e.g. "ر.س"
 * @returns {Promise<{ filePath, fileName, sizeBytes }>}
 */
async function generateMenuImage({
  storeId,
  storeName,
  invoiceColor,
  invoiceLogoUrl,
  categories = [],
  products   = [],
  currency   = "ر.س",
}) {
  loadFonts();
  if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });

  const brandColor = invoiceColor || "#1B5E20";

  const W       = 900;
  const pad     = 32;
  const HEADER_H = 120;
  const CAT_H   = 48;   // category header height
  const ROW_H   = 130;  // product row height (زاد لاستيعاب التفاصيل: أحجام + إضافات + قابل للإزالة)
  const IMG_SZ  = 70;   // product thumbnail size
  const FOOTER_H = 56;

  // Filter to only available products
  const availableProducts = products.filter(p => p.available !== false);

  // Build ordered list of categories that have at least one available product
  const orderedCats = categories.filter(cat =>
    availableProducts.some(p => p.category === cat.id)
  );

  // Products without a category (or unknown category)
  const knownCatIds = new Set(categories.map(c => c.id));
  const uncategorized = availableProducts.filter(
    p => !p.category || !knownCatIds.has(p.category)
  );

  // Build sections: [ { cat, items } ]
  const sections = orderedCats.map(cat => ({
    cat,
    items: availableProducts.filter(p => p.category === cat.id),
  }));
  if (uncategorized.length > 0) {
    sections.push({ cat: { id: "__other__", name: "أخرى", emoji: "🍽️" }, items: uncategorized });
  }

  // Total dynamic height
  const contentH = sections.reduce((sum, sec) => sum + CAT_H + sec.items.length * ROW_H, 0);
  const H = HEADER_H + pad + contentH + FOOTER_H + pad * 2;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  // RTL direction for all text
  ctx.direction = "rtl";

  // ─── Background ─────────────────────────────────────────────────────────────
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // ─── Header band ────────────────────────────────────────────────────────────
  ctx.fillStyle = brandColor;
  ctx.fillRect(0, 0, W, HEADER_H);

  // Subtle bottom shadow on header
  const headerGrad = ctx.createLinearGradient(0, HEADER_H - 12, 0, HEADER_H + 12);
  headerGrad.addColorStop(0, "rgba(0,0,0,0.18)");
  headerGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = headerGrad;
  ctx.fillRect(0, HEADER_H - 12, W, 24);

  // Store logo (circular, 80px diameter) — positioned on the right side (RTL)
  const logoImg = invoiceLogoUrl ? await tryLoadImage(invoiceLogoUrl) : null;
  const LOGO_R = 40;
  const logoX  = W - pad - LOGO_R;   // center-x of logo circle
  const logoY  = HEADER_H / 2;       // center-y
  if (logoImg) {
    // White circle border
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.arc(logoX, logoY, LOGO_R + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    drawCircleImage(ctx, logoImg, logoX, logoY, LOGO_R);
  } else {
    // Placeholder circle with store initial
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.beginPath();
    ctx.arc(logoX, logoY, LOGO_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `bold 32px TajawalBold`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((storeName || "م")[0], logoX, logoY);
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  // Store name
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 36px TajawalBold";
  ctx.textAlign = "center";
  ctx.fillText(storeName || "متجرنا", W / 2 - LOGO_R / 2, 52);

  // Sub-title "قائمة الطلبات"
  ctx.fillStyle = COLORS.gold;
  ctx.font = "20px Tajawal";
  ctx.textAlign = "center";
  ctx.fillText("قائمة الطلبات", W / 2 - LOGO_R / 2, 84);

  // ─── Product Sections ────────────────────────────────────────────────────────
  let y = HEADER_H + pad;

  // Preload all product images in parallel
  const allItems = sections.flatMap(s => s.items);
  const allImgs  = await Promise.all(allItems.map(p => tryLoadImage(p.imageUrl)));
  const imgMap   = new Map();
  allItems.forEach((p, i) => imgMap.set(p.id, allImgs[i]));

  for (const { cat, items } of sections) {
    // ── Category header ────────────────────────────────────────────────────────
    ctx.fillStyle = hexAlpha(brandColor, 0.12);
    ctx.fillRect(0, y, W, CAT_H);

    // Left accent bar
    ctx.fillStyle = brandColor;
    ctx.fillRect(0, y, 6, CAT_H);

    ctx.fillStyle = COLORS.textDark;
    ctx.font = "bold 22px TajawalBold";
    ctx.textAlign = "right";
    ctx.fillText(`${cat.emoji || "🍽️"}  ${cat.name}`, W - pad, y + CAT_H / 2 + 8);

    y += CAT_H;

    // ── Product rows ───────────────────────────────────────────────────────────
    items.forEach((product, idx) => {
      const rowY = y;

      // Alternating row background
      if (idx % 2 === 0) {
        ctx.fillStyle = "#F5F5F5";
        ctx.fillRect(0, rowY, W, ROW_H);
      } else {
        ctx.fillStyle = COLORS.card;
        ctx.fillRect(0, rowY, W, ROW_H);
      }

      // Product thumbnail — right side (RTL = right)
      const imgX = W - pad - IMG_SZ;
      const imgY = rowY + (ROW_H - IMG_SZ) / 2;
      const img  = imgMap.get(product.id);

      if (img) {
        drawRoundedImage(ctx, img, imgX, imgY, IMG_SZ, IMG_SZ, 10);
      } else {
        drawPlaceholder(ctx, product.name, imgX, imgY, IMG_SZ, IMG_SZ, 10);
      }

      // Text area — to the left of the image
      const textAreaRight = imgX - 14;
      const midY = rowY + ROW_H / 2;

      // Product name (top of row)
      const nameY = rowY + 22;
      ctx.fillStyle = COLORS.textDark;
      ctx.font = "bold 18px TajawalBold";
      ctx.textAlign = "right";
      ctx.fillText(truncate(product.name, 32), textAreaRight, nameY);

      // Description (under name)
      let detailY = nameY + 22;
      if (product.description) {
        ctx.fillStyle = COLORS.textLite;
        ctx.font = "13px Tajawal";
        ctx.fillText(truncate(product.description, 80), textAreaRight, detailY);
        detailY += 18;
      }

      // 📏 Sizes (under description)
      if (Array.isArray(product.sizes) && product.sizes.length) {
        ctx.fillStyle = brandColor;
        ctx.font = "12px Tajawal";
        const sizesTxt = "📏 " + product.sizes.map(s => `${s.name}: ${s.price || product.price} ${currency}`).join(" • ");
        ctx.fillText(truncate(sizesTxt, 70), textAreaRight, detailY);
        detailY += 16;
      }

      // 🍽️ Modifiers (إضافات اختيارية)
      const modsArr = Array.isArray(product.modifiers) ? product.modifiers : (Array.isArray(product.options) ? product.options : []);
      if (modsArr.length) {
        ctx.fillStyle = COLORS.textLite;
        ctx.font = "11px Tajawal";
        const modsTxt = "✨ إضافات: " + modsArr.map(m => `${m.name || m.label}${m.price > 0 ? ` +${m.price}` : ""}`).join("، ");
        ctx.fillText(truncate(modsTxt, 80), textAreaRight, detailY);
        detailY += 15;
      }

      // 🚫 Removable ingredients
      if (Array.isArray(product.removableIngredients) && product.removableIngredients.length) {
        ctx.fillStyle = "#dc2626"; // أحمر للتمييز
        ctx.font = "11px Tajawal";
        const remTxt = "🚫 يمكن إزالة: " + product.removableIngredients.join("، ");
        ctx.fillText(truncate(remTxt, 80), textAreaRight, detailY);
      }

      // Price — left side
      ctx.fillStyle = brandColor;
      ctx.font = "bold 20px TajawalBold";
      ctx.textAlign = "left";
      ctx.fillText(`${Number(product.price).toFixed(2)} ${currency}`, pad, rowY + 30);

      // Thin divider at bottom of row
      if (idx < items.length - 1) {
        ctx.fillStyle = COLORS.divider;
        ctx.fillRect(pad, rowY + ROW_H - 1, W - pad * 2, 1);
      }

      y += ROW_H;
    });

    // Gap between sections
    y += 4;
  }

  // Handle empty menu
  if (sections.length === 0) {
    ctx.fillStyle = COLORS.textLite;
    ctx.font = "22px Tajawal";
    ctx.textAlign = "center";
    ctx.fillText("لا توجد منتجات متاحة حالياً", W / 2, HEADER_H + pad + 60);
    y = HEADER_H + pad + 120;
  }

  // ─── Footer ─────────────────────────────────────────────────────────────────
  const footerY = H - FOOTER_H;

  // Gold separator line
  ctx.fillStyle = COLORS.gold;
  ctx.fillRect(pad * 2, footerY, W - pad * 4, 2);

  ctx.fillStyle = COLORS.textLite;
  ctx.font = "14px Tajawal";
  ctx.textAlign = "center";
  ctx.fillText("Powered by NEXUS ✦", W / 2, footerY + 30);

  // ─── Save ────────────────────────────────────────────────────────────────────
  const buffer    = canvas.toBuffer("image/png");
  const timestamp = Date.now();
  const fileName  = `menu-${storeId || "store"}-${timestamp}.png`;
  const filePath  = path.join(INVOICE_DIR, fileName);

  if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });
  fs.writeFileSync(filePath, buffer);

  return { filePath, fileName, sizeBytes: buffer.length };
}

module.exports = { generateMenuImage };
