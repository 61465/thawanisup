/* ============================================================
   🍽️ Thawani Menu Pro — Logic (vanilla JS, ~250 lines)
   - Sticky tabs scroll-spy
   - Product detail bottom-sheet
   - Cart FAB
   - Side drawer (account)
   - Order submit (uses existing /api/order/:token endpoint)
   ============================================================ */
(function() {
  "use strict";

  // ─── Globals injected by server.js render ───
  // TOKEN, PRODS, CATS, CUR, NAME, LOGO, DINE_IN, TABLE, TABLE_LABEL,
  // TERMS, MENU_LAYOUT, WELCOME_MSG, BOT_PHONE, EXTRAS
  const cart = JSON.parse(localStorage.getItem("mp_cart_" + TOKEN) || "{}");
  const saveCart = () => localStorage.setItem("mp_cart_" + TOKEN, JSON.stringify(cart));

  // 🔑 Cart Variant Key — يميّز variant واحد من نفس المنتج
  // مثلاً بروستد عادي = "p_1#s0" | بروستد سبايسي = "p_1#s1" | بدون سلطة = "p_1#s0#e:سلطة"
  function _ck(pid, sizeIdx, opts, excluded) {
    const sIdx  = Number(sizeIdx || 0);
    const oIdxs = (Array.isArray(opts) ? [...opts].map(Number).filter(n => Number.isFinite(n)).sort((a,b)=>a-b) : []);
    const exSt  = (Array.isArray(excluded) ? [...excluded].sort() : []);
    // key بسيط لو لا variants → pid نفسه (backward compat)
    if (sIdx === 0 && !oIdxs.length && !exSt.length) return pid;
    return pid + "#s" + sIdx +
           (oIdxs.length ? "#o" + oIdxs.join(",") : "") +
           (exSt.length  ? "#e" + exSt.join("|")  : "");
  }
  // كل الـ variants لمنتج معين
  function _variantsOfPid(pid) {
    return Object.keys(cart).filter(k => k === pid || k.startsWith(pid + "#"));
  }
  // مجموع كمية كل الـ variants لمنتج
  function _qtyOfPid(pid) {
    return _variantsOfPid(pid).reduce((sum, k) => sum + (Number(cart[k]?.qty) || 0), 0);
  }
  // ID المنتج من الـ key المركّب
  function _pidOfKey(key) {
    const i = key.indexOf("#");
    return i === -1 ? key : key.slice(0, i);
  }

  // ─── Helpers ───
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
  // 🛡️ Safe HTML escape (full — يحمي attributes أيضاً)
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const fmt = (n) => Number(n).toLocaleString("ar-EG", { maximumFractionDigits: 2 });

  // ─── Render Tabs ───
  const IS_ACHAY = (typeof MP_STYLE !== "undefined" && MP_STYLE === "achay");
  function renderTabs() {
    const tabs = $("#mpTabs");
    if (!tabs || !CATS || !CATS.length) return;
    // 🖼️ أيقونة الصنف: صورة (icon) لو موجودة، وإلا emoji
    const _catIcon = (c) => (c.icon || c.iconUrl)
      ? `<img src="${esc(c.icon || c.iconUrl)}" alt="">`
      : esc(c.emoji || "🍽️");
    if (IS_ACHAY) {
      tabs.innerHTML = CATS.map((c, i) => `
        <button class="mp-cat-circle${i === 0 ? " active" : ""}" data-cat="${esc(c.id)}">
          <div class="mp-cat-circle-icon">${_catIcon(c)}</div>
          <div class="mp-cat-circle-name">${esc(c.name)}</div>
        </button>
      `).join("");
    } else {
      tabs.innerHTML = CATS.map((c, i) => `
        <button class="mp-tab${i === 0 ? " active" : ""}" data-cat="${esc(c.id)}">
          <span class="mp-tab-emoji">${(c.icon || c.iconUrl) ? `<img src="${esc(c.icon || c.iconUrl)}" style="width:20px;height:20px;border-radius:4px;object-fit:cover;vertical-align:middle">` : esc(c.emoji || "🍽️")}</span>
          <span>${esc(c.name)}</span>
          <span class="mp-tab-count">${c.items.length}</span>
        </button>
      `).join("");
    }
    tabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".mp-cat-circle, .mp-tab");
      if (!btn) return;
      const id = btn.dataset.cat;
      const sec = $("#mp-sec-" + id);
      if (!sec) { console.warn("[mp] section not found:", id); return; }
      // 📍 Manual scroll — أكثر استقراراً من scrollIntoView على iOS
      const headerH = ($(".mp-tabs")?.offsetHeight || $(".mp-cats-circles")?.offsetHeight || 0) + 12;
      const top = sec.getBoundingClientRect().top + window.pageYOffset - headerH;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      // mark active
      $$(".mp-cat-circle, .mp-tab").forEach(t => t.classList.toggle("active", t.dataset.cat === id));
    });
  }

  // 💰 Saudi Riyal symbol (new official 2025+)
  const SAR_SVG = '<svg viewBox="0 0 1124.14 1256.39" aria-hidden="true"><path d="M699.62,1113.02h0c-20.06,44.48-33.32,92.75-38.4,143.37l424.51-90.24c20.06-44.47,33.31-92.75,38.4-143.37l-424.51,90.24Z"/><path d="M1085.73,895.8c20.06-44.47,33.32-92.75,38.4-143.37l-330.68,70.33v-135.2l292.27-62.11c20.06-44.47,33.33-92.75,38.42-143.37l-330.68,70.27V66.13c-50.67,28.45-95.67,66.32-132.25,110.99v403.35l-132.25,28.11V0c-50.67,28.44-95.67,66.32-132.25,110.99v525.69l-295.91,62.88c-20.06,44.47-33.33,92.75-38.42,143.37l334.33-71.05v170.26l-358.3,76.14c-20.06,44.47-33.32,92.75-38.4,143.37l375.04-79.7c30.53-6.35,56.77-22.67,75.94-45.41,18.66-22.55,29.84-51.77,29.84-83.84v-218.27l132.25-28.11v270.6l424.51-90.24Z"/></svg>';
  // 💰 SAR SVG wrapper (safe for injection في innerHTML)
  const SAR_SYM_HTML = `<span class="mp-sar-sym">${SAR_SVG}</span>`;
  // 💵 يرجع HTML للسعر: "12.00 <SAR svg>" لو ريال سعودي، وإلا "12.00 EGP" نصياً
  // ⚠️ استخدم مع innerHTML فقط (ليس textContent)
  function priceHtml(n, decimals = 2) {
    const num = fmt(Number(n).toFixed(decimals));
    return typeof IS_SAR !== "undefined" && IS_SAR
      ? `${num} ${SAR_SYM_HTML}`
      : `${num} ${esc(CUR)}`;
  }
  function priceChipHtml(p) {
    if (p.priceOnRequest) return `<span class="mp-price-chip">💬 السعر عند الطلب</span>`;
    return `<span class="mp-price-chip"><span class="mp-price-chip-sym">${SAR_SVG}</span>${fmt(p.price)}</span>`;
  }

  // ─── View mode (list/grid) ───
  let viewMode = localStorage.getItem("mp_view") || "list";

  // ─── Card renderer (list vs grid; achay style) ───
  function renderCard(pid, cat) {
    const p = PRODS[pid];
    if (!p) return "";
    // 🎨 Portfolio/Showcase-only item — عرض بلا سعر وبلا زر إضافة
    // فقط صورة أو فيديو + اسم/وصف (للأعمال، معرض، عيّنات، إلخ)
    if (p.isShowcaseOnly) return renderPortfolioCard(pid, cat);
    const qty = _qtyOfPid(pid); // مجموع كل variants
    const inCart = qty > 0;
    const desc = p.description || p.desc || "";
    const cal = p.calories || p.cal;
    const emoji = (cat && cat.emoji) || "🍽️";
    const img = p.imageUrl
      ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" loading="lazy" data-fallback="${esc(emoji)}">`
      : `<div class="mp-card-img-placeholder">${esc(emoji)}</div>`;
    const badges = [];
    if (p.popular) badges.push(`<span class="mp-badge popular">🔥</span>`);
    if (p.spicy) badges.push(`<span class="mp-badge spicy">🌶️</span>`);
    if (p.isNew) badges.push(`<span class="mp-badge new">جديد</span>`);
    const addCtrl = qty > 0
      ? `<div class="mp-card-add-wrap in-cart" data-add-wrap="${esc(pid)}">
           <button class="mp-card-qty-minus" data-pid="${esc(pid)}" aria-label="نقص">−</button>
           <span class="mp-card-qty-val">${qty}</span>
           <button class="mp-card-qty-plus" data-pid="${esc(pid)}" aria-label="زيادة">+</button>
         </div>`
      : `<div class="mp-card-add-wrap" data-add-wrap="${esc(pid)}">
           <button class="mp-card-add" data-add="${esc(pid)}" aria-label="إضافة">+</button>
         </div>`;

    // Grid view (large image card)
    if (viewMode === "grid") {
      return `
        <div class="mp-card-grid" data-pid="${esc(pid)}">
          <div class="mp-card-grid-img">${img}
            ${badges.length ? `<div class="mp-card-badges">${badges.join("")}</div>` : ""}
          </div>
          <div class="mp-card-grid-body">
            <h3 class="mp-card-grid-name">${esc(p.name)}</h3>
            ${desc ? `<p class="mp-card-desc" style="margin:4px 0 8px">${esc(desc)}</p>` : ""}
            <div class="mp-card-foot" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              <div>
                <div class="mp-card-price" style="font-size:16px;font-weight:800;color:var(--mp-primary)">${p.priceOnRequest ? "💬 السعر عند الطلب" : priceHtml(p.price)}</div>
                ${cal ? `<div class="mp-card-cal">🔥 ${esc(cal)} سعرة</div>` : ""}
              </div>
              ${addCtrl}
            </div>
          </div>
        </div>
      `;
    }

    // List view (classic-style card: image left + name + desc + price + add button)
    return `
      <div class="mp-card" data-pid="${esc(pid)}">
        <div class="mp-card-img-wrap">${img}
          ${badges.length ? `<div class="mp-card-badges">${badges.join("")}</div>` : ""}
        </div>
        <div class="mp-card-body">
          <h3 class="mp-card-name">${esc(p.name)}</h3>
          ${desc ? `<p class="mp-card-desc">${esc(desc)}</p>` : ""}
          <div class="mp-card-foot">
            <div class="mp-card-price-wrap">
              <div class="mp-card-price">${p.priceOnRequest ? "💬 السعر عند الطلب" : priceHtml(p.price)}</div>
              ${cal ? `<div class="mp-card-cal">🔥 ${esc(cal)} سعرة</div>` : ""}
            </div>
            ${addCtrl}
          </div>
        </div>
      </div>
    `;
  }

  // 🎨 Portfolio/Showcase card — للأعمال (فيديو/صور فقط، بلا سعر وبلا زر)
  function renderPortfolioCard(pid, cat) {
    const p = PRODS[pid];
    if (!p) return "";
    const name = p.name || "";
    const desc = p.description || p.desc || "";
    const emoji = (cat && cat.emoji) || "🖼️";
    const hasVideo = p.videoUrl && String(p.videoUrl).trim();
    const isNativeVideo = hasVideo && (/\.(mp4|webm|mov|m4v)($|\?)/i.test(p.videoUrl) || String(p.videoUrl).startsWith("/store-videos/"));
    const img = p.imageUrl
      ? `<img src="${esc(p.imageUrl)}" alt="${esc(name)}" loading="lazy">`
      : `<div class="mp-portfolio-img-placeholder">${esc(emoji)}</div>`;
    return `
      <div class="mp-portfolio-card" data-pid="${esc(pid)}">
        <div class="mp-portfolio-media">
          ${img}
          ${hasVideo ? `<button class="mp-portfolio-play" data-portfolio-video="${esc(pid)}" aria-label="شاهد الفيديو">▶</button>` : ""}
        </div>
        ${(name || desc) ? `
          <div class="mp-portfolio-body">
            ${name ? `<h4 class="mp-portfolio-name">${esc(name)}</h4>` : ""}
            ${desc ? `<p class="mp-portfolio-desc">${esc(desc)}</p>` : ""}
          </div>
        ` : ""}
      </div>
    `;
  }

  // View toggle (list/grid) for achay
  function setupViewToggle() {
    const tog = $("#mpViewToggle");
    if (!tog) return;
    $$("button[data-view]", tog).forEach(b => b.classList.toggle("active", b.dataset.view === viewMode));
    tog.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-view]");
      if (!b) return;
      viewMode = b.dataset.view;
      localStorage.setItem("mp_view", viewMode);
      $$("button[data-view]", tog).forEach(x => x.classList.toggle("active", x.dataset.view === viewMode));
      renderSections();
    });
  }

  // ─── Render Sections + Products ───
  let _sectionsClickBound = false;
  function renderSections() {
    const root = $("#mpSections");
    if (!root) return;
    root.innerHTML = CATS.map(c => {
      if (!c.items.length) return "";
      const cards = c.items.map(pid => renderCard(pid, c)).filter(Boolean).join("");
      const subtitleHtml = c.hours ? `<div class="mp-section-meta">⏰ ${esc(c.hours)}</div>` : "";
      // 🎨 هل كل منتجات الفئة portfolio-only? → استخدم grid layout مضغوط
      const isAllPortfolio = c.items.length > 0 && c.items.every(pid => PRODS[pid] && PRODS[pid].isShowcaseOnly);
      const wrapClass = isAllPortfolio
        ? "mp-cards"
        : ((IS_ACHAY && viewMode === "grid") ? "mp-card-grid-wrap" : "mp-card-list");
      const sectionClass = isAllPortfolio ? "mp-section mp-section-portfolio" : "mp-section";
      return `
        <section class="${sectionClass}" id="mp-sec-${esc(c.id)}" data-cat="${esc(c.id)}">
          <h2 class="mp-section-title">${esc(c.name)}</h2>
          ${subtitleHtml}
          <div class="${wrapClass}">${cards}</div>
        </section>
      `;
    }).join("");

    // delegate clicks — مرة واحدة فقط (يتمنّع التكرار لو re-render)
    if (_sectionsClickBound) return;
    _sectionsClickBound = true;
    root.addEventListener("click", (e) => {
      // Stepper (-) — ينقص من آخر variant (أو الوحيد)
      const minus = e.target.closest(".mp-card-qty-minus");
      if (minus) {
        e.stopPropagation();
        const pid = minus.dataset.pid;
        const variants = _variantsOfPid(pid);
        if (variants.length === 0) return;
        // ⚡ خذ آخر variant أُضيف (أعلى qty، أو أول واحد ينقصه qty)
        // نفضّل decrement من default key (pid) لو موجود، غيرها آخر variant في المصفوفة
        const key = variants.includes(pid) ? pid : variants[variants.length - 1];
        const q = (cart[key]?.qty || 1) - 1;
        if (q <= 0) delete cart[key];
        else cart[key].qty = q;
        saveCart(); updateCardUI(pid); updateCart();
        return;
      }
      // Stepper (+) — للسايز/إضافات/محذوفات → افتح sheet لأول مرة، أو زد نفس الـ variant لو واحد
      const addBtn = e.target.closest(".mp-card-add, .mp-card-qty-plus");
      if (addBtn) {
        e.stopPropagation();
        const pid = addBtn.dataset.add || addBtn.dataset.pid;
        const p = PRODS[pid];
        const variants = _variantsOfPid(pid);
        const hasVariantOptions = p && ((p.sizes?.length) || (p.options?.length) || (p.removableIngredients?.length));
        // متعدد الـ variants → افتح sheet ليختار أي واحد يكرر
        if (hasVariantOptions && variants.length > 1) {
          openSheet(pid);
          return;
        }
        // variant واحد → زد كميته مباشرة (بنفس السايز/الإضافات)
        if (variants.length === 1) {
          const key = variants[0];
          cart[key].qty = Math.min(99, (cart[key].qty || 1) + 1);
          saveCart(); updateCardUI(pid); updateCart();
          return;
        }
        // لا شيء في السلة + منتج له خيارات → افتح sheet
        if (hasVariantOptions) {
          openSheet(pid);
          return;
        }
        // منتج بسيط تماماً → استخدم default key = pid
        cart[pid] = { qty: 1 };
        saveCart();
        updateCardUI(pid);
        updateCart();
        return;
      }
      // 🎨 Portfolio play button — يفتح فيديو الأعمال
      const playBtn = e.target.closest("[data-portfolio-video]");
      if (playBtn) {
        e.stopPropagation();
        const pid = playBtn.dataset.portfolioVideo;
        const p = PRODS[pid];
        if (p && p.videoUrl) openPortfolioVideoModal(p);
        return;
      }
      // 🎨 Portfolio card click — يعرض الصورة full-screen (lightbox خفيف)
      const portfolio = e.target.closest(".mp-portfolio-card");
      if (portfolio) {
        e.stopPropagation();
        const p = PRODS[portfolio.dataset.pid];
        if (p) openPortfolioModal(p);
        return;
      }
      const card = e.target.closest(".mp-card, .mp-card-grid");
      if (card) openSheet(card.dataset.pid);
    });
  }

  // 🎬 Portfolio video modal
  function openPortfolioVideoModal(p) {
    document.getElementById("mpPortfolioModal")?.remove();
    const isNative = /\.(mp4|webm|mov|m4v)($|\?)/i.test(p.videoUrl) || String(p.videoUrl).startsWith("/store-videos/");
    let mediaHtml = "";
    if (isNative) {
      mediaHtml = `<video src="${esc(p.videoUrl)}" controls autoplay playsinline style="width:100%;height:100%;object-fit:contain;background:#000"></video>`;
    } else {
      // YouTube/Vimeo embed
      let embedUrl = p.videoUrl;
      const yt = p.videoUrl.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_\-]{11})/);
      if (yt) embedUrl = `https://www.youtube.com/embed/${yt[1]}?rel=0&autoplay=1`;
      const vm = p.videoUrl.match(/vimeo\.com\/(?:video\/)?(\d+)/);
      if (vm) embedUrl = `https://player.vimeo.com/video/${vm[1]}?autoplay=1`;
      mediaHtml = `<iframe src="${esc(embedUrl)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen style="width:100%;height:100%;border:0"></iframe>`;
    }
    const overlay = document.createElement("div");
    overlay.id = "mpPortfolioModal";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:9999;display:flex;align-items:center;justify-content:center;padding:0;animation:mpFadeIn .2s";
    overlay.innerHTML = `
      <button aria-label="إغلاق" style="position:absolute;top:12px;right:12px;background:rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.2);color:#fff;width:44px;height:44px;border-radius:50%;font-size:22px;cursor:pointer;z-index:5">✕</button>
      <div style="width:100%;max-width:900px;aspect-ratio:16/9;background:#000">${mediaHtml}</div>
    `;
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    const close = () => { overlay.remove(); document.body.style.overflow = ""; };
    overlay.querySelector("button").addEventListener("click", close);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
  }

  // 🖼️ Portfolio image lightbox
  function openPortfolioModal(p) {
    if (!p.imageUrl && !p.videoUrl) return;
    if (p.videoUrl) return openPortfolioVideoModal(p);
    document.getElementById("mpPortfolioModal")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "mpPortfolioModal";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;animation:mpFadeIn .2s";
    overlay.innerHTML = `
      <button aria-label="إغلاق" style="position:absolute;top:12px;right:12px;background:rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.2);color:#fff;width:44px;height:44px;border-radius:50%;font-size:22px;cursor:pointer;z-index:5">✕</button>
      <img src="${esc(p.imageUrl)}" alt="${esc(p.name || '')}" style="max-width:100%;max-height:90vh;object-fit:contain;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.5)">
    `;
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    const close = () => { overlay.remove(); document.body.style.overflow = ""; };
    overlay.querySelector("button").addEventListener("click", close);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
  }

  // 🔄 يحدّث UI زر "+" → stepper (- N +) ديناميكياً حسب الكمية في السلة
  function updateCardUI(pid) {
    // أعد رسم كل أزرار هذا المنتج (قد يكون في list + grid)
    const wraps = $$(`[data-add-wrap="${pid}"]`);
    if (!wraps.length) return;
    const qty = _qtyOfPid(pid); // مجموع كل variants
    wraps.forEach(wrap => {
      if (qty > 0) {
        wrap.innerHTML = `
          <button class="mp-card-qty-minus" data-pid="${esc(pid)}" aria-label="نقص">−</button>
          <span class="mp-card-qty-val">${qty}</span>
          <button class="mp-card-qty-plus" data-pid="${esc(pid)}" aria-label="زيادة">+</button>
        `;
        wrap.classList.add("in-cart");
      } else {
        wrap.innerHTML = `<button class="mp-card-add" data-add="${esc(pid)}" aria-label="إضافة">+</button>`;
        wrap.classList.remove("in-cart");
      }
    });
  }

  // ─── Scroll-spy for tabs ───
  let spyTimer = null;
  function setupScrollSpy() {
    window.addEventListener("scroll", function onScroll() {
      if (spyTimer) return;
      spyTimer = requestAnimationFrame(() => {
        spyTimer = null;
        const sections = $$(".mp-section");
        const tabsHeight = ($(".mp-tabs")?.offsetHeight || $(".mp-cats-circles")?.offsetHeight || 0) + ($(".mp-header")?.offsetHeight || 0) + 20;
        let activeId = null;
        for (const sec of sections) {
          const r = sec.getBoundingClientRect();
          if (r.top <= tabsHeight) activeId = sec.dataset.cat;
        }
        if (activeId) {
          const tabSel = IS_ACHAY ? ".mp-cat-circle" : ".mp-tab";
          $$(tabSel).forEach(t => t.classList.toggle("active", t.dataset.cat === activeId));
          // ⚠️ scrollIntoView كان يسبب scroll-back لأعلى الصفحة على iOS Safari
          // نستخدم scrollLeft يدوياً على parent (لا يلمس scroll الـ window أبداً)
          const activeTab = $(tabSel + '[data-cat="' + activeId + '"]');
          if (activeTab) {
            const parent = activeTab.parentElement;
            if (parent) {
              const tabCenter = activeTab.offsetLeft + activeTab.offsetWidth / 2;
              parent.scrollLeft = tabCenter - parent.clientWidth / 2;
            }
          }
        }
      });
    }, { passive: true });
  }

  // ─── Cart FAB ───
  function updateCart() {
    const fab = $("#mpCartFab");
    if (!fab) return;
    const keys = Object.keys(cart);
    if (!keys.length) {
      fab.classList.remove("show");
      return;
    }
    let total = 0, count = 0;
    for (const key of keys) {
      const pid = _pidOfKey(key); // 🔑 استخراج pid من الـ key المركّب
      const p = PRODS[pid];
      if (!p) continue;
      const it = cart[key];
      const q = it.qty || 1;
      count += q;
      if (!p.priceOnRequest) {
        let basePrice = Number(p.price || 0);
        const si = it.sizeIdx || 0;
        if (p.sizes?.length && p.sizes[si]?.price) basePrice = p.sizes[si].price;
        let extras = 0;
        if (p.options?.length && Array.isArray(it.opts)) {
          for (const oi of it.opts) extras += Number(p.options[oi]?.price || 0);
        }
        total += (basePrice + extras) * q;
      }
    }
    $("#mpCartCount").textContent = count;
    $("#mpCartTotal").innerHTML = priceHtml(total);
    fab.classList.add("show");
  }

  // ─── Bottom sheet (product detail) ───
  let sheetPid = null, sheetQty = 1, sheetSizeIdx = 0, sheetOpts = new Set();
  let sheetExcluded = new Set(); // 🚫 Phase 1: المكونات المُستبعدة
  function openSheet(pid) {
    const p = PRODS[pid]; if (!p) return;
    sheetPid = pid;
    // 🔄 الـ sheet دائماً يبدأ فارغاً — العداد = 0، الزبون يضغط + ليصبح 1
    sheetQty = 0;
    sheetSizeIdx = 0;
    sheetOpts = new Set();
    sheetExcluded = new Set();
    const desc = p.description || p.desc || "";
    const cal = p.calories || p.cal;
    $("#mpSheetHero").innerHTML = (p.imageUrl
      ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}">`
      : `<div style="font-size:80px;opacity:.3">🍽️</div>`) +
      `<button class="mp-sheet-close" onclick="_mpSheetClose()">✕</button>`;
    $("#mpSheetName").textContent = p.name;
    $("#mpSheetDesc").textContent = desc;
    const meta = [];
    if (cal) meta.push(`🔥 ${cal} سعرة`);
    if (p.prepTimeMin) meta.push(`⏱️ ${p.prepTimeMin} دقيقة`);
    if (p.size) meta.push(`📏 ${p.size}`);
    if (p.spicy) meta.push(`🌶️ حار`);
    if (p.ingredients) meta.push(`🥗 ${p.ingredients.slice(0, 40)}`);
    $("#mpSheetMeta").innerHTML = meta.map(m => `<span class="mp-sheet-meta-item">${esc(m)}</span>`).join("");

    // 🆕 Modifiers
    const modsHtml = [];
    if (p.sizes?.length) {
      modsHtml.push(`<div class="mp-sheet-modifiers">
        <div class="mp-sheet-mod-title">📏 الحجم</div>
        <div class="mp-sheet-mod-chips">
          ${p.sizes.map((s, i) => `
            <button class="mp-sheet-mod-chip${i === sheetSizeIdx ? " selected" : ""}" data-size="${i}">
              <span>${esc(s.name)}</span>
              ${s.price > 0 ? `<span class="mp-sheet-mod-price">+${priceHtml(s.price)}</span>` : ""}
            </button>
          `).join("")}
        </div>
      </div>`);
    }
    if (p.options?.length) {
      modsHtml.push(`<div class="mp-sheet-modifiers">
        <div class="mp-sheet-mod-title">✨ إضافات (اختياري)</div>
        <div class="mp-sheet-mod-chips">
          ${p.options.map((o, i) => `
            <button class="mp-sheet-mod-chip${sheetOpts.has(i) ? " selected" : ""}" data-opt="${i}">
              <span>${esc(o.label)}</span>
              ${o.price > 0 ? `<span class="mp-sheet-mod-price">+${priceHtml(o.price)}</span>` : ""}
            </button>
          `).join("")}
        </div>
      </div>`);
    }
    // 🚫 Phase 1: مكونات قابلة للإزالة
    if (p.removableIngredients?.length) {
      modsHtml.push(`<div class="mp-sheet-modifiers mp-sheet-excl">
        <div class="mp-sheet-mod-title">🚫 إزالة مكونات (اختياري)</div>
        <div class="mp-sheet-mod-chips">
          ${p.removableIngredients.map((ing) => `
            <button class="mp-sheet-mod-chip${sheetExcluded.has(ing) ? " selected excluded" : ""}" data-excl="${esc(ing)}">
              <span>${sheetExcluded.has(ing) ? "بدون " : ""}${esc(ing)}</span>
            </button>
          `).join("")}
        </div>
      </div>`);
    }
    const existingMods = $(".mp-sheet-modifiers", $("#mpSheet"));
    if (existingMods) $$(".mp-sheet-modifiers", $("#mpSheet")).forEach(e => e.remove());
    if (modsHtml.length) $("#mpSheetMeta").insertAdjacentHTML("afterend", modsHtml.join(""));

    // Click handlers
    // 📌 عند تغيير الحجم: احفظ الاختيار الحالي في السلة (variant منفصل) ثم صفّر العداد للجديد
    $$(".mp-sheet-mod-chip[data-size]").forEach(b => b.addEventListener("click", () => {
      const newSize = +b.dataset.size;
      if (newSize === sheetSizeIdx) return;
      // احفظ variant الحالي فقط لو العميل ضغط + مرة واحدة على الأقل (sheetQty > 0)
      if (sheetPid && sheetQty > 0) {
        const currentKey = _ck(sheetPid, sheetSizeIdx, [...sheetOpts], [...sheetExcluded]);
        if (cart[currentKey]) {
          cart[currentKey].qty = Math.min(99, (Number(cart[currentKey].qty) || 0) + sheetQty);
        } else {
          cart[currentKey] = {
            qty: sheetQty,
            sizeIdx: sheetSizeIdx,
            opts: [...sheetOpts],
            excluded: [...sheetExcluded],
          };
        }
        saveCart();
        updateCardUI(sheetPid);
        updateCart();
      }
      // ⚡ صفّر السايز الجديد — العداد يبدأ من 0
      sheetSizeIdx = newSize;
      sheetQty = 0;
      sheetOpts = new Set();
      sheetExcluded = new Set();
      $$(".mp-sheet-mod-chip[data-size]").forEach(x => x.classList.toggle("selected", +x.dataset.size === sheetSizeIdx));
      // reset options + excluded chips visually
      $$(".mp-sheet-mod-chip[data-opt]").forEach(x => x.classList.remove("selected"));
      $$(".mp-sheet-mod-chip[data-excl]").forEach(x => {
        x.classList.remove("selected", "excluded");
        const ing = x.dataset.excl;
        const spanEl = x.querySelector("span");
        if (spanEl) spanEl.textContent = ing;
      });
      updateSheetStepper();
    }));
    $$(".mp-sheet-mod-chip[data-opt]").forEach(b => b.addEventListener("click", () => {
      const i = +b.dataset.opt;
      if (sheetOpts.has(i)) sheetOpts.delete(i); else sheetOpts.add(i);
      b.classList.toggle("selected");
      updateSheetStepper();
    }));
    // 🚫 Phase 1: toggle exclusion
    $$(".mp-sheet-mod-chip[data-excl]").forEach(b => b.addEventListener("click", () => {
      const ing = b.dataset.excl;
      if (sheetExcluded.has(ing)) {
        sheetExcluded.delete(ing);
        b.classList.remove("selected", "excluded");
        b.querySelector("span").textContent = ing;
      } else {
        sheetExcluded.add(ing);
        b.classList.add("selected", "excluded");
        b.querySelector("span").textContent = "بدون " + ing;
      }
      updateSheetStepper();
    }));

    updateSheetStepper();
    $("#mpSheetBackdrop").classList.add("show");
    $("#mpSheet").classList.add("show");
    document.body.classList.add("mp-sheet-open");
  }
  function _calcSheetSubtotal() {
    const p = sheetPid && PRODS[sheetPid];
    if (!p || p.priceOnRequest) return 0;
    let basePrice = Number(p.price || 0);
    if (p.sizes?.length && p.sizes[sheetSizeIdx]?.price) basePrice = p.sizes[sheetSizeIdx].price;
    let extras = 0;
    if (p.options?.length) for (const i of sheetOpts) extras += Number(p.options[i]?.price || 0);
    return (basePrice + extras) * sheetQty;
  }
  function closeSheet() {
    // 🧹 نظّف _editingKey لتفادي حالة عالقة لو الزبون أغلق الـ sheet وسط تعديل
    window._editingKey = null;
    $("#mpSheetBackdrop").classList.remove("show");
    $("#mpSheet").classList.remove("show");
    document.body.classList.remove("mp-sheet-open");
    sheetPid = null;
  }
  function updateSheetStepper() {
    $("#mpSheetQty").textContent = sheetQty;
    const cta = $("#mpSheetCta");
    if (!cta) return;
    // 🔢 لو العداد = 0 → عطّل الزر + رسالة تنبيه
    if (sheetQty <= 0) {
      cta.disabled = true;
      cta.style.opacity = "0.55";
      cta.style.cursor  = "not-allowed";
      cta.innerHTML = "اضغط + لبدء الطلب";
    } else {
      cta.disabled = false;
      cta.style.opacity = "1";
      cta.style.cursor  = "pointer";
      const sub = _calcSheetSubtotal();
      cta.innerHTML = sub
        ? `أضف للسلة · ${priceHtml(sub)}`
        : `أضف للسلة`;
    }
  }
  window._mpSheetClose = closeSheet;
  window._mpSheetStep = (delta) => {
    // 🔢 العداد يبدأ من 0، الحد الأدنى 0 (زر - عند 0 لا يفعل شيئاً)
    sheetQty = Math.max(0, Math.min(99, sheetQty + delta));
    updateSheetStepper();
  };
  window._mpSheetAdd = () => {
    if (!sheetPid) return;
    const isEditing = !!window._editingKey;
    // 🗑️ لو التعديل بكمية 0 → حذف من السلة
    if (isEditing && sheetQty <= 0) {
      delete cart[window._editingKey];
      window._editingKey = null;
      saveCart();
      updateCardUI(sheetPid);
      updateCart();
      closeSheet();
      showToast("🗑️ تم الحذف");
      return;
    }
    // 🛑 إضافة جديدة بكمية صفر — تنبيه
    if (sheetQty <= 0) { showToast("اضغط + لبدء الطلب", "warn"); return; }
    // 🔑 مفتاح مركّب — كل variant له entry منفصل في cart
    const key = _ck(sheetPid, sheetSizeIdx, [...sheetOpts], [...sheetExcluded]);
    // لو في وضع التعديل، احذف الـ variant القديم أولاً (المفتاح المُعدَّل قد يختلف)
    if (isEditing && window._editingKey !== key) {
      delete cart[window._editingKey];
    }
    if (isEditing) {
      // Overwrite (تعديل صريح)
      cart[key] = {
        qty: sheetQty,
        sizeIdx: sheetSizeIdx,
        opts: [...sheetOpts],
        excluded: [...sheetExcluded],
      };
    } else if (cart[key]) {
      // Add: نفس الـ variant موجود → جمّع
      cart[key].qty = Math.min(99, (Number(cart[key].qty) || 0) + sheetQty);
    } else {
      // Add: variant جديد
      cart[key] = {
        qty: sheetQty,
        sizeIdx: sheetSizeIdx,
        opts: [...sheetOpts],
        excluded: [...sheetExcluded],
      };
    }
    window._editingKey = null;
    saveCart();
    updateCardUI(sheetPid);
    updateCart();
    closeSheet();
    showToast(isEditing ? "✅ تم التعديل" : "✅ أُضيف للسلة");
  };

  // ─── Side drawer ───
  function setupDrawer() {
    $("#mpHeaderMenu")?.addEventListener("click", () => {
      $("#mpDrawerBackdrop").classList.add("show");
      $("#mpDrawer").classList.add("show");
    });
    const close = () => {
      $("#mpDrawerBackdrop").classList.remove("show");
      $("#mpDrawer").classList.remove("show");
    };
    $("#mpDrawerBackdrop")?.addEventListener("click", close);
    $$("#mpDrawer [data-action]").forEach(el => el.addEventListener("click", (e) => {
      const a = el.dataset.action;
      if (a === "close") close();
      if (a === "rate") { close(); openRateModal(); }
      if (a === "lang") toggleLang();
      if (a === "showcase") {
        close();
        // ✨ افتح صفحة استعراض المنيو (تصميم فاخر بلا سلة)
        const sid = (typeof STORE_ID !== "undefined" && STORE_ID) ? STORE_ID : "";
        if (sid) {
          try { window.open("/browse/" + encodeURIComponent(sid), "_blank", "noopener"); }
          catch { location.href = "/browse/" + encodeURIComponent(sid); }
        }
      }
    }));
  }

  // ─── Notes modal: textarea للعميل قبل الإرسال ───
  function _openNotesModal(onConfirm) {
    // أزل أي modal قديم
    document.getElementById("mpNotesModal")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "mpNotesModal";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:flex-end;justify-content:center;animation:mpFadeIn .2s";
    overlay.innerHTML = `
      <div style="background:var(--mp-bg,#fff);border-radius:24px 24px 0 0;width:100%;max-width:540px;padding:22px 20px;box-shadow:0 -8px 32px rgba(0,0,0,.25);animation:mpSlideUp .25s">
        <div style="width:48px;height:5px;background:var(--mp-border,#d4d4d8);border-radius:3px;margin:0 auto 16px"></div>
        <div style="font-size:17px;font-weight:800;color:var(--mp-text,#111);margin-bottom:6px">📝 ملاحظات لطلبك</div>
        <div style="font-size:12.5px;color:var(--mp-text-muted,#71717a);margin-bottom:14px">اكتب أي طلب خاص (مثلاً: بدون ثلج، حار، تغليف هدية...) — اختياري</div>
        <textarea id="mpOrderNotes" placeholder="ملاحظات إضافية..." style="width:100%;min-height:80px;max-height:200px;border:1.5px solid var(--mp-border,#e5e7eb);border-radius:14px;padding:12px;font-family:inherit;font-size:14px;resize:vertical;direction:rtl;background:var(--mp-card,#fff);color:var(--mp-text,#111);box-sizing:border-box"></textarea>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button id="mpNotesCancel" style="flex:1;background:var(--mp-card-alt,#f4f4f5);color:var(--mp-text,#52525b);border:none;padding:14px;border-radius:14px;font-family:inherit;font-weight:700;font-size:14px;cursor:pointer">إلغاء</button>
          <button id="mpNotesConfirm" style="flex:2;background:var(--mp-primary,#16a34a);color:#fff;border:none;padding:14px;border-radius:14px;font-family:inherit;font-weight:800;font-size:14px;cursor:pointer">✅ تأكيد الطلب</button>
        </div>
      </div>
      <style>
        @keyframes mpFadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes mpSlideUp { from { transform:translateY(100%) } to { transform:translateY(0) } }
      </style>
    `;
    document.body.appendChild(overlay);
    const ta = overlay.querySelector("#mpOrderNotes");
    setTimeout(() => ta?.focus(), 100);
    overlay.querySelector("#mpNotesCancel").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#mpNotesConfirm").addEventListener("click", () => {
      const notes = String(ta.value || "").trim().slice(0, 500);
      overlay.remove();
      onConfirm(notes);
    });
    // اضغط خارج modal = إلغاء
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // 🛒 Cart Summary Modal — يعرض ملخص السلة قبل الإرسال، مع تعديل + حذف لكل variant
  function _openCartSummary(onProceed) {
    document.getElementById("mpCartSummaryModal")?.remove();
    const keys = Object.keys(cart);
    if (!keys.length) return;

    let total = 0;
    const rows = keys.map(key => {
      const pid = _pidOfKey(key);
      const p = PRODS[pid] || {};
      const it = cart[key];
      const si = it.sizeIdx || 0;
      let basePrice = Number(p.price || 0);
      let variantDetails = [];
      if (p.sizes?.length && p.sizes[si]) {
        if (p.sizes[si].price) basePrice = p.sizes[si].price;
        variantDetails.push("📏 " + p.sizes[si].name);
      }
      let extrasSum = 0;
      if (p.options?.length && Array.isArray(it.opts)) {
        const optNames = [];
        for (const oi of it.opts) {
          const o = p.options[oi];
          if (!o) continue;
          extrasSum += Number(o.price || 0);
          optNames.push(o.label || o.name);
        }
        if (optNames.length) variantDetails.push("✨ " + optNames.join("، "));
      }
      if (Array.isArray(it.excluded) && it.excluded.length) {
        variantDetails.push("🚫 بدون " + it.excluded.join("، "));
      }
      const unitPrice = basePrice + extrasSum;
      const qty = Number(it.qty || 1);
      const subtotal = unitPrice * qty;
      if (!p.priceOnRequest) total += subtotal;
      return {
        key, pid, name: p.name || pid,
        details: variantDetails.join(" · "),
        qty, unitPrice, subtotal,
        priceOnRequest: !!p.priceOnRequest,
        imageUrl: p.imageUrl,
      };
    });

    const overlay = document.createElement("div");
    overlay.id = "mpCartSummaryModal";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:flex-end;justify-content:center;animation:mpFadeIn .2s";
    overlay.innerHTML = `
      <div style="background:var(--mp-bg,#fff);border-radius:24px 24px 0 0;width:100%;max-width:560px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 -8px 32px rgba(0,0,0,.25);animation:mpSlideUp .25s">
        <div style="padding:14px 20px 8px;position:sticky;top:0;background:var(--mp-bg,#fff);z-index:2;border-radius:24px 24px 0 0">
          <div style="width:48px;height:5px;background:var(--mp-border,#d4d4d8);border-radius:3px;margin:0 auto 12px"></div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="font-size:17px;font-weight:800;color:var(--mp-text,#111)">🛒 ملخص طلبك</div>
            <button onclick="document.getElementById('mpCartSummaryModal').remove()" style="background:none;border:none;font-size:22px;color:var(--mp-text-muted,#71717a);cursor:pointer;padding:4px 8px">✕</button>
          </div>
        </div>
        <div id="mpCartRows" style="flex:1;overflow-y:auto;padding:8px 16px">
          ${rows.map(r => `
            <div class="mp-cs-row" data-key="${esc(r.key)}" data-pid="${esc(r.pid)}" style="display:flex;gap:10px;align-items:flex-start;background:var(--mp-card,#fff);border:1px solid var(--mp-border,#e5e7eb);border-radius:14px;padding:10px 12px;margin-bottom:8px">
              ${r.imageUrl ? `<img src="${esc(r.imageUrl)}" style="width:52px;height:52px;object-fit:cover;border-radius:10px;flex-shrink:0" loading="lazy">` : ""}
              <div style="flex:1;min-width:0">
                <div style="font-weight:800;font-size:14px;color:var(--mp-text,#111)">${esc(r.name)}</div>
                ${r.details ? `<div style="font-size:11.5px;color:var(--mp-text-muted,#71717a);margin-top:3px;line-height:1.5">${esc(r.details)}</div>` : ""}
                <div style="font-size:12px;color:var(--mp-primary,#16a34a);font-weight:700;margin-top:5px">
                  ${r.priceOnRequest ? "💬 السعر عند الطلب" : `${priceHtml(r.unitPrice)} × ${r.qty} = <b>${priceHtml(r.subtotal)}</b>`}
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:4px;align-items:center;flex-shrink:0">
                <button class="mp-cs-edit" data-key="${esc(r.key)}" data-pid="${esc(r.pid)}" style="background:#dbeafe;color:#1e40af;border:none;padding:6px 10px;border-radius:8px;font-family:inherit;font-size:11px;font-weight:800;cursor:pointer">✏️ تعديل</button>
                <button class="mp-cs-del" data-key="${esc(r.key)}" data-pid="${esc(r.pid)}" style="background:#fee2e2;color:#991b1b;border:none;padding:6px 10px;border-radius:8px;font-family:inherit;font-size:11px;font-weight:800;cursor:pointer">🗑️ حذف</button>
              </div>
            </div>
          `).join("")}
        </div>
        <div style="padding:12px 20px;background:var(--mp-card-alt,#f9fafb);border-top:1px solid var(--mp-border,#e5e7eb)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <span style="font-size:14px;color:var(--mp-text-muted,#71717a)">الإجمالي</span>
            <span style="font-size:18px;font-weight:900;color:var(--mp-primary,#16a34a)">${priceHtml(total)}</span>
          </div>
          <button id="mpCartConfirm" style="width:100%;background:var(--mp-primary,#16a34a);color:#fff;border:none;padding:14px;border-radius:14px;font-family:inherit;font-weight:800;font-size:15px;cursor:pointer">✅ تأكيد الطلب</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    // Handlers
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector("#mpCartConfirm").addEventListener("click", () => {
      overlay.remove();
      onProceed();
    });
    // Edit: افتح الـ sheet مع بيانات الـ variant محمّلة
    overlay.querySelectorAll(".mp-cs-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        const pid = btn.dataset.pid;
        const it = cart[key];
        if (!it) return;
        overlay.remove();
        openSheet(pid);
        // 💡 حمّل بيانات الـ variant للتعديل
        setTimeout(() => {
          sheetQty      = it.qty || 1;
          sheetSizeIdx  = it.sizeIdx || 0;
          sheetOpts     = new Set(it.opts || []);
          sheetExcluded = new Set(it.excluded || []);
          // تحديث UI
          $$(".mp-sheet-mod-chip[data-size]").forEach(x => x.classList.toggle("selected", +x.dataset.size === sheetSizeIdx));
          $$(".mp-sheet-mod-chip[data-opt]").forEach(x => x.classList.toggle("selected", sheetOpts.has(+x.dataset.opt)));
          $$(".mp-sheet-mod-chip[data-excl]").forEach(x => {
            const ing = x.dataset.excl;
            const has = sheetExcluded.has(ing);
            x.classList.toggle("selected", has);
            x.classList.toggle("excluded", has);
            const spanEl = x.querySelector("span");
            if (spanEl) spanEl.textContent = (has ? "بدون " : "") + ing;
          });
          updateSheetStepper();
          // ⚠️ سنحذف الـ variant القديم عند الحفظ (كي لا يتضاعف)
          window._editingKey = key;
        }, 100);
      });
    });
    overlay.querySelectorAll(".mp-cs-del").forEach(btn => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        const pid = btn.dataset.pid;
        delete cart[key];
        saveCart();
        updateCardUI(pid);
        updateCart();
        // Re-render summary
        overlay.remove();
        if (Object.keys(cart).length > 0) _openCartSummary(onProceed);
      });
    });
  }

  // ─── Cart → Submit ───
  function setupCartSubmit() {
    $("#mpCartFab")?.addEventListener("click", () => {
      // 🛒 افتح ملخص السلة أولاً — الزبون يراجع + يعدّل قبل الإرسال
      _openCartSummary(() => _doSubmitOrder());
    });
  }
  function _doSubmitOrder() {
      const keys = Object.keys(cart);
      if (!keys.length) return;
      const items = keys.map(key => {
        const pid = _pidOfKey(key);            // 🔑 استخراج pid من المفتاح المركّب
        const p = PRODS[pid] || {};
        const it = cart[key];
        const si = it.sizeIdx || 0;
        let basePrice = Number(p.price || 0);
        let nameExtra = "";
        if (p.sizes?.length && p.sizes[si]) {
          if (p.sizes[si].price) basePrice = p.sizes[si].price;
          nameExtra = " — " + p.sizes[si].name;
        }
        let extrasSum = 0;
        const extraNames = [];
        if (p.options?.length && Array.isArray(it.opts)) {
          for (const oi of it.opts) {
            const o = p.options[oi];
            if (!o) continue;
            extrasSum += Number(o.price || 0);
            extraNames.push(o.label);
          }
        }
        const excl = Array.isArray(it.excluded) ? it.excluded.filter(x => typeof x === "string") : [];
        const exclTxt = excl.length ? " (بدون " + excl.join("، ") + ")" : "";
        return {
          id: pid,                              // ✅ نُرسل pid الأصلي للسيرفر (ليجد المنتج)
          name: (p.name || pid) + nameExtra + (extraNames.length ? " + " + extraNames.join(", ") : "") + exclTxt,
          qty: it.qty || 1,
          price: basePrice + extrasSum,
          excluded: excl.length ? excl : undefined,
        };
      });
      // 📝 افتح notes modal — العميل يكتب طلب مخصوص (اختياري) ثم يضغط تأكيد
      _openNotesModal((notes) => submitOrder(items, notes));
  }
  // 🛒 Restore original FAB markup (يمنع الـ FAB من البقاء عالق في "جاري الإرسال")
  function _restoreFab() {
    const btn = $("#mpCartFab");
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML =
      '<span class="mp-cart-fab-count" id="mpCartCount">0</span>' +
      '<span class="mp-cart-fab-label">إرسال الطلب</span>' +
      '<span class="mp-cart-fab-total" id="mpCartTotal">0 ' + (typeof IS_SAR !== "undefined" && IS_SAR ? SAR_SYM_HTML : esc(CUR)) + '</span>';
  }
  async function submitOrder(items, notes) {
    // 🔗 Share-link mode: لا API call — نبني نص ونفتح واتساب البوت مباشرة
    if (typeof IS_SHARE_LINK !== "undefined" && IS_SHARE_LINK && typeof BOT_PHONE !== "undefined" && BOT_PHONE) {
      const lines = items.map(i => {
        const subtotal = (Number(i.price) || 0) * (Number(i.qty) || 1);
        return `• ${i.name} × ${i.qty}` + (subtotal > 0 ? ` — ${fmt(subtotal)} ${CUR}` : "");
      });
      const total = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
      // 🔑 marker بسيط — البوت يلتقطه = "هذا طلب جاهز من المنيو، تخطى الترحيب"
      const marker = "#طلب_من_المنيو";
      const text =
        `📦 *طلب جديد من المنيو*\n\n` +
        lines.join("\n") +
        (total > 0 ? `\n\n💰 الإجمالي: *${fmt(total)} ${CUR}*` : "") +
        (notes ? `\n\n📝 ملاحظات: ${notes}` : "") +
        `\n\n${marker}`;
      // نظّف السلة قبل الإنتقال
      Object.keys(cart).forEach(k => delete cart[k]);
      saveCart();
      location.href = `https://wa.me/${BOT_PHONE}?text=${encodeURIComponent(text)}`;
      return;
    }
    const btn = $("#mpCartFab");
    btn.disabled = true;
    btn.innerHTML = '<span style="display:flex;align-items:center;justify-content:center;gap:8px;width:100%">⏳ جاري الإرسال...</span>';
    try {
      const r = await fetch("/api/order/" + TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, notes })
      });
      if (!r.ok) throw new Error("failed");
      const data = await r.json().catch(() => ({}));
      Object.keys(cart).forEach(k => delete cart[k]);
      saveCart();
      $$(".mp-card-add").forEach(b => { b.classList.remove("in-cart"); b.textContent = "+"; });
      btn.classList.remove("show");
      _restoreFab();          // 🔄 أعد الـ FAB لشكله الأصلي (يستعد لطلب جديد)
      updateCart();
      showSuccess(data);
    } catch (e) {
      _restoreFab();
      updateCart();             // يحدد إذا يبقى show أو لا
      showToast("⚠️ خطأ في الإرسال، أعد المحاولة", "err");
    }
  }
  // ✨ Success overlay (يعرض animation + يُوجّه العميل)
  function showSuccess(data) {
    const isDine = data?.dine_in || (typeof DINE_IN !== "undefined" && DINE_IN);
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:var(--mp-bg);z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;text-align:center;animation:mpFade .35s ease";
    overlay.innerHTML = `
      <style>
        @keyframes mpFade{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}
        @keyframes mpPop{0%{transform:scale(.5)}60%{transform:scale(1.18)}100%{transform:scale(1)}}
      </style>
      <div style="font-size:96px;margin-bottom:18px;animation:mpPop .55s cubic-bezier(.34,1.56,.64,1)">✅</div>
      <h2 style="font-size:26px;font-weight:800;color:var(--mp-text);margin:0 0 10px">تم استلام طلبك!</h2>
      <p style="font-size:15px;color:var(--mp-text-muted);max-width:340px;line-height:1.7;margin:0 0 24px">
        ${isDine
          ? `طاولتك ستستلم الطلب خلال دقايق 🍽️<br><small>سيتم تجهيزه الآن</small>`
          : `سيتم تحضير طلبك وإشعارك بالتفاصيل عبر واتساب 📱`}
      </p>
      ${isDine ? `
        <button id="mpSuccessDine" style="background:var(--mp-primary);color:#fff;border:none;padding:14px 32px;border-radius:999px;font-size:14px;font-weight:800;font-family:inherit;box-shadow:0 4px 12px rgba(0,0,0,.18);margin-bottom:10px">📋 عرض حالة الطلب</button>
        <button id="mpSuccessAdd" style="background:none;color:var(--mp-text-muted);border:none;padding:10px 20px;font-size:13px;font-weight:600;font-family:inherit">➕ أضف طلب جديد</button>
      ` : BOT_PHONE ? `
        <a href="whatsapp://send?phone=${esc(BOT_PHONE)}" style="background:#25D366;color:#fff;border:none;padding:14px 32px;border-radius:999px;font-size:14px;font-weight:800;text-decoration:none;display:inline-block;box-shadow:0 4px 12px rgba(37,211,102,.3)">💬 العودة للواتساب</a>
      ` : ""}
    `;
    document.body.appendChild(overlay);

    if (isDine) {
      $("#mpSuccessDine")?.addEventListener("click", () => {
        overlay.remove();
        if (typeof dineOpen === "function") dineOpen();
        else location.reload();
      });
      $("#mpSuccessAdd")?.addEventListener("click", () => overlay.remove());
    } else if (BOT_PHONE) {
      setTimeout(() => { try { location.href = "whatsapp://send?phone=" + BOT_PHONE; } catch {} }, 2500);
    }
  }

  // ─── Toast ───
  function showToast(msg, type) {
    let t = $("#mpToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "mpToast";
      t.style.cssText = "position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:12px 22px;border-radius:24px;font-size:14px;font-weight:700;z-index:100;box-shadow:0 8px 24px rgba(0,0,0,.3);opacity:0;transition:opacity .25s;pointer-events:none";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    if (type === "err") t.style.background = "#dc2626"; else t.style.background = "#1a1a1a";
    t.style.opacity = "1";
    setTimeout(() => t.style.opacity = "0", 2500);
  }

  // ─── Rate modal (simple) ───
  function openRateModal() {
    const html = `
      <div id="mpRateBackdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:80;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)this.remove()">
        <div style="background:var(--mp-card);border-radius:20px;max-width:380px;width:100%;padding:24px;text-align:center">
          <div style="font-size:48px;margin-bottom:8px">⭐</div>
          <h3 style="margin:0 0 14px;font-size:18px;font-weight:800">قيّم تجربتك معنا</h3>
          <div id="mpStars" style="display:flex;justify-content:center;gap:8px;margin-bottom:14px">
            ${[1,2,3,4,5].map(i => `<button data-r="${i}" style="background:none;border:none;font-size:36px;cursor:pointer;color:#ddd">★</button>`).join("")}
          </div>
          <textarea id="mpRateNote" placeholder="اكتب ملاحظتك (اختياري)" style="width:100%;border:1.5px solid var(--mp-border);border-radius:12px;padding:10px;font-family:inherit;font-size:13px;resize:vertical;min-height:80px;direction:rtl"></textarea>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button onclick="document.getElementById('mpRateBackdrop').remove()" style="flex:1;background:var(--mp-bg);border:1.5px solid var(--mp-border);border-radius:24px;padding:12px;font-weight:700;font-family:inherit">إلغاء</button>
            <button onclick="window._mpSubmitRate()" style="flex:2;background:var(--mp-primary);color:#fff;border:none;border-radius:24px;padding:12px;font-weight:800;font-family:inherit">إرسال</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", html);
    let rating = 0;
    $("#mpStars").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      rating = +b.dataset.r;
      $$("#mpStars button").forEach((s, i) => s.style.color = (i < rating) ? "#F59E0B" : "#ddd");
    });
    window._mpSubmitRate = async () => {
      if (!rating) { showToast("⚠️ اختر عدد النجوم", "err"); return; }
      const note = $("#mpRateNote").value.trim();
      // Use existing dine-in message endpoint as transport for now
      try {
        if (typeof DINE_IN !== "undefined" && DINE_IN) {
          await fetch("/api/dine-in/" + TOKEN + "/message", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: `⭐ تقييم ${rating}/5\n${note || "بدون ملاحظات"}` })
          });
        }
        $("#mpRateBackdrop")?.remove();
        showToast("🌹 شكراً لتقييمك!");
      } catch { showToast("⚠️ فشل الإرسال", "err"); }
    };
  }

  // ─── Lang toggle (simple AR/EN) ───
  function toggleLang() {
    const cur = document.documentElement.lang || "ar";
    document.documentElement.lang = cur === "ar" ? "en" : "ar";
    document.documentElement.dir = cur === "ar" ? "ltr" : "rtl";
    // Render-time labels stay as Arabic for now (full i18n is Phase 6)
    showToast(cur === "ar" ? "English mode (basic)" : "الوضع العربي");
  }

  // ─── Init ───
  // 🖼️ Image fallback handler (يحل محل onerror inline — أنظف وأكثر أماناً)
  function setupImageFallback() {
    document.addEventListener("error", (e) => {
      const img = e.target;
      if (!img || img.tagName !== "IMG" || !img.dataset.fallback) return;
      const fb = img.dataset.fallback;
      const parent = img.parentNode;
      if (!parent) return;
      const placeholder = document.createElement("div");
      placeholder.className = "mp-card-img-placeholder";
      placeholder.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:32px";
      placeholder.textContent = fb;
      img.style.display = "none";
      parent.appendChild(placeholder);
    }, true); // capture phase to catch image errors
  }

  function init() {
    // 🧹 امسح أي state عالق من جلسة سابقة (sheet/drawer قد يكون عالق fixed)
    document.body.classList.remove("mp-sheet-open", "mp-drawer-open");
    if (!Array.isArray(CATS) || !CATS.length) {
      console.warn("[mp] CATS empty — falling back");
      return;
    }
    if (!PRODS || typeof PRODS !== "object") {
      console.warn("[mp] PRODS missing");
      return;
    }
    setupImageFallback();
    renderTabs();
    renderSections();
    setupScrollSpy();
    setupDrawer();
    setupCartSubmit();
    setupViewToggle();
    updateCart();
    console.log("[mp] init OK — cats:", CATS.length, "prods:", Object.keys(PRODS).length);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
