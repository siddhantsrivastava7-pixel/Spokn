// Canonical Flow session buffer. Single source of truth for what currently
// exists in the target field. Mutating methods return a typed FlowOp that the
// injection queue applies. The buffer never touches the OS.
//
// Recency bias: all mutations operate on the most recent segment first, then
// walk backward. This matches how humans correct themselves mid-flow.

import {
  FLOW_COMMAND_FUZZY_MAX_DISTANCE,
  FLOW_COMMAND_FUZZY_MIN_LEN,
  FLOW_UNDO_STACK_MAX,
} from "./flowConstants";

export interface Segment {
  id: string;
  text: string;
  words: number;
}

export type FlowOp =
  | { kind: "append"; text: string; appendedSegmentId: string }
  | { kind: "fullReplace"; fullText: string }
  | { kind: "sendKey"; key: "Enter" | "CtrlEnter"; sourceId: string }
  | { kind: "noop"; reason: string };

export interface SessionBuffer {
  segments(): readonly Segment[];
  fullText(): string;
  /** Append a fresh utterance. */
  append(text: string): FlowOp;
  /** Replace the most recent segment's text. */
  replaceLast(text: string): FlowOp;
  /** Recency-biased substring replace. Exact-then-fuzzy, walks backward. */
  changeXtoY(from: string, to: string): FlowOp;
  /** Drop the last word of the most recent non-empty segment. */
  deleteLastWord(): FlowOp;
  /** Drop the last sentence; walks back across segments if needed. */
  deleteLastSentence(): FlowOp;
  /** Drop the entire most recent segment. */
  deleteLastSegment(): FlowOp;
  /** Append a paragraph break. */
  newParagraph(): FlowOp;
  /** Pop the last applied op from the undo stack. */
  undo(): FlowOp;
  /** Snapshot for restore-on-cancel scenarios. */
  snapshot(): readonly Segment[];
  /** Restore from a snapshot. */
  restore(snapshot: readonly Segment[]): void;
}

export function createSessionBuffer(): SessionBuffer {
  let segments: Segment[] = [];
  // Each undo entry is the segments list as it was BEFORE the corresponding op.
  const undoStack: Segment[][] = [];
  let nextId = 1;

  function newId(): string {
    return `s_${nextId++}`;
  }

  function pushUndo() {
    undoStack.push(segments.map((s) => ({ ...s })));
    if (undoStack.length > FLOW_UNDO_STACK_MAX) undoStack.shift();
  }

  function fullText(): string {
    return segments.map((s) => s.text).join("");
  }

  function append(rawText: string): FlowOp {
    const text = rawText.length === 0 ? "" : ensureLeadingSpace(rawText, segments);
    if (text.length === 0) return { kind: "noop", reason: "empty" };
    pushUndo();
    const seg: Segment = { id: newId(), text, words: countWords(text) };
    segments.push(seg);
    return { kind: "append", text, appendedSegmentId: seg.id };
  }

  function replaceLast(text: string): FlowOp {
    if (segments.length === 0) return { kind: "noop", reason: "empty_buffer" };
    pushUndo();
    const last = segments[segments.length - 1]!;
    last.text = text;
    last.words = countWords(text);
    return { kind: "fullReplace", fullText: fullText() };
  }

  function changeXtoY(fromRaw: string, toRaw: string): FlowOp {
    const from = fromRaw.trim();
    const to = toRaw.trim();
    if (from.length === 0) return { kind: "noop", reason: "empty_from" };

    // Walk segments backward; in each, try exact then fuzzy.
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!;
      const replaced = replaceInText(seg.text, from, to);
      if (replaced !== null) {
        pushUndo();
        seg.text = replaced;
        seg.words = countWords(replaced);
        return { kind: "fullReplace", fullText: fullText() };
      }
    }
    return { kind: "noop", reason: "no_match" };
  }

  function deleteLastWord(): FlowOp {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!;
      const trimmed = seg.text.trimEnd();
      const idx = trimmed.search(/\S+\s*$/);
      if (idx === -1) continue;
      pushUndo();
      seg.text = trimmed.slice(0, idx).trimEnd();
      seg.words = countWords(seg.text);
      if (seg.text.length === 0) {
        // Drop fully-empty segment
        segments.splice(i, 1);
      }
      return { kind: "fullReplace", fullText: fullText() };
    }
    return { kind: "noop", reason: "empty_buffer" };
  }

  function deleteLastSentence(): FlowOp {
    if (segments.length === 0) return { kind: "noop", reason: "empty_buffer" };
    pushUndo();
    // Combine tail segments until we find a sentence boundary, then chop.
    let combined = "";
    let cutFromIndex = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      combined = segments[i]!.text + combined;
      const m = combined.match(/[^.!?]*[.!?][\s"')\]]*$/);
      if (m && m[0].length < combined.length) {
        // Found a complete trailing sentence with material before it
        const keepLen = combined.length - m[0].length;
        const head = combined.slice(0, keepLen).trimEnd();
        // Drop the tail segments and replace with the trimmed head
        segments.splice(i, segments.length - i);
        if (head.length > 0) {
          segments.push({ id: newId(), text: head, words: countWords(head) });
        }
        return { kind: "fullReplace", fullText: fullText() };
      }
      cutFromIndex = i;
    }
    // No sentence boundary found at all → clear the buffer
    if (cutFromIndex !== -1) {
      segments = [];
    }
    return { kind: "fullReplace", fullText: fullText() };
  }

  function deleteLastSegment(): FlowOp {
    if (segments.length === 0) return { kind: "noop", reason: "empty_buffer" };
    pushUndo();
    segments.pop();
    return { kind: "fullReplace", fullText: fullText() };
  }

  function newParagraph(): FlowOp {
    pushUndo();
    const text = segments.length === 0 ? "" : "\n\n";
    const seg: Segment = { id: newId(), text, words: 0 };
    segments.push(seg);
    return { kind: "append", text, appendedSegmentId: seg.id };
  }

  function undo(): FlowOp {
    const prior = undoStack.pop();
    if (!prior) return { kind: "noop", reason: "nothing_to_undo" };
    segments = prior.map((s) => ({ ...s }));
    return { kind: "fullReplace", fullText: fullText() };
  }

  function snapshot(): readonly Segment[] {
    return segments.map((s) => ({ ...s }));
  }

  function restore(snap: readonly Segment[]): void {
    segments = snap.map((s) => ({ ...s }));
  }

  return {
    segments: () => segments,
    fullText,
    append,
    replaceLast,
    changeXtoY,
    deleteLastWord,
    deleteLastSentence,
    deleteLastSegment,
    newParagraph,
    undo,
    snapshot,
    restore,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

function ensureLeadingSpace(text: string, segments: readonly Segment[]): string {
  if (segments.length === 0) return text;
  const tail = segments[segments.length - 1]!.text;
  if (tail.length === 0) return text;
  const lastChar = tail[tail.length - 1]!;
  const firstChar = text[0]!;
  if (/\s/.test(lastChar) || /\s/.test(firstChar)) return text;
  // Don't add a space if the new text starts with sentence punctuation
  if (/[.,!?;:)\]]/.test(firstChar)) return text;
  return " " + text;
}

/**
 * Try to replace `from` with `to` in `text`. Walks the text right-to-left
 * (recency within a segment) and uses exact match first, then fuzzy match
 * (Levenshtein ≤ FLOW_COMMAND_FUZZY_MAX_DISTANCE) gated by min word length.
 * Returns the modified text, or null if no match.
 */
function replaceInText(text: string, from: string, to: string): string | null {
  // Exact, case-insensitive, last occurrence — preserves surrounding whitespace.
  const lcText = text.toLowerCase();
  const lcFrom = from.toLowerCase();
  const exactIdx = lcText.lastIndexOf(lcFrom);
  if (exactIdx !== -1) {
    return text.slice(0, exactIdx) + to + text.slice(exactIdx + from.length);
  }

  // Fuzzy: tokenize, find the rightmost word within distance threshold.
  if (from.length < FLOW_COMMAND_FUZZY_MIN_LEN) return null;

  const wordRe = /\S+/g;
  type Hit = { start: number; end: number; word: string; distance: number };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(text)) !== null) {
    const word = m[0];
    if (Math.abs(word.length - from.length) > FLOW_COMMAND_FUZZY_MAX_DISTANCE) continue;
    const d = levenshtein(word.toLowerCase(), lcFrom);
    if (d <= FLOW_COMMAND_FUZZY_MAX_DISTANCE) {
      hits.push({ start: m.index, end: m.index + word.length, word, distance: d });
    }
  }
  if (hits.length === 0) return null;
  // Pick the rightmost hit (recency within the segment), tiebreak by lowest distance.
  hits.sort((a, b) => b.start - a.start || a.distance - b.distance);
  const best = hits[0]!;
  return text.slice(0, best.start) + to + text.slice(best.end);
}

/** Iterative Levenshtein with O(n) memory. Pure function. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length]!;
}
