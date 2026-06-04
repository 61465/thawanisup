/**
 * Invoice Image Generator
 * يولّد صورة فاتورة عربية احترافية PNG باستخدام @napi-rs/canvas + خط Tajawal.
 * تُحفظ في data/invoices/{orderId}.png وتُخدَم عبر /invoices/:id من السيرفر.
 */

const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const fs = require("fs");
const path = require("path");

const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");
const FONT_REGULAR = path.join(FONT_DIR, "Tajawal-Regular.ttf");
const FONT_BOLD = path.join(FONT_DIR, "Tajawal-Bold.ttf");

let _fontsLoaded = false;
function loadFonts() {
  if (_fontsLoaded) return;
  if (fs.existsSync(FONT_REGULAR)) GlobalFonts.registerFromPath(FONT_REGULAR, "Tajawal");
  if (fs.existsSync(FONT_BOLD))    GlobalFonts.registerFromPath(FONT_BOLD,    "TajawalBold");
  _fontsLoaded = true;
}

const INVOICE_DIR = path.join(__dirname, "..", "data", "invoices");

const COLORS = {
  bg:       "#FAF7F2",
  card:     "#FFFFFF",
  gold:     "#C9A24B",
  green:    "#1B5E20",
  textDark: "#1F2937",
  textMid:  "#4B5563",
  textLite: "#9CA3AF",
  divider:  "#E5E7EB",
  accent:   "#FFF8E7",
};

function generateInvoiceImage(data) {
  loadFonts();
  if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });

  const W = 820;
  const itemRow = 38;
  const itemsHeight = data.items.length * itemRow;
  const H = 760 + itemsHeight;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // ─── Background ─────────────────────────────────────────────
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // ─── White card with gold border ────────────────────────────
  const pad = 40;
  ctx.fillStyle = COLORS.card;
  roundRect(ctx, pad, pad, W - pad * 2, H - pad * 2, 18);
  ctx.fill();
  ctx.strokeStyle = COLORS.gold;
  ctx.lineWidth = 2;
  ctx.stroke();

  // ─── Header band ────────────────────────────────────────────
  ctx.fillStyle = COLORS.green;
  roundRect(ctx, pad + 4, pad + 4, W - pad * 2 - 8, 110, 14);
  ctx.fill();

  // Store name
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 38px TajawalBold";
  ctx.textAlign = "center";
  ctx.fillText(data.storeName || "متجرنا", W / 2, pad + 60);

  ctx.font = "20px Tajawal";
  ctx.fillStyle = "#E6E0CC";
  ctx.fillText("فاتورة طلب", W / 2, pad + 95);

  // ─── Order metadata ─────────────────────────────────────────
  let y = pad + 160;
  ctx.fillStyle = COLORS.textMid;
  ctx.font = "18px Tajawal";
  ctx.textAlign = "right";
  ctx.fillText(`رقم الطلب: ${data.orderId}`, W - pad - 30, y);
  ctx.textAlign = "left";
  ctx.fillText(`التاريخ: ${data.date}`, pad + 30, y);

  // ─── Customer details box ───────────────────────────────────
  y += 30;
  ctx.fillStyle = COLORS.accent;
  roundRect(ctx, pad + 30, y, W - pad * 2 - 60, 90, 10);
  ctx.fill();

  ctx.fillStyle = COLORS.textDark;
  ctx.font = "bold 18px TajawalBold";
  ctx.textAlign = "right";
  ctx.fillText("بيانات العميل", W - pad - 50, y + 28);

  ctx.font = "17px Tajawal";
  ctx.fillStyle = COLORS.textMid;
  ctx.fillText(`الاسم: ${data.customerName}`, W - pad - 50, y + 55);
  ctx.fillText(`العنوان: ${truncate(data.customerLocation, 50)}`, W - pad - 50, y + 78);

  // ─── Items table ────────────────────────────────────────────
  y += 130;

  // Header row
  ctx.fillStyle = COLORS.divider;
  ctx.fillRect(pad + 30, y, W - pad * 2 - 60, 2);
  y += 24;

  ctx.font = "bold 17px TajawalBold";
  ctx.fillStyle = COLORS.textDark;
  ctx.textAlign = "right";
  ctx.fillText("المنتج", W - pad - 50, y);
  ctx.textAlign = "center";
  ctx.fillText("الكمية", W / 2, y);
  ctx.textAlign = "left";
  ctx.fillText("المجموع", pad + 50, y);
  y += 12;
  ctx.fillStyle = COLORS.divider;
  ctx.fillRect(pad + 30, y, W - pad * 2 - 60, 1);

  // Item rows
  ctx.font = "17px Tajawal";
  ctx.fillStyle = COLORS.textDark;
  data.items.forEach((item, idx) => {
    y += itemRow;
    if (idx % 2 === 0) {
      ctx.fillStyle = "#FAFAFA";
      ctx.fillRect(pad + 30, y - itemRow + 8, W - pad * 2 - 60, itemRow);
    }
    ctx.fillStyle = COLORS.textDark;
    ctx.textAlign = "right";
    ctx.fillText(truncate(item.name, 30), W - pad - 50, y);
    ctx.textAlign = "center";
    ctx.fillText(`${item.qty} × ${item.price}`, W / 2, y);
    ctx.textAlign = "left";
    ctx.fillText(`${(item.qty * item.price).toFixed(2)}`, pad + 50, y);
  });

  // ─── Totals ─────────────────────────────────────────────────
  y += 30;
  ctx.fillStyle = COLORS.divider;
  ctx.fillRect(pad + 30, y, W - pad * 2 - 60, 2);
  y += 30;

  ctx.font = "17px Tajawal";
  ctx.fillStyle = COLORS.textMid;
  ctx.textAlign = "right";
  ctx.fillText("المجموع الفرعي", W - pad - 50, y);
  ctx.textAlign = "left";
  ctx.fillText(`${data.subtotal.toFixed(2)} ${data.currency}`, pad + 50, y);

  y += 28;
  ctx.textAlign = "right";
  ctx.fillText("رسوم التوصيل", W - pad - 50, y);
  ctx.textAlign = "left";
  ctx.fillText(`${data.deliveryFee.toFixed(2)} ${data.currency}`, pad + 50, y);

  y += 40;
  ctx.fillStyle = COLORS.green;
  roundRect(ctx, pad + 30, y - 28, W - pad * 2 - 60, 56, 12);
  ctx.fill();

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 22px TajawalBold";
  ctx.textAlign = "right";
  ctx.fillText("الإجمالي الكلي", W - pad - 50, y + 6);
  ctx.textAlign = "left";
  ctx.fillText(`${data.total.toFixed(2)} ${data.currency}`, pad + 50, y + 6);

  // ─── Footer ─────────────────────────────────────────────────
  y = H - pad - 70;
  ctx.font = "16px Tajawal";
  ctx.fillStyle = COLORS.textMid;
  ctx.textAlign = "center";
  ctx.fillText("طريقة الدفع: نقداً عند الاستلام", W / 2, y);
  y += 26;
  ctx.font = "14px Tajawal";
  ctx.fillStyle = COLORS.textLite;
  ctx.fillText(`شكراً لاختياركم ${data.storeName}`, W / 2, y);

  // ─── Save ───────────────────────────────────────────────────
  const buffer = canvas.toBuffer("image/png");
  const filePath = path.join(INVOICE_DIR, `${data.orderId}.png`);
  fs.writeFileSync(filePath, buffer);
  return { filePath, fileName: `${data.orderId}.png`, sizeBytes: buffer.length };
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

module.exports = { generateInvoiceImage };
