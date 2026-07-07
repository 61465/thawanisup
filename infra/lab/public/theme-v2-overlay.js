/**
 * 🎨 Theme v2 Overlay JS — يبني sidebar + topbar تلقائياً من tabs القديمة
 *
 * يعمل بعد DOMContentLoaded — يقرأ كل .tab في .tabs الأصلية
 * ويبني منها sidebar dark على اليمين + يربط showTab() بشكل نظيف.
 *
 * Safe: لا يلمس JS الأصلي، فقط يضيف عناصر DOM جديدة.
 */
(function () {
  "use strict";

  function init() {
    const appScreen = document.getElementById("appScreen");
    if (!appScreen) return;

    // إن كان مبنياً مسبقاً → skip
    if (document.getElementById("tv2-sidebar")) return;

    // 1. ابني الـ sidebar (مع class .sidebar ليلتقطها ux-enhancements الموحّد)
    const sidebar = document.createElement("aside");
    sidebar.id = "tv2-sidebar";
    sidebar.className = "sidebar"; // يطابق نمط master.html → يستفيد من ux-enhancements drawer + desktop hide
    sidebar.innerHTML = `
      <div class="tv2-header">
        <div class="tv2-logo">T</div>
        <div class="tv2-brand">
          <div class="name">منصة ثواني</div>
          <div class="store" id="tv2-storeName">لوحة التاجر</div>
        </div>
      </div>
      <div class="tv2-nav" id="tv2-nav"></div>
      <div class="tv2-footer">
        <button onclick="if(typeof doLogout==='function')doLogout(); else { localStorage.clear(); location.href='/login.html'; }">🚪 تسجيل الخروج</button>
      </div>
    `;
    document.body.appendChild(sidebar);

    // backdrop للموبايل
    const backdrop = document.createElement("div");
    backdrop.id = "tv2-backdrop";
    backdrop.onclick = () => toggleSidebar(false);
    document.body.appendChild(backdrop);

    // 2. ابني topbar
    const topbar = document.createElement("div");
    topbar.id = "tv2-topbar";
    topbar.innerHTML = `
      <button id="tv2-menu-toggle" onclick="window._tv2Toggle()" title="إخفاء/إظهار القائمة">☰</button>
      <div class="tv2-title" id="tv2-pageTitle">لوحة المعلومات</div>
      <div class="tv2-meta">
        <span id="tv2-storeBadge" style="font-size:12px;color:#cfd8d4"></span>
      </div>
    `;
    document.body.appendChild(topbar);

    // 3. اقرأ tabs الـ الرئيسية فقط (#tabsBar) — لا sub-tabs داخل sections
    const navBox = document.getElementById("tv2-nav");
    const tabsBar = document.getElementById("tabsBar");
    const oldTabs = tabsBar ? tabsBar.querySelectorAll(":scope > .tab") : [];
    if (!oldTabs.length) {
      // ربما الـ tabs لم تُحمَّل بعد، أعد المحاولة
      setTimeout(init, 200);
      return;
    }

    oldTabs.forEach(t => {
      // استخرج النص + الـ id الأصلي
      const id = t.id; // مثل: tabMenu
      const labelEl = t.querySelector("[data-biz]") || t;
      const label = (labelEl.textContent || t.textContent || "").trim();
      // استخرج اسم الـ tab من id (tabMenu → menu)
      const tabName = id.replace(/^tab/, "").charAt(0).toLowerCase() + id.replace(/^tab/, "").slice(1);
      // tab مخفي أصلاً → نخفيه في sidebar
      const item = document.createElement("a");
      item.className = "tv2-item";
      item.dataset.tab = tabName;
      item.dataset.origTabId = id;
      item.innerHTML = `<span class="tv2-label">${label}</span>`;
      item.style.cssText = window.getComputedStyle(t).display === "none" ? "display:none" : "";
      item.onclick = (e) => {
        e.preventDefault();
        if (typeof showTab === "function") {
          showTab(tabName);
          // تحديث الـ active في sidebar
          document.querySelectorAll("#tv2-sidebar .tv2-item").forEach(x => x.classList.remove("active"));
          item.classList.add("active");
          // عنوان
          document.getElementById("tv2-pageTitle").textContent = label;
          // إغلاق sidebar في الموبايل
          if (window.innerWidth <= 1024) toggleSidebar(false);
        }
      };
      navBox.appendChild(item);
    });

    // 4. أول tab نشط
    const firstActiveTab = document.querySelector(".tabs .tab.active");
    if (firstActiveTab) {
      const firstId = firstActiveTab.id.replace(/^tab/, "").charAt(0).toLowerCase() + firstActiveTab.id.replace(/^tab/, "").slice(1);
      const matchingItem = document.querySelector(`#tv2-sidebar .tv2-item[data-tab="${firstId}"]`);
      if (matchingItem) matchingItem.classList.add("active");
      document.getElementById("tv2-pageTitle").textContent = (firstActiveTab.textContent || "").trim();
    }

    // 5. اسم المتجر في الـ sidebar
    const storeName = localStorage.getItem("store_name") || "";
    if (storeName) {
      document.getElementById("tv2-storeName").textContent = storeName;
      document.getElementById("tv2-storeBadge").textContent = storeName;
    }

    // 6. مراقب: لو القديم أضاف tab جديد ديناميكياً (Gaming Topup) → نُضيفه للـ sidebar
    const observer = new MutationObserver(() => {
      const allOldTabs = tabsBar ? tabsBar.querySelectorAll(":scope > .tab") : [];
      const existingIds = new Set([...document.querySelectorAll("#tv2-sidebar .tv2-item")].map(x => x.dataset.origTabId));
      allOldTabs.forEach(t => {
        if (existingIds.has(t.id)) {
          // sync الـ display state
          const existing = document.querySelector(`#tv2-sidebar .tv2-item[data-orig-tab-id="${t.id}"]`);
          if (existing) {
            const isHidden = window.getComputedStyle(t).display === "none";
            existing.style.display = isHidden ? "none" : "";
          }
          return;
        }
        // tab جديد → نُضيفه
        const label = ((t.querySelector("[data-biz]") || t).textContent || "").trim();
        const tabName = t.id.replace(/^tab/, "").charAt(0).toLowerCase() + t.id.replace(/^tab/, "").slice(1);
        const item = document.createElement("a");
        item.className = "tv2-item";
        item.dataset.tab = tabName;
        item.dataset.origTabId = t.id;
        item.innerHTML = `<span class="tv2-label">${label}</span>`;
        item.onclick = (e) => {
          e.preventDefault();
          if (typeof showTab === "function") {
            showTab(tabName);
            document.querySelectorAll("#tv2-sidebar .tv2-item").forEach(x => x.classList.remove("active"));
            item.classList.add("active");
            document.getElementById("tv2-pageTitle").textContent = label;
            if (window.innerWidth <= 1024) toggleSidebar(false);
          }
        };
        navBox.appendChild(item);
      });
    });
    if (tabsBar) observer.observe(tabsBar, { attributes: true, attributeFilter: ["style"], subtree: true, childList: true });

    // 7. Safety sync — كل 2 ثانية نُحدّث visibility الـ sidebar items من tabs الأصلية
    function syncVisibility() {
      const items = document.querySelectorAll("#tv2-sidebar .tv2-item");
      items.forEach(item => {
        const origId = item.dataset.origTabId;
        if (!origId) return;
        const orig = document.getElementById(origId);
        if (!orig) return;
        const isHidden = window.getComputedStyle(orig).display === "none";
        item.style.display = isHidden ? "none" : "";
      });
    }
    setInterval(syncVisibility, 2000);
    syncVisibility();

    console.log("[theme-v2-overlay] sidebar built with", oldTabs.length, "tabs");
  }

  function toggleSidebar(open) {
    const sb = document.getElementById("tv2-sidebar");
    const bd = document.getElementById("tv2-backdrop");
    if (!sb) { console.warn("[tv2] sidebar not built yet"); return; }
    const isMobile = window.innerWidth <= 1024;
    if (isMobile) {
      // mobile: drawer toggle
      const should = open === undefined ? !document.body.classList.contains("ux-sidebar-open") : open;
      // 🧹 امسح أي ux-sidebar-hidden قديم من وضع desktop (يسبب تعارض)
      document.body.classList.remove("ux-sidebar-hidden");
      document.body.classList.toggle("ux-sidebar-open", should);
      sb.classList.toggle("tv2-open", should); // backward compat
      if (bd) bd.classList.toggle("tv2-show", should);
      // 🚧 منع تمرير الـ body خلف الـ drawer
      document.body.style.overflow = should ? "hidden" : "";
    } else {
      // desktop: hide/show + main expands (master pattern)
      const should = open === undefined ? !document.body.classList.contains("ux-sidebar-hidden") : !open;
      document.body.classList.toggle("ux-sidebar-hidden", should);
      try { localStorage.setItem("tv2_sidebar_hidden", should ? "1" : "0"); } catch {}
    }
  }
  window._tv2Toggle = (open) => toggleSidebar(open);
  window._tv2Close = () => {
    if (window.innerWidth <= 1024) toggleSidebar(false);
  };
  // restore desktop preference
  try {
    if (localStorage.getItem("tv2_sidebar_hidden") === "1" && window.innerWidth > 1024) {
      document.body.classList.add("ux-sidebar-hidden");
    }
  } catch {}

  // الـ sidebar ثابتة في desktop (مثل master.html) + drawer في الموبايل
  // CSS وحده يكفي — لا حاجة لـ JS resize

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  // إعادة المحاولة لاحقاً (لو showApp() ضخّ DOM بعد load)
  setTimeout(init, 500);
  setTimeout(init, 1500);
})();
