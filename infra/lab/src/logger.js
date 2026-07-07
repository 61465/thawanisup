// Minimal logger that respects LOG_LEVEL env var.
// Levels: debug | info | warn | error  (default: info)
const LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
const cur = ORDER[LEVEL] ?? 1;

module.exports = {
  debug: (...a) => { if (cur <= 0) console.log(...a); },
  info:  (...a) => { if (cur <= 1) console.log(...a); },
  warn:  (...a) => { if (cur <= 2) console.warn(...a); },
  error: (...a) => { if (cur <= 3) console.error(...a); },
};
