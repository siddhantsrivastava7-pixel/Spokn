// FIFO worker that drains FlowOps into the focused application via Tauri.
//
// Op shapes:
//   - "append"      → inject_text (clipboard + Ctrl+V), waits FLOW_INJECT_DELAY_MS
//   - "fullReplace" → inject_full_replace (Ctrl+A → clipboard → Ctrl+V),
//                     coalesces consecutive ops within FLOW_CORRECTION_COALESCE_MS
//   - "sendKey"     → send_key (Enter / CtrlEnter), non-coalescing. Awaits
//                     FLOW_SEND_POST_PASTE_MS before invoking so the prior
//                     paste has visibly landed in the target app.
//
// Reliability:
//   - Single retry on injection failure (FLOW_INJECT_RETRY_MS later)
//   - Pause/resume signal driven by the cursor-awareness layer (don't paste
//     into Spokn itself, hold during off-target focus shifts)
//
// Flush contract (used by send path + stop()): flush() resolves only when
// EVERY timer the queue controls has either fired or been cleared — not just
// when queue.length === 0. A coalesce timer that fires later would produce a
// fullReplace AFTER the send key has been pressed, which would be
// catastrophic.

import {
  FLOW_CORRECTION_COALESCE_MS,
  FLOW_INJECT_DELAY_MS,
  FLOW_INJECT_RETRY_MS,
  FLOW_SEND_POST_PASTE_MS,
} from "./flowConstants";
import type { FlowOp } from "./flowSessionBuffer";
import { flowLog, type FlowStateTag } from "./flowObservability";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface InjectionQueueDeps {
  invoke: Invoke;
  /** Returns true when injection should hold (Spokn focused / wrong app). */
  shouldHold: () => boolean;
  /** Subscribe to hold-state changes so the queue can resume promptly. */
  onHoldChange: (handler: () => void) => () => void;
  /** Called when a sendKey op successfully fires in the target app. */
  onSendOk?: (sourceId: string, key: string) => void;
  /** Called when a sendKey op fails despite retry. */
  onSendFail?: (sourceId: string, reason: string) => void;
  /**
   * Current FlowState at the moment the queue needs to log an event. Used
   * only in the `flow.injection_discarded` payload today; keep the getter
   * cheap — it runs synchronously inside `enqueue` on the hot path.
   */
  getFlowState: () => FlowStateTag;
  /**
   * Seeded from the startup Accessibility probe. When `"denied"` the queue
   * starts in the permission-blocked state: construction itself never emits
   * a discard event (nothing has been enqueued yet), but the first enqueue
   * attempt that follows is rejected and logged as `blockedEpisodeEntry =
   * "first"`. See plan Stage 4 — this is the startup-timing invariant.
   */
  initialAccessibilityStatus?: "granted" | "denied";
}

export interface InjectionQueue {
  enqueue(op: FlowOp, opts: { immediate: boolean; sourceId: string }): void;
  /** Drop everything pending. Called on Flow stop. */
  clear(): void;
  /** Number of ops waiting (for observability). */
  depth(): number;
  /** Resolves when the queue is fully drained AND every owned timer has fired
   *  or been cleared. Rejects after timeoutMs — callers that must not
   *  block indefinitely (e.g. stop()) supply a timeout; the send path waits
   *  with a long timeout since it defers rather than giving up. */
  flush(timeoutMs: number): Promise<void>;
  /**
   * Transition into the permission-blocked state.
   *
   *   1. Drains (discards) everything currently pending — queued ops, any
   *      armed coalesce timer.
   *   2. Emits ONE `flow.injection_discarded` event summarizing the batch.
   *      Skipped when the queue happens to be empty at the moment of
   *      suspension (nothing to log).
   *   3. Rejects every subsequent `enqueue` until `resumeFromPermissionBlock`
   *      is called. Each rejected enqueue emits its own
   *      `flow.injection_discarded` event (count = 1).
   *
   * Idempotent: calling while already suspended is a no-op. Safe to invoke
   * from any context, including concurrently with an in-flight drain.
   */
  suspendForPermissionBlock(): void;
  /**
   * Lift the suspension. **Does NOT replay previously discarded ops** —
   * discarded text stays discarded. New enqueues from this point forward
   * are accepted; the next transition back into the denied state begins a
   * fresh episode whose first event is marked `blockedEpisodeEntry =
   * "first"` again.
   */
  resumeFromPermissionBlock(): void;
  /** True while the queue is in the permission-blocked state. */
  isPermissionBlocked(): boolean;
}

interface QueuedItem {
  op: FlowOp;
  immediate: boolean;
  sourceId: string;
  enqueuedAt: number;
}

export function createInjectionQueue(deps: InjectionQueueDeps): InjectionQueue {
  const queue: QueuedItem[] = [];
  let running = false;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let coalesceCount = 0;

  // Permission-blocked state (Stage 4). Seeded from the startup probe via
  // `initialAccessibilityStatus` so the very first discard in a session is
  // unambiguously marked `"first"` — no race with a late-arriving probe.
  let permissionBlocked = deps.initialAccessibilityStatus === "denied";
  // Set true on the first discard event emitted within the current blocked
  // episode. Reset by `suspendForPermissionBlock` each time the queue
  // transitions into blocked state. Drives the `blockedEpisodeEntry` field.
  let firstDiscardEmittedThisEpisode = false;

  // Resolvers for any in-flight flush() awaiters — fired when the queue is
  // fully quiescent.
  const flushResolvers: Set<() => void> = new Set();

  // When the hold state changes (e.g. focus returns to target), kick the queue.
  const unsubscribe = deps.onHoldChange(() => {
    if (!deps.shouldHold()) void drain();
  });
  void unsubscribe; // retained closure; we never expose unsubscribe externally

  /** Character count represented by an op — what the user "lost" when
   *  discarded. `sendKey` / `noop` carry no text, so they count as 0. */
  function charsForOp(op: FlowOp): number {
    if (op.kind === "append") return op.text.length;
    if (op.kind === "fullReplace") return op.fullText.length;
    return 0;
  }

  function emitDiscard(count: number, queuedTextChars: number) {
    // Per plan: one event per batch (drain) or per rejected op; NEVER one
    // per op inside a drained batch.
    flowLog.injectionDiscarded({
      count,
      reason: "permission_blocked_accessibility",
      queuedTextChars,
      flowState: deps.getFlowState(),
      blockedEpisodeEntry: firstDiscardEmittedThisEpisode ? "subsequent" : "first",
    });
    firstDiscardEmittedThisEpisode = true;
  }

  function enqueue(op: FlowOp, opts: { immediate: boolean; sourceId: string }) {
    if (op.kind === "noop") return;

    if (permissionBlocked) {
      // Reject immediately. Emit a dedicated discard event so a debugger
      // can answer "why didn't that text paste?" without cross-referencing
      // logs. Dropped ops stay dropped — permission-recovery does not
      // replay them.
      emitDiscard(1, charsForOp(op));
      return;
    }

    if (op.kind === "fullReplace") {
      // Correction coalescing: if a fullReplace is already at the tail
      // (or buffered), replace its text with this newer op's text and re-arm.
      const tail = queue[queue.length - 1];
      if (tail && tail.op.kind === "fullReplace") {
        tail.op = op;
        coalesceCount += 1;
        scheduleCoalesce();
        return;
      }
      queue.push({ op, immediate: opts.immediate, sourceId: opts.sourceId, enqueuedAt: Date.now() });
      coalesceCount = 1;
      scheduleCoalesce();
      flowLog.queueEnqueue(opts.sourceId, queue.length, op.kind);
      return;
    }

    queue.push({ op, immediate: opts.immediate, sourceId: opts.sourceId, enqueuedAt: Date.now() });
    flowLog.queueEnqueue(opts.sourceId, queue.length, op.kind);
    void drain();
  }

  function scheduleCoalesce() {
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null;
      if (coalesceCount > 1) {
        flowLog.correctionCoalesced(coalesceCount, "fullReplace");
      }
      coalesceCount = 0;
      void drain();
    }, FLOW_CORRECTION_COALESCE_MS);
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        if (deps.shouldHold()) {
          flowLog.queuePaused("hold_signal");
          // Wait for hold to release; onHoldChange triggers another drain.
          break;
        }
        const head = queue[0]!;
        // If this is a fullReplace and the coalesce timer is still pending,
        // wait for it to finish so we don't paste twice.
        if (head.op.kind === "fullReplace" && coalesceTimer !== null) break;

        await injectOne(head);
        queue.shift();
      }
    } finally {
      running = false;
      maybeResolveFlush();
    }
  }

  function isQuiescent(): boolean {
    return queue.length === 0 && coalesceTimer === null && !running;
  }

  function maybeResolveFlush() {
    if (flushResolvers.size === 0) return;
    if (!isQuiescent()) return;
    const resolvers = Array.from(flushResolvers);
    flushResolvers.clear();
    for (const r of resolvers) r();
  }

  async function injectOne(item: QueuedItem) {
    const op = item.op;
    if (op.kind === "noop") return;

    if (op.kind === "sendKey") {
      // Extra settle so the prior paste is visibly landed before Enter fires.
      await sleep(FLOW_SEND_POST_PASTE_MS);
      flowLog.injectAttempt(item.sourceId, FLOW_SEND_POST_PASTE_MS, 1, op.kind);
      try {
        await deps.invoke("send_key", { key: op.key });
        flowLog.injectOk(item.sourceId, Date.now() - item.enqueuedAt, op.kind);
        flowLog.sendFired(item.sourceId, op.key, Date.now() - item.enqueuedAt);
        deps.onSendOk?.(item.sourceId, op.key);
        return;
      } catch (e) {
        const reason = String(e);
        flowLog.injectFailed(item.sourceId, 1, reason);
      }
      // Retry once
      await sleep(FLOW_INJECT_RETRY_MS);
      flowLog.injectAttempt(item.sourceId, FLOW_INJECT_RETRY_MS, 2, op.kind);
      try {
        await deps.invoke("send_key", { key: op.key });
        flowLog.injectOk(item.sourceId, Date.now() - item.enqueuedAt, op.kind);
        flowLog.sendFired(item.sourceId, op.key, Date.now() - item.enqueuedAt);
        deps.onSendOk?.(item.sourceId, op.key);
      } catch (e) {
        const reason = String(e);
        flowLog.injectFailed(item.sourceId, 2, reason);
        deps.onSendFail?.(item.sourceId, reason);
      }
      return;
    }

    const waitMs =
      op.kind === "append" && !item.immediate ? FLOW_INJECT_DELAY_MS : 0;
    if (waitMs > 0) await sleep(waitMs);

    const cmdName = op.kind === "append" ? "inject_text" : "inject_full_replace";
    const args =
      op.kind === "append"
        ? { text: op.text }
        : { text: op.fullText };

    flowLog.injectAttempt(item.sourceId, waitMs, 1, op.kind);
    try {
      await deps.invoke(cmdName, args);
      flowLog.injectOk(item.sourceId, Date.now() - item.enqueuedAt, op.kind);
      return;
    } catch (e) {
      const reason = String(e);
      flowLog.injectFailed(item.sourceId, 1, reason);
    }

    // Retry once
    await sleep(FLOW_INJECT_RETRY_MS);
    flowLog.injectAttempt(item.sourceId, FLOW_INJECT_RETRY_MS, 2, op.kind);
    try {
      await deps.invoke(cmdName, args);
      flowLog.injectOk(item.sourceId, Date.now() - item.enqueuedAt, op.kind);
    } catch (e) {
      flowLog.injectFailed(item.sourceId, 2, String(e));
    }
  }

  function clear() {
    queue.length = 0;
    if (coalesceTimer) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    coalesceCount = 0;
    // Resolve any flush awaiters — after clear() the queue is quiescent by
    // definition. Rejected awaiters (stopped mid-wait) are better than hung.
    maybeResolveFlush();
  }

  function suspendForPermissionBlock() {
    if (permissionBlocked) return; // Idempotent — no double-drain.
    permissionBlocked = true;
    // Fresh episode: the next discard (this drain OR, if queue is empty,
    // the next rejected enqueue) becomes `blockedEpisodeEntry = "first"`.
    firstDiscardEmittedThisEpisode = false;

    const drainedCount = queue.length;
    const drainedChars = queue.reduce((acc, q) => acc + charsForOp(q.op), 0);
    queue.length = 0;
    if (coalesceTimer) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    coalesceCount = 0;

    if (drainedCount > 0) {
      emitDiscard(drainedCount, drainedChars);
    }
    maybeResolveFlush();
  }

  function resumeFromPermissionBlock() {
    // Idempotent: resuming a non-blocked queue is a safe no-op.
    permissionBlocked = false;
    // Intentionally do NOT reset `firstDiscardEmittedThisEpisode` here —
    // it's re-seeded to `false` by `suspendForPermissionBlock` the next
    // time the queue enters a blocked episode. Discarded ops are NOT
    // replayed; new enqueues start fresh.
    maybeResolveFlush();
  }

  function flush(timeoutMs: number): Promise<void> {
    if (isQuiescent()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        flushResolvers.delete(resolver);
        reject(new Error("flush_timeout"));
      }, timeoutMs);
      const resolver = () => {
        clearTimeout(timer);
        resolve();
      };
      flushResolvers.add(resolver);
    });
  }

  return {
    enqueue,
    clear,
    depth: () => queue.length,
    flush,
    suspendForPermissionBlock,
    resumeFromPermissionBlock,
    isPermissionBlocked: () => permissionBlocked,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
