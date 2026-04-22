// Deterministic, local spoken self-repair detection.
//
// When a speaker restarts mid-sentence ("the meeting is at 3 actually at 4"),
// the trailing correction should replace the bit they are restarting from —
// the final text should read as the corrected thought, not a literal
// transcription of the false start.
//
// Safety is the dominant design choice: a wrong edit is worse than no edit.
// This module prefers returning { kind: "none" } over aggressive stitching.
// Filler cleanup (ums, uhs) is explicitly OUT of scope — the LLM
// post-processor on the transcribe path already handles those per context.

import {
  FLOW_REPAIR_MARKERS,
  FLOW_REPAIR_PREPOSITIONS,
  FLOW_REPAIR_MIN_LEFT_WORDS,
  FLOW_REPAIR_MIN_RIGHT_WORDS,
  FLOW_REPAIR_MIN_SPEECH_RATIO,
  FLOW_REPAIR_MIN_RMS_DB,
  FLOW_REPAIR_MIN_TEXT_CHARS,
} from "./flowConstants";

export type RepairResult =
  | { kind: "none" }
  | { kind: "intraUtterance"; cleaned: string; marker: string; leftWords: number; rightWords: number };

/** The audioQuality shape the repair trusts. Read-only — never recomputed
 *  here. If fields are missing, repair is skipped (conservative default). */
interface AudioQuality {
  rmsDb?: number;
  speechRatio?: number;
}

export function detectRepair(text: string, audioQuality: AudioQuality | null): RepairResult {
  // Weak-input gate. Any of these failing → skip repair. The speechRatio and
  // rmsDb values MUST come from the trusted TranscriptLike.audioQuality
  // already flowing through the pipeline — they are never recomputed here.
  if (!audioQuality) return { kind: "none" };
  if (text.length < FLOW_REPAIR_MIN_TEXT_CHARS) return { kind: "none" };
  if ((audioQuality.rmsDb ?? -Infinity) < FLOW_REPAIR_MIN_RMS_DB) return { kind: "none" };
  if ((audioQuality.speechRatio ?? 0) < FLOW_REPAIR_MIN_SPEECH_RATIO) return { kind: "none" };

  // Quoted-marker guard: allow "the word 'actually' is overused" to pass
  // through unchanged. Cheap check — look for any quote char at all in the
  // raw text, and if present, require the marker occurrence to NOT be
  // adjacent to a quote.
  const hasQuotes = /["'\u2018\u2019\u201c\u201d]/.test(text);

  // Find the rightmost marker. Rightmost = recency; the last correction wins.
  const hit = findRightmostMarker(text, hasQuotes);
  if (!hit) return { kind: "none" };

  const { markerStart, markerEnd, marker } = hit;
  const leftRaw = text.slice(0, markerStart).trimEnd();
  const tailRaw = text.slice(markerEnd).trimStart();

  const leftTokens = tokenize(leftRaw);
  const tailTokens = tokenize(tailRaw);

  if (leftTokens.length < FLOW_REPAIR_MIN_LEFT_WORDS) return { kind: "none" };
  if (tailTokens.length < FLOW_REPAIR_MIN_RIGHT_WORDS) return { kind: "none" };

  // "wait" is trigger-happy. Extra guard: require the tail to start with a
  // preposition, a numeric, or an "i mean"/"it's" style continuation marker.
  if (marker === "wait" || marker === "no wait") {
    const head = tailTokens[0]!.toLowerCase();
    const startsNumeric = /^\d/.test(head);
    const startsPrep = FLOW_REPAIR_PREPOSITIONS.includes(head);
    const startsContinuation = head === "it's" || head === "its" || head === "i";
    if (!startsNumeric && !startsPrep && !startsContinuation) return { kind: "none" };
  }

  // ── Stitching ──────────────────────────────────────────────────────
  // Rule 1: preposition-pair drop ("at 3 actually at 4" → drop "at 3")
  const leftLast = leftTokens[leftTokens.length - 1]?.toLowerCase();
  const leftPrev = leftTokens[leftTokens.length - 2]?.toLowerCase();
  const tailFirst = tailTokens[0]?.toLowerCase();

  let cleaned: string | null = null;

  if (
    leftPrev &&
    tailFirst &&
    FLOW_REPAIR_PREPOSITIONS.includes(leftPrev) &&
    leftPrev === tailFirst
  ) {
    // Drop the last two tokens of left (the preposition and its argument).
    const keptLeft = leftTokens.slice(0, -2).join(" ");
    cleaned = joinSentenceish(keptLeft, tailRaw);
  }
  // Also handle the degenerate case where leftLast itself is the preposition
  // and there's no numeric argument yet ("let's meet at actually in 5").
  else if (leftLast && tailFirst && FLOW_REPAIR_PREPOSITIONS.includes(leftLast) && leftLast !== tailFirst) {
    const keptLeft = leftTokens.slice(0, -1).join(" ");
    cleaned = joinSentenceish(keptLeft, tailRaw);
  }

  // Rule 2: sentence-boundary fallback.
  if (cleaned === null) {
    const sentenceCut = lastSentenceBoundary(leftRaw);
    if (sentenceCut !== -1) {
      const keptLeft = leftRaw.slice(0, sentenceCut + 1).trim();
      cleaned = joinSentenceish(keptLeft, tailRaw);
    }
  }

  // Rule 3: if neither rule applies, don't guess. Skip.
  if (cleaned === null) return { kind: "none" };

  // Length guard: cleaned must be strictly shorter than the original by at
  // least the marker length. A stitch that grows the text means the rule
  // misfired — abort.
  if (cleaned.length > text.length) return { kind: "none" };
  if (cleaned.length > text.length - marker.length) return { kind: "none" };

  return {
    kind: "intraUtterance",
    cleaned: cleaned.trim(),
    marker,
    leftWords: leftTokens.length,
    rightWords: tailTokens.length,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface MarkerHit {
  marker: string;
  markerStart: number;
  markerEnd: number;
}

function findRightmostMarker(text: string, hasQuotes: boolean): MarkerHit | null {
  let best: MarkerHit | null = null;
  const lower = text.toLowerCase();

  for (const marker of FLOW_REPAIR_MARKERS) {
    const m = marker.toLowerCase();
    let idx = 0;
    while (idx < lower.length) {
      const found = lower.indexOf(m, idx);
      if (found === -1) break;
      // Require whole-word boundary on both sides.
      const before = found === 0 ? " " : lower[found - 1]!;
      const after = found + m.length >= lower.length ? " " : lower[found + m.length]!;
      const okBefore = /[\s.,!?;:]/.test(before);
      const okAfter = /[\s.,!?;:]/.test(after);
      if (okBefore && okAfter) {
        // Quoted-marker skip — if adjacent to a quote, treat as content.
        if (hasQuotes) {
          const quoteBefore = found > 0 && /["'\u2018\u2019\u201c\u201d]/.test(text[found - 1]!);
          const quoteAfter =
            found + m.length < text.length &&
            /["'\u2018\u2019\u201c\u201d]/.test(text[found + m.length]!);
          if (quoteBefore || quoteAfter) {
            idx = found + m.length;
            continue;
          }
        }
        if (!best || found > best.markerStart) {
          best = { marker, markerStart: found, markerEnd: found + m.length };
        }
      }
      idx = found + m.length;
    }
  }
  return best;
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter((t) => t.length > 0);
}

function lastSentenceBoundary(text: string): number {
  // Returns the index of the last `.`, `!`, or `?` before the end of `text`,
  // or -1 if none. Quoted punctuation counts.
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i]!;
    if (c === "." || c === "!" || c === "?") return i;
  }
  return -1;
}

function joinSentenceish(left: string, right: string): string {
  const l = left.trim();
  const r = right.trim();
  if (l.length === 0) return r;
  if (r.length === 0) return l;
  // Preserve terminal punctuation on the left if it ended a sentence.
  const needsSpace = !/[.!?,:;]$/.test(l) || /[.!?]$/.test(l);
  return needsSpace ? `${l} ${r}` : `${l}${r}`;
}
