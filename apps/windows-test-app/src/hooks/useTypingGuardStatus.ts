// Stage 7 — React hook that surfaces the Rust-side typing guard install
// status published by flowTypingGuard. Used by LeftPanel + DebugPanel to
// render the "Typing awareness" status line.
//
// Implementation notes:
//   - The authoritative status is owned by `flowObservability`'s module-
//     level store. `flowTypingGuard.start()` calls `get_typing_guard_status`
//     exactly once at bootstrap and pushes the result into that store; this
//     hook subscribes to updates via `subscribeTypingGuardStatus`.
//   - No direct Tauri invoke here — doubling up on the probe would waste an
//     IPC round-trip and introduce ordering races between the hook and the
//     guard's own bootstrap.
//   - Returns `"unknown"` until the guard has probed; UI should render
//     nothing in that state (see LeftPanel consumer).

import { useEffect, useState } from "react";
import {
  getTypingGuardStatus,
  subscribeTypingGuardStatus,
  type TypingGuardStatus,
} from "../lib/flowObservability";

export function useTypingGuardStatus(): TypingGuardStatus {
  const [status, setStatus] = useState<TypingGuardStatus>(() =>
    getTypingGuardStatus(),
  );
  useEffect(() => subscribeTypingGuardStatus(setStatus), []);
  return status;
}
