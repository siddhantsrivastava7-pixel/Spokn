// Central seam between a transcribed utterance and the injection queue.
//
// Responsibilities:
//   - Pick the single source-of-truth string from the transcript response
//     (chat → correctedText, email/notes → formattedOutput when present)
//   - Validate (drop noise / hallucinations)
//   - Detect spoken self-repair ("actually at 4" → collapse to "at 4")
//   - Detect trailing "send" intent (split content from command)
//   - Parse for commands (delete last word, change X to Y, undo, send, ...)
//   - Apply commands to the canonical session buffer
//   - Hold *append* ops in a pre-commit slot for FLOW_PRECOMMIT_HOLD_MS so
//     a follow-up correction can intercept BEFORE anything reaches the
//     target field — the user never sees the wrong text flash and disappear.
//   - Orchestrate voice send: freeze buffer mutations, defer until settled,
//     enqueue content + sendKey atomically.
//
// The assembler is stateful (pre-commit timer, send-pending flag) but pure
// with respect to the OS — it pushes FlowOps to the queue, never touches it.

import { parseCommand, extractTrailingSend, type Command } from "./flowCommandParser";
import { stripSoundTags, validate } from "./flowValidation";
import { detectRepair } from "./flowSelfRepair";
import {
  pickInjectionText,
  type FlowContext,
} from "./flowToneMapping";
import type { FlowOp, SessionBuffer } from "./flowSessionBuffer";
import {
  FLOW_CONFIDENCE_HOLD_TTL_MS,
  FLOW_CONFIDENCE_LOW_MIN_CHARS,
  FLOW_CONFIDENCE_LOW_THRESHOLD,
  FLOW_CONFIDENCE_MATCH_MIN_LEV_RATIO,
  FLOW_CONFIDENCE_MATCH_MIN_SHARED_TOKENS,
  FLOW_PRECOMMIT_HOLD_MS,
  FLOW_SEND_DEFER_RETRY_MS,
  FLOW_SEND_RELAXED_MAX_TOKENS,
  FLOW_SEND_RELAXED_MAX_UTTERANCE_MS,
  FLOW_SEND_RELAXED_MIN_CONFIDENCE,
} from "./flowConstants";
import { flowLog } from "./flowObservability";
import type { SendKey } from "./flowSendMap";
import { levenshtein } from "./flowSessionBuffer";

export interface TranscriptLike {
  correctedText?: string;
  formattedOutput?: string;
  fullText?: string;
  audioQuality?: {
    rmsDb?: number;
    silenceRatio?: number;
    speechRatio?: number;
    /** Longest continuous voiced-frame run within the utterance, in ms. Used
     *  by the typing-cooldown onset gate to distinguish speech from transient
     *  spikes. */
    longestVoicedRunMs?: number;
    serverRmsDb?: number;
    serverSilenceRatio?: number;
  } | null;
  /** Whisper-reported language for this utterance (e.g. "en", "hi", "ja"). */
  language?: string;
  /** Aggregate transcription confidence ∈ [0, 1]. Derived upstream from
   *  per-segment Whisper confidences. Consumed by the low-confidence hold
   *  gate and the Stage-2 relaxed send parser. */
  confidence?: number;
  /** Total audio duration in ms. Used by the Stage-2 relaxed send parser to
   *  gate on short "terminal-intent" utterances. */
  audioMs?: number;
}

export interface AssemblerDeps {
  buffer: SessionBuffer;
  enqueue: (op: FlowOp, opts: { immediate: boolean; sourceId: string }) => void;
  /** Trigger a brief overlay nack pulse on validation drop / no-match. */
  nack: () => void;
  /** Trigger a positive confirmation pulse on successful send. */
  sendOk?: () => void;
  /** Returns true when the system is fully settled (no in-flight transcription,
   *  no pending VAD capture). Assembler defers send until this is true. */
  isSettled?: () => boolean;
  /** Resolves the send key for the current context; returns "Noop" when the
   *  context doesn't support auto-send (email in MVP, notes). */
  resolveSendKey?: () => SendKey;
  /** Live thunk returning the user's allowed Whisper language codes (empty =
   *  no filter). Checked at validate-time so onboarding changes pick up
   *  without recreating the assembler. */
  allowedLanguages?: () => string[];
  /** Current composition reset epoch. Increments on every composition reset
   *  (send-complete, focus-change, stop). Used by the pre-commit hold to
   *  discard held text whose epoch has been superseded — covers the case
   *  where a held append's 200 ms timer fires AFTER a reset. */
  currentEpoch?: () => number;
  /** Fired AFTER the send key has been enqueued and the send-freeze has been
   *  released. The host layer performs the composition reset here:
   *  clear recentContext, fresh SessionBuffer, bump the reset epoch. */
  onSendComplete?: (id: string) => void;
}

export interface FlowAssembler {
  /** Process a transcribed utterance. May emit immediately, hold, or noop. */
  process(id: string, transcript: TranscriptLike, context: FlowContext): void;
  /** Force-release any pending held append. Called on Flow stop. */
  flush(): void;
  /** Drop any pending held append without emitting. Called on hard cancel. */
  cancelPending(): void;
  /** True when a voice send is in progress (between intent and key press).
   *  Late transcripts are dropped while this is set. */
  isSendPending(): boolean;
}

interface Pending {
  id: string;
  text: string;
  timer: ReturnType<typeof setTimeout>;
  /** Composition epoch at the time this hold was registered. If the host
   *  epoch advances past this before the timer fires, the held text is
   *  silently discarded — protects against late appends leaking across a
   *  send or focus-change reset. */
  epoch: number;
}

interface LowConfHold {
  id: string;
  text: string;
  heldAt: number;
  confidence: number;
  timer: ReturnType<typeof setTimeout>;
  epoch: number;
}

export function createAssembler(deps: AssemblerDeps): FlowAssembler {
  let pending: Pending | null = null;
  let sendPending: { messageId: string } | null = null;
  let lowConfHold: LowConfHold | null = null;

  function clearLowConfHold(reason: "expired" | "released" | "superseded") {
    if (!lowConfHold) return;
    clearTimeout(lowConfHold.timer);
    if (reason === "expired") {
      flowLog.lowConfidenceExpired(lowConfHold.id);
    }
    lowConfHold = null;
  }

  /** True when this non-send utterance text plausibly continues the held
   *  low-confidence utterance (repeat attempt by the user). Uses two
   *  independent similarity checks — either is sufficient. */
  function matchesLowConfHold(nextText: string): boolean {
    if (!lowConfHold) return false;
    const prev = lowConfHold.text.toLowerCase().trim();
    const curr = nextText.toLowerCase().trim();
    if (!prev || !curr) return false;
    const prevTokens = new Set(prev.split(/\s+/).filter((t) => t.length >= 3));
    const currTokens = new Set(curr.split(/\s+/).filter((t) => t.length >= 3));
    let shared = 0;
    for (const t of currTokens) if (prevTokens.has(t)) shared++;
    if (shared >= FLOW_CONFIDENCE_MATCH_MIN_SHARED_TOKENS) return true;
    const maxLen = Math.max(prev.length, curr.length);
    if (maxLen === 0) return false;
    const ratio = 1 - levenshtein(prev, curr) / maxLen;
    return ratio >= FLOW_CONFIDENCE_MATCH_MIN_LEV_RATIO;
  }

  function clearPending() {
    if (pending) {
      clearTimeout(pending.timer);
      pending = null;
    }
  }

  function commitPending() {
    if (!pending) return;
    const heldText = pending.text;
    const heldId = pending.id;
    const heldEpoch = pending.epoch;
    clearPending();
    // Race guard: if the composition has reset since this hold was taken,
    // discard the held text silently. Any late append here would land into a
    // fresh message and leak prior content across the reset boundary.
    const currentEpoch = deps.currentEpoch?.() ?? 0;
    if (currentEpoch !== heldEpoch) {
      flowLog.staleHoldDiscarded(heldId, heldEpoch, currentEpoch);
      return;
    }
    if (heldText.trim().length === 0) return;
    const op = deps.buffer.append(heldText);
    deps.enqueue(op, { immediate: false, sourceId: heldId });
  }

  function holdAppend(id: string, text: string) {
    clearPending();
    pending = {
      id,
      text,
      epoch: deps.currentEpoch?.() ?? 0,
      timer: setTimeout(() => {
        commitPending();
      }, FLOW_PRECOMMIT_HOLD_MS),
    };
  }

  /** Apply a command against the pending held text only. Returns true if the
   *  command was fully resolved against the held text (no buffer touch). */
  function applyCommandToHeld(cmd: Command, cmdId: string): boolean {
    if (!pending) return false;

    switch (cmd.kind) {
      case "undo": {
        // Undoing the held append = discarding it before it ever showed up.
        flowLog.precommitIntercepted(pending.id, cmdId, cmd.kind);
        clearPending();
        return true;
      }
      case "deleteLast": {
        flowLog.precommitIntercepted(pending.id, cmdId, cmd.kind);
        clearPending();
        return true;
      }
      case "deleteLastWord": {
        const next = stripLastWord(pending.text);
        if (next === null) return false;
        flowLog.precommitIntercepted(pending.id, cmdId, cmd.kind);
        if (next.trim().length === 0) {
          clearPending();
        } else {
          rearm(pending.id, next);
        }
        return true;
      }
      case "deleteLastSentence": {
        const next = stripLastSentence(pending.text);
        if (next === null) return false;
        flowLog.precommitIntercepted(pending.id, cmdId, cmd.kind);
        if (next.trim().length === 0) {
          clearPending();
        } else {
          rearm(pending.id, next);
        }
        return true;
      }
      case "changeXtoY": {
        const next = replaceInHeld(pending.text, cmd.from, cmd.to);
        if (next === null) return false;
        flowLog.precommitIntercepted(pending.id, cmdId, cmd.kind);
        rearm(pending.id, next);
        return true;
      }
      case "send":
      case "newParagraph":
        return false;
    }
  }

  function rearm(id: string, text: string) {
    clearPending();
    pending = {
      id,
      text,
      epoch: deps.currentEpoch?.() ?? 0,
      timer: setTimeout(() => commitPending(), FLOW_PRECOMMIT_HOLD_MS),
    };
  }

  // ── Send orchestration ────────────────────────────────────────────────

  function triggerSend(id: string): void {
    flowLog.sendPath(id, "enter");
    if (sendPending) {
      // A send is already queued — ignore the repeat intent. Rare, but guards
      // against double-fire if the user says "send send".
      flowLog.sendPath(id, "already_pending", `prev=${sendPending.messageId}`);
      flowLog.sendRejected(id, "already_pending");
      return;
    }

    const resolve = deps.resolveSendKey ?? (() => "Noop" as const);
    const key = resolve();
    if (key === "Noop") {
      flowLog.sendPath(id, "noop_context", `key=${key}`);
      deps.nack();
      flowLog.sendRejected(id, "unsupported_context");
      return;
    }
    flowLog.sendPath(id, "key_resolved", `key=${key}`);

    // Note: we intentionally do NOT gate on Spokn's internal buffer being
    // empty. The target app (Slack, chat, etc.) may have content the user
    // typed manually or from a previous Flow session — "send it" should press
    // Enter regardless of our internal state. Safety comes from the strict
    // context mapping (email/notes are already Noop) and the narrow send
    // command surface, not from second-guessing the target field's contents.

    // Begin buffer freeze so late-arriving transcripts can't contaminate the
    // message. Release any held append so it sits AHEAD of the sendKey in FIFO.
    sendPending = { messageId: id };
    flowLog.sendPath(id, "freeze_begin");
    flowLog.sendFreeze(id, "begin");
    commitPending();

    // Defer until the pipeline is settled — then enqueue the sendKey.
    void deferUntilSettled(id, key);
  }

  async function deferUntilSettled(id: string, key: "Enter" | "CtrlEnter"): Promise<void> {
    const startedAt = Date.now();
    const isSettled = deps.isSettled ?? (() => true);

    // Persistent defer — never nack for timing, the user's intent is a strong
    // signal to eventually fire. Cancellation happens via cancelPending() on
    // stop() which clears sendPending.
    //
    // Throttle the "waiting" log so we don't spam once per retry tick — one
    // line per second of waiting is plenty for observability.
    let lastLogAt = 0;
    while (sendPending?.messageId === id && !isSettled()) {
      const waitedMs = Date.now() - startedAt;
      if (waitedMs === 0 || waitedMs - lastLogAt >= 1_000) {
        flowLog.sendDeferred(id, waitedMs, "not_settled");
        lastLogAt = waitedMs;
      }
      await sleep(FLOW_SEND_DEFER_RETRY_MS);
    }

    // If the freeze was cleared (stop or cancel), abort the send.
    if (sendPending?.messageId !== id) {
      flowLog.sendPath(id, "cancelled_mid_defer");
      flowLog.sendRejected(id, "cancelled_while_deferred");
      return;
    }
    flowLog.sendPath(id, "defer_ok", `waitedMs=${Date.now() - startedAt}`);

    // Re-check: if a new held append snuck in via some path (shouldn't, but
    // defense-in-depth), release it so it sits ahead of the sendKey.
    commitPending();

    flowLog.sendPath(id, "enqueue_key", `key=${key}`);
    deps.enqueue(
      { kind: "sendKey", key, sourceId: id },
      { immediate: true, sourceId: id },
    );
    // The queue fires deps.onSendOk (wired at the useFlowMode layer) and the
    // layer calls clearSendPending() via the assembler's exposed flag. See
    // below: sendPending is cleared in onSendComplete.
  }

  function onSendComplete(id: string) {
    if (sendPending?.messageId === id) {
      flowLog.sendFreeze(id, "end");
      sendPending = null;
      // Notify the host layer AFTER releasing the freeze so its reset runs
      // without racing the freeze flag. The host bumps the composition epoch,
      // clears recentContext, and swaps the SessionBuffer.
      deps.onSendComplete?.(id);
    }
  }

  // Expose onSendComplete to the hook layer by making it callable via the
  // queue's onSendOk callback. We stash it on the returned assembler as a
  // side-channel method below.

  function process(id: string, transcript: TranscriptLike, context: FlowContext): void {
    const rawPicked = pickInjectionText(transcript, context);

    // ── Buffer freeze: drop late transcripts during a send ─────────────
    if (sendPending) {
      flowLog.sendFreeze(sendPending.messageId, "send_freeze_atomic_guard", id);
      return;
    }

    // ── Non-speech artifact stripping (Change 1) ───────────────────────
    // Strip sound tags from mixed utterances BEFORE validation, self-repair,
    // send extraction, and command parsing — none of those stages should ever
    // see "[cough]" / "*sigh*" / boundary noise tokens.
    const stripped = stripSoundTags(rawPicked, transcript.audioQuality ?? undefined);
    if (stripped.tagsRemoved > 0 || stripped.edgeNoiseRemoved.length > 0) {
      flowLog.soundTagStripped(id, stripped.tagsRemoved, stripped.text.length);
      for (const token of stripped.edgeNoiseRemoved) {
        flowLog.edgeNoiseStripped(id, token, "weak_audio_edge");
      }
    }
    const text = stripped.text;

    // INVARIANT: a disallowed detectedLanguage must be rejected here, BEFORE
    // self-repair, trailing-send extraction, command parsing, buffer mutation,
    // assembler pre-commit hold, or queue enqueue. Do not move this check
    // downstream — wrong-language audio never reaches the target field.
    const v = validate({
      text,
      audioQuality: transcript.audioQuality ?? null,
      detectedLanguage: transcript.language,
      allowedLanguages: deps.allowedLanguages?.(),
    });
    if (!v.ok) {
      flowLog.validation(id, "reject", text.length, v.reason);
      deps.nack();
      return;
    }
    flowLog.validation(id, "accept", text.length);

    // ── Self-repair (before send extraction so trailing send applies to the
    //    cleaned content) ────────────────────────────────────────────────
    const repaired = detectRepair(text, transcript.audioQuality ?? null);
    const workingText = repaired.kind === "intraUtterance" ? repaired.cleaned : text;
    if (repaired.kind === "intraUtterance") {
      flowLog.repairDetected(id, repaired.marker, repaired.leftWords, repaired.rightWords);
    }

    // ── Trailing send extraction ───────────────────────────────────────
    // Check the cleaned text first, then fall back to raw whisper output —
    // the LLM post-processor sometimes rewrites/drops the send phrase, but
    // the raw transcript still carries the user's intent.
    const cleanedSend = extractTrailingSend(workingText);
    const rawSend = transcript.fullText
      ? extractTrailingSend(transcript.fullText)
      : { content: "", sendAfter: false };

    const sendAfter = cleanedSend.sendAfter || rawSend.sendAfter;
    // Prefer the cleaned content when available — it reflects LLM
    // grammar/filler cleanup the user expects to see in the target app.
    const content = cleanedSend.sendAfter ? cleanedSend.content : workingText;

    // ── Command parsing (peek; we always parse so we can log the result
    //    even when the send path didn't trigger) ──────────────────────
    const cmd = parseCommand(workingText);

    // ── Send diagnostics ───────────────────────────────────────────────
    // Emit ONE consolidated line whenever there's any signal that this
    // utterance could have been a send. This is the primary grep target
    // when "I said send and nothing happened" — covers parser misses,
    // LLM rewrites, context/key mismatches, and settle races.
    const rawText = transcript.fullText ?? "";
    const hasSendSignal =
      sendAfter ||
      (cmd && cmd.kind === "send") ||
      SEND_KEYWORD_RE.test(workingText) ||
      SEND_KEYWORD_RE.test(rawText);

    if (hasSendSignal) {
      const ctxForDiag = context;
      const sendKeyForDiag = (deps.resolveSendKey?.() ?? "Noop") as string;
      const tokens = workingText.trim().length === 0
        ? 0
        : workingText.trim().split(/\s+/).length;
      const trailingPhrase = cleanedSend.sendAfter
        ? extractTrailingPhrase(workingText)
        : rawSend.sendAfter
          ? extractTrailingPhrase(rawText)
          : "";
      flowLog.sendDiag(id, {
        textLen: workingText.length,
        rawLen: rawText.length,
        tokens,
        cleanedTail: tail(workingText, 24),
        rawTail: tail(rawText, 24),
        trailingHit: sendAfter,
        trailingPhrase,
        commandKind: cmd?.kind ?? "none",
        ctx: ctxForDiag,
        sendKey: sendKeyForDiag,
      });
    }

    // ── Strict send classification (Change 6, Stage 1) ─────────────────
    // This runs BEFORE the low-confidence gate so that a low-confidence
    // "send" / "send it" / "submit" always fires, regardless of confidence.
    // Explicitly exempt — do NOT rely on the length override for send intent.
    const strictSendMatched = sendAfter || cmd?.kind === "send";

    // ── Low-confidence hold gate (Change 5) ────────────────────────────
    // Only runs for utterances that did NOT match a strict send command.
    // Held text never touches the buffer, the injection queue, or the
    // prompt-continuity history.
    if (!strictSendMatched) {
      const conf = transcript.confidence;
      if (typeof conf === "number" && conf < FLOW_CONFIDENCE_LOW_THRESHOLD) {
        const longEnough = workingText.length >= FLOW_CONFIDENCE_LOW_MIN_CHARS;
        const confirmed = matchesLowConfHold(workingText);
        if (longEnough) {
          flowLog.lowConfidenceInjected(id, conf, "length_override");
          clearLowConfHold("released");
          // fall through to normal path
        } else if (confirmed) {
          flowLog.lowConfidenceInjected(id, conf, "second_utterance_confirmed");
          clearLowConfHold("released");
          // fall through to normal path
        } else {
          clearLowConfHold("superseded");
          const heldEpoch = deps.currentEpoch?.() ?? 0;
          flowLog.lowConfidenceHold(id, conf);
          lowConfHold = {
            id,
            text: workingText,
            heldAt: Date.now(),
            confidence: conf,
            epoch: heldEpoch,
            timer: setTimeout(() => {
              clearLowConfHold("expired");
            }, FLOW_CONFIDENCE_HOLD_TTL_MS),
          };
          return;
        }
      } else if (lowConfHold && matchesLowConfHold(workingText)) {
        // High-confidence follow-up that continues the held text — release.
        flowLog.lowConfidenceInjected(
          lowConfHold.id,
          lowConfHold.confidence,
          "second_utterance_confirmed",
        );
        clearLowConfHold("released");
      }
    }

    if (sendAfter && content.trim().length > 0) {
      // Content + send: hold the content (normal precommit path), then trigger
      // the send. triggerSend will commitPending() so the append lands BEFORE
      // the sendKey in the FIFO queue.
      flowLog.sendStage(id, "strict", extractTrailingPhrase(workingText) || extractTrailingPhrase(rawText) || "send");
      holdAppend(id, content);
      triggerSend(id);
      return;
    }

    if (sendAfter && content.trim().length === 0) {
      // Pure send: no content to inject, just fire.
      flowLog.sendStage(id, "strict", extractTrailingPhrase(workingText) || extractTrailingPhrase(rawText) || "send");
      triggerSend(id);
      return;
    }

    if (cmd) {
      if (cmd.kind === "send") {
        flowLog.sendStage(id, "strict", "send");
        triggerSend(id);
        return;
      }

      flowLog.commandParsed(
        id,
        cmd.kind,
        cmd.kind === "changeXtoY" ? cmd.from.length : undefined,
        cmd.kind === "changeXtoY" ? cmd.to.length : undefined
      );

      // First try to resolve against the held append (so the wrong text never
      // flashes). If that doesn't apply, fall back to the buffer.
      if (applyCommandToHeld(cmd, id)) return;

      const op = applyCommandToBuffer(cmd, deps.buffer);
      if (op.kind === "noop" && op.reason === "no_match") {
        flowLog.commandNack(id, op.reason, workingText);
        deps.nack();
        return;
      }
      if (op.kind === "noop") return;
      // Corrections bypass the precommit hold — they always go straight in.
      deps.enqueue(op, { immediate: true, sourceId: id });
      return;
    }

    // ── Stage-2 relaxed send parser (Change 6) ─────────────────────────
    // Only fires when Stage 1 missed AND all four gates pass. Can never
    // fire on the first utterance of a composition (needs prior context).
    if (!strictSendMatched && maybeRelaxedSend(id, workingText, transcript)) {
      return;
    }

    // Content utterance: release any held append, then hold this one.
    if (pending) commitPending();
    holdAppend(id, workingText);
  }

  /** Stage-2 relaxed send. Returns true if it fired (caller returns too). */
  function maybeRelaxedSend(
    id: string,
    workingText: string,
    transcript: TranscriptLike,
  ): boolean {
    const conf = transcript.confidence;
    if (typeof conf !== "number" || conf < FLOW_SEND_RELAXED_MIN_CONFIDENCE) {
      return false;
    }
    const audioMs = transcript.audioMs;
    if (
      typeof audioMs !== "number" ||
      audioMs > FLOW_SEND_RELAXED_MAX_UTTERANCE_MS
    ) {
      return false;
    }
    const trimmed = workingText.trim();
    if (trimmed.length === 0) return false;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length > FLOW_SEND_RELAXED_MAX_TOKENS) return false;
    const match = trimmed.match(RELAXED_SEND_RE);
    if (!match) return false;
    // Terminal-intent prosody proxy: short utterance inside an existing
    // composition. First utterance of a message never triggers relaxed send.
    const hasPriorComposition =
      deps.buffer.segments().length > 0 || pending !== null;
    if (!hasPriorComposition) return false;

    flowLog.sendStage(id, "relaxed", match[1]!.toLowerCase());
    triggerSend(id);
    return true;
  }

  function flush(): void {
    if (pending) commitPending();
  }

  function cancelPending(): void {
    clearPending();
    clearLowConfHold("superseded");
    // Also clear any pending send — stop() is a hard cancel.
    if (sendPending) {
      flowLog.sendFreeze(sendPending.messageId, "end");
      sendPending = null;
    }
  }

  const assembler: FlowAssembler & { onSendComplete: (id: string) => void } = {
    process,
    flush,
    cancelPending,
    isSendPending: () => sendPending !== null,
    onSendComplete,
  };
  return assembler;
}

function applyCommandToBuffer(cmd: Command, buffer: SessionBuffer): FlowOp {
  switch (cmd.kind) {
    case "deleteLastWord": return buffer.deleteLastWord();
    case "deleteLastSentence": return buffer.deleteLastSentence();
    case "deleteLast": return buffer.deleteLastSegment();
    case "undo": return buffer.undo();
    case "newParagraph": return buffer.newParagraph();
    case "changeXtoY": return buffer.changeXtoY(cmd.from, cmd.to);
    case "send":
      // Send never reaches the buffer path — it's handled in triggerSend before
      // applyCommandToBuffer is called. Return a noop for type-safety.
      return { kind: "noop", reason: "send_not_applied_to_buffer" };
  }
}

// Broad send-keyword sniffer — fires the send_diag log when any of these
// tokens appears in cleaned OR raw text, so parser misses ("send it" was
// rewritten by the LLM) still show up in diagnostics. Intentionally loose:
// this is a log-emit gate only, it does NOT cause a send.
const SEND_KEYWORD_RE = /\b(send|submit|post)\b/i;

// Stage-2 relaxed-send morpheme regex. Wider than Stage 1 (the strict parser
// in flowCommandParser), but still narrow enough that only deliberately-short
// send-like utterances match. The capture group feeds the sendStage log so
// reviewers can grep for which phrase caused a relaxed send.
const RELAXED_SEND_RE = /\b(send|submit|post|shoot|fire|go)\b/i;

/** Last N chars of a string, with whitespace collapsed for grep-friendly logs.
 *  Returns empty string for empty input. */
function tail(s: string, n: number): string {
  if (!s) return "";
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length <= n ? collapsed : collapsed.slice(collapsed.length - n);
}

/** Pull the trailing send phrase (e.g. "send it") from a string where
 *  extractTrailingSend returned sendAfter=true. Safe for diagnostics only —
 *  do not use as a routing signal; the assembler already has that data. */
function extractTrailingPhrase(s: string): string {
  const m = s.trimEnd().match(/\b(send it|send this|send please|send|submit|post this|post it)[\s.!?,;:]*$/i);
  return m ? m[1]!.toLowerCase() : "";
}

// ── Local string helpers (operate on held text only — buffer has its own) ──

function stripLastWord(text: string): string | null {
  const trimmed = text.trimEnd();
  const idx = trimmed.search(/\S+\s*$/);
  if (idx === -1) return null;
  return trimmed.slice(0, idx).trimEnd();
}

function stripLastSentence(text: string): string | null {
  const m = text.match(/[^.!?]*[.!?][\s"')\]]*$/);
  if (!m) return "";
  if (m[0].length === text.length) return "";
  return text.slice(0, text.length - m[0].length).trimEnd();
}

/** Case-insensitive last-occurrence replace within a single string. Returns
 *  null when `from` doesn't appear. (Fuzzy matching is reserved for the
 *  buffer-walking path, which has more context to disambiguate; held text is
 *  short enough that exact match is the right behavior.) */
function replaceInHeld(text: string, from: string, to: string): string | null {
  const lc = text.toLowerCase();
  const idx = lc.lastIndexOf(from.toLowerCase());
  if (idx === -1) return null;
  return text.slice(0, idx) + to + text.slice(idx + from.length);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
