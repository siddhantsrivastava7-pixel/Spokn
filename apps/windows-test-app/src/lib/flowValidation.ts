// Pre-injection transcript validation. Filters whisper noise, hallucinations,
// and low-quality audio outputs before they reach the user's app.
//
// Runs after transcription, before injection. This is the "text-level gate"
// complement to the audio-level gate in useFlowMode.commitUtterance.

import {
  FLOW_AUDIO_MIN_RMS_DB,
  FLOW_HALLUCINATION_DENYLIST,
  FLOW_MIN_ALNUM_RATIO,
  FLOW_MIN_INJECT_CHARS,
  FLOW_HALLUC_MIN_REPEATS,
  FLOW_HALLUC_NGRAM_UNIQUE_RATIO,
  FLOW_HALLUC_NGRAM_MIN_TOKENS,
  FLOW_HALLUC_REPEAT_COVERAGE,
} from "./flowConstants";

export interface ValidationInput {
  text: string;
  /** Optional audio quality metadata. Client-computed values (rmsDb,
   *  silenceRatio, speechRatio) come from commitUtterance; server-reported
   *  values ride along in serverRmsDb/serverSilenceRatio for completeness. */
  audioQuality?: {
    rmsDb?: number;
    silenceRatio?: number;
    speechRatio?: number;
    serverRmsDb?: number;
    serverSilenceRatio?: number;
  } | null;
  /** Whisper-reported language for this utterance (e.g. "en", "hi", "ja"). */
  detectedLanguage?: string;
  /** The set of Whisper language codes the user selected during onboarding.
   *  When non-empty and detectedLanguage is not in the set, the utterance is
   *  rejected as a cross-language hallucination. Empty array = no filter. */
  allowedLanguages?: string[];
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validate(input: ValidationInput): ValidationResult {
  const text = input.text.trim();

  // Language allowlist — runs FIRST so a disallowed detected language never
  // reaches command parsing, self-repair, the buffer, or the queue. This is
  // a hard invariant; do not move downstream.
  //
  // Missing / malformed language values (empty string, whitespace, non-string,
  // or non-lang-shaped like digits/punctuation) normalize to "" and are
  // treated as "missing" — the filter is SKIPPED rather than used as either a
  // pass or a reject signal. This prevents a malformed value from accidentally
  // rejecting every utterance or accidentally passing a wrong-language one.
  if (input.allowedLanguages && input.allowedLanguages.length > 0 && input.detectedLanguage) {
    const detected = normalizeLangCode(input.detectedLanguage);
    const allowed = new Set(
      input.allowedLanguages.map(normalizeLangCode).filter((c) => c.length > 0),
    );
    // Only apply the filter when BOTH sides survive normalization. If allowed
    // is empty (all entries malformed) or detected is "" (malformed), skip.
    if (allowed.size > 0 && detected.length > 0 && !allowed.has(detected)) {
      return { ok: false, reason: "language_not_allowed" };
    }
  }

  if (text.length < FLOW_MIN_INJECT_CHARS) {
    return { ok: false, reason: "too_short" };
  }

  // Alphanumeric ratio — catches "..." or pure punctuation.
  const alnum = (text.match(/[a-z0-9\u00c0-\uffff]/gi) ?? []).length;
  const ratio = alnum / text.length;
  if (ratio < FLOW_MIN_ALNUM_RATIO) {
    return { ok: false, reason: "low_alnum_ratio" };
  }

  // Denylist — normalized (NFC + lowercase + trim punctuation) Set lookup.
  if (isDenylisted(text)) {
    return { ok: false, reason: "hallucination_denylist" };
  }

  // Sound-tag stripper — Whisper sometimes emits non-speech sounds as text
  // wrapped in [...], (...), *...*, or bare (e.g. "cough", "[cough]",
  // "(laugh)", "*sigh*", "clear throat"). Reject when the ENTIRE output is
  // just a tag — never strips partial matches from real content.
  if (isSoundTagOnly(text)) {
    return { ok: false, reason: "sound_tag_only" };
  }

  // Repeated-phrase detector — n-gram (n=1..4) repeats consecutively.
  if (hasRepeatedPhrase(text)) {
    return { ok: false, reason: "repeated_phrase" };
  }

  // N-gram uniqueness ratio — low unique/total means loop or near-loop.
  if (hasLowNgramUniqueness(text)) {
    return { ok: false, reason: "low_ngram_uniqueness" };
  }

  // Combined-signal: very short text + low audio quality → drop.
  const q = input.audioQuality;
  const veryShort = text.length < 8;
  if (veryShort && q) {
    if ((q.silenceRatio ?? 0) > 0.85) return { ok: false, reason: "mostly_silence" };
    if ((q.rmsDb ?? 0) < -55) return { ok: false, reason: "below_noise_floor" };
  }

  return { ok: true };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Normalize a language code for set membership. Strips region suffix and
 *  whitespace so "en-US"/"zh_CN" compare equal to "en"/"zh".
 *
 *  Malformed / missing inputs (null, undefined, whitespace-only, non-string)
 *  normalize to `""`. The caller treats `""` as "missing" and SKIPS the
 *  allowlist check for that utterance — a malformed value must never be
 *  compared against the allowlist as if it were a real code (neither to pass
 *  nor to reject). Other validators downstream still run. */
function normalizeLangCode(s: unknown): string {
  if (typeof s !== "string") return "";
  const base = s.trim().toLowerCase().split(/[-_]/)[0];
  if (!base) return "";
  // Only accept plausibly-valid codes (letters only, 2-8 chars). Anything
  // else — digits, punctuation, empty — is treated as missing.
  return /^[a-z]{2,8}$/.test(base) ? base : "";
}

function normalizeForDenylist(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/^[\s.,!?;:)\]"']+|[\s.,!?;:)\]"']+$/g, "");
}

// Build the normalized denylist once — the constant is readonly, so this
// closes over a stable Set for O(1) lookup.
const DENYLIST_SET: ReadonlySet<string> = new Set(
  FLOW_HALLUCINATION_DENYLIST.map(normalizeForDenylist),
);

function isDenylisted(text: string): boolean {
  return DENYLIST_SET.has(normalizeForDenylist(text));
}

/** Non-speech sound words Whisper emits when it hears breath/cough/keyboard/etc.
 *  Narrow, explicit set — each entry must have been observed in real output,
 *  not added speculatively. Grouped so the typing/percussive subset is easy
 *  to review when tuning. */
const SOUND_TAG_WORDS: ReadonlySet<string> = new Set([
  // Body / breath
  "cough",
  "coughing",
  "laugh",
  "laughs",
  "laughing",
  "laughter",
  "sigh",
  "sighs",
  "sighing",
  "breath",
  "breathes",
  "breathing",
  "inhale",
  "exhale",
  "sneeze",
  "sneezes",
  "sneezing",
  "clear throat",
  "throat clearing",
  "grunt",
  "grunts",
  "gasp",
  "gasps",
  "chuckle",
  "chuckles",
  "cry",
  "cries",
  "crying",
  "sob",
  "sobs",
  "sobbing",
  "weep",
  "weeps",
  "weeping",
  "whimper",
  "whimpers",
  "whimpering",
  "sniffle",
  "sniffles",
  "sniffling",
  // Keyboard / percussive onomatopoeia — Whisper emits these for keystroke
  // thuds, desk taps, chair creaks, mouse clicks. Added after observing
  // *Tonk*, *Thud*, *Tap*, *Clack* in real dictation output during typing.
  "click",
  "clicks",
  "clicking",
  "clack",
  "clacks",
  "clacking",
  "clatter",
  "clattering",
  "tap",
  "taps",
  "tapping",
  "thud",
  "thuds",
  "thump",
  "thumps",
  "thumping",
  "tonk",
  "tonks",
  "knock",
  "knocks",
  "knocking",
  "bang",
  "bangs",
  "banging",
  "pop",
  "pops",
  "popping",
  "tick",
  "ticks",
  "ticking",
  "beep",
  "beeps",
  "ping",
  "pings",
  "typing",
  "keyboard",
  "keystroke",
  "keystrokes",
  // Ambient
  "silence",
  "music",
  "applause",
  "noise",
  "static",
  "rustling",
  "rustle",
]);

/** True when the entire utterance is a non-speech sound tag and nothing else.
 *  Matches:
 *    - [cough], [ cough ], [laugh], [Cough.]
 *    - (cough), (  laugh  )
 *    - *cough*, * laugh *
 *    - bare "cough", "cough.", "CLEAR THROAT."
 *  Never strips partial matches — "the cough was bad" passes through untouched. */
function isSoundTagOnly(text: string): boolean {
  const normalized = text.normalize("NFC").trim().toLowerCase();
  if (!normalized) return false;
  // Strip a single surrounding [...], (...), or *...* wrapper if present.
  const wrapped = normalized.match(/^[\[(*]\s*([^\])*]+?)\s*[\])*]$/);
  const inner = wrapped ? wrapped[1]! : normalized;
  // Trim trailing punctuation so "cough." / "laugh!" still match.
  const stripped = inner.replace(/[\s.,!?;:"'`]+$/g, "").replace(/^[\s.,!?;:"'`]+/g, "");
  return SOUND_TAG_WORDS.has(stripped);
}

// ── Non-speech artifact stripper (Change 1) ────────────────────────────────
//
// SCOPE DISCIPLINE — this function does EXACTLY two things:
//   1. Remove bracketed/parenthesized/asterisked sound tags + bare
//      SOUND_TAG_WORDS tokens at utterance boundaries.
//   2. The edge-noise secondary rule (very short edge tokens in weak audio).
//
// It is NOT a general text cleanup engine. Do not add filler-word stripping,
// punctuation normalization, or casing changes here — those belong to the
// stt-core post-processing pipeline (grammarCleanup). Widening this function
// would create copy-drift with the validator and the post-processor.

export interface StripSoundTagsAudioQuality {
  rmsDb?: number;
  silenceRatio?: number;
  speechRatio?: number;
}

export interface StripSoundTagsResult {
  /** Stripped text with collapsed whitespace. May be empty if everything was
   *  a sound tag — callers should then fall through to isSoundTagOnly. */
  text: string;
  /** Number of sound-tag tokens (wrapped + bare) removed. */
  tagsRemoved: number;
  /** The edge-noise tokens that were stripped (for observability). */
  edgeNoiseRemoved: string[];
}

// Bracketed / parenthesized wrappers — strict, only strip when the inner
// content is in SOUND_TAG_WORDS. `[John]` and `(or maybe)` have legitimate
// meanings in chat (mentions, asides) and must pass through untouched.
const BRACKET_PAREN_TAG_RE = /[\[(]\s*([^\])]+?)\s*[\])]/g;
// Asterisk-wrapped content — Whisper's standard non-verbal sound descriptor
// convention in transcripts. Dictated speech almost never intends markdown
// bold, so strip any 1–2 alphabetic-word payload regardless of whether it's
// in SOUND_TAG_WORDS. Caps inner to ≤ 32 chars so we don't swallow an
// actual long phrase a user dictated with emphasis markers.
const ASTERISK_TAG_RE = /\*\s*([A-Za-z][A-Za-z]*(?:\s+[A-Za-z]+)?)\s*\*/g;

/** Strip non-speech sound tags from a mixed utterance. Never widens beyond
 *  `SOUND_TAG_WORDS` + the edge-noise rule. Returns the stripped text plus
 *  counts for observability. */
export function stripSoundTags(
  rawText: string,
  audioQuality?: StripSoundTagsAudioQuality,
): StripSoundTagsResult {
  if (!rawText) {
    return { text: rawText, tagsRemoved: 0, edgeNoiseRemoved: [] };
  }

  let tagsRemoved = 0;
  let text = rawText;

  // 1a. Asterisk-wrapped content → strip liberally. Whisper's convention is
  // that *...* always marks a non-verbal sound descriptor. We cap the inner
  // at ≤ 2 alphabetic words (≤ 32 chars) so a stray emphasis phrase like
  // "*this is actually important*" survives.
  text = text.replace(ASTERISK_TAG_RE, (match, inner: string) => {
    if (inner.length > 32) return match;
    tagsRemoved++;
    return " ";
  });

  // 1b. Bracket / paren wrappers → strict, only strip known sound words.
  // "[John]" (mention) and "(or maybe)" (aside) stay put.
  text = text.replace(BRACKET_PAREN_TAG_RE, (match, inner: string) => {
    const inner_norm = inner
      .normalize("NFC")
      .trim()
      .toLowerCase()
      .replace(/[\s.,!?;:"'`]+$/g, "")
      .replace(/^[\s.,!?;:"'`]+/g, "");
    if (SOUND_TAG_WORDS.has(inner_norm)) {
      tagsRemoved++;
      return " ";
    }
    return match;
  });

  // 1b. Remove bare sound words only at utterance boundaries (start/end) or
  // flanked by pause markers (, . ;). Walk tokens once, right-to-left then
  // left-to-right, so we only touch true boundary positions.
  // Token regex keeps punctuation out of the captured token but preserves it
  // for boundary detection.
  {
    const parts = text.split(/(\s+)/);
    // First pass: remove leading sound words (followed by boundary/punct).
    let leadCut = 0;
    while (leadCut < parts.length) {
      const tok = parts[leadCut]!;
      if (/^\s+$/.test(tok)) {
        leadCut++;
        continue;
      }
      const normalized = tok
        .toLowerCase()
        .replace(/[\s.,!?;:"'`]+$/g, "")
        .replace(/^[\s.,!?;:"'`]+/g, "");
      if (!SOUND_TAG_WORDS.has(normalized)) break;
      // Check boundary: the next non-whitespace token (if any) should be
      // after a punctuation gap OR we hit the end of the utterance.
      const followingText = parts.slice(leadCut + 1).join("");
      const trimmedOriginalToken = tok.replace(/^\s+|\s+$/g, "");
      const endsWithPunct = /[.,;:!?]$/.test(trimmedOriginalToken);
      const followStartsWithNothing = followingText.trim().length === 0;
      if (!(endsWithPunct || followStartsWithNothing)) break;
      tagsRemoved++;
      // Consume this token + any following whitespace.
      parts.splice(leadCut, leadCut + 1 < parts.length ? 2 : 1);
    }
    // Second pass: remove trailing sound words (preceded by boundary/punct).
    while (parts.length > 0) {
      const tok = parts[parts.length - 1]!;
      if (/^\s+$/.test(tok)) {
        parts.pop();
        continue;
      }
      const normalized = tok
        .toLowerCase()
        .replace(/[\s.,!?;:"'`]+$/g, "")
        .replace(/^[\s.,!?;:"'`]+/g, "");
      if (!SOUND_TAG_WORDS.has(normalized)) break;
      // Check the prior token ends with a boundary punctuation OR start of utterance.
      const priorParts = parts.slice(0, -1);
      const priorText = priorParts.join("");
      const priorTrimmed = priorText.trimEnd();
      const startsWithNothing = priorTrimmed.length === 0;
      const endsWithPunct = /[.,;:!?]$/.test(priorTrimmed);
      if (!(endsWithPunct || startsWithNothing)) break;
      tagsRemoved++;
      // Consume the token + preceding whitespace if present.
      parts.pop();
      if (parts.length > 0 && /^\s+$/.test(parts[parts.length - 1]!)) {
        parts.pop();
      }
    }
    text = parts.join("");
  }

  // 2. Edge-noise secondary rule — very short (<3 alnum) token at absolute
  // start/end, separated by a pause marker, only when audio quality is weak.
  const edgeNoiseRemoved: string[] = [];
  if (audioQuality) {
    const weakAudio =
      (audioQuality.rmsDb !== undefined &&
        audioQuality.rmsDb < FLOW_AUDIO_MIN_RMS_DB + 4) ||
      (audioQuality.silenceRatio !== undefined &&
        audioQuality.silenceRatio > 0.75) ||
      (audioQuality.speechRatio !== undefined &&
        audioQuality.speechRatio < 0.45);
    if (weakAudio) {
      // Leading short token followed by pause marker or EOU.
      const leadMatch = text.match(/^\s*([A-Za-z0-9]{1,2})\s*([.,;:]|\s*$)/);
      if (leadMatch) {
        edgeNoiseRemoved.push(leadMatch[1]!.toLowerCase());
        text = text.slice(leadMatch[0].length);
      }
      // Trailing short token preceded by pause marker or SOU.
      const tailMatch = text.match(/(^|[.,;:]\s*)([A-Za-z0-9]{1,2})\s*[.,;:!?]*\s*$/);
      if (tailMatch) {
        edgeNoiseRemoved.push(tailMatch[2]!.toLowerCase());
        text =
          text.slice(0, text.length - tailMatch[0].length) +
          (tailMatch[1] ?? "");
      }
    }
  }

  // Collapse runs of whitespace left behind and trim.
  text = text.replace(/\s{2,}/g, " ").trim();
  // Clean up dangling punctuation glue like " . ," that shows up when we
  // excise a token between two punctuation marks.
  text = text.replace(/\s+([.,;:!?])/g, "$1");

  return { text, tagsRemoved, edgeNoiseRemoved };
}

function tokenize(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** True when any 1..4-gram appears ≥ FLOW_HALLUC_MIN_REPEATS times consecutively
 *  AND the repeat covers ≥ FLOW_HALLUC_REPEAT_COVERAGE of total tokens. */
function hasRepeatedPhrase(text: string): boolean {
  const tokens = tokenize(text);
  if (tokens.length < FLOW_HALLUC_MIN_REPEATS) return false;

  for (let n = 1; n <= 4; n++) {
    if (tokens.length < n * FLOW_HALLUC_MIN_REPEATS) continue;
    for (let i = 0; i + n * FLOW_HALLUC_MIN_REPEATS <= tokens.length; i++) {
      // Check that the n-gram at i repeats FLOW_HALLUC_MIN_REPEATS times.
      let ok = true;
      for (let k = 1; k < FLOW_HALLUC_MIN_REPEATS; k++) {
        for (let j = 0; j < n; j++) {
          if (tokens[i + j] !== tokens[i + k * n + j]) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
      }
      if (!ok) continue;

      // Extend the run as long as the n-gram keeps repeating, then check coverage.
      let runTokens = n * FLOW_HALLUC_MIN_REPEATS;
      while (i + runTokens + n <= tokens.length) {
        let stillMatches = true;
        for (let j = 0; j < n; j++) {
          if (tokens[i + j] !== tokens[i + runTokens + j]) {
            stillMatches = false;
            break;
          }
        }
        if (!stillMatches) break;
        runTokens += n;
      }

      if (runTokens / tokens.length >= FLOW_HALLUC_REPEAT_COVERAGE) return true;
    }
  }
  return false;
}

/** True when 3-gram uniqueness is pathologically low — a sign of looped output. */
function hasLowNgramUniqueness(text: string): boolean {
  const tokens = tokenize(text);
  if (tokens.length < FLOW_HALLUC_NGRAM_MIN_TOKENS) return false;

  const ngrams: string[] = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    ngrams.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  if (ngrams.length === 0) return false;
  const unique = new Set(ngrams).size;
  return unique / ngrams.length < FLOW_HALLUC_NGRAM_UNIQUE_RATIO;
}
