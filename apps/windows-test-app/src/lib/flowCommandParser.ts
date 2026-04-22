// Deterministic, regex-based command parser for Flow Mode.
// No AI, no fuzzy matching at the phrase level (the buffer's changeXtoY does
// fuzzy matching on the `from` argument, but the command shape itself is exact).
//
// Disambiguation rule: only short utterances (≤ FLOW_COMMAND_MAX_WORDS) that
// match a pattern *fully* (modulo trailing punctuation) are treated as
// commands. Anything else is content.
//
// The `send` command is stricter — it is recognized ONLY when the utterance
// is the send phrase and nothing else (punctuation/whitespace aside). This
// is a deliberate product rule: the intent-to-action mapping must be
// unambiguous and earphone-safe.

import { FLOW_COMMAND_MAX_WORDS, FLOW_SEND_MAX_TOKENS } from "./flowConstants";

export type Command =
  | { kind: "deleteLastWord" }
  | { kind: "deleteLastSentence" }
  | { kind: "deleteLast" }
  | { kind: "undo" }
  | { kind: "newParagraph" }
  | { kind: "send" }
  | { kind: "changeXtoY"; from: string; to: string };

interface SimplePattern {
  re: RegExp;
  build: (m: RegExpMatchArray) => Command;
}

const PATTERNS: readonly SimplePattern[] = [
  { re: /^(?:delete|remove)\s+(?:the\s+)?last\s+word$/i, build: () => ({ kind: "deleteLastWord" }) },
  { re: /^(?:delete|remove)\s+(?:the\s+)?last\s+sentence$/i, build: () => ({ kind: "deleteLastSentence" }) },
  { re: /^(?:delete|remove|scratch)\s+that(?:\s+one)?$/i, build: () => ({ kind: "deleteLast" }) },
  { re: /^scratch\s+that$/i, build: () => ({ kind: "deleteLast" }) },
  { re: /^undo(?:\s+that)?$/i, build: () => ({ kind: "undo" }) },
  { re: /^(?:new\s+(?:paragraph|line))$/i, build: () => ({ kind: "newParagraph" }) },
  {
    re: /^change\s+(.+?)\s+to\s+(.+)$/i,
    build: (m) => ({ kind: "changeXtoY", from: m[1]!.trim(), to: m[2]!.trim() }),
  },
  {
    re: /^replace\s+(.+?)\s+with\s+(.+)$/i,
    build: (m) => ({ kind: "changeXtoY", from: m[1]!.trim(), to: m[2]!.trim() }),
  },
];

// Send patterns are matched on their own pass, AFTER the token-count check,
// because they have stricter length requirements than the generic commands.
// Safe polite variants ("send this", "send please") accepted — still within
// FLOW_SEND_MAX_TOKENS and unambiguous. Do not broaden further without a
// measured need; loose grammar is the enemy of accidental sends.
const SEND_RE = /^(?:send|send it|send this|send please|submit|post this|post it)$/i;

/**
 * Returns a Command if the utterance fully matches a known phrase, else null.
 * Strips trailing/leading whitespace and trailing punctuation before matching.
 * Rejects utterances longer than FLOW_COMMAND_MAX_WORDS as content.
 */
export function parseCommand(rawText: string): Command | null {
  const text = rawText.trim();
  if (text.length === 0) return null;

  const wordCount = text.split(/\s+/).length;
  if (wordCount > FLOW_COMMAND_MAX_WORDS) return null;

  // Strip trailing terminal punctuation; preserve internal punctuation since
  // "change foo, bar to baz" is unusual but valid.
  const normalized = text.replace(/[.!?,;:\s]+$/g, "");

  // Send is the strictest path — no extra lexical content permitted, and
  // the whole utterance must be ≤ FLOW_SEND_MAX_TOKENS (stricter than the
  // generic command gate). This is the deliberate product rule.
  const normalizedTokens = normalized.split(/\s+/).length;
  if (normalizedTokens <= FLOW_SEND_MAX_TOKENS && SEND_RE.test(normalized)) {
    return { kind: "send" };
  }

  for (const p of PATTERNS) {
    const m = normalized.match(p.re);
    if (m) return p.build(m);
  }
  return null;
}

/**
 * Detects a trailing "send"-family phrase on a content utterance. Returns
 * the content minus the trailing phrase if one is found. The trailing match
 * must be ≤ FLOW_SEND_MAX_TOKENS tokens AND anchored to end-of-string (tail),
 * so "I'll send it tomorrow" won't match.
 *
 * Matches: "reply to Alex send it" → content="reply to Alex", sendAfter=true
 * Non-matches: "send a note to Alex" → sendAfter=false (leading, not trailing)
 */
const TRAILING_SEND_RE = /\b(send it|send this|send please|send|submit|post this|post it)[\s.!?,;:]*$/i;

export function extractTrailingSend(rawText: string): { content: string; sendAfter: boolean } {
  const text = rawText.trimEnd();
  const m = text.match(TRAILING_SEND_RE);
  if (!m) return { content: rawText, sendAfter: false };

  const phrase = m[1]!;
  const phraseTokens = phrase.trim().split(/\s+/).length;
  if (phraseTokens > FLOW_SEND_MAX_TOKENS) {
    return { content: rawText, sendAfter: false };
  }

  // Trim the matched suffix plus any trailing punctuation/whitespace from the
  // original text. The regex's index already points at the phrase start.
  const cut = m.index ?? text.length;
  const head = text.slice(0, cut).replace(/[\s,;:]+$/g, "");
  if (head.length === 0) {
    // Whole utterance was the send phrase — caller treats as pure command.
    return { content: "", sendAfter: true };
  }
  return { content: head, sendAfter: true };
}
