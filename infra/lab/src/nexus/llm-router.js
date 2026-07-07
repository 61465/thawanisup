/**
 * NEXUS LLM Router — multi-provider intelligent routing
 *
 * يدعم 3 مزودين:
 *   - Groq (Llama 3.3 70B + 4 Scout/Maverick) — سريع، رخيص، الافتراضي
 *   - Anthropic Claude (Sonnet 4) — دقيق، للمراجعات
 *   - Google Gemini (2.0 Flash) — vision + long context
 *
 * كل وكيل يقول: "أريد response من LLM للمهمة X" → نختار الأنسب.
 * Auto-fallback: إذا فشل Provider الأساسي، نجرّب التالي.
 */

const GROQ_KEY     = process.env.GROQ_API_KEY     || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const GEMINI_KEY   = process.env.GEMINI_API_KEY   || "";

const PROVIDERS = {
  groq: {
    enabled: !!GROQ_KEY,
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    models: {
      fast:    "llama-3.3-70b-versatile",
      cheap:   "llama-3.1-8b-instant",
      vision:  "meta-llama/llama-4-scout-17b-16e-instruct",
      vision2: "meta-llama/llama-4-maverick-17b-128e-instruct",
    },
  },
  claude: {
    enabled: !!ANTHROPIC_KEY,
    endpoint: "https://api.anthropic.com/v1/messages",
    models: {
      smart:   "claude-sonnet-4-6",
      smartest: "claude-opus-4-7",
    },
  },
  gemini: {
    enabled: !!GEMINI_KEY,
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    models: {
      flash:   "gemini-2.0-flash-exp",
      pro:     "gemini-2.0-pro-exp",
    },
  },
};

// ─── Default task→model mapping ──────────────────────────────────────
const TASK_DEFAULTS = {
  // مهام بسيطة سريعة → groq/fast
  "write_message":      { provider: "groq",   model: "fast" },
  "summarize":          { provider: "groq",   model: "fast" },
  "classify":           { provider: "groq",   model: "cheap" },
  "translate":          { provider: "groq",   model: "fast" },
  // مهام دقيقة → claude
  "code_review":        { provider: "claude", model: "smart" },
  "debug":              { provider: "claude", model: "smart" },
  "architecture":       { provider: "claude", model: "smartest" },
  "decision":           { provider: "claude", model: "smart" },
  // مهام رؤية → groq vision أو gemini
  "extract_from_image": { provider: "groq",   model: "vision" },
  "vision":             { provider: "gemini", model: "flash" },
  // مهام نص طويل → gemini
  "analyze_long":       { provider: "gemini", model: "flash" },
  "report":             { provider: "gemini", model: "flash" },
};

// ─── Fallback chains (لو الأساسي فشل) ─────────────────────────────────
const FALLBACK_CHAIN = ["groq", "gemini", "claude"];

// ─── Stats ─────────────────────────────────────────────────────────────
const _stats = { calls: 0, errors: 0, byProvider: {}, byTask: {} };

// ═══════════════════════════════════════════════════════════════════════
// Main API
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {string} task         — اسم المهمة (write_message, code_review, ...)
 * @param {object} opts
 * @param {string} opts.system  — system prompt
 * @param {string} opts.user    — user prompt
 * @param {string} [opts.image] — base64 image (للـ vision)
 * @param {number} [opts.maxTokens=2000]
 * @param {number} [opts.temperature=0.3]
 * @param {string} [opts.provider] — override
 * @param {string} [opts.model]    — override
 * @returns {Promise<{text, provider, model, usage}>}
 */
async function call(task, opts = {}) {
  _stats.calls++;
  _stats.byTask[task] = (_stats.byTask[task] || 0) + 1;

  // اختر الـ provider
  const target = opts.provider
    ? { provider: opts.provider, model: opts.model || _firstModel(opts.provider) }
    : (TASK_DEFAULTS[task] || TASK_DEFAULTS.write_message);

  // Build provider order: target first, then fallbacks
  const order = [target.provider, ...FALLBACK_CHAIN.filter(p => p !== target.provider)];

  let lastErr;
  for (const p of order) {
    if (!PROVIDERS[p]?.enabled) continue;
    try {
      const model = (p === target.provider ? target.model : _firstModel(p));
      const result = await _callProvider(p, model, opts);
      _stats.byProvider[p] = (_stats.byProvider[p] || 0) + 1;
      return { ...result, provider: p, model, task };
    } catch (e) {
      lastErr = e;
      console.warn(`[nexus/llm] ${p} failed for task=${task}:`, e.message);
    }
  }
  _stats.errors++;
  throw lastErr || new Error(`No provider available for task: ${task}`);
}

function _firstModel(provider) {
  const models = PROVIDERS[provider]?.models || {};
  return Object.values(models)[0];
}

// ─── Provider implementations ────────────────────────────────────────

async function _callProvider(provider, model, opts) {
  if (provider === "groq")   return _callGroq(model, opts);
  if (provider === "claude") return _callClaude(model, opts);
  if (provider === "gemini") return _callGemini(model, opts);
  throw new Error("Unknown provider: " + provider);
}

async function _callGroq(model, opts) {
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  if (opts.image) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: opts.user || "" },
        { type: "image_url", image_url: { url: opts.image } },
      ],
    });
  } else {
    messages.push({ role: "user", content: opts.user || "" });
  }
  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens || 2000,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await fetch(PROVIDERS.groq.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Groq HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content || "",
    usage: data.usage || null,
  };
}

async function _callClaude(model, opts) {
  const body = {
    model,
    max_tokens: opts.maxTokens || 2000,
    temperature: opts.temperature ?? 0.3,
    system: opts.system || "",
    messages: [{ role: "user", content: opts.user || "" }],
  };
  const res = await fetch(PROVIDERS.claude.endpoint, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Claude HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    text: data.content?.[0]?.text || "",
    usage: data.usage || null,
  };
}

async function _callGemini(model, opts) {
  const parts = [{ text: opts.user || "" }];
  if (opts.image) {
    // expect data URL — split out
    const m = String(opts.image).match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.3,
      maxOutputTokens: opts.maxTokens || 2000,
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
    },
    ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
  };
  const url = `${PROVIDERS.gemini.endpoint}/${model}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
    usage: data.usageMetadata || null,
  };
}

// ─── Stats ─────────────────────────────────────────────────────────────
function getStats() {
  return {
    ..._stats,
    providers: Object.fromEntries(
      Object.entries(PROVIDERS).map(([k, v]) => [k, { enabled: v.enabled }])
    ),
  };
}

function resetStats() {
  _stats.calls = 0; _stats.errors = 0;
  _stats.byProvider = {}; _stats.byTask = {};
}

module.exports = {
  call,
  getStats,
  resetStats,
  PROVIDERS,
  TASK_DEFAULTS,
};
