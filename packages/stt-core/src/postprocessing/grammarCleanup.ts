import type { CorrectionBudget, CorrectionMode } from "./correctionMode";
import type { TextToken } from "./entityProtection";
import {
  ALWAYS_FILLERS_SET,
  LIKE_BLOCKING_SET,
  YOU_KNOW_MEANINGFUL_FOLLOWERS_SET,
} from "./fillerWords";
import type { CorrectionLogEntry } from "./processTypes";

export interface GrammarCleanupOptions {
  budget: CorrectionBudget;
  mode: CorrectionMode;
  /** Filler words the user has consistently re-inserted. Kept as-is. */
  fillerExceptions?: ReadonlySet<string>;
}

export interface GrammarCleanupResult {
  tokens: TextToken[];
  corrections: CorrectionLogEntry[];
}

const STOPWORDS_FOR_COLLAPSE = new Set<string>([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "so",
  "i",
  "you",
  "we",
  "they",
  "it",
  "is",
  "are",
  "was",
  "were",
]);

/**
 * Normalizes casing + punctuation and removes fillers (subject to budget).
 *
 * Invariants:
 *   - Never adds a word.
 *   - Never modifies a token where mask[i] is true (numbers, emails, URLs,
 *     proper nouns).
 *   - Always emits an audit entry for every change.
 */
export function cleanupGrammar(
  tokens: TextToken[],
  mask: boolean[],
  opts: GrammarCleanupOptions,
): GrammarCleanupResult {
  const corrections: CorrectionLogEntry[] = [];
  const out: TextToken[] = tokens.map((t) => ({ ...t }));

  // ── Casing: capitalize the first word of each sentence ────────────────────
  if (opts.budget.allowCasing) {
    capitalizeSentenceStarts(out, mask, opts.mode, corrections);
  }

  // ── Filler removal ────────────────────────────────────────────────────────
  if (opts.budget.allowFillerRemoval) {
    removeFillers(out, mask, opts, corrections);
  }

  // ── Stopword collapse: "the the" → "the" — only under assertive budget ───
  if (opts.budget.allowRepeatedStopwordCollapse) {
    collapseRepeatedStopwords(out, mask, opts.mode, corrections);
  }

  // ── Punctuation normalization ─────────────────────────────────────────────
  if (opts.budget.allowPunctuation) {
    normalizePunctuation(out, opts.mode, corrections);
  }

  return { tokens: out, corrections };
}

// ── Casing ──────────────────────────────────────────────────────────────────

function capitalizeSentenceStarts(
  tokens: TextToken[],
  mask: boolean[],
  mode: CorrectionMode,
  log: CorrectionLogEntry[],
): void {
  let expectCap = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.isSeparator || t.text.length === 0) {
      if (t.text && /[.!?]/.test(t.text)) expectCap = true;
      continue;
    }
    if (expectCap) {
      if (!mask[i]) {
        const first = t.text[0]!;
        if (first !== first.toUpperCase() || first === first.toLowerCase()) {
          const capped = first.toUpperCase() + t.text.slice(1);
          if (capped !== t.text) {
            log.push({
              kind: "casing",
              from: t.text,
              to: capped,
              mode,
            });
            tokens[i] = { ...t, text: capped };
          }
        }
      }
      expectCap = false;
    }
  }
}

// ── Fillers ────────────────────────────────────────────────────────────────

function removeFillers(
  tokens: TextToken[],
  mask: boolean[],
  opts: GrammarCleanupOptions,
  log: CorrectionLogEntry[],
): void {
  const wordIndices: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]!.isSeparator && tokens[i]!.text.length > 0) {
      wordIndices.push(i);
    }
  }

  const toRemove = new Set<number>();

  for (let k = 0; k < wordIndices.length; k++) {
    const i = wordIndices[k]!;
    if (mask[i]) continue;
    const lower = tokens[i]!.text.toLowerCase();

    if (opts.fillerExceptions?.has(lower)) continue;

    // 1. Always-fillers (uh, um, ...).
    if (ALWAYS_FILLERS_SET.has(lower)) {
      toRemove.add(i);
      log.push({ kind: "filler", from: tokens[i]!.text, to: "", mode: opts.mode });
      continue;
    }

    // 2. Multi-word "you know" — drop when followed by something that is NOT
    //    a meaningful completer.
    if (lower === "you" && k + 1 < wordIndices.length) {
      const nextIdx = wordIndices[k + 1]!;
      if (tokens[nextIdx]!.text.toLowerCase() === "know") {
        const after = k + 2 < wordIndices.length ? wordIndices[k + 2]! : -1;
        const nextWord =
          after >= 0 ? tokens[after]!.text.toLowerCase() : undefined;
        const meaningful =
          nextWord !== undefined &&
          YOU_KNOW_MEANINGFUL_FOLLOWERS_SET.has(nextWord);
        if (!meaningful && !mask[nextIdx]) {
          toRemove.add(i);
          toRemove.add(nextIdx);
          log.push({
            kind: "filler",
            from: `${tokens[i]!.text} ${tokens[nextIdx]!.text}`,
            to: "",
            mode: opts.mode,
          });
          k += 1; // skip the "know" we just consumed
          continue;
        }
      }
    }

    // 3. Contextual "like" — drop when not preceded by a blocking verb.
    if (lower === "like") {
      const prevIdx = k > 0 ? wordIndices[k - 1]! : -1;
      const prevWord =
        prevIdx >= 0 ? tokens[prevIdx]!.text.toLowerCase() : "";
      if (!LIKE_BLOCKING_SET.has(prevWord) && prevWord !== "") {
        toRemove.add(i);
        log.push({ kind: "filler", from: tokens[i]!.text, to: "", mode: opts.mode });
      }
      continue;
    }
  }

  // Apply removals: empty the token and any leading whitespace that would
  // otherwise create a doubled space.
  for (const i of toRemove) {
    tokens[i] = { ...tokens[i]!, text: "" };
    // Collapse the separator right after the removed word if it's whitespace
    // AND the separator before is also whitespace — we only need one.
    if (i + 1 < tokens.length && /^\s+$/.test(tokens[i + 1]!.text)) {
      tokens[i + 1] = { ...tokens[i + 1]!, text: "" };
    }
  }
}

// ── Stopword collapse ──────────────────────────────────────────────────────

function collapseRepeatedStopwords(
  tokens: TextToken[],
  mask: boolean[],
  mode: CorrectionMode,
  log: CorrectionLogEntry[],
): void {
  const wordIndices: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]!.isSeparator && tokens[i]!.text.length > 0) {
      wordIndices.push(i);
    }
  }
  for (let k = 0; k < wordIndices.length - 1; k++) {
    const i = wordIndices[k]!;
    const j = wordIndices[k + 1]!;
    if (mask[i] || mask[j]) continue;
    const a = tokens[i]!.text.toLowerCase();
    const b = tokens[j]!.text.toLowerCase();
    if (a !== b) continue;
    if (!STOPWORDS_FOR_COLLAPSE.has(a)) continue;
    log.push({
      kind: "stopword_collapse",
      from: `${tokens[i]!.text} ${tokens[j]!.text}`,
      to: tokens[j]!.text,
      mode,
    });
    // Remove the earlier one (and its trailing whitespace).
    tokens[i] = { ...tokens[i]!, text: "" };
    if (i + 1 < tokens.length && /^\s+$/.test(tokens[i + 1]!.text)) {
      tokens[i + 1] = { ...tokens[i + 1]!, text: "" };
    }
  }
}

// ── Punctuation normalization ──────────────────────────────────────────────

function normalizePunctuation(
  tokens: TextToken[],
  mode: CorrectionMode,
  log: CorrectionLogEntry[],
): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.isSeparator || t.text.length === 0) continue;
    // Collapse duplicated terminal punctuation (".. .!" → ".")
    const normalized = t.text
      .replace(/\s+([,.!?;:])/g, "$1")
      .replace(/([,.!?;:]){2,}/g, "$1")
      .replace(/[ \t]{2,}/g, " ");
    if (normalized !== t.text) {
      log.push({
        kind: "punctuation",
        from: t.text,
        to: normalized,
        mode,
      });
      tokens[i] = { ...t, text: normalized };
    }
  }

  // Ensure terminal punctuation at the very end of the string — only if the
  // text has real content and no terminator yet.
  const lastMeaningful = findLastWordIndex(tokens);
  if (lastMeaningful < 0) return;
  // Look at what's after the last word.
  let trailingPunct = "";
  for (let i = lastMeaningful + 1; i < tokens.length; i++) {
    trailingPunct += tokens[i]!.text;
  }
  if (!/[.!?]/.test(trailingPunct)) {
    log.push({
      kind: "punctuation",
      from: "",
      to: ".",
      mode,
    });
    tokens.push({
      text: ".",
      start: -1,
      end: -1,
      isSeparator: true,
    });
  }
}

function findLastWordIndex(tokens: TextToken[]): number {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (!t.isSeparator && t.text.length > 0) return i;
  }
  return -1;
}
