// Structured console logging for Flow Mode. All lines tagged `[flow]` with
// stable field names for grep-friendly debugging. No telemetry, no PII —
// only counts/lengths, never transcript text.

type Level = "info" | "warn";
type Fields = Record<string, string | number | boolean | undefined>;

function fmt(event: string, fields: Fields): string {
  const parts: string[] = [`[flow]`, event.padEnd(22)];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const sv = typeof v === "string" ? `"${v}"` : String(v);
    parts.push(`${k}=${sv}`);
  }
  return parts.join(" ");
}

function emit(level: Level, event: string, fields: Fields) {
  const line = fmt(event, fields);
  if (level === "warn") console.warn(line);
  else console.info(line);
}

export const flowLog = {
  utteranceCommitted: (id: string, audioMs: number, wordsRaw: number) =>
    emit("info", "utterance_committed", { id, audioMs, wordsRaw }),

  transcribeDone: (id: string, latencyMs: number, model?: string) =>
    emit("info", "transcribe_done", { id, latencyMs, model }),

  validation: (id: string, result: "accept" | "reject", charsOut: number, reason?: string) =>
    emit(result === "accept" ? "info" : "warn", "validation", { id, result, charsOut, reason }),

  queueEnqueue: (id: string, queueDepth: number, kind: string) =>
    emit("info", "queue_enqueue", { id, queueDepth, kind }),

  injectAttempt: (id: string, waitMs: number, attempt: number, kind: string) =>
    emit("info", "inject_attempt", { id, waitMs, attempt, kind }),

  injectOk: (id: string, totalMs: number, kind: string) =>
    emit("info", "inject_ok", { id, totalMs, kind }),

  injectFailed: (id: string, attempt: number, reason: string) =>
    emit("warn", "inject_failed", { id, attempt, reason }),

  contextResolved: (mode: "auto" | "manual", resolved: string, exe?: string, title?: string) =>
    emit("info", "context_resolved", { mode, resolved, exe, title }),

  commandParsed: (id: string, cmd: string, fromLen?: number, toLen?: number) =>
    emit("info", "command_parsed", { id, cmd, fromLen, toLen }),

  commandNack: (id: string, reason: string, phrase: string) =>
    emit("warn", "command_nack", { id, reason, phrase }),

  precommitIntercepted: (heldId: string, cmdId: string, cmd: string) =>
    emit("info", "precommit_intercepted", { heldId, cmdId, cmd }),

  correctionCoalesced: (collapsed: number, finalOp: string) =>
    emit("info", "correction_coalesced", { collapsed, finalOp }),

  vadRate: (wps: number, tier: "FAST" | "DEFAULT" | "SLOW", pauseMs: number) =>
    emit("info", "vad_rate", { wps: Number(wps.toFixed(2)), tier, pauseMs }),

  fuzzyMatch: (from: string, matched: string, distance: number) =>
    emit("info", "fuzzy_match", { from, matched, distance }),

  /** Spokn → external window transition. Fires exactly once per transition
   *  so a reader can tell which app the next paste will land in. Empty titles
   *  are logged as "" (never null/undefined) for grep-friendly output. */
  focusReleased: (exe: string, title: string) =>
    emit("info", "focus_released", { exe, title }),

  queuePaused: (reason: string) => emit("warn", "queue_paused", { reason }),
  queueResumed: () => emit("info", "queue_resumed", {}),

  audioGate: (id: string, reason: string, rmsDb: number, speechMs: number, speechRatio: number) =>
    emit("warn", "audio_gate", { id, reason, rmsDb, speechMs, speechRatio }),

  repairDetected: (id: string, marker: string, leftWords: number, rightWords: number) =>
    emit("info", "repair_detected", { id, marker, leftWords, rightWords }),

  repairSkipped: (id: string, reason: string) =>
    emit("info", "repair_skipped", { id, reason }),

  sendFreeze: (id: string, phase: "begin" | "end" | "send_freeze_atomic_guard", droppedUtteranceId?: string) =>
    emit("info", "send_freeze", { id, phase, droppedUtteranceId }),

  sendDeferred: (id: string, waitingMs: number, reason: string) =>
    emit("info", "send_deferred", { id, waitingMs, reason }),

  sendFired: (id: string, key: string, totalMs: number) =>
    emit("info", "send_fired", { id, key, totalMs }),

  sendRejected: (id: string, reason: string) =>
    emit("warn", "send_rejected", { id, reason }),

  /**
   * Single consolidated diagnostic line emitted whenever an utterance shows
   * any signal that it might be a send — either parseCommand matched, or
   * extractTrailingSend matched, or the cleaned/raw text contains a send
   * keyword. Answers: where did the send pipeline take the turn? If a user
   * said "send it" and nothing fired, grep for this line and you'll see
   * which layer lost the signal (parser, post-processor, context, key).
   */
  sendDiag: (id: string, fields: {
    textLen: number;
    rawLen: number;
    tokens: number;
    cleanedTail: string;   // last ~24 chars of cleaned text, for grep
    rawTail: string;       // last ~24 chars of raw text, for grep
    trailingHit: boolean;
    trailingPhrase: string;
    commandKind: string;   // "send" / "deleteLastWord" / ... / "none"
    ctx: string;           // resolved FlowContext at decision time
    sendKey: string;       // "Enter" / "CtrlEnter" / "Noop"
  }) =>
    emit("info", "send_diag", { id, ...fields }),

  /** Granular path marker inside triggerSend / deferUntilSettled. Step values:
   *  "enter" | "already_pending" | "noop_context" | "freeze_begin" |
   *  "defer_loop" | "defer_ok" | "cancelled_mid_defer" | "enqueue_key". */
  sendPath: (id: string, step: string, detail?: string) =>
    emit("info", "send_path", { id, step, detail }),

  // ── Change 1 — non-speech stripping ─────────────────────────────────────
  soundTagStripped: (id: string, removed: number, remaining: number) =>
    emit("info", "sound_tag_stripped", { id, removed, remaining }),

  edgeNoiseStripped: (id: string, token: string, reason: string) =>
    emit("info", "edge_noise_stripped", { id, token, reason }),

  // ── Change 2 — typing awareness ─────────────────────────────────────────
  typingCooldownActive: (id: string, msSinceLast: number) =>
    emit("info", "typing_cooldown_active", { id, msSinceLast }),

  typingGuardReject: (
    id: string,
    reason: "rms" | "speech_ratio" | "speech_ms" | "min_chars" | "onset",
    rmsDb?: number,
    speechRatio?: number,
    speechMs?: number,
    textLen?: number,
    onsetMs?: number,
  ) =>
    emit("warn", "typing_guard_reject", {
      id,
      reason,
      rmsDb,
      speechRatio,
      speechMs,
      textLen,
      onsetMs,
    }),

  // ── Change 3 — session reset + race guard ───────────────────────────────
  sessionReset: (
    id: string,
    cause: "send_complete" | "focus_change" | "stop",
  ) => emit("info", "session_reset", { id, cause }),

  staleUtteranceDiscarded: (
    id: string,
    heldEpoch: number,
    currentEpoch: number,
  ) => emit("warn", "stale_utterance_discarded", { id, heldEpoch, currentEpoch }),

  staleHoldDiscarded: (id: string, heldEpoch: number, currentEpoch: number) =>
    emit("warn", "stale_hold_discarded", { id, heldEpoch, currentEpoch }),

  // ── Change 4 — external edit capture ────────────────────────────────────
  fingerprintNormalized: (raw: string, normalized: string, rule: string) =>
    emit("info", "fingerprint_normalized", { raw, normalized, rule }),

  extEditSkipped: (
    id: string,
    reason:
      | "fingerprint_mismatch"
      | "stale"
      | "low_jaccard"
      | "too_many_changes"
      | "empty"
      | "read_failed",
  ) => emit("info", "ext_edit_skipped", { id, reason }),

  extEditCaptured: (id: string, changeCount: number) =>
    emit("info", "ext_edit_captured", { id, changeCount }),

  // ── Change 5 — low-confidence hold ──────────────────────────────────────
  lowConfidenceHold: (id: string, confidence: number) =>
    emit("info", "low_confidence_hold", {
      id,
      confidence: Number(confidence.toFixed(3)),
    }),

  lowConfidenceInjected: (
    id: string,
    confidence: number,
    reason: "length_override" | "second_utterance_confirmed",
  ) =>
    emit("info", "low_confidence_injected", {
      id,
      confidence: Number(confidence.toFixed(3)),
      reason,
    }),

  lowConfidenceExpired: (id: string) =>
    emit("info", "low_confidence_expired", { id }),

  // ── Change 6 — two-stage send parser ────────────────────────────────────
  sendStage: (id: string, stage: "strict" | "relaxed", phrase: string) =>
    emit("info", "send_stage", { id, stage, phrase }),

  // ── macOS Accessibility permission (Stage 4) ────────────────────────────
  //
  // Emitted every time the injection queue discards pending / incoming ops
  // because text injection is currently blocked. Single event per discard
  // batch, not per op. `blockedEpisodeEntry` distinguishes the FIRST drain
  // after the app entered `permission_blocked` state ("user just hit the
  // wall") from drains that fire while the app is already blocked ("user
  // kept dictating while blocked") — different support stories.
  //
  // On Windows this never fires: Rust reports "granted" unconditionally
  // and the queue never enters the suspended state. On macOS it fires when
  // AXIsProcessTrusted() returns false at startup or re-probe (Stage 6).
  injectionDiscarded: (fields: {
    count: number;
    reason: InjectionDiscardReason;
    queuedTextChars: number;
    flowState: FlowStateTag;
    blockedEpisodeEntry: BlockedEpisodeEntry;
  }) =>
    emit("warn", "injection_discarded", {
      count: fields.count,
      reason: fields.reason,
      queuedTextChars: fields.queuedTextChars,
      flowState: fields.flowState,
      blockedEpisodeEntry: fields.blockedEpisodeEntry,
    }),
};

/**
 * Reason code for why a batch of injection ops was discarded. A union so a
 * future reason (e.g. user toggled Flow off mid-drain) can be added without
 * reshaping consumers of the event.
 */
export type InjectionDiscardReason = "permission_blocked_accessibility";

/**
 * Serializable snapshot of Flow Mode's runtime state at the moment an event
 * fires. Kept separate from the live `FlowState` type in useFlowMode.ts to
 * avoid a cross-import between logging and state machine; keep the two in
 * sync by convention (compile-time check via a small unit test in this file's
 * tests if that ever becomes an issue).
 */
export type FlowStateTag =
  | "idle"
  | "recording"
  | "quiet"
  | "transcribing"
  | "stopping";

/**
 * "first" = this drain is the one that transitioned `accessibilityReady`
 * from a non-denied state (ready / unknown / probing) into denied.
 * "subsequent" = the app was already in the permission_blocked state when
 * this drain fired.
 *
 * Startup-timing invariant: the flag must be seeded synchronously by the
 * startup probe before the injection queue is constructed, so the very
 * first real denial is unambiguously marked "first" rather than racing a
 * late-arriving probe result. If the initial probe itself fails for any
 * unexpected reason, treat the flag as "denied" (never "unknown").
 */
export type BlockedEpisodeEntry = "first" | "subsequent";
