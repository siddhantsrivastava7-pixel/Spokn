// Stage 7 — verifies the startup typing-guard probe behaves correctly.
//
// Motivation: the probe must fire at app boot (not only when Flow Mode
// starts). Otherwise the "Typing awareness: Limited — grant Input
// Monitoring …" hint stays hidden during the exact window when the user
// could grant the permission ahead of first use.
//
// Uses `vi.resetModules()` between tests to get a fresh copy of
// flowObservability — the `typingGuardProbed` latch lives at module
// scope and one successful probe pins it for the session.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function freshModule() {
  vi.resetModules();
  return await import("../flowObservability");
}

describe("probeTypingGuardStatusOnce", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("invokes the Rust command and publishes an active status", async () => {
    const mod = await freshModule();
    const invoke = vi.fn(async () => "active");

    expect(mod.getTypingGuardStatus()).toBe("unknown");
    await mod.probeTypingGuardStatusOnce(invoke);

    expect(invoke).toHaveBeenCalledWith("get_typing_guard_status");
    expect(mod.getTypingGuardStatus()).toBe("active");
    // No degraded event on the active path.
    expect(
      warnSpy.mock.calls.some((args) =>
        String(args[0]).includes("typing_guard_degraded"),
      ),
    ).toBe(false);
  });

  it("publishes degraded status and emits a single typing_guard_degraded event", async () => {
    const mod = await freshModule();
    const invoke = vi.fn(async () => "degraded_no_permission");

    await mod.probeTypingGuardStatusOnce(invoke);

    expect(mod.getTypingGuardStatus()).toBe("degraded_no_permission");
    const degradedEvents = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("typing_guard_degraded"),
    );
    expect(degradedEvents).toHaveLength(1);
  });

  it("is idempotent — repeat calls do not re-invoke the command", async () => {
    const mod = await freshModule();
    const invoke = vi.fn(async () => "degraded_no_permission");

    await mod.probeTypingGuardStatusOnce(invoke);
    await mod.probeTypingGuardStatusOnce(invoke);
    await mod.probeTypingGuardStatusOnce(invoke);

    expect(invoke).toHaveBeenCalledTimes(1);
    // Status transition only notifies once → only one degraded event.
    const degradedEvents = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("typing_guard_degraded"),
    );
    expect(degradedEvents).toHaveLength(1);
  });

  it("leaves status 'unknown' and does NOT latch when invoke returns undefined", async () => {
    // Browser dev fallback path — `invoke` is a no-op returning undefined.
    // Without this non-latching behavior, a late-arriving Tauri bridge
    // (e.g. dev HMR) would never get a second probe attempt.
    const mod = await freshModule();
    const invoke = vi.fn(async () => undefined);

    await mod.probeTypingGuardStatusOnce(invoke);
    expect(mod.getTypingGuardStatus()).toBe("unknown");

    // Second call with a real response should resolve normally.
    const invoke2 = vi.fn(async () => "active");
    await mod.probeTypingGuardStatusOnce(invoke2);
    expect(mod.getTypingGuardStatus()).toBe("active");
  });

  it("stamps typingGuardStatus into emitted log lines once probed", async () => {
    const mod = await freshModule();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn(async () => "active");

    // Before probe — no stamp.
    mod.flowLog.sendFired("u1", "Enter", 42);
    const beforeLine = String(infoSpy.mock.calls[0]![0]);
    expect(beforeLine).not.toContain("typingGuardStatus=");

    await mod.probeTypingGuardStatusOnce(invoke);

    mod.flowLog.sendFired("u2", "Enter", 42);
    const afterLine = String(infoSpy.mock.calls[1]![0]);
    expect(afterLine).toContain('typingGuardStatus="active"');

    infoSpy.mockRestore();
  });
});
