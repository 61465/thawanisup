/**
 * PM2 Ecosystem — BotHatim (WhatsApp Cafe Bot)
 * تشغيل: pm2 start ecosystem.config.js
 * إيقاف: pm2 stop all
 *
 * ملاحظة: cf-tunnel يستدعي `pm2 restart whatsapp-bot` عند كل تغيير لـ PUBLIC_URL،
 * فالـ restart counter يتراكم سريعاً — هذا سلوك مقصود لا خلل.
 */

// تقدير الذاكرة:
//   - Baileys session واحدة ≈ 30-50MB
//   - 50 متجر = ~1.5-2.5GB لـ sessions فقط
//   - + Node heap + buffers + audit في الذاكرة ≈ 500MB
//   - الإجمالي: ~3GB
// لذا max_memory_restart = 2.5GB (يعطي 30% headroom)
// VPS الموصى به: 4GB RAM على الأقل لـ 50 متجر
module.exports = {
  apps: [
    {
      name: "whatsapp-bot",
      script: "src/server.js",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 3003,
        TZ: "Asia/Riyadh",
        // V8 heap max (يطابق max_memory_restart)
        NODE_OPTIONS: "--max-old-space-size=2048",
        CANVAS_WORKERS: "2",
        // DEBUG_POLLS: "1",  // فعّلها فقط عند تشخيص فك تشفير الاستطلاعات
      },
      // 2.5GB للـ 50 متجر؛ خفّض لـ "1G" إذا < 25 متجر و VPS صغير
      max_memory_restart: "2500M",
      restart_delay: 3000,
      max_restarts: 100,
      // graceful shutdown — أعطي 10s للـ sessions تُحفظ قبل القتل
      kill_timeout: 10_000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/app.log",
      error_file: "./logs/app.err.log",
      merge_logs: true,
    },
    // cf-tunnel أُزيل: المشروع يستخدم Tailscale Funnel (bothatim-vps.tail19ddab.ts.net)
    // كان start-tunnel.js يحوي CF_BIN ثابت لـ Windows path يفشل على Linux بـ ENOENT
    // ويعيد PM2 تشغيله كل 5 ثوان => استهلاك CPU/IO بلا فائدة.
  ]
};
