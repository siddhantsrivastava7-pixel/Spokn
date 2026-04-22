// Global keyboard-activity guard. Reads `get_last_keystroke_ms_ago` from the
// Rust side (backed by a WH_KEYBOARD_LL hook that filters LLKHF_INJECTED so
// our own enigo keystrokes don't self-trigger) and converts the raw signal
// into a "typing is happening" boolean plus a stricter utterance gate.
//
// Design:
//   - One poll every FLOW_TYPING_POLL_MS (200ms) to keep ms-since-last fresh
//     without an IPC round-trip on the hot commit path.
//   - `isTypingActive()` is O(1).
//   - `shouldSuppressWeakUtterance` raises the bar during typing. A clear
//     strong onset still commits — we never hard-block speech.
//   - Follows the guiding principle: when uncertain, drop. Every failure path
//     logs before returning via the caller, not inside the guard.
//
// Web fallback: when running under `npm run dev` without the Tauri runtime,
// `invoke` returns `undefined` and the guard stays idle — never suppresses.

import {
  FLOW_TYPING_COOLDOWN_MS,
  FLOW_TYPING_ONSET_MIN_MS,
  FLOW_TYPING_POLL_MS,
  FLOW_TYPING_STRICT_MIN_CHARS,
  FLOW_TYPING_STRICT_RMS_DB,
  FLOW_TYPING_STRICT_SPEECH_MS,
  FLOW_TYPING_STRICT_SPEECH_RATIO,
} from "./flowConstants";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface TypingGuardAudioQuality {
  rmsDb?: number;
  speechRatio?: number;
  longestVoicedRunMs?: number;
}

export interface WeakUtteranceVerdict {
  suppress: boolean;
  reason?: "rms" | "speech_ratio" | "speech_ms" | "min_chars" | "onset";
}

export interface TypingGuardDeps {
  invoke: Invoke;
}

export interface TypingGuard {
  start(): void;
  stop(): void;
  /** True when we saw a real (non-injected) keystroke within the cooldown window. */
  isTypingActive(): boolean;
  /** Milliseconds since the last real keystroke, or Infinity if none observed. */
  msSinceLastKeystroke(): number;
  /** When typing is active, evaluate the stricter gate. Returns a verdict so
   *  the caller can log the specific reason before returning. */
  evaluate(
    audioQuality: TypingGuardAudioQuality | null | undefined,
    textLen: number,
    audioMs: number,
  ): WeakUtteranceVerdict;
}

export function createTypingGuard(deps: TypingGuardDeps): TypingGuard {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastKeystrokeMsAgo: number = Number.POSITIVE_INFINITY;
  let lastPollAt: number = 0;

  async function pollOnce() {
    try {
      const raw = await deps.invoke("get_last_keystroke_ms_ago");
      if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
        lastKeystrokeMsAgo = raw;
      } else {
        lastKeystrokeMsAgo = Number.POSITIVE_INFINITY;
      }
      lastPollAt = Date.now();
    } catch {
      // Best-effort; leave lastKeystrokeMsAgo unchanged.
    }
  }

  return {
    start() {
      if (pollTimer) return;
      void pollOnce();
      pollTimer = setInterval(() => void pollOnce(), FLOW_TYPING_POLL_MS);
    },
    stop() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      lastKeystrokeMsAgo = Number.POSITIVE_INFINITY;
    },
    isTypingActive(): boolean {
      // Add elapsed time since the last poll so a just-missed poll doesn't
      // report stale "recent" activity. If we polled 180ms ago and got "80ms
      // since keystroke", effective ms-since-last is 260ms — still inside the
      // 1200ms cooldown but shouldn't be reported as "we just saw a key" for
      // decisions that happen much later.
      const staleness =
        lastPollAt === 0 ? 0 : Math.max(0, Date.now() - lastPollAt);
      return lastKeystrokeMsAgo + staleness < FLOW_TYPING_COOLDOWN_MS;
    },
    msSinceLastKeystroke(): number {
      const staleness =
        lastPollAt === 0 ? 0 : Math.max(0, Date.now() - lastPollAt);
      return lastKeystrokeMsAgo + staleness;
    },
    evaluate(audioQuality, textLen, audioMs): WeakUtteranceVerdict {
      if (!this.isTypingActive()) return { suppress: false };
      const q = audioQuality ?? {};
      // Guiding principle: any gate failure → drop. Strong onset clears all.
      if ((q.rmsDb ?? -Infinity) < FLOW_TYPING_STRICT_RMS_DB) {
        return { suppress: true, reason: "rms" };
      }
      if ((q.speechRatio ?? 0) < FLOW_TYPING_STRICT_SPEECH_RATIO) {
        return { suppress: true, reason: "speech_ratio" };
      }
      const speechMs = audioMs * (q.speechRatio ?? 0);
      if (speechMs < FLOW_TYPING_STRICT_SPEECH_MS) {
        return { suppress: true, reason: "speech_ms" };
      }
      if (textLen < FLOW_TYPING_STRICT_MIN_CHARS) {
        return { suppress: true, reason: "min_chars" };
      }
      if ((q.longestVoicedRunMs ?? 0) < FLOW_TYPING_ONSET_MIN_MS) {
        return { suppress: true, reason: "onset" };
      }
      return { suppress: false };
    },
  };
}
