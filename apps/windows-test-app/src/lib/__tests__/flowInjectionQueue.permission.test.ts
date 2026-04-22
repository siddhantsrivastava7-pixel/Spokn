// Stage 4 plumbing coverage for the injection queue's permission-blocked
// path. Platform-agnostic — the queue doesn't care whether the block came
// from Windows, macOS, or a unit test; it only cares about its own state.
//
// What we verify:
//   - Startup-timing invariant: seeding the queue with `"denied"` puts it
//     in the blocked state immediately, with no event emitted at
//     construction (nothing has been enqueued yet).
//   - First enqueue after a fresh block is marked `"first"`; every
//     subsequent one is `"subsequent"`.
//   - suspendForPermissionBlock drains + emits a single batched event
//     covering the drained ops; idempotent on repeat calls.
//   - resumeFromPermissionBlock does NOT replay previously discarded ops;
//     it only lifts the gate for new enqueues.
//   - `flowState` in the event payload reflects the getter's current value
//     at emission time.
//   - `sendKey` / `noop` ops count as zero chars (they carry no user text).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectionQueue, type InjectionQueue, type InjectionQueueDeps } from "../flowInjectionQueue";
import type { FlowOp } from "../flowSessionBuffer";
import type { FlowStateTag } from "../flowObservability";

// ── Helpers ──────────────────────────────────────────────────────────────────

function appendOp(text: string): FlowOp {
  return { kind: "append", text, appendedSegmentId: "seg-" + text.length };
}

function fullReplaceOp(text: string): FlowOp {
  return { kind: "fullReplace", fullText: text };
}

function sendOp(): FlowOp {
  return { kind: "sendKey", key: "Enter", sourceId: "send-1" };
}

function noopOp(): FlowOp {
  return { kind: "noop", reason: "empty" };
}

interface DiscardEvent {
  count: number;
  reason: string;
  queuedTextChars: number;
  flowState: FlowStateTag;
  blockedEpisodeEntry: "first" | "subsequent";
}

/**
 * Subscribes to `console.warn` and returns every parsed
 * `flow.injection_discarded` event. Uses the log line's field=value format
 * produced by flowObservability's `fmt()`.
 */
function captureDiscardEvents(): { events: DiscardEvent[]; restore: () => void } {
  const events: DiscardEvent[] = [];
  const orig = console.warn;
  console.warn = (msg: unknown, ...rest: unknown[]) => {
    const line = String(msg);
    if (!line.includes("injection_discarded")) {
      orig.call(console, msg as string, ...(rest as string[]));
      return;
    }
    events.push(parseLine(line));
  };
  return {
    events,
    restore: () => {
      console.warn = orig;
    },
  };
}

/** Parse one `[flow] injection_discarded k=v ...` line into a DiscardEvent. */
function parseLine(line: string): DiscardEvent {
  const out: Record<string, string | number> = {};
  // Matches k="v" for strings and k=v for numbers; values have no whitespace.
  const re = /(\w+)=("([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const key = m[1]!;
    const rawNumber = m[4];
    const stringVal = m[3];
    if (stringVal !== undefined) {
      out[key] = stringVal;
    } else if (rawNumber !== undefined) {
      const asNum = Number(rawNumber);
      out[key] = Number.isFinite(asNum) ? asNum : rawNumber;
    }
  }
  return {
    count: Number(out.count),
    reason: String(out.reason),
    queuedTextChars: Number(out.queuedTextChars),
    flowState: String(out.flowState) as FlowStateTag,
    blockedEpisodeEntry: String(out.blockedEpisodeEntry) as "first" | "subsequent",
  };
}

function makeDeps(overrides: Partial<InjectionQueueDeps> = {}): InjectionQueueDeps {
  const base: InjectionQueueDeps = {
    invoke: vi.fn(async () => undefined),
    shouldHold: () => false,
    onHoldChange: () => () => {},
    getFlowState: () => "recording",
    ...overrides,
  };
  return base;
}

function makeQueue(overrides: Partial<InjectionQueueDeps> = {}): {
  q: InjectionQueue;
  deps: InjectionQueueDeps;
  events: DiscardEvent[];
  restore: () => void;
} {
  const { events, restore } = captureDiscardEvents();
  const deps = makeDeps(overrides);
  const q = createInjectionQueue(deps);
  return { q, deps, events, restore };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("flowInjectionQueue — permission-blocked gate", () => {
  let cleanups: Array<() => void> = [];
  beforeEach(() => {
    cleanups.forEach((c) => c());
    cleanups = [];
  });

  it("starts in the blocked state when seeded with initialAccessibilityStatus=denied", () => {
    const { q, events, restore } = makeQueue({ initialAccessibilityStatus: "denied" });
    cleanups.push(restore);
    // Startup-timing invariant: no event at construction — nothing's been
    // enqueued yet. The gate is armed for the first real enqueue attempt.
    expect(events).toHaveLength(0);
    expect(q.isPermissionBlocked()).toBe(true);
  });

  it("marks the first rejected enqueue as 'first' and subsequent ones as 'subsequent'", () => {
    const { q, events, restore } = makeQueue({ initialAccessibilityStatus: "denied" });
    cleanups.push(restore);

    q.enqueue(appendOp("hello"), { immediate: false, sourceId: "u1" });
    q.enqueue(appendOp("world!"), { immediate: false, sourceId: "u2" });
    q.enqueue(appendOp("again"), { immediate: false, sourceId: "u3" });

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      count: 1,
      reason: "permission_blocked_accessibility",
      queuedTextChars: 5, // "hello"
      blockedEpisodeEntry: "first",
    });
    expect(events[1]!.blockedEpisodeEntry).toBe("subsequent");
    expect(events[2]!.blockedEpisodeEntry).toBe("subsequent");
  });

  it("drains pending ops and emits a single 'first' event covering the whole batch on suspend", () => {
    const { q, events, restore } = makeQueue({
      invoke: vi.fn(async () => new Promise((r) => setTimeout(r, 1000))), // stall the worker
    });
    cleanups.push(restore);

    q.enqueue(appendOp("a"), { immediate: false, sourceId: "u1" });
    q.enqueue(appendOp("bc"), { immediate: false, sourceId: "u2" });
    q.enqueue(appendOp("def"), { immediate: false, sourceId: "u3" });

    q.suspendForPermissionBlock();

    expect(q.isPermissionBlocked()).toBe(true);
    // At least one event covering the drained tail. The head ("a") may
    // already be in flight via the invoke stall; it doesn't appear in the
    // drained batch. Remaining tail ops (at least "bc" and "def") do.
    expect(events.length).toBe(1);
    expect(events[0]!.blockedEpisodeEntry).toBe("first");
    expect(events[0]!.reason).toBe("permission_blocked_accessibility");
    expect(events[0]!.count).toBeGreaterThanOrEqual(2);
    expect(events[0]!.queuedTextChars).toBeGreaterThanOrEqual(5); // "bc" + "def"
  });

  it("does not emit an event when suspending an already-empty queue", () => {
    const { q, events, restore } = makeQueue();
    cleanups.push(restore);
    q.suspendForPermissionBlock();
    expect(events).toHaveLength(0);
    expect(q.isPermissionBlocked()).toBe(true);
    // The next rejected enqueue is still marked 'first' — the episode
    // begins with whatever event fires first, even if it's the first reject.
    q.enqueue(appendOp("late"), { immediate: false, sourceId: "u1" });
    expect(events).toHaveLength(1);
    expect(events[0]!.blockedEpisodeEntry).toBe("first");
  });

  it("suspendForPermissionBlock is idempotent — second call is a no-op", () => {
    const { q, events, restore } = makeQueue({
      invoke: vi.fn(async () => new Promise((r) => setTimeout(r, 1000))),
    });
    cleanups.push(restore);
    q.enqueue(appendOp("xyz"), { immediate: false, sourceId: "u1" });
    q.enqueue(appendOp("tail"), { immediate: false, sourceId: "u2" });

    q.suspendForPermissionBlock();
    const firstCount = events.length;
    q.suspendForPermissionBlock();
    q.suspendForPermissionBlock();
    expect(events).toHaveLength(firstCount);
  });

  it("resumeFromPermissionBlock does NOT replay previously discarded ops", async () => {
    const invoke = vi.fn(async () => undefined);
    const { q, events, restore } = makeQueue({
      invoke,
      initialAccessibilityStatus: "denied",
    });
    cleanups.push(restore);

    q.enqueue(appendOp("lost-1"), { immediate: false, sourceId: "u1" });
    q.enqueue(appendOp("lost-2"), { immediate: false, sourceId: "u2" });
    expect(events).toHaveLength(2);

    q.resumeFromPermissionBlock();

    // Permission was restored — but the queue must stay quiet. No ops are
    // pending; nothing gets replayed. Give the microtask loop a chance to
    // catch any stragglers.
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();

    // New enqueues now go through normally. `immediate: true` skips the
    // FLOW_INJECT_DELAY_MS (150ms) wait that the non-immediate path takes,
    // so the test doesn't need to sleep for that long.
    q.enqueue(appendOp("new"), { immediate: true, sourceId: "u3" });
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).toHaveBeenCalledWith("inject_text", { text: "new" });
    // No additional discard events.
    expect(events).toHaveLength(2);
  });

  it("resume + re-suspend starts a fresh episode marked 'first'", async () => {
    const { q, events, restore } = makeQueue({ initialAccessibilityStatus: "denied" });
    cleanups.push(restore);

    q.enqueue(appendOp("a"), { immediate: false, sourceId: "u1" });
    q.enqueue(appendOp("b"), { immediate: false, sourceId: "u2" });
    expect(events.map((e) => e.blockedEpisodeEntry)).toEqual(["first", "subsequent"]);

    q.resumeFromPermissionBlock();
    q.suspendForPermissionBlock();
    // Second episode, queue is empty → no event yet.
    expect(events).toHaveLength(2);

    q.enqueue(appendOp("c"), { immediate: false, sourceId: "u3" });
    expect(events).toHaveLength(3);
    // Fresh episode → "first" again, not "subsequent".
    expect(events[2]!.blockedEpisodeEntry).toBe("first");
  });

  it("captures the current FlowState in the event payload via the getter", () => {
    let currentFlow: FlowStateTag = "idle";
    const { q, events, restore } = makeQueue({
      initialAccessibilityStatus: "denied",
      getFlowState: () => currentFlow,
    });
    cleanups.push(restore);

    currentFlow = "quiet";
    q.enqueue(appendOp("x"), { immediate: false, sourceId: "u1" });
    expect(events[0]!.flowState).toBe("quiet");

    currentFlow = "transcribing";
    q.enqueue(appendOp("y"), { immediate: false, sourceId: "u2" });
    expect(events[1]!.flowState).toBe("transcribing");
  });

  it("counts 0 chars for sendKey and noop ops (they carry no user text)", () => {
    const { q, events, restore } = makeQueue({ initialAccessibilityStatus: "denied" });
    cleanups.push(restore);

    q.enqueue(sendOp(), { immediate: false, sourceId: "u1" });
    expect(events).toHaveLength(1);
    expect(events[0]!.queuedTextChars).toBe(0);

    // noop is silently dropped at the top of enqueue() — not a discard
    // event, not a queued op. Assert the event count did not increase.
    q.enqueue(noopOp(), { immediate: false, sourceId: "u2" });
    expect(events).toHaveLength(1);
  });

  it("includes fullReplace char count in the queuedTextChars for rejected enqueues", () => {
    const { q, events, restore } = makeQueue({ initialAccessibilityStatus: "denied" });
    cleanups.push(restore);
    q.enqueue(fullReplaceOp("hello world"), { immediate: false, sourceId: "u1" });
    expect(events[0]!.queuedTextChars).toBe("hello world".length);
  });

  it("starts in the normal state when initialAccessibilityStatus is granted (default)", async () => {
    const invoke = vi.fn(async () => undefined);
    const { q, events, restore } = makeQueue({ invoke });
    cleanups.push(restore);
    expect(q.isPermissionBlocked()).toBe(false);
    q.enqueue(appendOp("ok"), { immediate: true, sourceId: "u1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).toHaveBeenCalledWith("inject_text", { text: "ok" });
    expect(events).toHaveLength(0);
  });
});
