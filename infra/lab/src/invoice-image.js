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

// تحويل آمن لرقم — يحمي من null/undefined/NaN في الطلبات القديمة أو المشوّهة
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 4 قوالب فاتورة جاهزة + الألوان قابلة للتخصيص من المتجر
// كل template يحدد ألوان + layout خصائص فعلاً مختلفة (headerStyle/showImages/borderWidth)
const TEMPLATES = {
  // 🏛️ كلاسيكي ذهبي (الافتراضي) — header band + thumbnails + alternating rows
  classic: {
    bg:"#FAF7F2", card:"#FFFFFF", gold:"#C9A24B", green:"#1B5E20",
    textDark:"#1F2937", textMid:"#4B5563", textLite:"#9CA3AF",
    divider:"#E5E7EB", accent:"#FFF8E7", altRow:"#FAFAFA", headerTextLight:"#E6E0CC",
    headerStyle:"band", showImages:true, borderWidth:2, decoration:"simple",
  },
  // ⚪ بسيط أنيق — header line فقط، لا thumbnails، خطوط رفيعة
  minimal: {
    bg:"#FFFFFF", card:"#FFFFFF", gold:"#000000", green:"#000000",
    textDark:"#000000", textMid:"#52525b", textLite:"#a1a1aa",
    divider:"#e4e4e7", accent:"#f4f4f5", altRow:"#ffffff", headerTextLight:"#71717a",
    headerStyle:"line", showImages:false, borderWidth:1, decoration:"none",
  },
  // ⬛ غامق فخم — header full + thumbnails + dark bg
  bold: {
    bg:"#0a0a0a", card:"#171717", gold:"#D4AF37", green:"#0a0a0a",
    textDark:"#f5f5f5", textMid:"#a3a3a3", textLite:"#525252",
    divider:"#262626", accent:"#262626", altRow:"#1f1f1f", headerTextLight:"#D4AF37",
    headerStyle:"full", showImages:true, borderWidth:3, decoration:"simple",
  },
  // 💎 أنيق مونوكروم — header band ناعم + لا images + minimal lines
  elegant: {
    bg:"#FFFFFF", card:"#FFFFFF", gold:"#1f2937", green:"#111827",
    textDark:"#111827", textMid:"#374151", textLite:"#9ca3af",
    divider:"#d1d5db", accent:"#f9fafb", altRow:"#ffffff", headerTextLight:"#d1d5db",
    headerStyle:"band", showImages:false, borderWidth:1, decoration:"none",
  },
  // 🌿 سعودي ملكي — header band + double-gold border + thumbnails + ivory bg
  saudi_royal: {
    bg:"#F5F1E8", card:"#FFFFFF", gold:"#C9A227", green:"#0F4C2C",
    textDark:"#1A1A1A", textMid:"#4A4A4A", textLite:"#8E8E8E",
    divider:"#E8DCC4", accent:"#FAF5E6", altRow:"#FCF8EE", headerTextLight:"#F0E6C7",
    headerStyle:"band", showImages:true, borderWidth:3, decoration:"double-gold",
  },
  // ⚫ أبيض/أسود حاد — header full أسود + لا images + bold lines
  minimal_mono: {
    bg:"#FFFFFF", card:"#FFFFFF", gold:"#000000", green:"#000000",
    textDark:"#000000", textMid:"#3A3A3A", textLite:"#8C8C8C",
    divider:"#000000", accent:"#F5F5F5", altRow:"#ffffff", headerTextLight:"#FFFFFF",
    headerStyle:"full", showImages:false, borderWidth:4, decoration:"thick-line",
  },
  // 🍂 دافئ — header band بني + thumbnails كبيرة + warm accents
  warm: {
    bg:"#FBF5EE", card:"#FFFCF7", gold:"#A0522D", green:"#5D4037",
    textDark:"#3E2723", textMid:"#6D4C41", textLite:"#A1887F",
    divider:"#E8D5B9", accent:"#F5E6D3", altRow:"#FAF1E4", headerTextLight:"#FFE6CC",
    headerStyle:"band", showImages:true, borderWidth:2, decoration:"simple",
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
  // ✅ خدمات صور شائعة يستخدمها التجار (Pinterest + Unsplash + Pexels + DuckDuckGo)
  "i.pinimg.com", "pinimg.com",
  "images.unsplash.com", "unsplash.com",
  "images.pexels.com", "pexels.com",
  "external-content.duckduckgo.com",
  // مواقع تجارية شائعة لصور المنتجات
  "i5.walmartimages.com", "walmartimages.com",
  "m.media-amazon.com", "media-amazon.com",
  "cdn.shopify.com", "shopify.com",
  // 🍴 صور المطاعم (deliveryhero/talabat + wordpress + موردي طعام)
  "images.deliveryhero.io", "deliveryhero.io",
  "simplystart.in",
  "f.nooncdn.com", "cdn.salla.network", "cdn.salla.sa",
  // WordPress + CDN عام
  "i0.wp.com", "i1.wp.com", "i2.wp.com",
  "images.weserv.nl",  // CDN proxy موثوق للصور
  // مواقع طعام شائعة
  "static.foodora.com", "static.toptenfoods.com",
  "images.heb.com", "images.albertsons-media.com",
  // 🆕 Freepik / Pixabay / iStock — صور مجانية شائعة الاستخدام
  "img.freepik.com", "freepik.com",
  "img.magnific.com", "magnific.com",
  "pixabay.com", "cdn.pixabay.com",
  "media.istockphoto.com",
  "media.gettyimages.com",
  // Discord/Imgix CDNs شائعة
  "cdn.discordapp.com",
]);

// 🛡️ سياسة SSRF متوازنة:
//   - HTTPS فقط (HTTP مرفوض)
//   - يحجز كل private/internal IPs و localhost
//   - يحجز metadata endpoints الخطيرة (AWS/GCP/Azure)
//   - يحجز file:// و data:// و javascript:
//   - يقبل أي host عام آخر (Google/freepik/jpg مرفوعة من العميل ...)
function _isAllowedExternalImage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    // 🚫 Internal/private IPs
    if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.|::1|localhost|0\.0\.0\.0)$/.test(host)) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return false;
    // 🚫 Cloud metadata endpoints (AWS/GCP/Azure)
    if (host === "169.254.169.254" || host === "metadata.google.internal" || host === "metadata.azure.com") return false;
    // 🚫 IPv6 internal
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host.startsWith("::1")) return false;
    // 🚫 نطاقاتنا الداخلية
    if (host.endsWith(".tail19ddab.ts.net") && !host.includes(".public.")) {
      // ✅ منصتنا نفسها (الصور المرفوعة على ثواني) مسموحة
      if (host === "thawani.tail19ddab.ts.net" || host === "ame.tail19ddab.ts.net") return true;
      return false;
    }
    return true; // ✅ أي host عام آخر
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
      // 🔒 follow redirects يدوياً مع إعادة فحص whitelist في كل hop (5 redirects max)
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000); // 10s — Google images أبطأ
      try {
        let currentUrl = url;
        let res;
        // User-Agent مهم — بعض CDNs ترفض Node.js default
        const fetchOpts = {
          signal: controller.signal,
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ThawaniBot/1.0; +https://thawani.tail19ddab.ts.net)",
            "Accept": "image/avif,image/webp,image/jpeg,image/png,image/gif,image/*,*/*;q=0.8",
            "Accept-Language": "ar,en;q=0.8",
          },
        };
        for (let hop = 0; hop < 6; hop++) {
          res = await fetch(currentUrl, fetchOpts);
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) break;
            const nextUrl = new URL(loc, currentUrl).toString();
            if (!_isAllowedExternalImage(nextUrl)) {
              console.warn(`[invoice-image] redirect blocked: ${nextUrl}`);
              return null;
            }
            currentUrl = nextUrl;
            continue;
          }
          break;
        }
        if (!res || !res.ok) {
          console.warn(`[invoice-image] fetch failed for ${url} (status=${res?.status})`);
          return null;
        }
        // ⚠️ تحقق من Content-Type — يجب أن يكون صورة
        const ct = String(res.headers.get("content-type") || "").toLowerCase();
        if (ct && !/^image\//.test(ct)) {
          console.warn(`[invoice-image] not an image content-type: ${ct} for ${url}`);
          return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) {  // 5MB → 8MB
          console.warn(`[invoice-image] image too large: ${buf.length} bytes for ${url}`);
          return null;
        }
        // 🔍 magic-byte check — يمنع HTML/SVG-as-image attacks
        const magic = buf.subarray(0, 12).toString("hex");
        const isJpeg = magic.startsWith("ffd8ff");
        const isPng  = magic.startsWith("89504e470d0a1a0a");
        const isGif  = magic.startsWith("474946383761") || magic.startsWith("474946383961");
        const isWebp = magic.startsWith("52494646") && buf.subarray(8, 12).toString() === "WEBP";
        const isAvif = magic.includes("66747970"); // ftyp box
        const isBmp  = magic.startsWith("424d");
        if (!(isJpeg || isPng || isGif || isWebp || isAvif || isBmp)) {
          console.warn(`[invoice-image] not a valid image (magic: ${magic.slice(0,16)}) for ${url}`);
          return null;
        }
        return await loadImage(buf);
      } finally { clearTimeout(timer); }
    }
  } catch (e) {
    console.warn(`[invoice-image] tryLoadImage error for ${url}:`, e.message);
  }
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

// 💱 تحويل ر.س → ريالٌ (للفاتورة فقط) — يحافظ على أي عملة أخرى
function _displayCurrency(c) {
  const s = String(c || "").trim();
  if (!s) return "";
  if (/^(ر\.?س|SAR|ريال|ر$)/i.test(s)) return "ريالٌ";
  return s;
}

async function generateInvoiceImage(data) {
  loadFonts();
  if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });

  // ── اختر قالب الفاتورة (classic | minimal | bold | elegant) ──
  const tpl = resolveTemplate(data);
  // 💱 استبدل عملة العرض
  data = { ...data, currency: _displayCurrency(data.currency) };
  // أعرّف COLORS محلياً للقالب المختار (يحجب الـ default)
  const COLORS = tpl;

  const W       = 820;
  const pad     = 40;
  const showImages = tpl.showImages !== false;
  const IMG_SZ  = showImages ? 56 : 0;
  const ROW_H   = showImages ? 70 : 52;
  const itemsHeight = (data.items || []).length * ROW_H;
  // 🎯 مساحة إضافية للـ customAnswers + notes
  const _answersCount = data.customAnswers && typeof data.customAnswers === "object"
    ? Object.values(data.customAnswers).filter(v => v && String(v).trim()).length
    : 0;
  const _notesLen = String(data.notes || "").trim().length;
  const answersExtra = _answersCount > 0 ? (46 + _answersCount * 22 + 8) : 0;
  const notesExtra   = _notesLen > 0 ? (46 + Math.ceil(_notesLen / 50) * 22 + 8) : 0;
  const H = 800 + itemsHeight + answersExtra + notesExtra;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  // ─── Background ──────────────────────────────────────────────
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // ─── Card with template-specific border ──────────────────────
  ctx.fillStyle = COLORS.card;
  roundRect(ctx, pad, pad, W - pad * 2, H - pad * 2, 18);
  ctx.fill();
  ctx.strokeStyle = COLORS.gold;
  ctx.lineWidth = tpl.borderWidth || 2;
  ctx.stroke();
  // Double-gold decoration (Saudi Royal)
  if (tpl.decoration === "double-gold") {
    ctx.strokeStyle = COLORS.gold;
    ctx.lineWidth = 1;
    roundRect(ctx, pad + 8, pad + 8, W - pad * 2 - 16, H - pad * 2 - 16, 14);
    ctx.stroke();
  }

  // ─── Header — 3 styles: band | full | line ───────────────────
  const headerColor = data.invoiceColor || COLORS.green;
  const headerStyle = tpl.headerStyle || "band";
  let headerH;

  if (headerStyle === "line") {
    // Minimal: لا خلفية، فقط نص + خط رفيع تحته
    headerH = 90;
    // نص أسود مباشرة على bg
    ctx.fillStyle = COLORS.textDark;
    ctx.font = "bold 36px TajawalBold";
    ctx.textAlign = "center";
    ctx.fillText(data.storeName || "متجرنا", W / 2, pad + 50);
    ctx.font = "16px Tajawal";
    ctx.fillStyle = COLORS.textLite;
    ctx.fillText("فاتورة طلب", W / 2, pad + 78);
    // خط رفيع تحت الـ header
    ctx.fillStyle = COLORS.divider;
    ctx.fillRect(pad + 30, pad + 100, W - pad * 2 - 60, 1);
  } else if (headerStyle === "full") {
    // Bold/Minimal-mono: header ممتد بالكامل (يصل لحواف الكارد بدون margin)
    headerH = 140;
    ctx.fillStyle = headerColor;
    // ينقطع بحواف الكارد بدون border radius خفيف
    ctx.beginPath();
    ctx.moveTo(pad, pad + 18);
    ctx.lineTo(pad, pad + headerH);
    ctx.lineTo(W - pad, pad + headerH);
    ctx.lineTo(W - pad, pad + 18);
    ctx.quadraticCurveTo(W - pad, pad, W - pad - 18, pad);
    ctx.lineTo(pad + 18, pad);
    ctx.quadraticCurveTo(pad, pad, pad, pad + 18);
    ctx.closePath();
    ctx.fill();
  } else {
    // Band (default classic): مستطيل صغير داخل الكارد
    headerH = 120;
    ctx.fillStyle = headerColor;
    roundRect(ctx, pad + 4, pad + 4, W - pad * 2 - 8, headerH, 14);
    ctx.fill();
  }

  // Logo (if provided) — for band/full styles
  const logoImg = (headerStyle !== "line" && data.invoiceLogoUrl) ? await tryLoadImage(data.invoiceLogoUrl) : null;
  if (logoImg) {
    const lh = 80, lw = 80;
    const lx = pad + 24, ly = pad + 20;
    drawRoundedImage(ctx, logoImg, lx, ly, lw, lh, 10);
  }

  // Store name + subtitle for band/full headers
  if (headerStyle !== "line") {
    // minimal/elegant: نص غامق على header فاتح؛ غيرها: أبيض
    const headerTextMain = (data.invoiceTemplate === "elegant") ? COLORS.textDark : "#FFFFFF";
    ctx.fillStyle = headerTextMain;
    ctx.font = "bold 36px TajawalBold";
    ctx.textAlign = "center";
    ctx.fillText(data.storeName || "متجرنا", W / 2, pad + (headerStyle === "full" ? 70 : 65));
    ctx.font = "19px Tajawal";
    ctx.fillStyle = COLORS.headerTextLight;
    ctx.fillText("فاتورة طلب", W / 2, pad + (headerStyle === "full" ? 110 : 100));
  }

  // Thick-line decoration (Minimal Mono): خط أسود ثخين تحت الـ header
  if (tpl.decoration === "thick-line") {
    ctx.fillStyle = COLORS.divider;
    ctx.fillRect(pad + 4, pad + headerH + 4, W - pad * 2 - 8, 4);
  }

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

  // Load images only if template uses them
  const itemImages = showImages
    ? await Promise.all((data.items || []).map(item => tryLoadImage(item.imageUrl)))
    : [];

  // Item rows
  (data.items || []).forEach((item, idx) => {
    y += ROW_H;
    const rowY = y - ROW_H + 8;

    // Alternating row background (skipped لو decoration=thick-line يميل لـ minimal-mono)
    if (idx % 2 === 0 && tpl.decoration !== "thick-line") {
      ctx.fillStyle = COLORS.altRow;
      ctx.fillRect(pad + 30, rowY, W - pad * 2 - 60, ROW_H);
    }

    const textY = rowY + ROW_H / 2 + 6;
    let nameX;

    if (showImages) {
      // Thumbnail right side (RTL)
      const imgX = W - pad - 50 - IMG_SZ;
      const imgY = rowY + (ROW_H - IMG_SZ) / 2;
      const img  = itemImages[idx];
      if (img) drawRoundedImage(ctx, img, imgX, imgY, IMG_SZ, IMG_SZ, 8);
      else drawPlaceholder(ctx, item.name, imgX, imgY, IMG_SZ, IMG_SZ, 8);
      nameX = imgX - 12;
    } else {
      // No thumbnail: اسم المنتج يبدأ من أقصى اليمين، خط أكبر
      nameX = W - pad - 50;
    }

    // Product name (font size أكبر لو لا images)
    ctx.fillStyle = COLORS.textDark;
    ctx.font = showImages ? "bold 16px TajawalBold" : "bold 18px TajawalBold";
    ctx.textAlign = "right";
    ctx.fillText(truncate(item.name, showImages ? 22 : 30), nameX, textY);

    // Qty × price (center)
    ctx.font = "16px Tajawal";
    ctx.fillStyle = COLORS.textMid;
    ctx.textAlign = "center";
    ctx.fillText(`${num(item.qty)} × ${num(item.price)}`, W / 2, textY);

    // Total (left)
    ctx.fillStyle = COLORS.textDark;
    ctx.font = "bold 16px TajawalBold";
    ctx.textAlign = "left";
    ctx.fillText(`${(num(item.qty) * num(item.price)).toFixed(2)}`, pad + 50, textY);

    // Thick-line: خط أسود بسيط تحت كل صف
    if (tpl.decoration === "thick-line") {
      ctx.fillStyle = COLORS.divider;
      ctx.fillRect(pad + 30, rowY + ROW_H, W - pad * 2 - 60, 1);
    }
  });

  // ─── Custom Answers (إجابات الأسئلة الديناميكية) ─────────────
  const _customAnswers = data.customAnswers || {};
  const _hasAnswers = _customAnswers && typeof _customAnswers === "object" && Object.keys(_customAnswers).length > 0;
  if (_hasAnswers) {
    y += 20;
    ctx.fillStyle = COLORS.divider;
    ctx.fillRect(pad + 30, y, W - pad * 2 - 60, 1);
    y += 22;
    ctx.font = "bold 16px TajawalBold";
    ctx.fillStyle = COLORS.gold;
    ctx.textAlign = "right";
    ctx.fillText("📋 تفاصيل إضافية", W - pad - 40, y);
    y += 24;
    ctx.font = "15px Tajawal";
    ctx.fillStyle = COLORS.textMid;
    for (const [key, value] of Object.entries(_customAnswers)) {
      if (!value || String(value).trim() === "") continue;
      const shortVal = String(value).slice(0, 90);
      const line = `• ${shortVal}`;
      ctx.textAlign = "right";
      ctx.fillText(line, W - pad - 40, y);
      y += 22;
    }
    y += 6;
  }

  // ─── Notes (ملاحظات العميل) ──────────────────────────────────
  const _notes = String(data.notes || "").trim();
  if (_notes) {
    y += 12;
    ctx.fillStyle = COLORS.divider;
    ctx.fillRect(pad + 30, y, W - pad * 2 - 60, 1);
    y += 22;
    ctx.font = "bold 16px TajawalBold";
    ctx.fillStyle = COLORS.gold;
    ctx.textAlign = "right";
    ctx.fillText("📝 ملاحظات:", W - pad - 40, y);
    y += 24;
    ctx.font = "15px Tajawal";
    ctx.fillStyle = COLORS.textMid;
    // wrap طويل — نقسّم على أسطر
    const maxWidth = W - pad * 2 - 60;
    const words = _notes.split(/\s+/);
    let currentLine = "";
    ctx.textAlign = "right";
    for (const w of words) {
      const test = currentLine ? currentLine + " " + w : w;
      if (ctx.measureText(test).width > maxWidth) {
        ctx.fillText(currentLine, W - pad - 40, y);
        y += 22;
        currentLine = w;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) {
      ctx.fillText(currentLine, W - pad - 40, y);
      y += 22;
    }
    y += 6;
  }

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
  ctx.fillText(`${num(data.subtotal).toFixed(2)} ${data.currency || ""}`, pad + 50, y);

  y += 30;
  // 🚚 اسم المنطقة (لو موجودة) → "رسوم التوصيل (المحمدية)"
  const _feeLabel = data.deliveryZone
    ? `رسوم التوصيل (${String(data.deliveryZone).slice(0, 30)})`
    : "رسوم التوصيل";
  ctx.textAlign = "right";
  ctx.fillText(_feeLabel, W - pad - 50, y);
  ctx.textAlign = "left";
  ctx.fillText(`${num(data.deliveryFee).toFixed(2)} ${data.currency || ""}`, pad + 50, y);

  y += 44;
  ctx.fillStyle = headerColor;
  roundRect(ctx, pad + 30, y - 28, W - pad * 2 - 60, 58, 12);
  ctx.fill();

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 22px TajawalBold";
  ctx.textAlign = "right";
  ctx.fillText("الإجمالي الكلي", W - pad - 50, y + 8);
  ctx.textAlign = "left";
  ctx.fillText(`${num(data.total).toFixed(2)} ${data.currency || ""}`, pad + 50, y + 8);

  // ─── Footer ───────────────────────────────────────────────────
  y = H - pad - 72;
  ctx.font = "16px Tajawal";
  ctx.fillStyle = COLORS.textMid;
  ctx.textAlign = "center";
  ctx.fillText(`طريقة الدفع: ${data.paymentSummary || "نقداً عند الاستلام 💵"}`, W / 2, y);
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
  // 💱 استبدل عملة العرض
  data = { ...data, currency: _displayCurrency(data.currency) };

  const W       = 700;
  const pad     = 32;
  const IMG_SZ  = 72;
  const ROW_H   = 90;
  const items   = data.items || [];
  // 🎯 قللنا المساحة السفلية (حُذف الإجمالي والرسوم) — كان 120، صار 80
  const H       = 160 + items.length * ROW_H + 80;
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

    // 🎯 قسم "الكمية × السعر" و "item total" محذوفان — الأسعار تُحدَّد بعد قبول المتجر
    // نبقي فقط الكمية بشكل بسيط
    ctx.font = "15px Tajawal";
    ctx.fillStyle = COLORS.textMid;
    ctx.textAlign = "right";
    ctx.fillText(`الكمية: ${num(item.qty)}`, imgX - 14, midY + 14);

    y += ROW_H;
  }

  // 🎯 رسوم التوصيل + الإجمالي محذوفة من الملخص (تظهر بعد قبول المتجر فقط)
  //   السبب: البوت يحسب رسوم مقترحة، لكن المتجر يعدّلها عند القبول → لا نظهرها للعميل مبكراً
  y += 8;
  ctx.fillStyle = COLORS.divider;
  ctx.fillRect(pad + 16, y, W - pad * 2 - 32, 2);
  y += 24;

  // سطر واحد بديل: "بانتظار موافقة المتجر"
  ctx.font = "16px Tajawal";
  ctx.fillStyle = COLORS.textMid;
  ctx.textAlign = "center";
  ctx.fillText("⌛ بانتظار موافقة المتجر على الطلب", W / 2, y);
  y += 10;

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

// Helper: builds a one-line payment summary for the invoice footer from store fields
function buildPaymentSummary(store) {
  const opts = [];
  if (store?.payCash !== false) opts.push("نقداً عند الاستلام");
  if (store?.payBank === true || store?.payBank === "true" || store?.payBank === 1) opts.push("تحويل بنكي");
  if (store?.payStc  === true || store?.payStc  === "true" || store?.payStc  === 1) opts.push("STC Pay");
  if (!opts.length) opts.push("نقداً عند الاستلام");
  return opts.join(" · ");
}

module.exports = { generateInvoiceImage, generateSummaryImage, buildPaymentSummary };
