// Cooperative cursor awareness. We do NOT control the cursor — we respect
// it. Two responsibilities, cleanly separated:
//
//   1. Queue hold logic — pause injection only when Spokn itself is focused.
//      Any other window (Claude, Slack, Chrome, VS Code, …) is a legitimate
//      paste target. Users switch between target apps mid-session, so there
//      is no single "locked" target.
//   2. Active-window metadata — every poll updates `latest`, consumed by
//      flowAutoContext for context inference, tone mapping, and send-key
//      selection. The `current()` contract is unchanged.
//
// Observability: a single info-level `focus_released` line fires exactly once
// on each Spokn → external transition. External → external hops produce no
// log (they are irrelevant to queue behavior). The reverse edge is already
// covered by the existing `queue_paused reason="spokn_focused"`.

import {
  FLOW_FOCUS_CONTEXT_DEBOUNCE_MS,
  FLOW_FOCUS_POLL_MS,
} from "./flowConstants";
import type { ActiveWindowInfo } from "./flowAutoContext";
import { flowLog } from "./flowObservability";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface RawWindowInfo {
  process_name: string;
  /** macOS: bundleIdentifier; Windows: empty. */
  bundle_id?: string;
  /** macOS: localizedName; Windows: empty. */
  localized_name?: string;
  window_title: string;
  is_self: boolean;
}

export interface CursorAwarenessDeps {
  invoke: Invoke;
}

export interface CursorAwareness {
  /** Begin polling. */
  start(): void;
  /** Stop polling. */
  stop(): void;
  /** True when injection should hold (Spokn itself is focused). */
  shouldHold(): boolean;
  /** Latest observed foreground window info (or null when not started). */
  current(): ActiveWindowInfo | null;
  /** Subscribe to hold-state changes. Returns an unsubscribe function. */
  onHoldChange(handler: () => void): () => void;
  /** Subscribe to external→external focus-context changes (e.g. Slack →
   *  ChatGPT). Fires once per change after `FLOW_FOCUS_CONTEXT_DEBOUNCE_MS`
   *  of focus stability, so Alt-Tab wiggling doesn't trigger a reset
   *  mid-composition. Receives the PRIOR window so the reconciliation path
   *  can diff against the correct fingerprint. Returns unsubscribe. */
  onFocusContextChange(
    handler: (prev: ActiveWindowInfo, next: ActiveWindowInfo) => void,
  ): () => void;
}

/** Future-ready: a controller that can manipulate the focused field's
 *  cursor/selection. Not implemented in MVP — full-buffer paste covers
 *  every text field universally. */
export interface CursorController {
  moveTo(offset: number): Promise<void>;
  selectRange(start: number, end: number): Promise<void>;
  insertAtCursor(text: string): Promise<void>;
}

export function createCursorAwareness(deps: CursorAwarenessDeps): CursorAwareness {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let latest: ActiveWindowInfo | null = null;
  let holdActive = false;
  const handlers = new Set<() => void>();
  // External→external focus-context tracking. `stableExternal` is the last
  // external window we've treated as "the current target". `pendingExternal`
  // is a candidate that just appeared and must survive
  // FLOW_FOCUS_CONTEXT_DEBOUNCE_MS before promoting. Self-focused and
  // external-with-same-fingerprint are no-ops.
  let stableExternal: ActiveWindowInfo | null = null;
  let pendingExternal: {
    info: ActiveWindowInfo;
    firstSeenAt: number;
  } | null = null;
  const contextHandlers = new Set<
    (prev: ActiveWindowInfo, next: ActiveWindowInfo) => void
  >();

  function sameExternalFingerprint(
    a: ActiveWindowInfo,
    b: ActiveWindowInfo,
  ): boolean {
    // Raw fingerprint equality here — normalization is done by
    // flowExternalEditCapture for edit reconciliation. For focus-debounce
    // purposes, a title-only flicker (e.g. Slack unread counter) should NOT
    // cause a reset — we compare stable identifiers only, matching how a
    // user thinks about "switched apps".
    //
    // macOS: prefer bundleId (stable across renames / version bumps);
    // Windows: fall back to processName (bundleId is empty). Either identity
    // on either side is enough to count as "same target".
    if (a.bundleId && b.bundleId) {
      return a.bundleId === b.bundleId;
    }
    return a.processName === b.processName;
  }

  function notify() {
    for (const h of handlers) {
      try { h(); } catch { /* ignore */ }
    }
  }

  // INVARIANT: `flowLog.queueResumed()` fires exactly once per true → false
  // hold transition. The queue-drain fix depends on this edge firing
  // correctly — the injection queue's onHoldChange handler runs drain() on
  // every notify, and queueResumed is what tells the log reader the edge
  // actually happened.
  //
  // Proof (by case analysis on every path through setHold):
  //   - `next === holdActive` early-returns → zero logs on same-state calls.
  //     So repeated polls with unchanged focus produce no log spam.
  //   - `holdActive = false → true` branch logs `queuePaused` only.
  //   - `holdActive = true  → false` branch logs `queueResumed` exactly once
  //     (unconditional, inside the else branch), then optionally
  //     `focusReleased` when the new focus is an external window.
  //   - Initial `holdActive = false` at start(); if the first poll also sees
  //     external focus, `setHold(false, ...)` hits the same-state guard and
  //     emits no log — no spurious startup `queueResumed`.
  function setHold(next: boolean, reason: string, info: ActiveWindowInfo | null) {
    if (next === holdActive) return;
    const wasHeld = holdActive;
    holdActive = next;
    if (next) {
      flowLog.queuePaused(reason);
    } else {
      flowLog.queueResumed();
      // Spokn → external breadcrumb: fire exactly on the true→false edge,
      // and only when the new focus is an external window we know about.
      // Empty titles are preserved as "" (not null/omitted) so the log line
      // has a stable shape for grep.
      if (wasHeld && info && !info.isSelf) {
        flowLog.focusReleased(info.processName ?? "", info.windowTitle ?? "");
      }
    }
    notify();
  }

  async function pollOnce() {
    try {
      const raw = (await deps.invoke("get_active_window_info")) as RawWindowInfo | null;
      if (!raw) return;
      const info: ActiveWindowInfo = {
        processName: raw.process_name ?? "",
        bundleId: raw.bundle_id ?? "",
        localizedName: raw.localized_name ?? "",
        windowTitle: raw.window_title ?? "",
        isSelf: !!raw.is_self,
      };
      latest = info;

      // Hold semantics: Spokn focused → hold; anything else → release.
      // No target-lock, no grace period — paste is safe into any non-self
      // window and unsafe into Spokn itself. Simpler and correct.
      if (info.isSelf) {
        setHold(true, "spokn_focused", info);
        // Self-focus doesn't change the composition target — leave
        // stableExternal untouched and cancel any pending candidate.
        pendingExternal = null;
        return;
      }

      setHold(false, "external_focused", info);

      // ── External→external focus-context tracking ──────────────────────
      if (!stableExternal) {
        // First external we've seen — establish the baseline without firing.
        stableExternal = info;
        pendingExternal = null;
        return;
      }

      if (sameExternalFingerprint(info, stableExternal)) {
        // Same target (maybe title churn) — nothing to do.
        pendingExternal = null;
        return;
      }

      // Different external — debounce.
      const now = Date.now();
      if (
        pendingExternal &&
        sameExternalFingerprint(pendingExternal.info, info)
      ) {
        if (now - pendingExternal.firstSeenAt >= FLOW_FOCUS_CONTEXT_DEBOUNCE_MS) {
          const prev = stableExternal;
          stableExternal = info;
          pendingExternal = null;
          for (const h of contextHandlers) {
            try {
              h(prev, info);
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        // New candidate — start the debounce clock.
        pendingExternal = { info, firstSeenAt: now };
      }
    } catch {
      // Best-effort polling — never throw.
    }
  }

  function start() {
    if (pollTimer) return;
    latest = null;
    holdActive = false;
    stableExternal = null;
    pendingExternal = null;
    void pollOnce();
    pollTimer = setInterval(() => { void pollOnce(); }, FLOW_FOCUS_POLL_MS);
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    latest = null;
    holdActive = false;
    stableExternal = null;
    pendingExternal = null;
  }

  function onHoldChange(handler: () => void): () => void {
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  }

  function onFocusContextChange(
    handler: (prev: ActiveWindowInfo, next: ActiveWindowInfo) => void,
  ): () => void {
    contextHandlers.add(handler);
    return () => {
      contextHandlers.delete(handler);
    };
  }

  return {
    start,
    stop,
    shouldHold: () => holdActive,
    current: () => latest,
    onHoldChange,
    onFocusContextChange,
  };
}
