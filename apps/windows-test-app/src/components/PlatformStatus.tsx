// Stage 7 — read-only typing-guard status line.
//
// Rendered as a compact hint under Flow Mode in LeftPanel and again in
// DebugPanel. Hidden on Windows — the WH_KEYBOARD_LL hook installs
// unconditionally and there's no actionable permission surface, so
// surfacing the status would be noise. Also hidden while `"unknown"`
// (status unresolved, nothing to say yet) or `"inactive_platform_stub"`
// (dev-only platforms with no hook).
//
// The Rust side returns `"active"` on both platforms when the hook is up,
// so we can't distinguish them from the status string alone — fall back to
// a userAgent sniff for the only OS that actually needs this UI.

import { useTypingGuardStatus } from "../hooks/useTypingGuardStatus";

interface Props {
  /** "compact" (LeftPanel) trims the prose; "detailed" (DebugPanel) spells it out. */
  variant?: "compact" | "detailed";
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

export function PlatformStatus({ variant = "compact" }: Props) {
  const status = useTypingGuardStatus();

  if (!IS_MAC) return null;
  if (status === "inactive_platform_stub" || status === "unknown") {
    return null;
  }

  const isActive = status === "active";
  const label =
    variant === "compact"
      ? isActive
        ? "Typing awareness: Active"
        : "Typing awareness: Limited — grant Input Monitoring in System Settings → Privacy → Input Monitoring for better Flow Mode behavior while typing"
      : isActive
        ? "Typing awareness: Active (CGEventTap installed; keystrokes observed for Flow Mode cooldown)"
        : "Typing awareness: Limited (Input Monitoring not granted — typing-cooldown gate is disabled; Flow Mode still transcribes)";

  return (
    <div
      className="platform-status"
      data-status={status}
      style={{
        marginTop: 8,
        fontSize: 10,
        lineHeight: 1.45,
        fontFamily: "var(--font-mono)",
        color: isActive ? "var(--text-4)" : "var(--warn, #c08b17)",
      }}
    >
      {label}
    </div>
  );
}
