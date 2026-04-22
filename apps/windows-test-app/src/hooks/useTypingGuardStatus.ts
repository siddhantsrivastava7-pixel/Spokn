// Stage 7 — React hook that surfaces the Rust-side typing guard install
// status. Used by LeftPanel + DebugPanel to render the "Typing awareness"
// status line.
//
// Implementation notes:
//   - The authoritative status is owned by `flowObservability`'s module-
//     level store.
//   - On first mount, this hook fires `probeTypingGuardStatusOnce` so the
//     status resolves at app startup — NOT gated on Flow Mode starting.
//     Without this, the "Typing awareness: Limited" hint would stay hidden
//     during exactly the window when the user is deciding whether to grant
//     Input Monitoring ahead of first Flow use.
//   - The probe is idempotent at module level; multiple mounts of this
//     hook (e.g. LeftPanel + DebugPanel both rendering it) only trigger
//     one IPC round-trip.
//   - Returns `"unknown"` until the probe resolves; UI renders nothing in
//     that state (see PlatformStatus consumer).

import { useEffect, useState } from "react";
import {
  getTypingGuardStatus,
  probeTypingGuardStatusOnce,
  subscribeTypingGuardStatus,
  type TypingGuardStatus,
} from "../lib/flowObservability";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function useTypingGuardStatus(): TypingGuardStatus {
  const [status, setStatus] = useState<TypingGuardStatus>(() =>
    getTypingGuardStatus(),
  );
  useEffect(() => {
    const unsubscribe = subscribeTypingGuardStatus(setStatus);
    if (isTauri) {
      // Dynamic import keeps the browser dev fallback lightweight.
      void import("@tauri-apps/api/core").then(({ invoke }) => {
        void probeTypingGuardStatusOnce(invoke);
      });
    }
    return unsubscribe;
  }, []);
  return status;
}
