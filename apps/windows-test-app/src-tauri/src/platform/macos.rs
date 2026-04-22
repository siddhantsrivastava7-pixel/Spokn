// macOS platform bridges — Stage 1 stubs.
//
// These match the Windows API surface so the rest of the codebase can call
// `platform::read_active_window_info(...)` etc. without cfg gates. Real impls
// land in later stages:
//   - Stage 6: read_active_window_info via NSWorkspace + AX
//   - Stage 7: keyboard_activity via CGEventTap
//   - Stage 8: read_focused_element_text_impl via AX (stretch, may be deferred)
//
// Stubs return the same safe defaults that the Windows build's
// `#[cfg(not(windows))]` fallbacks used to return, so TS-side consumers
// continue to degrade gracefully (no active window info → no auto-context
// inference; `u64::MAX` since last keystroke → typing guard no-ops).

use super::ActiveWindowInfo;

pub fn read_active_window_info(_self_titles: &[String]) -> ActiveWindowInfo {
    // Stage 6 will populate process_name, bundle_id, localized_name,
    // window_title via NSWorkspace.frontmostApplication + AX.
    ActiveWindowInfo::default()
}

pub fn read_focused_element_text_impl() -> Result<String, String> {
    // Stage 8 (stretch) will implement this via AXUIElementCopyAttributeValue.
    // Until then, returning an error keeps flowExternalEditCapture's error
    // path ("skip reconciliation") in effect on macOS.
    Err("read_focused_text is not yet implemented on macOS".into())
}

/// Stage 4 stub. Returns `"granted"` unconditionally so the full TS
/// permission plumbing (queue suspend/resume, discard events, banner,
/// overlay `blocked` state) can be developed and tested before Apple
/// hardware is available. Stage 6 replaces this with a real
/// `AXIsProcessTrusted()` probe via the AX framework — at that point a
/// user on macOS who hasn't granted Accessibility will see the plumbing
/// wire itself up automatically.
pub fn check_accessibility_permission() -> &'static str {
    "granted"
}

pub mod keyboard_activity {
    // Stage 7 replaces these with a CGEventTap-backed implementation.
    // `u64::MAX` is the "never observed a keystroke" sentinel that the
    // TS typing guard already handles.
    pub fn install() {}

    pub fn ms_since_last() -> u64 {
        u64::MAX
    }
}
