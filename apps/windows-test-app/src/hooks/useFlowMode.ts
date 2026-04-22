// Continuous-listen Flow Mode hook.
//
// Owns its own MediaStream / AudioContext / Analyser / ScriptProcessor —
// modeled on useRecording but never stops between utterances. Implements:
//   - RMS-based VAD with adaptive pause threshold (FAST/DEFAULT/SLOW tiers)
//   - Pre-roll buffer so the first phoneme of a new utterance is preserved
//   - Short-utterance merge so mid-thought fragments don't split unnaturally
//   - Per-utterance POST to /api/transcribe with filtered prompt continuity
//   - Wires the transcribed result into the assembly layer + injection queue
//
// The classic one-shot path (useRecording) is untouched.

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWav } from "../lib/wavEncode";
import { apiUrl, transcribe } from "../lib/api";
import { buildPrompt } from "../lib/learnedVocab";
import { toWhisperLang, expandToWhisperLangs } from "../lib/languages";
import {
  VAD_MAX_UTTERANCE_MS,
  VAD_MERGE_HOLD_MS,
  VAD_MERGE_WORD_FLOOR,
  VAD_MIN_UTTERANCE_MS,
  VAD_PAUSE_MS_DEFAULT,
  VAD_PAUSE_MS_FAST,
  VAD_PAUSE_MS_FLOOR,
  VAD_PAUSE_MS_SLOW,
  VAD_PRE_ROLL_MS,
  VAD_RATE_FAST_WPS,
  VAD_RATE_SLOW_WPS,
  VAD_RATE_WINDOW_MS,
  VAD_SPEECH_RMS_THRESHOLD,
  FLOW_PROMPT_MAX_AGE_MS,
  FLOW_PROMPT_MAX_CHARS,
  FLOW_PROMPT_MAX_SENTENCES,
  FLOW_PROMPT_MIN_WORDS,
  FLOW_RECENT_CONTEXT_SEGMENTS,
  FLOW_AUDIO_MIN_SPEECH_MS,
  FLOW_AUDIO_MIN_RMS_DB,
  FLOW_AUDIO_MIN_SPEECH_RATIO,
  FLOW_IDLE_CONFIDENCE_MS,
  FLOW_AUDIO_STRICT_RMS_DB,
  FLOW_AUDIO_STRICT_SPEECH_RATIO,
  FLOW_AUDIO_STRICT_SPEECH_MS,
  FLOW_TYPING_COOLDOWN_MS,
  FLOW_TYPING_STRICT_RMS_DB,
  FLOW_TYPING_STRICT_SPEECH_RATIO,
  FLOW_TYPING_STRICT_SPEECH_MS,
  FLOW_TYPING_STRICT_MIN_CHARS,
  FLOW_TYPING_ONSET_MIN_MS,
} from "../lib/flowConstants";
import type { Transcript } from "../lib/types";
import type { AccessibilityStatus } from "./useAccessibilityPermission";
import { createTypingGuard, type TypingGuard } from "../lib/flowTypingGuard";
import {
  createExternalEditCapture,
  type ExternalEditCapture,
} from "../lib/flowExternalEditCapture";
import { createSessionBuffer, type SessionBuffer } from "../lib/flowSessionBuffer";
import { createAssembler, type FlowAssembler, type TranscriptLike } from "../lib/flowTextAssembly";
import { createInjectionQueue, type InjectionQueue } from "../lib/flowInjectionQueue";
import { createCursorAwareness, type CursorAwareness } from "../lib/flowCursorAwareness";
import { postProcessingForContext, type FlowContext } from "../lib/flowToneMapping";
import { sendKeyForContext } from "../lib/flowSendMap";
import { flowLog } from "../lib/flowObservability";
import { countWords } from "../lib/flowSessionBuffer";

const BUFFER_SIZE = 4096;

const isTauri = "__TAURI_INTERNALS__" in window;

export type FlowState = "idle" | "recording" | "quiet" | "transcribing" | "stopping";

export interface UseFlowModeReturn {
  isActive: boolean;
  state: FlowState;
  /** Currently resolved context (after auto inference). */
  resolvedContext: FlowContext;
  /** The session buffer's current full text — for debug / readonly UI. */
  bufferText: string;
  analyserRef: React.MutableRefObject<AnalyserNode | null>;
  start: (opts: { langs: string[]; selectedMicId?: string; contextOverride?: FlowContext | "auto" }) => Promise<void>;
  stop: () => Promise<void>;
  error: string | null;
}

interface FlowDeps {
  /** Resolves the FlowContext at commit time. Returns "auto" → caller infers. */
  resolveContext: () => FlowContext;
  /** Optional notify on state change for overlay sync. */
  onStateChange?: (state: FlowState) => void;
  /** Brief overlay nack pulse on validation drop / no-match. */
  nack: () => void;
  /** Positive confirmation pulse when a voice send successfully fires. */
  sendOk?: () => void;
  /**
   * Current Accessibility permission state (three-valued — see
   * `AccessibilityStatus`).
   *
   *   - `"probing"` — initial probe not yet resolved. `start()` refuses
   *                   with a friendly error so Flow Mode can't be launched
   *                   into an ambiguous permission state.
   *   - `"granted"` — normal operation.
   *   - `"denied"`  — `start()` refuses; if the flag flips to `"denied"`
   *                   mid-session the injection queue is suspended, its
   *                   pending ops are drained and discarded, and
   *                   previously-discarded ops are NOT replayed on
   *                   recovery.
   *
   * Windows always passes `"granted"` once the (no-op) probe returns — the
   * whole pipeline is inert there.
   */
  accessibilityStatus: AccessibilityStatus;
}

interface RecentContextEntry {
  text: string;
  committedAt: number;
}

export function useFlowMode(deps: FlowDeps): UseFlowModeReturn {
  const [isActive, setIsActive] = useState(false);
  const [state, setState] = useState<FlowState>("idle");
  const [resolvedContext, setResolvedContext] = useState<FlowContext>("chat");
  const [bufferText, setBufferText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // ── Audio resources (mirror useRecording) ────────────────────────────────
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const keepAliveRef = useRef<OscillatorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sampleRateRef = useRef<number>(48000);

  // ── VAD state ────────────────────────────────────────────────────────────
  const samplesRef = useRef<Float32Array[]>([]);     // current utterance audio
  const preRollRef = useRef<Float32Array[]>([]);     // rolling silent-audio circular buffer
  const preRollFramesRef = useRef<number>(0);
  const silenceMsRef = useRef<number>(0);
  const speechMsRef = useRef<number>(0);
  const utteranceMsRef = useRef<number>(0);
  const inSpeechRef = useRef<boolean>(false);
  const utteranceStartTimeRef = useRef<number>(0);
  const adaptivePauseMsRef = useRef<number>(VAD_PAUSE_MS_DEFAULT);
  const recentRateSamplesRef = useRef<{ at: number; words: number }[]>([]);

  // ── Pipeline state ───────────────────────────────────────────────────────
  const bufferRef = useRef<SessionBuffer | null>(null);
  const assemblerRef = useRef<FlowAssembler | null>(null);
  const queueRef = useRef<InjectionQueue | null>(null);
  const awarenessRef = useRef<CursorAwareness | null>(null);
  const recentContextRef = useRef<RecentContextEntry[]>([]);
  const pendingMergeRef = useRef<{ text: string; samples: Float32Array[]; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const utteranceCounterRef = useRef<number>(0);
  const langsRef = useRef<string[]>([]);
  const contextOverrideRef = useRef<FlowContext | "auto">("auto");
  const inFlightRef = useRef<number>(0);
  const stoppingRef = useRef<boolean>(false);
  const lastCommitAtRef = useRef<number>(0);
  const typingGuardRef = useRef<TypingGuard | null>(null);
  const extEditRef = useRef<ExternalEditCapture | null>(null);
  // Monotonic composition-reset epoch. Increments on every send_complete,
  // focus-change reset, and stop. Transcribe-and-assemble captures this at
  // commit time; if it differs on resolution, the utterance is discarded as
  // stale (prevents late appends from leaking across reset boundaries).
  const resetEpochRef = useRef<number>(0);
  // Max-contiguous voiced-frame run within the current utterance. Reset on
  // commit. The typing-cooldown gate reads this as the "proof of speech" signal
  // — RMS alone can be satisfied by a transient spike.
  const longestVoicedRunMsRef = useRef<number>(0);
  const currentVoicedRunMsRef = useRef<number>(0);

  // Synchronous mirror of `state` so the injection queue's `getFlowState`
  // getter can read the current value without crossing the React render
  // boundary. Kept in lock-step via `setStateBoth`.
  const stateRef = useRef<FlowState>("idle");

  // Synchronous mirror of `deps.accessibilityStatus`. The queue samples this
  // via `getFlowState`'s sibling getter at construction time; the reactive
  // useEffect below translates changes into explicit `suspend` / `resume`
  // calls so the queue's internal episode-tracking stays accurate.
  const accessibilityStatusRef = useRef<AccessibilityStatus>(
    deps.accessibilityStatus,
  );

  function setStateBoth(next: FlowState) {
    stateRef.current = next;
    setState(next);
    deps.onStateChange?.(next);
  }

  // Keep the accessibility ref in lock-step with the prop AND translate
  // every transition into an explicit queue action. The ref update is
  // synchronous so the queue's next `getFlowState()` / construction read
  // sees the latest value — no render-lag window where the ref is stale.
  useEffect(() => {
    const next = deps.accessibilityStatus;
    accessibilityStatusRef.current = next;
    const q = queueRef.current;
    if (!q) return; // No live queue yet — the next `start()` will seed it.
    if (next === "denied" && !q.isPermissionBlocked()) {
      q.suspendForPermissionBlock();
    } else if (next === "granted" && q.isPermissionBlocked()) {
      q.resumeFromPermissionBlock();
    }
  }, [deps.accessibilityStatus]);

  // ── Audio frame handler ──────────────────────────────────────────────────
  const handleFrame = useCallback((frame: Float32Array, sampleRate: number) => {
    if (stoppingRef.current) return;
    const frameMs = (frame.length / sampleRate) * 1000;

    let rms = 0;
    for (let i = 0; i < frame.length; i++) rms += frame[i]! * frame[i]!;
    rms = Math.sqrt(rms / frame.length);

    const isSpeech = rms > VAD_SPEECH_RMS_THRESHOLD;

    if (isSpeech) {
      if (!inSpeechRef.current) {
        // Transition silence → speech: prepend pre-roll
        for (const f of preRollRef.current) samplesRef.current.push(f);
        preRollRef.current = [];
        preRollFramesRef.current = 0;
        utteranceStartTimeRef.current = Date.now();
        if (state === "quiet" || state === "idle") setStateBoth("recording");
      }
      inSpeechRef.current = true;
      silenceMsRef.current = 0;
      speechMsRef.current += frameMs;
      utteranceMsRef.current += frameMs;
      // Continuous voiced run: extend on every voiced frame, track the max.
      currentVoicedRunMsRef.current += frameMs;
      if (currentVoicedRunMsRef.current > longestVoicedRunMsRef.current) {
        longestVoicedRunMsRef.current = currentVoicedRunMsRef.current;
      }
      samplesRef.current.push(new Float32Array(frame));

      // Hard cap: very long monologues get force-committed
      if (utteranceMsRef.current >= VAD_MAX_UTTERANCE_MS) {
        commitUtterance("max_duration");
      }
    } else {
      // Silence frame
      // Break the continuous voiced run — the longest run so far is preserved
      // in longestVoicedRunMsRef, used by the typing-cooldown onset gate.
      currentVoicedRunMsRef.current = 0;
      if (inSpeechRef.current) {
        // Trailing silence — keep capturing so we don't clip the last word
        samplesRef.current.push(new Float32Array(frame));
        silenceMsRef.current += frameMs;
        utteranceMsRef.current += frameMs;
        if (silenceMsRef.current >= adaptivePauseMsRef.current) {
          if (speechMsRef.current >= VAD_MIN_UTTERANCE_MS) {
            commitUtterance("pause");
          } else {
            // Pause fired but the utterance is too brief to commit. Without
            // this reset we'd keep accumulating silence forever — every random
            // noise blip re-arms silenceMs=0, and real subsequent speech ends
            // up buried in a silent megasegment (95% silence, Whisper garbage).
            // Reset to idle so the next speech onset starts a clean utterance.
            samplesRef.current = [];
            inSpeechRef.current = false;
            silenceMsRef.current = 0;
            speechMsRef.current = 0;
            utteranceMsRef.current = 0;
            longestVoicedRunMsRef.current = 0;
            currentVoicedRunMsRef.current = 0;
            if (state === "recording") setStateBoth("quiet");
          }
        }
      } else {
        // Pure silence — feed the pre-roll circular buffer
        preRollRef.current.push(new Float32Array(frame));
        preRollFramesRef.current += frame.length;
        const maxPreRollSamples = Math.ceil((VAD_PRE_ROLL_MS / 1000) * sampleRate);
        while (preRollFramesRef.current > maxPreRollSamples && preRollRef.current.length > 0) {
          const dropped = preRollRef.current.shift()!;
          preRollFramesRef.current -= dropped.length;
        }
        // Drop overlay to "quiet" if we've been silent long enough — caller
        // handles the visual delay via onStateChange + their own debounce.
        if (state === "recording") setStateBoth("quiet");
      }
    }
  }, [state]);

  // ── Commit utterance — encode + POST + assemble ──────────────────────────
  function commitUtterance(reason: string) {
    if (samplesRef.current.length === 0) return;
    const samples = samplesRef.current;
    samplesRef.current = [];
    const audioMs = utteranceMsRef.current;
    // Capture speech metrics BEFORE zeroing — the audio gate needs them.
    const speechMs = speechMsRef.current;
    // Capture the max continuous voiced-run length for the typing-cooldown
    // onset check. Reset along with the rest of the VAD counters.
    const longestVoicedRunMs = longestVoicedRunMsRef.current;
    inSpeechRef.current = false;
    silenceMsRef.current = 0;
    speechMsRef.current = 0;
    utteranceMsRef.current = 0;
    longestVoicedRunMsRef.current = 0;
    currentVoicedRunMsRef.current = 0;
    void reason;

    // Mint the utterance id up front so any rejection logs have a handle.
    const utteranceId = `u_${++utteranceCounterRef.current}`;

    // Concatenate frames
    const totalLen = samples.reduce((n, s) => n + s.length, 0);
    const pcm = new Float32Array(totalLen);
    let off = 0;
    for (const f of samples) { pcm.set(f, off); off += f.length; }

    // ── Audio-level gate ────────────────────────────────────────────────
    // Compute RMS in dBFS across the whole utterance, plus the ratio of
    // voiced-to-total duration. These are cheap (O(n) over samples).
    let sumSq = 0;
    for (let i = 0; i < pcm.length; i++) sumSq += pcm[i]! * pcm[i]!;
    const rms = pcm.length > 0 ? Math.sqrt(sumSq / pcm.length) : 0;
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const speechRatio = audioMs > 0 ? speechMs / audioMs : 0;
    const silenceRatio = 1 - speechRatio;

    const now = Date.now();
    const idleMs = lastCommitAtRef.current === 0 ? Infinity : now - lastCommitAtRef.current;

    const rejection = evaluateAudioGate({ audioMs, speechMs, rmsDb, speechRatio, idleMs });
    if (rejection !== null) {
      flowLog.audioGate(utteranceId, rejection, Math.round(rmsDb), Math.round(speechMs), Number(speechRatio.toFixed(2)));
      deps.nack();
      return;
    }

    const wav = encodeWav(pcm, sampleRateRef.current);
    flowLog.utteranceCommitted(utteranceId, Math.round(audioMs), 0);
    lastCommitAtRef.current = now;

    void transcribeAndAssemble(utteranceId, wav, audioMs, {
      rmsDb,
      silenceRatio,
      speechRatio,
      longestVoicedRunMs,
    });
  }

  async function transcribeAndAssemble(
    id: string,
    wav: Blob,
    audioMs: number,
    clientAudioQuality: {
      rmsDb: number;
      silenceRatio: number;
      speechRatio: number;
      longestVoicedRunMs: number;
    },
  ) {
    if (!assemblerRef.current || !bufferRef.current) return;
    setStateBoth("transcribing");
    inFlightRef.current += 1;
    const startedAt = Date.now();
    // Stamp this in-flight utterance with the current composition epoch. If
    // the epoch advances before the transcribe promise resolves (send, focus
    // change, or stop fired mid-transcription), the result is discarded as
    // stale. This prevents a late-arriving transcript from appending into a
    // fresh message after a reset boundary.
    const epochAtCommit = resetEpochRef.current;

    // Resolve context at commit time so user app switches are picked up.
    const ctx = deps.resolveContext();
    setResolvedContext(ctx);

    const file = new File([wav], `${id}.wav`, { type: "audio/wav" });
    const promptText = buildPromptWithContinuity();

    try {
      const result = await transcribe({
        audioFile: file,
        durationMs: Math.round(audioMs),
        settings: {
          mode: "fast",
          language: toWhisperLang(langsRef.current),
          timestamps: false,
          offlineOnly: true,
          prompt: promptText || undefined,
        },
        processingMode: "instant",
        postProcessing: postProcessingForContext(ctx),
      });

      const latency = Date.now() - startedAt;
      flowLog.transcribeDone(id, latency, result.modelId);

      // ── Reset-race guard ────────────────────────────────────────────────
      // If the composition has reset (send complete, focus change, stop) while
      // this transcribe was in flight, drop the result. Do NOT touch
      // recentContextRef, the buffer, or the assembler.
      if (resetEpochRef.current !== epochAtCommit) {
        flowLog.staleUtteranceDiscarded(id, epochAtCommit, resetEpochRef.current);
        return;
      }

      // ── Typing-awareness guard ──────────────────────────────────────────
      // When the user is typing (in Spokn or any target app), raise the bar.
      // Weak utterances — low RMS, short voiced run, short transcript — are
      // almost certainly mic bleed or keystroke noise, not speech.
      if (typingGuardRef.current?.isTypingActive()) {
        const msSinceLast = typingGuardRef.current.msSinceLastKeystroke();
        flowLog.typingCooldownActive(id, Math.round(msSinceLast));
        const pickedText =
          result.transcript.correctedText ??
          result.transcript.formattedOutput ??
          result.transcript.fullText ??
          "";
        const verdict = typingGuardRef.current.evaluate(
          {
            rmsDb: clientAudioQuality.rmsDb,
            speechRatio: clientAudioQuality.speechRatio,
            longestVoicedRunMs: clientAudioQuality.longestVoicedRunMs,
          },
          pickedText.trim().length,
          audioMs,
        );
        if (verdict.suppress && verdict.reason) {
          flowLog.typingGuardReject(
            id,
            verdict.reason,
            Math.round(clientAudioQuality.rmsDb),
            Number(clientAudioQuality.speechRatio.toFixed(2)),
            Math.round(audioMs * clientAudioQuality.speechRatio),
            pickedText.trim().length,
            Math.round(clientAudioQuality.longestVoicedRunMs),
          );
          deps.nack();
          return;
        }
      }

      // Merge client-side metrics (computed from the raw PCM in commitUtterance)
      // with any server-reported quality. Client metrics are the trusted source
      // for downstream gates (validation, self-repair) — never recompute them
      // elsewhere.
      const serverQ = result.transcript.audioQuality;
      const aggregateConfidence = computeAggregateConfidence(result.transcript);
      const transcriptLike: TranscriptLike = {
        correctedText: result.transcript.correctedText,
        formattedOutput: result.transcript.formattedOutput,
        fullText: result.transcript.fullText,
        language: result.transcript.language,
        confidence: aggregateConfidence,
        audioMs,
        audioQuality: {
          rmsDb: clientAudioQuality.rmsDb,
          silenceRatio: clientAudioQuality.silenceRatio,
          speechRatio: clientAudioQuality.speechRatio,
          longestVoicedRunMs: clientAudioQuality.longestVoicedRunMs,
          serverRmsDb: serverQ?.rmsDb,
          serverSilenceRatio: serverQ?.silenceRatio,
        },
      };

      // Track for prompt continuity (only final, validated content gets recorded
      // — we add it lazily inside the assembler-driven flow via the buffer)
      const cleanedText = transcriptLike.correctedText ?? "";
      const wordCount = countWords(cleanedText);
      if (wordCount >= FLOW_PROMPT_MIN_WORDS) {
        recentContextRef.current.push({
          text: cleanedText,
          committedAt: Date.now(),
        });
        // Trim aggressively so we never grow without bound
        if (recentContextRef.current.length > FLOW_RECENT_CONTEXT_SEGMENTS * 4) {
          recentContextRef.current.splice(0, recentContextRef.current.length - FLOW_RECENT_CONTEXT_SEGMENTS * 4);
        }
      }

      assemblerRef.current.process(id, transcriptLike, ctx);
      setBufferText(bufferRef.current.fullText());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      flowLog.injectFailed(id, 0, `transcribe_failed: ${String(e)}`);
    } finally {
      inFlightRef.current -= 1;
      if (inFlightRef.current === 0 && !stoppingRef.current) {
        setStateBoth(inSpeechRef.current ? "recording" : "quiet");
      }
    }
  }

  // ── Composition reset (Change 3) ────────────────────────────────────────
  // Called on send-complete and focus-context change. Bumps the reset epoch,
  // drops prompt-continuity history, swaps the SessionBuffer, and asks the
  // assembler to discard any held pre-commit text. Does NOT clear VAD state,
  // language preferences, or speech-rate samples — those are session-scoped.
  function resetCompositionState(cause: "send_complete" | "focus_change" | "stop") {
    resetEpochRef.current += 1;
    const id = `e_${resetEpochRef.current}`;
    flowLog.sessionReset(id, cause);
    recentContextRef.current = [];
    if (bufferRef.current) bufferRef.current = createSessionBuffer();
    setBufferText("");
    // Defensive: clear any straggler pre-commit hold. cancelPending() also
    // clears sendPending, which is already null at send_complete (the
    // assembler cleared it before firing onSendComplete), and harmless for
    // focus_change (no active send in flight by definition).
    assemblerRef.current?.cancelPending();
  }

  // ── Aggregate confidence helper ─────────────────────────────────────────
  // Weighted-by-duration average of per-segment confidence. Returns 1.0 when
  // no segment-level data is available (conservative — assume confidence is
  // high so we don't over-suppress on backends that don't emit per-segment
  // confidence). Consumers must still check `confidence !== undefined`
  // before applying Stage-5 holds if stricter behavior is needed.
  function computeAggregateConfidence(transcript: Transcript): number {
    const segs = transcript.segments;
    if (!segs || segs.length === 0) return 1;
    let totalWeight = 0;
    let weightedSum = 0;
    for (const seg of segs) {
      if (typeof seg.confidence !== "number" || !Number.isFinite(seg.confidence)) {
        continue;
      }
      const durMs = Math.max(1, (seg.endMs ?? 0) - (seg.startMs ?? 0));
      totalWeight += durMs;
      weightedSum += durMs * Math.max(0, Math.min(1, seg.confidence));
    }
    if (totalWeight === 0) return 1;
    return weightedSum / totalWeight;
  }

  // ── Adaptive VAD pause threshold ─────────────────────────────────────────
  function recordRateSample(words: number) {
    const now = Date.now();
    recentRateSamplesRef.current.push({ at: now, words });
    // Drop samples outside the rolling window
    const cutoff = now - VAD_RATE_WINDOW_MS;
    while (recentRateSamplesRef.current.length > 0 && recentRateSamplesRef.current[0]!.at < cutoff) {
      recentRateSamplesRef.current.shift();
    }
    const totalWords = recentRateSamplesRef.current.reduce((n, s) => n + s.words, 0);
    const span = Math.max(1, now - recentRateSamplesRef.current[0]!.at);
    const wps = totalWords / (span / 1000);

    let next: number;
    let tier: "FAST" | "DEFAULT" | "SLOW";
    if (wps > VAD_RATE_FAST_WPS) {
      next = Math.max(VAD_PAUSE_MS_FAST, VAD_PAUSE_MS_FLOOR);
      tier = "FAST";
    } else if (wps < VAD_RATE_SLOW_WPS) {
      next = VAD_PAUSE_MS_SLOW;
      tier = "SLOW";
    } else {
      next = VAD_PAUSE_MS_DEFAULT;
      tier = "DEFAULT";
    }
    if (next !== adaptivePauseMsRef.current) {
      adaptivePauseMsRef.current = next;
      flowLog.vadRate(wps, tier, next);
    }
  }

  // ── Build prompt with continuity (filtered + capped) ─────────────────────
  function buildPromptWithContinuity(): string {
    const base = buildPrompt() || "";
    const now = Date.now();
    const recent = recentContextRef.current
      .filter((e) => now - e.committedAt <= FLOW_PROMPT_MAX_AGE_MS)
      .slice(-FLOW_RECENT_CONTEXT_SEGMENTS);

    if (recent.length === 0) return base;

    // Take the joined text, then cap by sentences and chars.
    let joined = recent.map((e) => e.text.trim()).filter(Boolean).join(" ");
    // Sentence cap
    const sentences = joined.match(/[^.!?]+[.!?]+/g);
    if (sentences && sentences.length > FLOW_PROMPT_MAX_SENTENCES) {
      joined = sentences.slice(-FLOW_PROMPT_MAX_SENTENCES).join(" ").trim();
    }
    // Char cap (take the tail — most recent is what matters)
    if (joined.length > FLOW_PROMPT_MAX_CHARS) {
      joined = joined.slice(joined.length - FLOW_PROMPT_MAX_CHARS);
    }

    return base ? `${base}. ${joined}` : joined;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  const start = useCallback(async (opts: { langs: string[]; selectedMicId?: string; contextOverride?: FlowContext | "auto" }) => {
    if (isActive) return;
    if (accessibilityStatusRef.current === "denied") {
      // Refuse rather than quietly running Flow Mode where every utterance
      // would be rejected by the injection queue. The banner in App.tsx
      // already tells the user what to do; start() just surfaces the same
      // message through the hook's error channel so older callers see it.
      setError(
        "Accessibility permission required to inject text into other apps. Grant it in System Settings → Privacy → Accessibility, then try again.",
      );
      return;
    }
    if (accessibilityStatusRef.current === "probing") {
      // Startup probe hasn't resolved yet. Surfacing "try again" here is
      // friendlier than silently kicking off Flow Mode with an ambiguous
      // permission state — the probe normally resolves in <50ms so a retry
      // immediately after sees "granted".
      setError(
        "Checking accessibility permission — please try again in a moment.",
      );
      return;
    }
    setError(null);
    langsRef.current = opts.langs;
    contextOverrideRef.current = opts.contextOverride ?? "auto";
    stoppingRef.current = false;

    bufferRef.current = createSessionBuffer();
    setBufferText("");
    recentContextRef.current = [];
    pendingMergeRef.current = null;
    inFlightRef.current = 0;
    samplesRef.current = [];
    preRollRef.current = [];
    preRollFramesRef.current = 0;
    silenceMsRef.current = 0;
    speechMsRef.current = 0;
    utteranceMsRef.current = 0;
    utteranceCounterRef.current = 0;
    inSpeechRef.current = false;
    adaptivePauseMsRef.current = VAD_PAUSE_MS_DEFAULT;
    recentRateSamplesRef.current = [];
    lastCommitAtRef.current = 0;
    // Fresh session → fresh composition epoch. Any late-arriving transcript
    // from a previous stopped session that somehow still resolves will now
    // fail the staleness check.
    resetEpochRef.current = 0;
    longestVoicedRunMsRef.current = 0;
    currentVoicedRunMsRef.current = 0;

    // Cursor awareness + injection queue + assembler
    const invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> =
      isTauri
        ? async (cmd, args) => {
            const { invoke: inv } = await import("@tauri-apps/api/core");
            return inv(cmd, args ?? {});
          }
        : async () => undefined;

    awarenessRef.current = createCursorAwareness({ invoke });
    if (isTauri) awarenessRef.current.start();

    typingGuardRef.current = createTypingGuard({ invoke });
    if (isTauri) typingGuardRef.current.start();

    extEditRef.current = createExternalEditCapture({
      invoke,
      currentActiveWindow: () => awarenessRef.current?.current() ?? null,
      isTauri,
      postFeedback: async (payload) => {
        const url = await apiUrl("/api/feedback");
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          throw new Error(`feedback POST failed: ${res.status}`);
        }
      },
    });

    // External → external focus-context change fires a composition reset.
    // Debounce is handled inside awarenessRef. Reconcile the PRIOR window's
    // last injection BEFORE resetting — we can't read the prior field's
    // text after focus has moved on. (Reconcile itself will detect the
    // fingerprint mismatch since active window has already changed; it
    // gracefully skips and logs. This path exists so the entry is cleaned
    // up and its settle-timer cancelled.)
    awarenessRef.current.onFocusContextChange((prev, next) => {
      void next;
      void extEditRef.current?.onFocusChange(prev);
      resetCompositionState("focus_change");
    });

    queueRef.current = createInjectionQueue({
      invoke,
      shouldHold: () => awarenessRef.current?.shouldHold() ?? false,
      onHoldChange: (h) => awarenessRef.current?.onHoldChange(h) ?? (() => {}),
      onSendOk: (sourceId) => {
        const a = assemblerRef.current as (FlowAssembler & {
          onSendComplete?: (id: string) => void;
        }) | null;
        a?.onSendComplete?.(sourceId);
        deps.sendOk?.();
      },
      onSendFail: (sourceId) => {
        const a = assemblerRef.current as (FlowAssembler & {
          onSendComplete?: (id: string) => void;
        }) | null;
        a?.onSendComplete?.(sourceId);
        deps.nack();
      },
      // Permission plumbing (Stage 4). Seed from the ref so the startup-
      // timing invariant holds: the probe has already resolved by the time
      // `start()` runs and constructs the queue (the `"probing"` / `"denied"`
      // guards above are the only paths that reach this construction site,
      // so the ref is guaranteed `"granted"` here).
      getFlowState: () => stateRef.current,
      initialAccessibilityStatus: "granted",
    });

    assemblerRef.current = createAssembler({
      buffer: bufferRef.current,
      enqueue: (op, o) => {
        queueRef.current?.enqueue(op, o);
        // Recency-track committed appends for prompt continuity and record
        // the latest buffer state for external-edit reconciliation. We record
        // the FULL buffer text, not the op fragment, so reconciliation diffs
        // against what the target field should actually contain.
        if (op.kind === "append" && bufferRef.current) {
          setBufferText(bufferRef.current.fullText());
          recordRateSample(countWords(op.text));
          extEditRef.current?.recordInjection(o.sourceId, bufferRef.current.fullText());
        } else if (op.kind === "fullReplace" && bufferRef.current) {
          setBufferText(bufferRef.current.fullText());
          extEditRef.current?.recordInjection(o.sourceId, bufferRef.current.fullText());
        }
      },
      nack: deps.nack,
      sendOk: deps.sendOk,
      isSettled: () =>
        inFlightRef.current === 0 &&
        samplesRef.current.length === 0 &&
        !inSpeechRef.current,
      resolveSendKey: () => sendKeyForContext(deps.resolveContext()),
      allowedLanguages: () => expandToWhisperLangs(langsRef.current),
      currentEpoch: () => resetEpochRef.current,
      onSendComplete: (sourceId) => {
        void sourceId;
        resetCompositionState("send_complete");
      },
    });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: opts.selectedMicId ? { deviceId: { exact: opts.selectedMicId } } : true,
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      sampleRateRef.current = ctx.sampleRate;

      // Keep-alive oscillator (same trick useRecording uses to prevent
      // background-tab AudioContext suspension)
      const keepAlive = ctx.createOscillator();
      const keepAliveGain = ctx.createGain();
      keepAliveGain.gain.value = 0;
      keepAlive.connect(keepAliveGain);
      keepAliveGain.connect(ctx.destination);
      keepAlive.start();
      keepAliveRef.current = keepAlive;

      ctx.onstatechange = () => {
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
      };
      await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyserRef.current = analyser;

      const processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        handleFrame(data, ctx.sampleRate);
      };

      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(ctx.destination);

      setIsActive(true);
      setStateBoth("quiet");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Microphone access denied");
      cleanup();
    }
  }, [isActive, deps, handleFrame]);

  function cleanup() {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    keepAliveRef.current?.stop();
    keepAliveRef.current?.disconnect();
    audioCtxRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach((t) => t.stop());
    processorRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    keepAliveRef.current = null;
    audioCtxRef.current = null;
    streamRef.current = null;

    awarenessRef.current?.stop();
    awarenessRef.current = null;

    typingGuardRef.current?.stop();
    typingGuardRef.current = null;

    extEditRef.current?.stop();
    extEditRef.current = null;

    queueRef.current?.clear();
    queueRef.current = null;

    if (pendingMergeRef.current?.timer) clearTimeout(pendingMergeRef.current.timer);
    pendingMergeRef.current = null;
  }

  const stop = useCallback(async () => {
    if (!isActive) return;
    stoppingRef.current = true;
    setStateBoth("stopping");

    // Commit any in-flight speech as a final utterance
    if (samplesRef.current.length > 0 && speechMsRef.current >= VAD_MIN_UTTERANCE_MS) {
      commitUtterance("flow_stop");
    }

    // Bump reset epoch on stop so any still-in-flight transcribe resolves
    // into the staleness guard and exits cleanly instead of touching a
    // nulled buffer / disposed assembler.
    resetEpochRef.current += 1;
    flowLog.sessionReset(`e_${resetEpochRef.current}`, "stop");

    // Wait briefly for in-flight transcriptions to land
    const start = Date.now();
    while (inFlightRef.current > 0 && Date.now() - start < 5000) {
      await sleep(50);
    }

    assemblerRef.current?.flush();
    // Clear any in-progress voice send — stop() is a hard cancel.
    assemblerRef.current?.cancelPending();
    assemblerRef.current = null;

    cleanup();
    setIsActive(false);
    setStateBoth("idle");
  }, [isActive]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (isActive) {
      stoppingRef.current = true;
      cleanup();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Touch the merge constants so the linter doesn't complain — they will be
  // wired into the merge codepath in a follow-up tweak. (Short-utterance
  // merge logic is kept simple in this MVP: the assembler's pre-commit hold
  // already absorbs most thinking-pause fragments.)
  void VAD_MERGE_HOLD_MS;
  void VAD_MERGE_WORD_FLOOR;

  return {
    isActive,
    state,
    resolvedContext,
    bufferText,
    analyserRef,
    start,
    stop,
    error,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Audio gate ───────────────────────────────────────────────────────────────
// Returns a rejection reason (string) if the utterance fails the gate, or null
// if it should proceed to transcription. Applies the baseline gate always;
// layers the stricter "idle confidence" gate when the system has been silent
// past FLOW_IDLE_CONFIDENCE_MS (i.e. this is the first utterance breaking a
// quiet window — the window where whisper hallucinations cluster).
function evaluateAudioGate(q: {
  audioMs: number;
  speechMs: number;
  rmsDb: number;
  speechRatio: number;
  idleMs: number;
}): string | null {
  if (q.audioMs === 0) return "zero_audio";

  if (q.speechMs < FLOW_AUDIO_MIN_SPEECH_MS) return "too_little_speech";
  if (q.rmsDb < FLOW_AUDIO_MIN_RMS_DB) return "below_noise_floor";
  if (q.speechRatio < FLOW_AUDIO_MIN_SPEECH_RATIO) return "mostly_silence";

  // Stricter gate for post-idle onsets — hallucinations cluster here.
  if (q.idleMs >= FLOW_IDLE_CONFIDENCE_MS) {
    if (q.rmsDb < FLOW_AUDIO_STRICT_RMS_DB) return "idle_low_rms";
    if (q.speechRatio < FLOW_AUDIO_STRICT_SPEECH_RATIO) return "idle_low_speech_ratio";
    if (q.speechMs < FLOW_AUDIO_STRICT_SPEECH_MS) return "idle_too_short";
  }

  return null;
}
