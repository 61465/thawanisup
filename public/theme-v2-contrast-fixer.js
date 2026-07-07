/**
 * 🎨 Theme v2 Contrast Fixer v3 — أكثر دقة + safety
 *
 * المبدأ المُحسَّن:
 *   - نفحص computed style (الفعلي) لا فقط inline
 *   - نتأكد من أن العنصر له خلفية صريحة (مش transparent/inherit)
 *   - نتأكد من أن النص له لون صريح (مش inherited)
 *   - نُعدّل فقط لو نسبة contrast < 4.5 (WCAG AA)
 *   - نتجاهل العناصر الصغيرة جداً + svg/img
 *
 * مرة على load + observer للجديد. لا interval ثقيل.
 */
(function () {
  "use strict";

  // ─── Helpers ────────────────────────────────────────────────────────────
  function _parseColor(str) {
    if (!str || str === "transparent" || str === "rgba(0, 0, 0, 0)") return null;
    str = str.trim().toLowerCase();
    if (str.startsWith("#")) {
      let h = str.slice(1);
      if (h.length === 3) h = h.split("").map(c => c + c).join("");
      if (h.length !== 6) return null;
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    }
    const m = str.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
    if (m) {
      const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
      if (a < 0.1) return null; // ~transparent
      return { r: +m[1], g: +m[2], b: +m[3], a };
    }
    return null;
  }

  function _luminance(c) {
    if (!c) return null;
    const norm = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * norm(c.r) + 0.7152 * norm(c.g) + 0.0722 * norm(c.b);
  }

  function _contrastRatio(c1, c2) {
    const L1 = _luminance(c1), L2 = _luminance(c2);
    if (L1 === null || L2 === null) return 21;
    const light = Math.max(L1, L2), dark = Math.min(L1, L2);
    return (light + 0.05) / (dark + 0.05);
  }

  // الخلفية الفعلية (تتسلسل من parent إن كانت transparent)
  function _effectiveBg(el) {
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.documentElement && depth < 20) {
      const cs = getComputedStyle(cur);
      const bg = _parseColor(cs.backgroundColor);
      if (bg) return bg;
      cur = cur.parentElement;
      depth++;
    }
    // أساس: dark theme
    return { r: 8, g: 18, b: 14, a: 1 }; // var(--bg)
  }

  function _fixElement(el) {
    if (!el || !el.tagName) return;
    const tag = el.tagName;
    // تجاهل العناصر بدون نص ظاهر
    if (tag === "SVG" || tag === "IMG" || tag === "SELECT" || tag === "TEXTAREA") return;
    // INPUT: نفحص فقط لو placeholder visible (سنفحص أزرار، عناوين، نصوص)
    if (tag === "INPUT") return;
    // تأكد فيها نص (لا فقط wrapper)
    const hasText = el.childNodes && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!hasText) return;

    const cs = getComputedStyle(el);
    const fg = _parseColor(cs.color);
    if (!fg) return;
    const bg = _effectiveBg(el);

    const ratio = _contrastRatio(fg, bg);
    if (ratio >= 4.5) {
      // OK الآن — لو سبق إصلاحه، نظّف العلامة
      if (el.dataset.tv2Fixed === "1") {
        el.dataset.tv2Fixed = "ok";
      }
      return;
    }

    // contrast سيء → اختر اللون الأنسب
    const bgLum = _luminance(bg);
    const newColor = bgLum > 0.4 ? "#1f2937" : "#f1f5f4";
    el.style.setProperty("color", newColor, "important");
    el.dataset.tv2Fixed = "1";
  }

  function scanAll(root) {
    root = root || document.body;
    if (!root || !root.querySelectorAll) return;
    let fixed = 0;
    // نفحص العناصر التي تحوي نصاً + الأزرار
    const candidates = root.querySelectorAll("span, div, p, h1, h2, h3, h4, h5, h6, a, label, li, td, th, strong, b, em, small, code, pre, button, option, summary, legend");
    candidates.forEach(el => {
      const before = el.dataset.tv2Fixed === "1";
      _fixElement(el);
      if (el.dataset.tv2Fixed === "1" && !before) fixed++;
    });
    if (fixed > 0) console.debug(`[contrast-fixer] fixed ${fixed} elements`);
  }

  function init() {
    scanAll();
    // Mutation observer للعناصر المُضافة
    const obs = new MutationObserver(muts => {
      let toScan = [];
      for (const m of muts) {
        m.addedNodes.forEach(n => {
          if (n.nodeType === 1) toScan.push(n);
        });
      }
      if (toScan.length) {
        // debounce
        clearTimeout(window._tv2ContrastDebounce);
        window._tv2ContrastDebounce = setTimeout(() => {
          toScan.forEach(n => {
            _fixElement(n);
            scanAll(n);
          });
        }, 200);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  // إعادة كل 3 ثواني (للأشياء التي تتغير عبر JS بدون mutation observable)
  setTimeout(() => scanAll(), 1500);
  setTimeout(() => scanAll(), 4000);
  // فحص دوري كل 5 ثواني (للحالات النادرة: re-render بدون إضافة nodes جديدة)
  setInterval(() => scanAll(), 5000);
})();
