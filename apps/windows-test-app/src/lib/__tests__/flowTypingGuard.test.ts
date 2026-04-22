import { describe, expect, it, vi } from "vitest";
import { createTypingGuard } from "../flowTypingGuard";

function makeGuardWithMsSinceLastKey(msSinceLastKey: number) {
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === "get_last_keystroke_ms_ago") return msSinceLastKey;
    return undefined;
  });
  const guard = createTypingGuard({ invoke });
  return { guard, invoke };
}

describe("typingGuard.evaluate — typing NOT active", () => {
  it("never suppresses when no keystrokes have been observed", () => {
    const { guard } = makeGuardWithMsSinceLastKey(Number.POSITIVE_INFINITY);
    // start() not called → lastKeystroke remains at init (infinity)
    const v = guard.evaluate(
      { rmsDb: -60, speechRatio: 0.1, longestVoicedRunMs: 50 },
      2,
      200,
    );
    expect(v.suppress).toBe(false);
  });
});

describe("typingGuard.evaluate — typing active", () => {
  it("drops on low RMS", async () => {
    const { guard } = makeGuardWithMsSinceLastKey(100);
    guard.start();
    await new Promise((r) => setTimeout(r, 10));
    const v = guard.evaluate(
      { rmsDb: -50, speechRatio: 0.8, longestVoicedRunMs: 400 },
      50,
      800,
    );
    guard.stop();
    expect(v).toEqual({ suppress: true, reason: "rms" });
  });

  it("drops on low speech ratio", async () => {
    const { guard } = makeGuardWithMsSinceLastKey(100);
    guard.start();
    await new Promise((r) => setTimeout(r, 10));
    const v = guard.evaluate(
      { rmsDb: -30, speechRatio: 0.2, longestVoicedRunMs: 400 },
      50,
      800,
    );
    guard.stop();
    expect(v.reason).toBe("speech_ratio");
  });

  it("drops on short continuous voiced run (onset)", async () => {
    const { guard } = makeGuardWithMsSinceLastKey(100);
    guard.start();
    await new Promise((r) => setTimeout(r, 10));
    const v = guard.evaluate(
      { rmsDb: -20, speechRatio: 0.9, longestVoicedRunMs: 100 },
      50,
      800,
    );
    guard.stop();
    expect(v.reason).toBe("onset");
  });

  it("passes a clear strong onset even during typing", async () => {
    const { guard } = makeGuardWithMsSinceLastKey(100);
    guard.start();
    await new Promise((r) => setTimeout(r, 10));
    const v = guard.evaluate(
      { rmsDb: -20, speechRatio: 0.9, longestVoicedRunMs: 800 },
      50,
      1500,
    );
    guard.stop();
    expect(v.suppress).toBe(false);
  });
});
