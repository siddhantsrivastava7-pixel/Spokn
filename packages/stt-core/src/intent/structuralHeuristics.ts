import type { ScoredSegment } from "../types";

/**
 * Structural / length signals used by the intent classifier when no explicit
 * trigger phrase is present. Every signal is cheap and deterministic.
 */
export interface StructuralSignals {
  /** 3+ consecutive noun-phrase-like tokens → bullet_list candidate. */
  nounPhraseRun: boolean;
  /** 3+ comma-separated items with no terminal punctuation → bullet_list. */
  commaChain: boolean;
  /** 3+ items separated by "and" → bullet_list. */
  andChain: boolean;
  /** Sentence starts with a base-form verb → todo_list. */
  imperative: boolean;
  /** Coarse segment-length distribution. */
  lengthPattern: "short_segments" | "uniform_short" | "mixed" | "long_form";
  /** Machine-readable list of fired signal names. */
  fired: string[];
}

const IMPERATIVE_VERBS = new Set<string>([
  "call",
  "send",
  "review",
  "finish",
  "write",
  "check",
  "book",
  "buy",
  "schedule",
  "pay",
  "order",
  "get",
  "pick",
  "drop",
  "email",
  "text",
  "reply",
  "update",
  "fix",
  "file",
  "submit",
  "remind",
  "follow",
  "ship",
  "draft",
  "plan",
  "prepare",
  "reach",
]);

const ENGLISH_STOPWORDS = new Set<string>([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "so",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "as",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "we",
  "they",
  "it",
  "he",
  "she",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
]);

const COMMON_VERBS = new Set<string>([
  "go",
  "goes",
  "going",
  "went",
  "gone",
  "do",
  "does",
  "doing",
  "did",
  "done",
  "have",
  "has",
  "having",
  "had",
  "make",
  "makes",
  "making",
  "made",
  "get",
  "gets",
  "getting",
  "got",
  "take",
  "takes",
  "taking",
  "took",
  "taken",
  "come",
  "comes",
  "coming",
  "came",
  "see",
  "sees",
  "seeing",
  "saw",
  "seen",
  "know",
  "knows",
  "knowing",
  "knew",
  "known",
  "think",
  "thinks",
  "thinking",
  "thought",
  "want",
  "wants",
  "wanting",
  "wanted",
  "use",
  "uses",
  "using",
  "used",
  "work",
  "works",
  "working",
  "worked",
  "need",
  "needs",
  "needed",
  "needing",
  "seem",
  "seems",
  "seeming",
  "seemed",
  "feel",
  "feels",
  "feeling",
  "felt",
  "look",
  "looks",
  "looked",
  "looking",
  "say",
  "says",
  "said",
  "saying",
  "tell",
  "tells",
  "told",
  "telling",
  "give",
  "gives",
  "gave",
  "given",
  "giving",
  "find",
  "finds",
  "found",
  "finding",
  "build",
  "builds",
  "built",
  "building",
  "run",
  "runs",
  "running",
  "ran",
  "ship",
  "ships",
  "shipped",
  "shipping",
  "finish",
  "finishes",
  "finished",
  "finishing",
]);

export function computeStructuralSignals(
  text: string,
  segments?: ScoredSegment[],
): StructuralSignals {
  const fired: string[] = [];
  const nounPhraseRun = detectNounPhraseRun(text);
  if (nounPhraseRun) fired.push("noun_phrase_run");
  const commaChain = detectCommaChain(text);
  if (commaChain) fired.push("comma_chain");
  const andChain = detectAndChain(text);
  if (andChain) fired.push("and_chain");
  const imperative = detectImperative(text);
  if (imperative) fired.push("imperative");
  const lengthPattern = classifyLength(segments);
  fired.push(`length:${lengthPattern}`);
  return {
    nounPhraseRun,
    commaChain,
    andChain,
    imperative,
    lengthPattern,
    fired,
  };
}

// ── Detectors ────────────────────────────────────────────────────────────────

/**
 * Heuristic: 3+ consecutive token groups that look like short noun phrases.
 * A token group is: one or two non-verb content words, delimited by whitespace.
 * No comma / conjunction / verb between them.
 */
function detectNounPhraseRun(text: string): boolean {
  const cleaned = text
    .trim()
    .replace(/[.!?]+$/, "")
    .toLowerCase();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;
  // No commas, no conjunctions, no verbs.
  if (/,/.test(cleaned)) return false;
  for (const tok of tokens) {
    if (tok === "and" || tok === "or" || tok === "but") return false;
    if (COMMON_VERBS.has(tok) || IMPERATIVE_VERBS.has(tok)) return false;
  }
  const contentTokens = tokens.filter((t) => !ENGLISH_STOPWORDS.has(t));
  return contentTokens.length >= 3;
}

function detectCommaChain(text: string): boolean {
  const trimmed = text.trim().replace(/[.!?]+$/, "");
  const parts = trimmed
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return false;
  // Each part should be short (≤ 5 words).
  return parts.every((p) => p.split(/\s+/).length <= 5);
}

function detectAndChain(text: string): boolean {
  const lower = text.toLowerCase();
  // Count " and " occurrences, plus ", and ".
  const count = (lower.match(/\band\b/g) ?? []).length;
  return count >= 2;
}

function detectImperative(text: string): boolean {
  const firstSentence = text.split(/[.!?]/, 1)[0] ?? "";
  const firstWord = firstSentence.trim().toLowerCase().split(/\s+/)[0];
  if (!firstWord) return false;
  return IMPERATIVE_VERBS.has(firstWord);
}

function classifyLength(
  segments?: ScoredSegment[],
): StructuralSignals["lengthPattern"] {
  if (!segments || segments.length === 0) return "mixed";
  const wordCounts = segments.map(
    (s) => s.text.trim().split(/\s+/).filter(Boolean).length,
  );
  const durations = segments.map((s) => s.endMs - s.startMs);
  const avgWords = wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length;
  const allShort = durations.every((d) => d < 2000) && wordCounts.every((w) => w < 8);
  if (allShort && segments.length >= 4) return "uniform_short";
  if (avgWords > 15) return "long_form";
  if (wordCounts.some((w) => w < 3) && wordCounts.some((w) => w > 10)) return "mixed";
  if (wordCounts.some((w) => w < 8)) return "short_segments";
  return "mixed";
}
