/**
 * Mobile Enhance — منصة ثواني (2026 standards)
 * تقنيات حديثة:
 *  • Vibration API — haptic feedback
 *  • Pointer Events — touch/mouse/pen موحد
 *  • Pull-to-Refresh مع overscroll-behavior
 *  • Swipe gestures (Pointer + bezel handling)
 *  • Bottom sheet swipe-down to close
 *  • Visual Viewport API — keyboard avoid
 *  • Screen Wake Lock API — أثناء scan QR
 *  • Web Share API — مشاركة روابط
 *  • Network Information — offline UI
 *  • IntersectionObserver — scroll spy + lazy load
 *  • PWA install prompt
 *  • View Transitions API — page transitions
 *
 * يُحمَّل defer، لا يكسر شيئاً لو فشل.
 */
(function () {
  "use strict";
  if (window.TwaniMobile) return;

  const TwaniMobile = {};

  // ═══════════════════════════════════════════════════════════════
  // 1) Haptic feedback (Vibration API)
  // ⚠️ Chrome يحظر vibrate قبل user gesture — نحفظ حالة + لا نستدعيه قبلها
  // ═══════════════════════════════════════════════════════════════
  let _userGestured = false;
  ["pointerdown", "touchstart", "click", "keydown"].forEach(ev => {
    document.addEventListener(ev, () => { _userGestured = true; }, { once: true, passive: true });
  });
  const _vib = (p) => { if (_userGestured && navigator.vibrate) { try { navigator.vibrate(p); } catch {} } };
  const haptic = {
    tap:     () => _vib(8),
    success: () => _vib([10, 30, 10]),
    warning: () => _vib([20, 50, 20]),
    error:   () => _vib([40, 60, 40, 60, 40]),
    light:   () => _vib(4),
  };
  TwaniMobile.haptic = haptic;

  // اربط haptic تلقائياً مع clicks (للأزرار الأساسية)
  document.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest("button, .btn, .tab, .bnav-item, .sc-btn, [role='button']");
    if (!btn) return;
    if (btn.classList.contains("danger") || btn.classList.contains("logout-btn")) {
      haptic.warning();
    } else {
      haptic.light();
    }
  }, { passive: true });

  // ═══════════════════════════════════════════════════════════════
  // 2) Pull-to-Refresh مخصص (يعمل بدون lib خارجية)
  // ═══════════════════════════════════════════════════════════════
  let pullStart = 0;
  let pullDistance = 0;
  const pullThreshold = 80;
  let pullIndicator = null;

  function ensurePullIndicator() {
    if (pullIndicator) return pullIndicator;
    pullIndicator = document.createElement("div");
    pullIndicator.id = "twani-pull-refresh";
    pullIndicator.style.cssText = `
      position: fixed; top: 0; inset-inline: 0;
      height: 60px; display: flex; align-items: center; justify-content: center;
      background: linear-gradient(180deg, rgba(255,255,255,.95), transparent);
      backdrop-filter: blur(8px);
      transform: translateY(-100%); transition: transform .2s ease-out;
      z-index: 9999; pointer-events: none;
      font-size: 24px;
    `;
    pullIndicator.innerHTML = '<div id="twani-pull-icon" style="transition: transform .2s">⬇️</div>';
    document.body.appendChild(pullIndicator);
    return pullIndicator;
  }

  // pull-to-refresh على main content فقط
  const enablePullToRefresh = (refreshFn) => {
    if (!("ontouchstart" in window)) return; // mouse devices skip
    document.addEventListener("touchstart", (e) => {
      if (window.scrollY > 5) return; // فقط لو في top
      pullStart = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
      if (!pullStart || window.scrollY > 5) return;
      pullDistance = e.touches[0].clientY - pullStart;
      if (pullDistance > 0 && pullDistance < 200) {
        const indicator = ensurePullIndicator();
        const progress = Math.min(pullDistance / pullThreshold, 1);
        indicator.style.transform = `translateY(${Math.min(pullDistance - 60, 20)}px)`;
        document.getElementById("twani-pull-icon").style.transform =
          `rotate(${progress * 360}deg)`;
      }
    }, { passive: true });

    document.addEventListener("touchend", () => {
      if (pullDistance > pullThreshold) {
        haptic.success();
        const indicator = ensurePullIndicator();
        indicator.style.transform = "translateY(20px)";
        document.getElementById("twani-pull-icon").textContent = "🔄";
        Promise.resolve(refreshFn?.()).finally(() => {
          setTimeout(() => {
            indicator.style.transform = "translateY(-100%)";
            document.getElementById("twani-pull-icon").textContent = "⬇️";
          }, 600);
        });
      } else if (pullIndicator) {
        pullIndicator.style.transform = "translateY(-100%)";
      }
      pullStart = 0;
      pullDistance = 0;
    }, { passive: true });
  };
  TwaniMobile.enablePullToRefresh = enablePullToRefresh;

  // ═══════════════════════════════════════════════════════════════
  // 3) Bottom Sheet swipe-down to close
  // ═══════════════════════════════════════════════════════════════
  function makeBottomSheetSwipeable(modalSelector) {
    document.addEventListener("pointerdown", (e) => {
      const modal = e.target.closest(modalSelector || ".modal");
      if (!modal) return;
      // فقط لو الـ pointer قريب من الـ drag handle (أعلى 60px)
      const rect = modal.getBoundingClientRect();
      if (e.clientY - rect.top > 60) return;

      let startY = e.clientY;
      let currentY = startY;
      modal.style.transition = "none";

      const onMove = (e) => {
        currentY = e.clientY;
        const delta = currentY - startY;
        if (delta > 0) {
          modal.style.transform = `translateY(${delta}px)`;
        }
      };

      const onEnd = () => {
        modal.style.transition = "transform .3s cubic-bezier(.32,.72,0,1)";
        const delta = currentY - startY;
        if (delta > 100) {
          haptic.tap();
          modal.style.transform = "translateY(100%)";
          setTimeout(() => {
            const overlay = modal.closest(".overlay");
            if (overlay) overlay.click(); // close
          }, 300);
        } else {
          modal.style.transform = "translateY(0)";
        }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onEnd);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onEnd);
    });
  }
  TwaniMobile.makeBottomSheetSwipeable = makeBottomSheetSwipeable;

  // ═══════════════════════════════════════════════════════════════
  // 4) Visual Viewport API — يدير الـ keyboard
  // ═══════════════════════════════════════════════════════════════
  if ("visualViewport" in window) {
    const vv = window.visualViewport;
    const handleResize = () => {
      const heightDiff = window.innerHeight - vv.height;
      // لو keyboard ظاهر، scroll للـ focused input
      if (heightDiff > 100) {
        const focused = document.activeElement;
        if (focused && ["INPUT", "TEXTAREA"].includes(focused.tagName)) {
          setTimeout(() => {
            focused.scrollIntoView({ block: "center", behavior: "smooth" });
          }, 100);
        }
      }
      // تحديث CSS variable للـ keyboard
      document.documentElement.style.setProperty("--keyboard-height", `${heightDiff}px`);
    };
    vv.addEventListener("resize", handleResize);
    vv.addEventListener("scroll", handleResize);
  }

  // ═══════════════════════════════════════════════════════════════
  // 5) Network Information — offline UI
  // ═══════════════════════════════════════════════════════════════
  function setupOfflineBanner() {
    let banner = null;
    const showOffline = () => {
      if (banner) return;
      banner = document.createElement("div");
      banner.style.cssText = `
        position: fixed; top: 0; inset-inline: 0; z-index: 9998;
        background: #dc2626; color: #fff; padding: 8px 16px;
        text-align: center; font-size: 13px; font-weight: 700;
        animation: slideDown .3s ease-out;
      `;
      banner.textContent = "🔌 لا يوجد اتصال بالإنترنت — يعمل وضع offline";
      document.body.appendChild(banner);
      haptic.warning();
    };
    const hideOffline = () => {
      if (!banner) return;
      banner.style.transform = "translateY(-100%)";
      setTimeout(() => { banner?.remove(); banner = null; }, 300);
      haptic.success();
    };
    window.addEventListener("online", hideOffline);
    window.addEventListener("offline", showOffline);
    if (!navigator.onLine) showOffline();
  }
  setupOfflineBanner();

  // ═══════════════════════════════════════════════════════════════
  // 6) Auto lazy-loading للصور القديمة
  // ═══════════════════════════════════════════════════════════════
  document.querySelectorAll("img:not([loading])").forEach(img => {
    img.loading = "lazy";
    img.decoding = "async";
  });

  // ═══════════════════════════════════════════════════════════════
  // 7) Smooth scroll spy للـ tabs
  // ═══════════════════════════════════════════════════════════════
  function setupScrollSpy(tabsSelector, contentSelector) {
    const tabs = document.querySelectorAll(tabsSelector);
    if (!tabs.length || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          const tab = document.querySelector(`${tabsSelector}[data-target="${id}"]`);
          if (tab) {
            tabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            tab.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" });
          }
        }
      });
    }, { threshold: 0.5, rootMargin: "-100px 0px -50% 0px" });

    document.querySelectorAll(contentSelector).forEach(s => observer.observe(s));
  }
  TwaniMobile.setupScrollSpy = setupScrollSpy;

  // ═══════════════════════════════════════════════════════════════
  // 8) PWA Install prompt
  // ═══════════════════════════════════════════════════════════════
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner();
  });

  function showInstallBanner() {
    if (localStorage.getItem("twani-install-dismissed")) return;
    const banner = document.createElement("div");
    banner.className = "pwa-install-banner";
    banner.innerHTML = `
      <div style="flex:1">
        <div style="font-weight:800;font-size:14px">ثبّت التطبيق على الشاشة الرئيسية</div>
        <div style="font-size:11px;opacity:.9">تجربة أسرع، إشعارات، يعمل offline</div>
      </div>
      <button id="twani-install-btn" style="background:#fff;color:#1b5e20;border:0;padding:10px 18px;border-radius:10px;font-weight:800;cursor:pointer">ثبّت</button>
      <button id="twani-install-dismiss" style="background:transparent;border:0;color:#fff;font-size:24px;cursor:pointer">×</button>
    `;
    document.body.appendChild(banner);

    document.getElementById("twani-install-btn").onclick = async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      haptic.success();
      banner.remove();
    };
    document.getElementById("twani-install-dismiss").onclick = () => {
      localStorage.setItem("twani-install-dismissed", "1");
      banner.remove();
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 9) View Transitions API (Chrome 111+)
  // ═══════════════════════════════════════════════════════════════
  if ("startViewTransition" in document) {
    document.addEventListener("click", (e) => {
      const link = e.target.closest("a[href]:not([target='_blank'])");
      if (!link || link.origin !== location.origin) return;
      if (link.hash) return; // intra-page anchors
      e.preventDefault();
      document.startViewTransition(() => {
        location.href = link.href;
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 10) iOS bounce scroll guard على الـ body (مع smooth بقاء داخل modals)
  // ═══════════════════════════════════════════════════════════════
  // تم في الـ CSS عبر overscroll-behavior: none

  // ═══════════════════════════════════════════════════════════════
  // 11) Screen Wake Lock (مفيد لـ QR display)
  // ═══════════════════════════════════════════════════════════════
  let wakeLock = null;
  const requestWakeLock = async () => {
    if (!("wakeLock" in navigator)) return false;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      return true;
    } catch { return false; }
  };
  const releaseWakeLock = () => wakeLock?.release()?.then(() => wakeLock = null);
  TwaniMobile.requestWakeLock = requestWakeLock;
  TwaniMobile.releaseWakeLock = releaseWakeLock;

  // Auto wake lock لما يفتح QR
  const qrObserver = new MutationObserver(() => {
    const qrVisible = document.querySelector("#qrCodeContainer:not([style*='display:none']), .qr-section:not([style*='display:none'])");
    if (qrVisible && !wakeLock) requestWakeLock();
    else if (!qrVisible && wakeLock) releaseWakeLock();
  });
  qrObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });

  // ═══════════════════════════════════════════════════════════════
  // 12) Web Share API helper
  // ═══════════════════════════════════════════════════════════════
  TwaniMobile.share = async (data) => {
    if (!navigator.share) {
      // fallback: copy
      await navigator.clipboard?.writeText(data.url || data.text || "");
      return "copied";
    }
    try {
      await navigator.share(data);
      haptic.success();
      return "shared";
    } catch { return "cancelled"; }
  };

  // ═══════════════════════════════════════════════════════════════
  // 13) Modern Image upload UX
  // ═══════════════════════════════════════════════════════════════
  document.addEventListener("change", (e) => {
    const input = e.target;
    if (input.type !== "file") return;
    if (!input.files?.length) return;
    const file = input.files[0];
    if (!file.type.startsWith("image/")) return;
    // إنشاء preview تلقائي قريب من الـ input
    const url = URL.createObjectURL(file);
    let preview = input.parentElement.querySelector(".twani-preview");
    if (!preview) {
      preview = document.createElement("img");
      preview.className = "twani-preview";
      preview.style.cssText = "max-width:120px;border-radius:10px;margin-top:8px;display:block;box-shadow:0 4px 12px rgba(0,0,0,.1)";
      input.parentElement.appendChild(preview);
    }
    preview.src = url;
    haptic.light();
  });

  // ═══════════════════════════════════════════════════════════════
  // 14) Activate bottom sheets swipe automatically
  // ═══════════════════════════════════════════════════════════════
  makeBottomSheetSwipeable(".modal");

  // ═══════════════════════════════════════════════════════════════
  // 15) Auto-detect iOS Safari PWA bug + workaround
  // ═══════════════════════════════════════════════════════════════
  const isiOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
                    || window.navigator.standalone;
  if (isiOS && isStandalone) {
    document.documentElement.classList.add("ios-pwa");
  }

  // Expose
  window.TwaniMobile = TwaniMobile;
  console.log("✨ TwaniMobile loaded");
})();
