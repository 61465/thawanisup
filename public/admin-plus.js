/* admin-plus.js — 2026-07-07 — 13 UX enhancements bundle
   All features additive, opt-in via <script src="/admin-plus.js" defer>
   Rollback = remove the script tag.
*/
(function () {
  "use strict";

  // ─── Helpers ────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0,2) === "on") n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    if (children) children.forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function debounce(fn, ms) {
    var t; return function () { var a = arguments, ctx = this; clearTimeout(t); t = setTimeout(function () { fn.apply(ctx, a); }, ms); };
  }
  function fuzzyMatch(query, text) {
    query = (query || "").toLowerCase().trim();
    text = (text || "").toLowerCase();
    if (!query) return { matched: true, score: 0, hits: [] };
    var qi = 0, hits = [], score = 0;
    for (var i = 0; i < text.length && qi < query.length; i++) {
      if (text[i] === query[qi]) { hits.push(i); qi++; score++; }
    }
    return { matched: qi === query.length, score: score, hits: hits };
  }
  function highlight(text, hits) {
    if (!hits || !hits.length) return text;
    var out = "", set = {}, i;
    hits.forEach(function (h) { set[h] = true; });
    for (i = 0; i < text.length; i++) {
      out += set[i] ? "<mark>" + text[i] + "</mark>" : text[i];
    }
    return out;
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 1: MERGE TABS — hide 4 tabs; redirect their functionality
  // ═════════════════════════════════════════════════════════════
  function mergeTabsInit() {
    // Hide 4 tabs (they still exist in DOM, sections work)
    var toHide = ["tabRejections", "tabSupport", "tabShowcase", "tabWhatsapp"];
    toHide.forEach(function (id) {
      var t = $(id);
      if (t) t.style.setProperty("display", "none", "important");
    });

    // For merged views: intercept showTab to render mixed sections
    var origShowTab = window.showTab;
    if (typeof origShowTab !== "function") return;

    var MERGED = {
      // orders → also shows rejections section below
      orders:  ["orders", "rejections"],
      // inbox → also shows support section
      inbox:   ["inbox", "tickets", "support"],
      // menu → also shows showcase
      menu:    ["menu", "showcase"],
      // settings → also shows whatsapp
      settings: ["settings", "whatsapp"]
    };

    function insertMergeDivider(section, name) {
      if (section.dataset.plusMerged === "1") return;
      section.dataset.plusMerged = "1";
      var labels = { rejections: "⚠️ أسباب الرفض", support: "🆘 الدعم", showcase: "🎨 استعراض المنتجات", whatsapp: "📱 ربط واتساب" };
      var label = labels[name];
      if (!label) return;
      var hr = el("div", {
        style: "margin:32px 0 16px;padding:14px 20px;background:linear-gradient(135deg,#e8f5e9,transparent);border-right:4px solid #1b5e20;border-radius:10px;font-size:17px;font-weight:900;color:#1b5e20;font-family:inherit"
      });
      hr.textContent = label;
      section.insertBefore(hr, section.firstChild);
    }

    var LOADERS = {
      rejections: window.loadRejections,
      tickets:    window.loadTickets,
      support:    window.supportLoad,
      showcase:   window.scLoad,
      whatsapp:   window.loadWaStatus
    };

    var newShowTab = function (name) {
      // If this is one of our merged parents, show all children
      var subs = MERGED[name];
      if (subs) {
        origShowTab.call(window, subs[0]);
        for (var i = 1; i < subs.length; i++) {
          var sec = $(subs[i] + "Section");
          if (sec) {
            sec.style.display = "";
            insertMergeDivider(sec, subs[i]);
          }
          try { if (typeof LOADERS[subs[i]] === "function") LOADERS[subs[i]](); } catch (e) {}
        }
        return;
      }
      return origShowTab.apply(this, arguments);
    };
    window.showTab = newShowTab;
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 2: COMMAND PALETTE (Ctrl+K)
  // ═════════════════════════════════════════════════════════════
  var COMMANDS = [
    { id:"dash",       label:"📊 لوحة التحكم",           kw:"dashboard main", action: function(){ safeShowTab("dash"); } },
    { id:"orders",     label:"📦 الطلبات",              kw:"orders sales",  action: function(){ safeShowTab("orders"); } },
    { id:"menu",       label:"🛍️ المنيو والمنتجات",       kw:"products menu", action: function(){ safeShowTab("menu"); } },
    { id:"customers",  label:"👥 العملاء والولاء",       kw:"customers loyalty ratings", action: function(){ safeShowTab("customers"); } },
    { id:"inbox",      label:"🔔 الإشعارات والتذاكر",   kw:"notifications inbox", action: function(){ safeShowTab("inbox"); } },
    { id:"bookings",   label:"📅 الحجوزات",             kw:"bookings appointments", action: function(){ safeShowTab("bookings"); }, requires: function(){ var t = document.getElementById("tabBookings"); return t && t.style.display !== "none" && t.dataset.featureGated !== "1"; } },
    { id:"accounting", label:"💰 الحسابات والأرباح",     kw:"accounting profit revenue", action: function(){ safeShowTab("accounting"); } },
    { id:"themes",     label:"🎨 الثيمات",              kw:"themes colors design", action: function(){ safeShowTab("themes"); } },
    { id:"settings",   label:"⚙️ إعدادات المتجر",       kw:"settings config", action: function(){ safeShowTab("settings"); } },
    { id:"archive",    label:"📚 الأرشيف والمخزون",     kw:"archive inventory stock", action: function(){ safeShowTab("archive"); } },
    { id:"botq",       label:"🤖 أسئلة البوت",          kw:"bot questions", action: function(){ safeShowTab("botq"); } },
    { id:"add-product",label:"➕ إضافة منتج جديد",      kw:"add product new item", action: function(){ safeShowTab("menu"); setTimeout(function(){ var b=document.querySelector("[onclick*='openProductModal']"); if(b) b.click(); }, 400); } },
    { id:"broadcast",  label:"📢 بث رسالة للعملاء",     kw:"broadcast message marketing", action: function(){ safeShowTab("customers"); setTimeout(function(){ var s=$("broadcastSection"); if(s) s.scrollIntoView({behavior:"smooth"}); }, 600); } },
    { id:"export-csv", label:"📥 تصدير الطلبات CSV",   kw:"export csv excel download", action: function(){ safeShowTab("orders"); setTimeout(function(){ var b=document.querySelector("[onclick*='exportCSV'],[onclick*='exportOrders']"); if(b) b.click(); }, 500); } },
    { id:"help",       label:"❓ الاختصارات",           kw:"help shortcuts keys", action: function(){ toggleKbdHelp(true); } },
    { id:"logout",     label:"🚪 تسجيل خروج",           kw:"logout exit", action: function(){ if (window.logout) window.logout(); } }
  ];

  function safeShowTab(t) { try { if (window.showTab) window.showTab(t); } catch (e) {} }

  var cmdpState = { activeIdx: 0, results: [] };
  function cmdpBuild() {
    if ($("cmdpBackdrop")) return;
    var backdrop = el("div", { class: "cmdp-backdrop", id: "cmdpBackdrop", onclick: function(e){ if (e.target === backdrop) cmdpToggle(false); } });
    var modal = el("div", { class: "cmdp-modal" });
    var input = el("input", { class: "cmdp-input", id: "cmdpInput", placeholder: "🔍 ابحث عن أي شيء... (اكتب اسم الميزة)", type: "text" });
    var results = el("div", { class: "cmdp-results", id: "cmdpResults" });
    var isMac = navigator.platform.toUpperCase().indexOf("MAC") !== -1;
    var kSym = isMac ? "⌘" : "Ctrl";
    var footer = el("div", { class: "cmdp-footer", html: '<span><kbd>↑</kbd><kbd>↓</kbd> للتنقل</span><span><kbd>↵</kbd> للاختيار</span><span><kbd>Esc</kbd> للإغلاق</span><span><kbd>' + kSym + '</kbd>+<kbd>K</kbd> للفتح</span>' });
    modal.appendChild(input);
    modal.appendChild(results);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    input.addEventListener("input", cmdpFilter);
    input.addEventListener("keydown", cmdpKeydown);
  }
  function cmdpFilter() {
    var q = ($("cmdpInput").value || "").trim();
    var matches = [];
    COMMANDS.forEach(function (c) {
      // Check availability guard (e.g., bookings only for booking businesses)
      if (typeof c.requires === "function") {
        try { if (!c.requires()) return; } catch (e) { return; }
      }
      var m1 = fuzzyMatch(q, c.label);
      var m2 = fuzzyMatch(q, c.kw || "");
      if (m1.matched || m2.matched) {
        matches.push({ cmd: c, hits: m1.matched ? m1.hits : [], score: (m1.score + m2.score) });
      }
    });
    matches.sort(function (a, b) { return b.score - a.score; });
    matches = matches.slice(0, 8);
    cmdpState.results = matches;
    cmdpState.activeIdx = 0;
    cmdpRender();
  }
  function cmdpRender() {
    var box = $("cmdpResults");
    if (!box) return;
    box.innerHTML = "";
    if (cmdpState.results.length === 0) {
      box.innerHTML = '<div class="cmdp-empty">🔍 لا نتائج تطابق البحث</div>';
      return;
    }
    cmdpState.results.forEach(function (r, i) {
      var it = el("div", { class: "cmdp-item" + (i === cmdpState.activeIdx ? " active" : ""), onclick: function(){ cmdpExec(i); } });
      it.innerHTML = highlight(r.cmd.label, r.hits);
      box.appendChild(it);
    });
  }
  function cmdpKeydown(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); cmdpState.activeIdx = Math.min(cmdpState.activeIdx + 1, cmdpState.results.length - 1); cmdpRender(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cmdpState.activeIdx = Math.max(0, cmdpState.activeIdx - 1); cmdpRender(); }
    else if (e.key === "Enter") { e.preventDefault(); cmdpExec(cmdpState.activeIdx); }
    else if (e.key === "Escape") { cmdpToggle(false); }
  }
  function cmdpExec(i) {
    var r = cmdpState.results[i];
    if (!r) return;
    cmdpToggle(false);
    try { r.cmd.action(); } catch (e) { console.error(e); }
  }
  function cmdpToggle(open) {
    cmdpBuild();
    var b = $("cmdpBackdrop"); if (!b) return;
    b.classList.toggle("open", !!open);
    if (open) { $("cmdpInput").value = ""; cmdpFilter(); setTimeout(function(){ $("cmdpInput").focus(); }, 60); }
  }
  window.openCmdPalette = function () { cmdpToggle(true); };

  // ═════════════════════════════════════════════════════════════
  // FEATURE 3: NOTIFICATION PANEL (dropdown from bell)
  // ═════════════════════════════════════════════════════════════
  function notifpBuild() {
    if ($("notifpPanel")) return;
    var panel = el("div", { class: "notifp-panel", id: "notifpPanel" });
    panel.innerHTML = ''
      + '<div class="notifp-head">'
        + '<h3>🔔 الإشعارات</h3>'
        + '<div class="notifp-head-actions">'
          + '<button onclick="window.notifpMarkAll()">✓ الكل مقروء</button>'
          + '<button onclick="window.notifpClose()">✕</button>'
        + '</div>'
      + '</div>'
      + '<div class="notifp-list" id="notifpList"><div class="notifp-empty"><div class="notifp-empty-icon">⏳</div>جاري التحميل...</div></div>'
      + '<div class="notifp-foot"><button onclick="window.notifpClose(); safeShowTab(\'inbox\')">عرض كل الإشعارات</button></div>';
    document.body.appendChild(panel);

    // Outside click closes
    document.addEventListener("click", function (e) {
      var p = $("notifpPanel");
      if (!p || !p.classList.contains("open")) return;
      if (p.contains(e.target)) return;
      var bell = document.querySelector(".notifp-bell-btn");
      if (bell && bell.contains(e.target)) return;
      p.classList.remove("open");
    });
  }
  function fmtTime(ts) {
    try {
      var d = new Date(ts);
      var diff = (Date.now() - d.getTime()) / 1000;
      if (diff < 60) return "الآن";
      if (diff < 3600) return Math.floor(diff / 60) + " د";
      if (diff < 86400) return Math.floor(diff / 3600) + " س";
      return Math.floor(diff / 86400) + " يوم";
    } catch (e) { return ""; }
  }
  async function notifpLoad() {
    var list = $("notifpList");
    if (!list) return;
    try {
      var r = await window.api("GET", "/store/notifications/inbox");
      var items = (r.items || []).slice(0, 6);
      if (!items.length) {
        list.innerHTML = '<div class="notifp-empty"><div class="notifp-empty-icon">✨</div>لا إشعارات — كل شيء تحت السيطرة!</div>';
        return;
      }
      list.innerHTML = "";
      items.forEach(function (n) {
        var it = el("div", { class: "notifp-item" + (n.read ? "" : " unread") });
        it.innerHTML = '<div class="notifp-item-title">' + (n.icon || "🔔") + ' ' + (n.title || "") + '</div>'
          + '<div class="notifp-item-body">' + (n.body || "") + '</div>'
          + '<div class="notifp-item-time">' + fmtTime(n.ts) + '</div>';
        it.addEventListener("click", function () {
          window.notifpClose();
          if (n.link) safeShowTab(n.link);
          if (!n.read && n.id) window.api("POST", "/store/notifications/" + encodeURIComponent(n.id) + "/read").catch(function(){});
        });
        list.appendChild(it);
      });
    } catch (e) {
      list.innerHTML = '<div class="notifp-empty">⚠️ فشل التحميل</div>';
    }
  }
  window.notifpMarkAll = async function () {
    try { await window.api("POST", "/store/notifications/read-all"); notifpLoad(); notifpUpdateBadge(); } catch (e) {}
  };
  window.notifpClose = function () { var p = $("notifpPanel"); if (p) p.classList.remove("open"); };
  window.openNotifPanel = function () {
    notifpBuild();
    var p = $("notifpPanel");
    if (!p) return;
    p.classList.toggle("open");
    if (p.classList.contains("open")) notifpLoad();
  };
  async function notifpUpdateBadge() {
    try {
      var r = await window.api("GET", "/store/notifications/unread-count");
      var bell = document.querySelector(".notifp-bell-btn");
      if (bell) bell.classList.toggle("has-unread", (r.count || 0) > 0);
    } catch (e) {}
  }
  function injectBellIntoNavbar() {
    if (document.querySelector(".notifp-bell-btn")) return;
    var navRight = document.querySelector(".navbar-right");
    if (!navRight) return;
    var btn = el("button", { class: "notifp-bell-btn", title: "الإشعارات (سيتم فتح الاختصار من الجرس)", onclick: function (e) { e.stopPropagation(); window.openNotifPanel(); } });
    btn.innerHTML = '🔔<span class="notifp-bell-dot"></span>';
    navRight.insertBefore(btn, navRight.firstChild);
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 4: KEYBOARD SHORTCUTS + HELP MODAL (?)
  // ═════════════════════════════════════════════════════════════
  var SHORTCUTS = [
    { keys: ["Ctrl", "K"], desc: "فتح Command Palette (بحث سريع)" },
    { keys: ["N"],         desc: "إضافة منتج جديد" },
    { keys: ["/"],         desc: "التركيز على البحث" },
    { keys: ["Esc"],       desc: "إغلاق النوافذ المنبثقة" },
    { keys: ["?"],         desc: "عرض هذه القائمة" },
    { keys: ["G", "D"],    desc: "الذهاب إلى لوحة التحكم" },
    { keys: ["G", "O"],    desc: "الذهاب إلى الطلبات" },
    { keys: ["G", "M"],    desc: "الذهاب إلى المنيو" },
    { keys: ["G", "C"],    desc: "الذهاب إلى العملاء" },
    { keys: ["G", "S"],    desc: "الذهاب إلى الإعدادات" }
  ];
  function kbdhBuild() {
    if ($("kbdhBackdrop")) return;
    var backdrop = el("div", { class: "kbdh-backdrop", id: "kbdhBackdrop", onclick: function(e){ if (e.target === backdrop) toggleKbdHelp(false); } });
    var modal = el("div", { class: "kbdh-modal", style: "position:relative" });
    modal.innerHTML = '<button class="kbdh-close" onclick="window.toggleKbdHelp(false)">✕</button>'
      + '<h2>⌨️ اختصارات لوحة المفاتيح</h2>'
      + '<div class="sub">وفّر وقتك — استخدم الاختصارات للتنقل السريع</div>';
    var rows = SHORTCUTS.map(function (s) {
      var keys = s.keys.map(function (k) { return "<kbd>" + k + "</kbd>"; }).join(s.keys.length > 1 ? " + " : "");
      var row = el("div", { class: "kbdh-row" });
      row.innerHTML = '<span class="kbdh-desc">' + s.desc + '</span><span class="kbdh-keys">' + keys + '</span>';
      return row;
    });
    rows.forEach(function (r) { modal.appendChild(r); });
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }
  function toggleKbdHelp(open) {
    kbdhBuild();
    var b = $("kbdhBackdrop"); if (!b) return;
    b.classList.toggle("open", !!open);
  }
  window.toggleKbdHelp = toggleKbdHelp;

  var gPending = false;
  function globalKeydown(e) {
    var tag = (e.target.tagName || "").toLowerCase();
    var typing = (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable);
    // Ctrl/Cmd+K (works even in inputs)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      cmdpToggle(true);
      return;
    }
    if (typing) return;
    // Escape closes overlays
    if (e.key === "Escape") {
      cmdpToggle(false);
      toggleKbdHelp(false);
      window.notifpClose();
      return;
    }
    if (e.key === "?") { e.preventDefault(); toggleKbdHelp(true); return; }
    if (e.key === "/") { e.preventDefault(); cmdpToggle(true); return; }
    if (e.key.toLowerCase() === "n") {
      e.preventDefault();
      safeShowTab("menu");
      setTimeout(function () { var b = document.querySelector("[onclick*='openProductModal']"); if (b) b.click(); }, 400);
      return;
    }
    // g-prefix shortcuts (Vim-like)
    if (e.key.toLowerCase() === "g" && !gPending) {
      gPending = true;
      setTimeout(function () { gPending = false; }, 900);
      return;
    }
    if (gPending) {
      gPending = false;
      var map = { d: "dash", o: "orders", m: "menu", c: "customers", s: "settings", a: "accounting", t: "themes", i: "inbox" };
      // 'b' → bookings ONLY if booking business
      if (e.key.toLowerCase() === "b") {
        var tab = $("tabBookings");
        if (tab && tab.style.display !== "none" && tab.dataset.featureGated !== "1") {
          e.preventDefault(); safeShowTab("bookings");
        }
        return;
      }
      var target = map[e.key.toLowerCase()];
      if (target) { e.preventDefault(); safeShowTab(target); }
    }
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 5: GLOBAL SEARCH + STATUS DOT (in navbar)
  // ═════════════════════════════════════════════════════════════
  function injectGlobalHeader() {
    var navRight = document.querySelector(".navbar-right");
    if (!navRight) return;
    // status dot
    if (!navRight.querySelector(".gh-status")) {
      var st = el("div", { class: "gh-status", id: "ghStatus", title: "حالة الاتصال بواتساب" });
      st.innerHTML = '<span class="gh-status-dot"></span><span id="ghStatusText">متصل</span>';
      navRight.insertBefore(st, navRight.firstChild);
    }
    // search input
    if (!navRight.querySelector(".gh-search")) {
      var s = el("input", { class: "gh-search", type: "text", placeholder: "🔍 بحث سريع...", onfocus: function () { cmdpToggle(true); this.blur(); } });
      navRight.insertBefore(s, navRight.firstChild);
    }
  }
  function refreshStatusDot() {
    var status = $("ghStatus"), txt = $("ghStatusText");
    if (!status) return;
    // Try to read from waStatus if available; fallback to just showing "متصل"
    fetch("/store/wa-status", { headers: { "x-store-token": localStorage.getItem("store_token") || "" }})
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var connected = d && (d.status === "open" || d.status === "connected");
        status.classList.toggle("off", !connected);
        if (txt) txt.textContent = connected ? "متصل" : "غير متصل";
      }).catch(function () {});
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 6: SIDEBAR TOGGLE (☰) — Adds toggle to navbar; collapses tabs
  // ═════════════════════════════════════════════════════════════
  function injectSidebarToggle() {
    var navRight = document.querySelector(".navbar-right");
    if (!navRight || navRight.querySelector(".sbt-toggle")) return;
    var btn = el("button", { class: "sbt-toggle", title: "طي/عرض القائمة", onclick: function () {
      var collapsed = document.documentElement.classList.toggle("tabs-collapsed");
      try { localStorage.setItem("tabsCollapsed", collapsed ? "1" : "0"); } catch (e) {}
    }});
    btn.textContent = "☰";
    navRight.appendChild(btn);
    // Restore
    try { if (localStorage.getItem("tabsCollapsed") === "1") document.documentElement.classList.add("tabs-collapsed"); } catch (e) {}
    // Add data-icon to each tab (first emoji from label)
    document.querySelectorAll(".tab").forEach(function (t) {
      if (t.dataset.icon) return;
      var text = t.textContent.trim();
      var m = text.match(/^([\p{Emoji}️]+)/u);
      if (m) t.dataset.icon = m[1];
    });
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 7: STICKY ACTION BAR (bottom, context-aware)
  // ═════════════════════════════════════════════════════════════
  var SAB_MAP = {
    orders:  [ {icon:"🔄", label:"تحديث", fn: function(){ if(window.loadOrders) window.loadOrders(); } }, {icon:"📥", label:"CSV", fn: function(){ var b=document.querySelector("[onclick*='exportCSV'],[onclick*='exportOrders']"); if(b) b.click(); } } ],
    menu:    [ {icon:"➕", label:"منتج جديد", primary:true, fn: function(){ var b=document.querySelector("[onclick*='openProductModal']"); if(b) b.click(); } } ],
    customers: [ {icon:"🔄", label:"تحديث", fn: function(){ if(window.loadCustomers) window.loadCustomers(); } } ],
    accounting: [ {icon:"🔄", label:"تحديث", fn: function(){ if(window.initAccounting) window.initAccounting(); } } ],
    dash: [ {icon:"🔄", label:"تحديث الكل", fn: function(){ location.reload(); } } ]
  };
  function sabBuild() {
    if ($("sabBar")) return;
    var bar = el("div", { class: "sab-bar", id: "sabBar" });
    document.body.appendChild(bar);
  }
  function sabRender(tab) {
    sabBuild();
    var bar = $("sabBar"); if (!bar) return;
    var actions = SAB_MAP[tab];
    if (!actions || !actions.length) { bar.classList.remove("visible"); return; }
    bar.innerHTML = "";
    actions.forEach(function (a, i) {
      if (i > 0) bar.appendChild(el("div", { class: "sab-divider" }));
      var b = el("button", { class: "sab-btn" + (a.primary ? " primary" : ""), onclick: a.fn });
      b.innerHTML = '<span>' + a.icon + '</span><span>' + a.label + '</span>';
      bar.appendChild(b);
    });
    bar.classList.add("visible");
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 8: SETTINGS HEALTH CHECK WIDGET
  // ═════════════════════════════════════════════════════════════
  function hcRun() {
    var sec = $("settingsSection");
    if (!sec) return;
    if ($("hcWidget")) return; // once
    var w = el("div", { class: "hc-widget", id: "hcWidget" });
    w.innerHTML = '<div class="hc-head"><span class="hc-title">🩺 فحص صحّة الإعدادات</span><span class="hc-percent" id="hcPct">—</span></div>'
      + '<div class="hc-bar"><div class="hc-fill" id="hcFill" style="width:0%"></div></div>'
      + '<div class="hc-issues" id="hcIssues"></div>';
    // Insert at top of settingsSection
    var firstChild = sec.firstElementChild;
    if (firstChild) sec.insertBefore(w, firstChild); else sec.appendChild(w);
    hcRefresh();
  }
  function hcRefresh() {
    var pct = $("hcPct"), fill = $("hcFill"), list = $("hcIssues");
    if (!pct) return;
    var checks = [];
    function check(id, label, ok) { checks.push({ id: id, label: label, ok: ok }); }
    var g = function(id){ var e=$(id); return e ? String(e.value||"").trim() : ""; };
    check("name", "اسم المتجر مكتمل", g("s_storeName").length > 1);
    check("logo", "شعار المتجر مرفوع", (g("s_logo") || g("s_logoCircle")).length > 0);
    check("wh", "ساعات العمل محددة", ($("s_open24") && $("s_open24").checked) || (g("s_start") && g("s_end")));
    check("wc", "رسالة الترحيب مخصصة", g("s_welcome").length > 5);
    check("pay", "طريقة دفع واحدة على الأقل مفعّلة", ($("s_pay_cash") && $("s_pay_cash").checked) || ($("s_pay_bank") && $("s_pay_bank").checked) || ($("s_pay_stc") && $("s_pay_stc").checked));
    check("del", "رسوم التوصيل محددة", parseFloat(g("s_deliveryFee")) >= 0);
    check("time", "وقت التوصيل محدد", g("s_deliveryTime").length > 0);
    check("tag", "شعار المتجر (tagline) موجود", g("s_tagline").length > 3);

    var okCnt = checks.filter(function (c) { return c.ok; }).length;
    var total = checks.length;
    var percent = total ? Math.round((okCnt / total) * 100) : 100;
    pct.textContent = okCnt + "/" + total + " (" + percent + "%)";
    fill.style.width = percent + "%";
    pct.classList.remove("warn", "danger");
    if (percent < 50) pct.classList.add("danger");
    else if (percent < 80) pct.classList.add("warn");
    list.innerHTML = "";
    checks.forEach(function (c) {
      var it = el("div", { class: "hc-issue" + (c.ok ? " ok" : "") });
      it.innerHTML = (c.ok ? "✅" : "⚠️") + " <span>" + c.label + "</span>";
      list.appendChild(it);
    });
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 9: SKELETON LOADERS — enhance placeholders
  // ═════════════════════════════════════════════════════════════
  function replacePlaceholdersWithSkeletons() {
    // Find any "جاري التحميل..." placeholders that were set by loaders
    document.querySelectorAll("[id$='List'], [id$='list'], [id$='Grid'], [id$='grid']").forEach(function (el) {
      var txt = (el.textContent || "").trim();
      if (txt.indexOf("جاري التحميل") !== -1 && !el.dataset.plusSkl) {
        el.dataset.plusSkl = "1";
        el.innerHTML = ''
          + '<div class="skl-card"><div class="skl skl-line w70"></div><div class="skl skl-line w30"></div><div class="skl skl-line w50"></div></div>'
          + '<div class="skl-card"><div class="skl skl-line w70"></div><div class="skl skl-line w30"></div><div class="skl skl-line w50"></div></div>'
          + '<div class="skl-card"><div class="skl skl-line w70"></div><div class="skl skl-line w30"></div></div>';
      }
    });
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 10: DASHBOARD ADAPTIVE (time-based reorder)
  // ═════════════════════════════════════════════════════════════
  function adaptDashboard() {
    // Just adds a subtle badge indicating current focus
    var dash = $("dashSection");
    if (!dash || dash.querySelector(".dw-adaptive-badge")) return;
    var hr = new Date().getHours();
    var isMorning = hr >= 5 && hr < 12;
    var isEvening = hr >= 17 && hr < 23;
    var msg = isMorning ? "☀️ صباح الخير — ركّز على طلبات اليوم"
            : isEvening ? "🌙 مساء الخير — تحقق من إيرادات اليوم"
            : "🌟 مرحباً — نظرة عامة على متجرك";
    var badge = el("div", { class: "dw-adaptive-badge", style: "background:linear-gradient(135deg,#C9A24B,#e0b85f);color:#1b5e20;padding:10px 18px;border-radius:12px;margin-bottom:14px;font-weight:800;font-size:14px;display:flex;align-items:center;gap:8px;box-shadow:0 3px 10px rgba(201,162,75,.25);font-family:'Tajawal',sans-serif" });
    badge.textContent = msg;
    dash.insertBefore(badge, dash.firstChild);
  }

  // ═════════════════════════════════════════════════════════════
  // MAIN INIT
  // ═════════════════════════════════════════════════════════════
  function init() {
    if (!document.body) { setTimeout(init, 40); return; }

    mergeTabsInit();

    // Wait for navbar to render
    setTimeout(function () {
      injectGlobalHeader();
      injectSidebarToggle();
      injectBellIntoNavbar();
      refreshStatusDot();
      setInterval(refreshStatusDot, 60000);
    }, 500);

    // Global keyboard
    document.addEventListener("keydown", globalKeydown);

    // Adapt dashboard
    setTimeout(adaptDashboard, 1200);

    // Health check when settings tab opens
    var origShowTab2 = window.showTab;
    if (typeof origShowTab2 === "function") {
      window.showTab = function (name) {
        var r = origShowTab2.apply(this, arguments);
        setTimeout(function () { sabRender(name); }, 100);
        if (name === "settings") setTimeout(hcRun, 400);
        if (name === "dash") setTimeout(adaptDashboard, 200);
        setTimeout(replacePlaceholdersWithSkeletons, 30);
        return r;
      };
    }
    // Initial SAB render for current tab
    setTimeout(function () {
      var active = document.querySelector(".tab.active");
      if (active) {
        var id = active.id.replace(/^tab/, "");
        id = id.charAt(0).toLowerCase() + id.slice(1);
        sabRender(id);
      }
    }, 1500);

    // Update bell badge every 30s
    setInterval(notifpUpdateBadge, 30000);
    setTimeout(notifpUpdateBadge, 2000);

    console.log("[admin-plus] initialized — Ctrl+K for command palette, ? for shortcuts");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
