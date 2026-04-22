import type { ScoredSegment, TranscriptSegment } from "../types";
import { COMMAND_VERBS, type FormatIntent, type IntentResult } from "./intentDetection";

/**
 * Transform a transcript into a human-presentable form based on `intent`.
 *
 * Accepts either a bare `FormatIntent` (back-compat) or the richer
 * `IntentResult` emitted by `detectIntentHybrid`.
 *
 * Guarantees:
 *   - Never invents words not already in the input text (the one exception is
 *     deterministic verb inheritance for LIST+COMMAND bullets — the verb
 *     always comes from another bullet in the same utterance).
 *   - Idempotent: applying twice converges on the same output.
 *   - Pure: no side effects.
 *   - Acronyms (2+ uppercase letters in a row) are never lowercased.
 *
 * Confidence-aware behavior (PARAGRAPH): when either side of a pause is
 * tagged `confidenceLevel === "LOW"`, the formatter downgrades a would-be
 * period to a comma. Low confidence shouldn't assert sentence boundaries
 * that the model may have gotten wrong.
 */
export function formatByIntent(
  intent: FormatIntent | IntentResult,
  segments: ReadonlyArray<TranscriptSegment | ScoredSegment>,
  fullText: string,
): string {
  const primary: FormatIntent = typeof intent === "string" ? intent : intent.primary;
  const secondary: FormatIntent | undefined =
    typeof intent === "string" ? undefined : intent.secondary;

  if (primary === "LIST" && secondary === "COMMAND") {
    return formatListCommand(segments, fullText);
  }

  switch (primary) {
    case "LIST":
      return formatList(segments, fullText);
    case "COMMAND":
      return formatCommand(fullText);
    case "PARAGRAPH":
      return formatParagraph(segments, fullText);
    case "NOTE":
      return formatNote(fullText);
  }
}

// ── LIST ────────────────────────────────────────────────────────────────────

function formatList(
  segments: ReadonlyArray<TranscriptSegment | ScoredSegment>,
  fullText: string,
): string {
  const lines = splitIntoListItems(segments, fullText);
  if (lines.length === 0) return cleanLine(fullText);

  return lines
    .map((l) => {
      const withoutBullet = l.replace(/^[\-•*·\s]+/, "").trimEnd();
      const trimmed = withoutBullet.replace(/[.!?]+$/, "");
      return `- ${capitalizeFirstPreservingAcronym(trimmed)}`;
    })
    .join("\n");
}

function splitIntoListItems(
  segments: ReadonlyArray<TranscriptSegment | ScoredSegment>,
  fullText: string,
): string[] {
  if (segments.length > 0) {
    return segments
      .map((s) => cleanLine(stripFillers(s.text)))
      .filter((s) => s.length > 0);
  }
  return fullText
    .split(/[.\n]|(?:,\s+and\s+)|(?:\s+and\s+)|,/i)
    .map((s) => cleanLine(stripFillers(s)))
    .filter((s) => s.length > 0);
}

// ── LIST + COMMAND (hybrid) ─────────────────────────────────────────────────

/**
 * Render an imperative list like "buy milk, eggs and call mom" as:
 *
 *   - Buy milk
 *   - Buy eggs
 *   - Call mom
 *
 * When a subsequent bullet doesn't already start with a known verb, we
 * prepend the first bullet's leading verb. The verb is taken from the
 * input text itself — we never introduce a word that wasn't spoken.
 */
function formatListCommand(
  segments: ReadonlyArray<TranscriptSegment | ScoredSegment>,
  fullText: string,
): string {
  const items = splitIntoListItems(segments, fullText);
  if (items.length === 0) return cleanLine(fullText);

  const firstWordsFirstItem = tokenizeWords(items[0]!);
  const inheritedVerb =
    firstWordsFirstItem[0] !== undefined && COMMAND_VERBS.has(firstWordsFirstItem[0])
      ? firstWordsFirstItem[0]
      : undefined;

  const bullets = items.map((item, i) => {
    const cleaned = cleanLine(stripFillers(item)).replace(/[.!?]+$/, "");
    if (i === 0 || !inheritedVerb) {
      return `- ${capitalizeFirstPreservingAcronym(cleaned)}`;
    }
    const firstWord = tokenizeWords(cleaned)[0];
    if (firstWord && COMMAND_VERBS.has(firstWord)) {
      return `- ${capitalizeFirstPreservingAcronym(cleaned)}`;
    }
    return `- ${capitalizeFirstPreservingAcronym(`${inheritedVerb} ${cleaned}`)}`;
  });
  return bullets.join("\n");
}

// ── COMMAND ─────────────────────────────────────────────────────────────────

function formatCommand(fullText: string): string {
  const stripped = stripFillers(fullText);
  const collapsed = cleanLine(stripped);
  if (!collapsed) return "";
  const trimmed = collapsed.replace(/[.!?]+$/, "");
  return capitalizeFirstPreservingAcronym(trimmed);
}

// ── PARAGRAPH ───────────────────────────────────────────────────────────────

const PAUSE_COMMA_MIN_MS = 400;
const PAUSE_PERIOD_MIN_MS = 900;

function formatParagraph(
  segments: ReadonlyArray<TranscriptSegment | ScoredSegment>,
  fullText: string,
): string {
  if (segments.length > 1) {
    const fromSegments = formatParagraphFromSegments(segments);
    if (fromSegments) return fromSegments;
  }
  return formatParagraphFromText(fullText);
}

function formatParagraphFromSegments(
  segments: ReadonlyArray<TranscriptSegment | ScoredSegment>,
): string {
  interface Piece {
    text: string;
    startMs: number;
    endMs: number;
    low: boolean;
  }

  const pieces: Piece[] = [];
  for (const seg of segments) {
    const cleaned = cleanLine(seg.text);
    if (!cleaned) continue;
    pieces.push({
      text: cleaned,
      startMs: seg.startMs,
      endMs: seg.endMs,
      low: isLowConfidence(seg),
    });
  }
  if (pieces.length === 0) return "";

  const parts: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (parts.length === 0) {
      parts.push(piece.text);
      continue;
    }
    const prev = pieces[i - 1]!;
    const gap = Math.max(0, piece.startMs - prev.endMs);
    const lastIdx = parts.length - 1;
    const lastPart = parts[lastIdx]!;
    const adjacentLow = prev.low || piece.low;

    if (gap >= PAUSE_PERIOD_MIN_MS && !adjacentLow) {
      parts[lastIdx] = endsWithTerminal(lastPart) ? lastPart : `${lastPart}.`;
      parts.push(piece.text);
    } else if (gap >= PAUSE_COMMA_MIN_MS || (gap >= PAUSE_PERIOD_MIN_MS && adjacentLow)) {
      parts[lastIdx] = endsWithAnyPunct(lastPart) ? lastPart : `${lastPart},`;
      parts.push(piece.text);
    } else {
      parts.push(piece.text);
    }
  }

  let joined = parts.join(" ").replace(/\s+([,.!?;:])/g, "$1");
  joined = capitalizeFirstPreservingAcronym(joined);
  joined = capitalizeSentences(joined);
  if (!endsWithTerminal(joined)) joined = `${joined}.`;
  return joined;
}

function formatParagraphFromText(fullText: string): string {
  const cleaned = cleanLine(fullText);
  if (!cleaned) return "";
  let out = capitalizeFirstPreservingAcronym(cleaned);
  out = capitalizeSentences(out);
  return endsWithTerminal(out) ? out : `${out}.`;
}

function isLowConfidence(
  seg: TranscriptSegment | ScoredSegment,
): boolean {
  const level = (seg as ScoredSegment).confidenceLevel;
  return level === "LOW";
}

// ── NOTE ────────────────────────────────────────────────────────────────────

function formatNote(fullText: string): string {
  return cleanLine(fullText);
}

// ── Shared helpers ──────────────────────────────────────────────────────────

const FILLER_WORDS: ReadonlyArray<string> = ["uh", "um", "erm", "like", "you know", "i mean"];

function stripFillers(text: string): string {
  let out = text;
  for (const filler of FILLER_WORDS) {
    const escaped = filler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\s)${escaped}(?=\\s|$|[,.!?])`, "gi");
    out = out.replace(re, "$1");
  }
  return out;
}

function cleanLine(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function endsWithTerminal(text: string): boolean {
  return /[.!?]$/.test(text);
}

function endsWithAnyPunct(text: string): boolean {
  return /[,.!?;:]$/.test(text);
}

function tokenizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function capitalizeFirstPreservingAcronym(text: string): string {
  if (!text) return text;
  const firstWord = text.match(/^\S+/)?.[0] ?? "";
  if (isAcronymLike(firstWord)) return text;
  return text[0]!.toUpperCase() + text.slice(1);
}

function capitalizeSentences(text: string): string {
  return text.replace(
    /([.!?]\s+)(\S+)/g,
    (_m, boundary: string, word: string) => {
      if (isAcronymLike(word)) return boundary + word;
      return boundary + word[0]!.toUpperCase() + word.slice(1);
    },
  );
}

function isAcronymLike(word: string): boolean {
  const leading = word.match(/^[A-Z]+/)?.[0] ?? "";
  return leading.length >= 2;
}
