// ════════════════════════════════════════════════════════════
//  UX Enhancements — ثواني | Thawani
//  يُحمَّل في store-admin.html + master.html
//  - Scroll up/down floating buttons
//  - Sidebar toggle (mobile + desktop)
//  - Auto-logout on 401 (يحل مشكلة "يحتاج refresh عدة مرات")
//  - First-login welcome onboarding (مرة واحدة فقط)
// ════════════════════════════════════════════════════════════

(function () {
  // ─── 1) Floating Scroll Buttons (Up / Down) ────────────────
  function injectScrollButtons() {
    if (document.getElementById("uxScrollUp")) return;
    const css = `
      .ux-scroll-fab{
        position:fixed;left:16px;width:44px;height:44px;border-radius:50%;
        background:#1b5e20;color:#fff;border:none;cursor:pointer;
        font-size:20px;display:flex;align-items:center;justify-content:center;
        box-shadow:0 4px 16px rgba(0,0,0,.25);z-index:9999;
        opacity:0;pointer-events:none;transition:opacity .2s,transform .15s;
        font-family:inherit
      }
      .ux-scroll-fab.show{opacity:.9;pointer-events:auto}
      .ux-scroll-fab:hover{opacity:1;transform:scale(1.08)}
      .ux-scroll-fab:active{transform:scale(.94)}
      #uxScrollUp{bottom:80px}
      #uxScrollDown{bottom:24px;background:#374151}
      @media (max-width:640px){
        .ux-scroll-fab{left:12px;width:40px;height:40px;font-size:18px}
        #uxScrollUp{bottom:72px}
      }
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const up = document.createElement("button");
    up.id = "uxScrollUp"; up.className = "ux-scroll-fab"; up.title = "للأعلى"; up.textContent = "▲";
    up.onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });

    const down = document.createElement("button");
    down.id = "uxScrollDown"; down.className = "ux-scroll-fab"; down.title = "للأسفل"; down.textContent = "▼";
    down.onclick = () => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });

    document.body.appendChild(up);
    document.body.appendChild(down);

    function updateVisibility() {
      const scrolled  = window.scrollY > 240;
      const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 100;
      up.classList.toggle("show", scrolled);
      down.classList.toggle("show", !nearBottom && document.body.scrollHeight > window.innerHeight + 200);
    }
    window.addEventListener("scroll", updateVisibility, { passive: true });
    window.addEventListener("resize", updateVisibility);
    setTimeout(updateVisibility, 600);
  }

  // ─── 2) Sidebar toggle (للقائمة الجانبية) ─────────────────
  function injectSidebarToggle() {
    const sidebar = document.querySelector(".sidebar") || document.querySelector("aside");
    if (!sidebar || document.getElementById("uxSidebarToggle")) return;
    // 🛑 لو theme-v2 موجود (store-admin)، يكون له toggle خاص — لا نحقن نسخة ثانية
    if (document.getElementById("tv2-menu-toggle") || document.getElementById("tv2-sidebar")) return;
    const css = `
      .ux-sidebar-toggle{
        position:fixed;top:14px;right:14px;width:42px;height:42px;border-radius:10px;
        background:#1b5e20;color:#fff;border:none;cursor:pointer;
        font-size:20px;display:flex;align-items:center;justify-content:center;
        box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:9998;font-family:inherit
      }
      .ux-sidebar-toggle:hover{background:#15803d}
      .sidebar,aside,.main-wrap,.main{transition:transform .28s ease, margin .28s ease, max-width .28s ease}
      body.ux-sidebar-hidden .sidebar,
      body.ux-sidebar-hidden aside{transform:translateX(110%)}
      /* تمديد الـ main عند إخفاء القائمة (desktop) */
      body.ux-sidebar-hidden .main-wrap{margin-right:0 !important;max-width:100vw !important}
      body.ux-sidebar-hidden .main{max-width:1400px !important}
      @media (max-width:900px){
        body:not(.ux-sidebar-open) .sidebar,
        body:not(.ux-sidebar-open) aside{transform:translateX(110%)}
        body.ux-sidebar-open::after{
          content:"";position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:50
        }
      }
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const btn = document.createElement("button");
    btn.id = "uxSidebarToggle"; btn.className = "ux-sidebar-toggle";
    btn.title = "إخفاء/إظهار القائمة";
    btn.innerHTML = "☰";
    btn.onclick = () => {
      if (window.innerWidth <= 900) {
        document.body.classList.toggle("ux-sidebar-open");
      } else {
        document.body.classList.toggle("ux-sidebar-hidden");
        try { localStorage.setItem("sidebar_hidden", document.body.classList.contains("ux-sidebar-hidden") ? "1" : "0"); } catch {}
      }
    };
    document.body.appendChild(btn);

    // restore preference
    try {
      if (localStorage.getItem("sidebar_hidden") === "1" && window.innerWidth > 900) {
        document.body.classList.add("ux-sidebar-hidden");
      }
    } catch {}

    // close on outside click in mobile
    document.addEventListener("click", (e) => {
      if (window.innerWidth > 900) return;
      if (!document.body.classList.contains("ux-sidebar-open")) return;
      if (sidebar.contains(e.target) || btn.contains(e.target)) return;
      document.body.classList.remove("ux-sidebar-open");
    });
  }

  // ─── 3) Auto-logout on 401 (يصلح "login يحتاج refresh") ──
  // يلتقط fetch errors ويفعّل clearAuth() على 401
  function attachAuthGuard() {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      if (res.status === 401 || res.status === 403) {
        const url = String(args[0] || "");
        if (url.includes("/store/") || url.includes("/master/")) {
          // الـ token غير صالح — امسح وأعد التسجيل
          try {
            localStorage.removeItem("store_token");
            localStorage.removeItem("master_token");
          } catch {}
          // لا توجّه فوراً — الكود قد يعالج 401 بنفسه. فقط ننظف.
        }
      }
      return res;
    };
  }

  // ─── 4) First-login welcome onboarding (مرة واحدة) ────────
  window.showFirstTimeWelcome = function (storeName, welcomeHTML) {
    const flagKey = "welcome_shown_" + (localStorage.getItem("store_id") || "default");
    if (localStorage.getItem(flagKey) === "1") return false;
    const overlay = document.createElement("div");
    overlay.id = "welcomeOverlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;animation:fadeIn .3s";
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:18px;max-width:560px;width:100%;padding:32px;box-shadow:0 24px 60px rgba(0,0,0,.3);animation:slideUp .35s">
        <div style="text-align:center;margin-bottom:18px">
          <div style="font-size:56px;margin-bottom:8px">🎉</div>
          <h2 style="font-size:22px;font-weight:900;color:#15803d;margin-bottom:6px">أهلاً بك في ثواني | Thawani</h2>
          <div style="font-size:14px;color:#6b7280">${storeName ? "متجرك: <strong>" + storeName + "</strong>" : ""}</div>
        </div>
        ${welcomeHTML || `
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;margin-bottom:18px;line-height:1.9;font-size:14px;color:#166534">
            🚀 <strong>ابدأ في 4 خطوات:</strong>
            <ol style="margin:10px 22px 0;padding:0">
              <li>أضف منتجاتك أو خدماتك من تبويب القائمة</li>
              <li>اربط رقم واتساب متجرك من تبويب "📱 ربط واتساب"</li>
              <li>اضبط شعار ولون متجرك من الإعدادات</li>
              <li>شارك رابط طلبك مع عملائك وابدأ البيع</li>
            </ol>
          </div>
        `}
        <div style="display:flex;gap:10px;justify-content:center;margin-top:18px">
          <button onclick="document.getElementById('welcomeOverlay').remove(); localStorage.setItem('${flagKey}','1')"
                  style="background:#15803d;color:#fff;border:none;padding:12px 28px;border-radius:999px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit">
            هيا نبدأ ✨
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    localStorage.setItem(flagKey, "1");
    return true;
  };

  // ─── Initialize after DOM ready ───────────────────────────
  function init() {
    injectScrollButtons();
    injectSidebarToggle();
    attachAuthGuard();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
