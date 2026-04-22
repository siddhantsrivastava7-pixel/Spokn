// Probes macOS Accessibility permission at startup and on focus regain, and
// subscribes to `permission:accessibility` events emitted by the Rust side
// (added in Stage 6 when the real `AXIsProcessTrusted()` probe lands). The
// hook returns a single synchronous status value that downstream consumers
// — the injection queue, the app-level banner, the overlay state — can
// branch on.
//
// Windows behavior: Rust's `check_accessibility_permission` is hardcoded to
// `"granted"`, so the initial probe resolves immediately to `"granted"` and
// no events fire. The whole permission pipeline remains inert on Windows
// while being identical in shape to the macOS path — one code path, two
// platforms, no cfg branches in the consumer.
//
// Startup-timing invariant (plan §Stage 4): the flag MUST be seeded before
// the injection queue is constructed. This hook returns `"probing"` while
// the first probe is in flight so callers can gate queue creation on a
// definite answer. If the probe itself fails for any unexpected reason, the
// hook resolves to `"denied"` (never stays in `"probing"`), keeping the
// first real discard event unambiguously marked `"first"`.

import { useEffect, useRef, useState } from "react";

const isTauri = "__TAURI_INTERNALS__" in window;

/**
 * Synchronous snapshot of the app's Accessibility permission state.
 *
 * - `"probing"`    — initial probe in flight. Flow Mode should refuse to
 *                    start, and the injection queue should not yet be
 *                    constructed. Typically lasts <50ms in normal runs.
 * - `"granted"`    — text injection will succeed. Normal operation.
 * - `"denied"`     — text injection will fail. Show the permission-blocked
 *                    banner, switch the overlay to the `blocked` variant,
 *                    suspend the injection queue.
 *
 * Note: `"unknown"` is intentionally NOT part of this union. Probe failures
 * collapse to `"denied"` so every callsite can exhaustively handle three
 * states without a fallback branch.
 */
export type AccessibilityStatus = "probing" | "granted" | "denied";

/**
 * Narrow the nuanced `AccessibilityStatus` to the two-state value the queue
 * actually cares about (`granted` vs `denied`). `"probing"` collapses to
 * `"granted"` because the caller must not have constructed the queue at all
 * while probing; this helper is only called after `probing` has resolved.
 */
export function toQueueStatus(
  status: AccessibilityStatus,
): "granted" | "denied" {
  return status === "denied" ? "denied" : "granted";
}

export interface UseAccessibilityPermissionReturn {
  /** Current snapshot. Re-renders downstream on every transition. */
  status: AccessibilityStatus;
  /** True once the initial probe has resolved (whether granted or denied). */
  resolved: boolean;
  /**
   * Trigger a fresh probe. Useful after the user has visited System Settings
   * and returned to Spokn — the window-focus listener already does this
   * automatically, but callers can re-probe explicitly (e.g. from a "check
   * again" button in the banner).
   */
  reprobe: () => void;
}

type RustStatusPayload = "granted" | "denied";

function coerceStatus(value: unknown): RustStatusPayload {
  // Treat any non-string or unknown token as "denied" so we never serve a
  // silently-wrong "granted" to the queue. Matches plan §Stage 4 — probe
  // failures collapse to denied.
  if (typeof value !== "string") return "denied";
  return value === "granted" ? "granted" : "denied";
}

export function useAccessibilityPermission(): UseAccessibilityPermissionReturn {
  const [status, setStatus] = useState<AccessibilityStatus>(
    // In non-Tauri contexts (browser dev, jsdom tests) the permission gate
    // is meaningless — resolve synchronously to "granted" so the queue wires
    // up normally. A real denial can only come from the Tauri command.
    isTauri ? "probing" : "granted",
  );
  const [resolved, setResolved] = useState(!isTauri);
  const probeInFlightRef = useRef(false);

  async function runProbe() {
    if (!isTauri) return;
    if (probeInFlightRef.current) return;
    probeInFlightRef.current = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke("check_accessibility_permission");
      setStatus(coerceStatus(raw));
    } catch {
      // Rust failure or transport error → treat as denied. Never leave the
      // hook parked in "probing" — that would block Flow Mode forever and
      // mask real breakage.
      setStatus("denied");
    } finally {
      setResolved(true);
      probeInFlightRef.current = false;
    }
  }

  // Initial probe + event subscription. Runs exactly once; reprobe() is
  // the only way to re-trigger a probe from outside.
  useEffect(() => {
    void runProbe();

    if (!isTauri) return;

    let unlistenEvent: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;

    // Push notifications from Rust — wired up in Stage 6 when macOS AX probe
    // becomes real. Shape is identical to the invoke return value so we can
    // reuse `coerceStatus` directly.
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<string>("permission:accessibility", (e) => {
        setStatus(coerceStatus(e.payload));
        setResolved(true);
      }).then((fn) => {
        unlistenEvent = fn;
      });
    });

    // Re-probe when the user returns to Spokn — common flow after granting
    // permission in System Settings on macOS. The Rust push-event path is
    // the primary notification channel; this is a belt-and-suspenders backup
    // for cases where the OS doesn't fire an event.
    const onFocus = () => {
      void runProbe();
    };
    window.addEventListener("focus", onFocus);
    unlistenFocus = () => window.removeEventListener("focus", onFocus);

    return () => {
      unlistenEvent?.();
      unlistenFocus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status,
    resolved,
    reprobe: () => void runProbe(),
  };
}
