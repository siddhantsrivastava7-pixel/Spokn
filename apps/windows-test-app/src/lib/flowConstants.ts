// All Flow Mode tunables. No magic numbers in hooks/libs — every threshold,
// timing, and heuristic lives here so behavior can be re-tuned without
// touching logic.

// ── VAD core ───────────────────────────────────────────────────────────────
export const VAD_SPEECH_RMS_THRESHOLD = 0.012;
export const VAD_MIN_UTTERANCE_MS = 400;
export const VAD_PRE_ROLL_MS = 300;
export const VAD_MAX_UTTERANCE_MS = 30_000;

// ── Adaptive pause threshold ───────────────────────────────────────────────
export const VAD_PAUSE_MS_FAST = 550;
export const VAD_PAUSE_MS_DEFAULT = 700;
export const VAD_PAUSE_MS_SLOW = 850;
export const VAD_PAUSE_MS_FLOOR = 450;
export const VAD_RATE_FAST_WPS = 3.5;
export const VAD_RATE_SLOW_WPS = 2.0;
export const VAD_RATE_WINDOW_MS = 5_000;

// ── Smoothing for thinking pauses ──────────────────────────────────────────
export const VAD_MERGE_WORD_FLOOR = 3;
export const VAD_MERGE_HOLD_MS = 4_000;

// ── Pre-injection validation ───────────────────────────────────────────────
export const FLOW_MIN_INJECT_CHARS = 2;
export const FLOW_MIN_ALNUM_RATIO = 0.3;
// Narrow safety net only. Do NOT grow this list reactively as new hallucinations
// surface — prefer tuning decoder thresholds (buildWhisperArgs.ts), the audio
// gates in useFlowMode, the language allowlist in flowValidation, or the
// text-shape filters below. Whisper produces hallucinations in 99 languages;
// maintaining a phrase allowlist is a losing battle and should not be the
// primary defense.
export const FLOW_HALLUCINATION_DENYLIST: readonly string[] = [
  // Silence / blank markers
  "[BLANK_AUDIO]",
  "[ silence ]",
  "(silence)",
  "[music]",
  "[applause]",
  "[laughter]",
  // Common Whisper confabulations (English)
  "thanks for watching",
  "thanks for watching!",
  "thanks for watching.",
  "thank you for watching",
  "thank you.",
  "please subscribe",
  "please like and subscribe",
  "subscribe to",
  "subtitles by",
  "transcribed by",
  "translated by",
  "amara.org",
  "you",
  ".",
  "...",
  "okay.",
  "ok.",
  "bye.",
  "bye bye.",
  // Multi-lingual Whisper garbage
  "merci.",
  "merci beaucoup.",
  "gracias.",
  "muchas gracias.",
  "धन्यवाद।",
  "شكرا",
  "다음 영상에서 만나요",
  // Japanese YouTube sign-offs (Whisper's training data is heavy on JP video)
  "ご視聴ありがとうございました",
  "ご視聴ありがとうございました。",
  "おやすみなさい",
  "おやすみなさい。",
  "チャンネル登録",
  "ありがとうございました",
  "ありがとうございました。",
  "字幕視聴ありがとうございました",
];

// ── Audio-level gate (pre-transcription) ───────────────────────────────────
export const FLOW_AUDIO_MIN_SPEECH_MS    = 350;   // ≈ one real syllable
export const FLOW_AUDIO_MIN_RMS_DB       = -42;   // above typical room tone
export const FLOW_AUDIO_MIN_SPEECH_RATIO = 0.35;  // voiced frames / total frames

// ── Idle confidence gate (post-silence onset) ──────────────────────────────
// Thresholds here must not reject legitimate short commands like "send it"
// or "submit" (~350-450ms voiced). The RMS gate is the real hallucination
// protection; keep the speech-duration and ratio gates close to baseline so
// short-but-real commands survive the post-silence strict pass.
export const FLOW_IDLE_CONFIDENCE_MS        = 3_000;  // post-silence window
export const FLOW_AUDIO_STRICT_RMS_DB       = -36;    // ~6 dB above baseline
export const FLOW_AUDIO_STRICT_SPEECH_RATIO = 0.40;
export const FLOW_AUDIO_STRICT_SPEECH_MS    = 300;

// ── Text-level hallucination gate ──────────────────────────────────────────
export const FLOW_HALLUC_MIN_REPEATS        = 3;     // "x x x" suspicious; "x x" legit
export const FLOW_HALLUC_NGRAM_UNIQUE_RATIO = 0.45;  // healthy text ~0.7–0.9
export const FLOW_HALLUC_NGRAM_MIN_TOKENS   = 6;     // skip short utterances
export const FLOW_HALLUC_REPEAT_COVERAGE    = 0.6;   // repeat must cover ≥60% of tokens

// ── Injection queue ────────────────────────────────────────────────────────
export const FLOW_PRECOMMIT_HOLD_MS = 200;
export const FLOW_INJECT_DELAY_MS = 150;
export const FLOW_INJECT_RETRY_MS = 250;
export const FLOW_CORRECTION_COALESCE_MS = 1_000;

// ── Prompt continuity ──────────────────────────────────────────────────────
export const FLOW_RECENT_CONTEXT_SEGMENTS = 2;
export const FLOW_PROMPT_MIN_WORDS = 3;
export const FLOW_PROMPT_MAX_AGE_MS = 30_000;
export const FLOW_PROMPT_MAX_CHARS = 300;
export const FLOW_PROMPT_MAX_SENTENCES = 2;

// ── Overlay ────────────────────────────────────────────────────────────────
export const FLOW_OVERLAY_QUIET_DELAY_MS = 250;

// ── Inline correction ──────────────────────────────────────────────────────
export const FLOW_COMMAND_MAX_WORDS = 8;
export const FLOW_COMMAND_FUZZY_MAX_DISTANCE = 2;
export const FLOW_COMMAND_FUZZY_MIN_LEN = 4;
export const FLOW_UNDO_STACK_MAX = 20;
export const FLOW_NACK_PULSE_MS = 400;

// ── Voice send ─────────────────────────────────────────────────────────────
export const FLOW_SEND_MAX_TOKENS     = 5;      // strict token cap for send intent
export const FLOW_SEND_POST_PASTE_MS  = 80;     // settle before pressing send key
export const FLOW_SEND_DEFER_RETRY_MS = 150;    // recheck interval while deferred
export const FLOW_FLUSH_TIMEOUT_MS    = 5_000;  // safety timeout for stop() path

// ── Self-repair ────────────────────────────────────────────────────────────
export const FLOW_REPAIR_MIN_LEFT_WORDS    = 2;
export const FLOW_REPAIR_MIN_RIGHT_WORDS   = 1;
export const FLOW_REPAIR_MIN_SPEECH_RATIO  = 0.4;  // skip repair on partial utterances
export const FLOW_REPAIR_MIN_RMS_DB        = -48;
export const FLOW_REPAIR_MIN_TEXT_CHARS    = 20;
export const FLOW_REPAIR_MARKERS: readonly string[] = [
  "actually",
  "i mean",
  "i meant",
  "sorry",
  "wait",
  "no wait",
  "let me say that again",
  "what i meant was",
];
export const FLOW_REPAIR_PREPOSITIONS: readonly string[] = [
  "at","on","in","to","from","for","by","with","about",
];

// ── Cursor awareness ───────────────────────────────────────────────────────
export const FLOW_FOCUS_POLL_MS = 500;
// Debounce for external→external focus transitions (e.g. Slack → ChatGPT).
// Short enough that humans don't perceive it; long enough that Alt-Tab wiggles
// don't trigger a composition reset mid-thought.
export const FLOW_FOCUS_CONTEXT_DEBOUNCE_MS = 1_000;

// ── Typing-awareness guard ─────────────────────────────────────────────────
// The user typing in ANY app (not just Spokn) biases the commit gate toward
// dropping weak utterances. A global keyboard hook feeds LAST_KEYSTROKE_MS;
// utterances committed within COOLDOWN_MS of a keystroke must clear stricter
// audio/text gates or be dropped. See flowTypingGuard.ts.
export const FLOW_TYPING_COOLDOWN_MS = 1_200;
export const FLOW_TYPING_POLL_MS = 200;
export const FLOW_TYPING_STRICT_RMS_DB = -34;      // ~8 dB above baseline noise floor
export const FLOW_TYPING_STRICT_SPEECH_RATIO = 0.55;
export const FLOW_TYPING_STRICT_SPEECH_MS = 500;
export const FLOW_TYPING_STRICT_MIN_CHARS = 6;
// Continuous voiced run required to clear the onset check during typing. RMS
// can be spoofed by a transient spike (keystroke thud, desk tap); a sustained
// voiced run is the cheapest proof-of-speech signal we have.
export const FLOW_TYPING_ONSET_MIN_MS = 250;

// ── Low-confidence hold ────────────────────────────────────────────────────
// When Whisper confidence is below threshold, the utterance is held for one
// cycle: a similar follow-up releases it, an unrelated follow-up drops it,
// and TTL auto-discards stale holds. Strict send commands (Stage 1) are
// EXEMPT from this gate — they always fire, regardless of confidence.
export const FLOW_CONFIDENCE_LOW_THRESHOLD = 0.55;
export const FLOW_CONFIDENCE_LOW_MIN_CHARS = 8;
export const FLOW_CONFIDENCE_HOLD_TTL_MS = 3_000;
// Similarity thresholds for matching a held low-conf utterance against the
// next one. Either gate can release the hold.
export const FLOW_CONFIDENCE_MATCH_MIN_SHARED_TOKENS = 2;
export const FLOW_CONFIDENCE_MATCH_MIN_LEV_RATIO = 0.7;

// ── Two-stage send parser (Stage 2 relaxed) ────────────────────────────────
// Runs ONLY when Stage 1 (strict) missed AND all four gates pass. Cannot fire
// on the first utterance of a composition (no prior composition context).
export const FLOW_SEND_RELAXED_MAX_TOKENS = 4;
export const FLOW_SEND_RELAXED_MIN_CONFIDENCE = 0.75;
export const FLOW_SEND_RELAXED_MAX_UTTERANCE_MS = 1_200;

// ── External edit capture ─────────────────────────────────────────────────
export const FLOW_EXT_EDIT_SETTLE_MS = 8_000;
export const FLOW_EXT_EDIT_MAX_AGE_MS = 15_000;
export const FLOW_EXT_EDIT_MAX_TOKENS = 6;
export const FLOW_EXT_EDIT_MIN_JACCARD = 0.5;
export const FLOW_EXT_EDIT_RING_SIZE = 8;
