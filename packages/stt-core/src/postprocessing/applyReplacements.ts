/**
 * Apply whole-word replacements to text from `AdaptiveRules.replacements`.
 *
 * Match semantics:
 *   - Case-insensitive lookup by lowercased key.
 *   - Replacement value's casing is preserved verbatim (no capitalization
 *     of output based on surrounding context — downstream stages handle
 *     sentence casing).
 *   - Word boundary matching only. "u" won't match inside "used"; "im"
 *     won't match inside "I'm" (apostrophe breaks the word).
 *
 * Performance: builds one compiled regex per call, O(n) scan. Keys are
 * ordered longest-first inside the alternation so that e.g. "you know"
 * wins over a standalone "you" rule.
 */
export function applyReplacements(
  text: string,
  replacements?: Record<string, string>,
): string {
  if (!replacements) return text;
  const keys = Object.keys(replacements).filter((k) => k.length > 0);
  if (keys.length === 0) return text;

  const sorted = keys.sort((a, b) => b.length - a.length);
  const alt = sorted.map(escapeRegExp).join("|");
  const pattern = new RegExp(`\\b(?:${alt})\\b`, "gi");

  return text.replace(pattern, (match) => {
    const lower = match.toLowerCase();
    return replacements[lower] ?? match;
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
