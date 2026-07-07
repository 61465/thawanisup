/**
 * 🐛 Debugger Agent — يحلل أخطاء logs ويقترح إصلاحات
 *
 * Input:  { logFile?, errorPattern?, lines? }
 * Output: { summary, suspects, suggestions }
 */

module.exports = async function debuggerAgent({ input, llm, reader, memory, log }) {
  const logFile = input.logFile || "data/alerts/error-monitor.jsonl";
  const lines   = input.lines || 100;

  // 1. اقرأ آخر N سطر من الـ log
  log(`reading last ${lines} lines from ${logFile}`);
  const logExists = await reader.exists(logFile);
  if (!logExists) {
    return { summary: "Log file not found", suspects: [], suggestions: [] };
  }
  const recent = await reader.tailLog(logFile, lines);
  if (!recent.trim()) {
    return { summary: "No recent errors", suspects: [], suggestions: [] };
  }

  // 2. اطلب من LLM التحليل
  const system = `أنت Debugger expert في Node.js + Express + Baileys WhatsApp bot.
تحلل logs، تجد الأنماط، تقترح إصلاحات دقيقة.
رد بـ JSON فقط:
{
  "summary": "ملخص قصير (سطرين)",
  "suspects": [
    {"file": "src/xxx.js", "line": 123, "issue": "وصف", "severity": "high|medium|low"}
  ],
  "suggestions": ["اقتراح 1", "اقتراح 2"]
}`;

  const user = `حلّل هذه السجلات وحدد المشاكل:

\`\`\`
${recent.slice(-8000)}
\`\`\`

لو شفت نمط متكرر، ركّز عليه. لو شفت TypeError محدد، عيّن الملف والسطر بدقة.`;

  const result = await llm.call("debug", { system, user, json: true });

  let parsed;
  try { parsed = JSON.parse(result.text); }
  catch { parsed = { summary: result.text.slice(0, 200), suspects: [], suggestions: [], _raw: result.text }; }

  // 3. احفظ في memory للاستدعاء التالي
  memory.remember("debugger", "lastAnalysis", { ...parsed, ranAt: Date.now() });

  return { ...parsed, provider: result.provider, model: result.model };
};
