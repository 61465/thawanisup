/**
 * Admin Enhancements — تحسينات UX مشتركة بين master.html و store-admin.html
 * يُحمَّل عبر:  <script src="/admin-enhancements.js" defer></script>
 *
 * يوفّر:
 *   • TwaniUX.copy(text)              — نسخ للحافظة مع toast
 *   • TwaniUX.waLink(phone)           — رابط wa.me/...
 *   • TwaniUX.exportCSV(rows, fname)  — تصدير CSV (RTL-safe + BOM)
 *   • TwaniUX.notify(title, body, opts) — Notification API + fallback
 *   • TwaniUX.pollNotifications(opts)   — polling تلقائي للأحداث الجديدة
 *   • TwaniUX.shortcuts(map)           — keyboard shortcuts
 *   • TwaniUX.timeAgo(date)            — "منذ 5 دقائق"
 */

(function () {
  "use strict";
  if (window.TwaniUX) return;

  // ─── Toast نظيف (لو ما فيش toast في الصفحة) ─────────────────────────────
  function _ensureToastEl() {
    let el = document.getElementById("twaniToast");
    if (el) return el;
    el = document.createElement("div");
    el.id = "twaniToast";
    el.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#1f2937;color:#fff;padding:12px 22px;border-radius:999px;font-weight:700;font-size:14px;box-shadow:0 8px 22px rgba(0,0,0,.25);opacity:0;transition:.25s;pointer-events:none;z-index:99999;font-family:inherit;max-width:90vw;text-align:center";
    document.body.appendChild(el);
    return el;
  }
  function toast(msg, type) {
    const el = _ensureToastEl();
    el.textContent = msg;
    el.style.background = type === "error" ? "#dc2626" : type === "warn" ? "#d97706" : type === "success" ? "#16a34a" : "#1f2937";
    el.style.opacity = "1";
    el.style.transform = "translateX(-50%) translateY(0)";
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateX(-50%) translateY(20px)";
    }, 2500);
  }

  // ─── Copy to clipboard ──────────────────────────────────────────────────
  async function copy(text, label) {
    const str = String(text || "");
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(str);
      } else {
        const ta = document.createElement("textarea");
        ta.value = str;
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast("✅ " + (label || "تم النسخ"), "success");
      return true;
    } catch {
      toast("⚠️ فشل النسخ — حدّد النص يدوياً", "error");
      return false;
    }
  }

  // ─── WhatsApp deep link ────────────────────────────────────────────────
  function waLink(phone, text) {
    const clean = String(phone || "").replace(/\D/g, "");
    if (!clean) return "#";
    const t = text ? "?text=" + encodeURIComponent(text) : "";
    return `https://wa.me/${clean}${t}`;
  }

  // helper: تحويل أي element مع data-copy / data-wa إلى أزرار شغّالة
  function _bindCopyAttrs() {
    document.addEventListener("click", (e) => {
      const cp = e.target.closest("[data-copy]");
      if (cp) {
        e.preventDefault();
        copy(cp.dataset.copy, cp.dataset.copyLabel || "تم النسخ");
        return;
      }
    });
  }

  // ─── CSV Export — UTF-8 BOM + escape proper ─────────────────────────────
  function exportCSV(rows, filename) {
    if (!Array.isArray(rows) || !rows.length) { toast("لا توجد بيانات للتصدير", "warn"); return; }
    const headers = Object.keys(rows[0]);
    const escape = (v) => {
      if (v == null) return "";
      const s = String(v).replace(/"/g, '""');
      return /[",\n\r]/.test(s) ? `"${s}"` : s;
    };
    const lines = [headers.map(escape).join(",")];
    for (const row of rows) {
      lines.push(headers.map(h => escape(row[h])).join(","));
    }
    // BOM لـ Excel ليفهم UTF-8 (الأحرف العربية)
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (filename || "export") + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("📥 تم تنزيل الملف", "success");
  }

  // ─── Browser Notifications ──────────────────────────────────────────────
  let _notifPermissionAsked = false;
  async function requestNotifPermission() {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied")  return false;
    if (_notifPermissionAsked) return false;
    _notifPermissionAsked = true;
    try {
      const r = await Notification.requestPermission();
      return r === "granted";
    } catch { return false; }
  }
  function notify(title, body, opts) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      toast((title || "") + " — " + (body || ""), "success");
      return null;
    }
    try {
      const n = new Notification(title || "تنبيه", {
        body: body || "",
        icon: opts?.icon || "/favicon.ico",
        tag: opts?.tag || "twani",
        renotify: true,
        ...opts,
      });
      if (opts?.onclick) n.onclick = opts.onclick;
      else n.onclick = () => { window.focus(); n.close(); };
      // auto close بعد 8 ثوانٍ
      setTimeout(() => { try { n.close(); } catch {} }, 8000);
      return n;
    } catch { return null; }
  }

  // ─── Polling مع memory للـ since ──────────────────────────────────────
  // opts: { url, headers, intervalMs, onNew(notifications) }
  function pollNotifications(opts) {
    if (!opts || !opts.url) return null;
    const storageKey = "twani_lastNotifTs_" + opts.url;
    let stopped = false;
    let lastTs = parseInt(localStorage.getItem(storageKey)) || Date.now();
    requestNotifPermission();

    async function tick() {
      if (stopped) return;
      try {
        const r = await fetch(opts.url + "?since=" + lastTs, { headers: opts.headers || {} });
        if (r.ok) {
          const d = await r.json();
          const ns = (d.notifications || []).filter(n => n.ts > lastTs);
          if (ns.length) {
            for (const n of ns) notify(n.title || "تنبيه", n.body || "", { tag: n.id });
            if (opts.onNew) opts.onNew(ns);
            lastTs = Math.max(lastTs, d.serverTime || Date.now());
            localStorage.setItem(storageKey, String(lastTs));
          } else if (d.serverTime) {
            lastTs = d.serverTime;
            localStorage.setItem(storageKey, String(lastTs));
          }
        }
      } catch {}
      if (!stopped) setTimeout(tick, opts.intervalMs || 25000);
    }
    setTimeout(tick, 2000); // أول tick بعد ثانيتين
    return { stop: () => { stopped = true; } };
  }

  // ─── Keyboard shortcuts ────────────────────────────────────────────────
  // shortcuts({"ctrl+k": fn, "esc": fn, "/": fn})
  function shortcuts(map) {
    const norm = (e) => {
      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push("ctrl");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey)   parts.push("alt");
      let k = e.key.toLowerCase();
      if (k === "escape") k = "esc";
      if (k === " ") k = "space";
      parts.push(k);
      return parts.join("+");
    };
    document.addEventListener("keydown", (e) => {
      // تجاهل لو المستخدم بيكتب في input/textarea (ما عدا esc)
      const inField = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
      const key = norm(e);
      const fn = map[key];
      if (!fn) return;
      if (inField && key !== "esc") return;
      e.preventDefault();
      try { fn(e); } catch {}
    });
  }

  // ─── time ago (RTL Arabic) ──────────────────────────────────────────────
  function timeAgo(date) {
    if (!date) return "—";
    const d = typeof date === "string" ? new Date(date) : date;
    const sec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return "الآن";
    const min = Math.floor(sec / 60);
    if (min < 60) return `منذ ${min} دقيقة`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `منذ ${hr} ساعة`;
    const days = Math.floor(hr / 24);
    if (days < 30) return `منذ ${days} يوم`;
    return d.toLocaleDateString("ar-EG", { day: "numeric", month: "short", year: "numeric" });
  }

  // init lightweight bindings
  _bindCopyAttrs();

  window.TwaniUX = {
    copy, waLink, exportCSV,
    notify, requestNotifPermission, pollNotifications,
    shortcuts, toast, timeAgo,
  };
})();
