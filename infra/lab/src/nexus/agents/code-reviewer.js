/**
 * 👁️ Code Reviewer Agent — يراجع التغييرات قبل النشر
 *
 * Input:  { files: ["src/x.js", ...] } أو { gitRef: "HEAD~1" }
 * Output: { verdict: "approve|changes_requested|reject", issues, summary }
 */

module.exports = async function codeReviewer({ input, llm, reader, log }) {
  let diff = "";

  if (input.files) {
    log(`reviewing ${input.files.length} file(s)`);
    for (const f of input.files) {
      const exists = await reader.exists(f);
      if (!exists) continue;
      const content = await reader.readFile(f);
      diff += `\n\n=== ${f} ===\n${content.slice(0, 6000)}`;
    }
  } else {
    const gitRef = input.gitRef || "HEAD~1";
    log(`reading git diff ${gitRef}`);
    diff = reader.gitDiff(gitRef) || "(no diff available)";
    diff = diff.slice(0, 12000);
  }

  if (!diff.trim() || diff === "(no diff available)") {
    return { verdict: "approve", summary: "No changes to review", issues: [] };
  }

  const system = `أنت Senior Code Reviewer للـ Node.js. تراجع تغييرات Thawani (متجر/بوت واتس).
معايير المراجعة:
1. أمان: SQL injection, XSS, command injection, path traversal
2. أداء: blocking ops, memory leaks, N+1 queries
3. صيانة: نسخ خطر، dead code، magic numbers
4. اتفاقيات: RTL, Arabic, نمط الكود الموجود

رد بـ JSON فقط:
{
  "verdict": "approve|changes_requested|reject",
  "summary": "ملخص في سطرين",
  "issues": [
    {"severity": "critical|high|medium|low", "file": "x.js", "line": 1, "issue": "...", "fix": "..."}
  ]
}`;

  const user = `راجع هذا الكود/diff:\n\n${diff}`;

  const result = await llm.call("code_review", { system, user, json: true, maxTokens: 3000 });

  let parsed;
  try { parsed = JSON.parse(result.text); }
  catch { parsed = { verdict: "changes_requested", summary: "Failed to parse review", issues: [], _raw: result.text }; }

  return { ...parsed, provider: result.provider, model: result.model };
};
