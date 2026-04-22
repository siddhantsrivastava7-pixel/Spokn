// Platform abstraction for Spokn's OS-specific bridges.
//
// Per-OS impls live in sibling modules (`windows.rs`, `macos.rs`) and are
// re-exported through this file so callers in `lib.rs` can write
// `platform::read_active_window_info(...)` without cfg gates scattered across
// the command surface.
//
// Layout:
//   - Windows: full impls (low-level keyboard hook, foreground window, UIA)
//   - macOS:   stubs that match the API surface; real impls land in later
//              stages (Stage 6 active window, Stage 7 typing guard, Stage 8
//              focused text). Stubs return safe defaults so the TS layer
//              degrades to "no typing detected" / "no active window info"
//              without crashing.
//   - Other:   same shape as macOS stubs — used only for non-shipping dev
//              builds on Linux, etc.

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
pub use windows::{
    check_accessibility_permission, keyboard_activity, read_active_window_info,
    read_focused_element_text_impl,
};

#[cfg(target_os = "macos")]
pub use macos::{
    check_accessibility_permission, keyboard_activity, read_active_window_info,
    read_focused_element_text_impl,
};

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod stub {
    use super::ActiveWindowInfo;

    pub fn read_active_window_info(_self_titles: &[String]) -> ActiveWindowInfo {
        ActiveWindowInfo::default()
    }

    pub fn read_focused_element_text_impl() -> Result<String, String> {
        Err("read_focused_text is not supported on this platform".into())
    }

    pub fn check_accessibility_permission() -> &'static str {
        // Dev-only platforms have no equivalent gate; the app behaves as if
        // injection is allowed. Frontend still respects the value — safe to
        // return "granted" so Flow Mode works during cross-platform dev.
        "granted"
    }

    pub mod keyboard_activity {
        pub fn install() {}
        pub fn ms_since_last() -> u64 {
            u64::MAX
        }
        /// Dev-only platforms never install a hook; surface the sentinel
        /// status so the TS guard degrades to "no typing detected" without
        /// any UI surfacing.
        pub fn status() -> &'static str {
            "inactive_platform_stub"
        }
    }
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub use stub::{
    check_accessibility_permission, keyboard_activity, read_active_window_info,
    read_focused_element_text_impl,
};

// ── Cross-platform types ──────────────────────────────────────────────────────

/// Foreground-window metadata surfaced to the TS Flow Mode layer.
///
/// `process_name` is the back-compat field that existing Windows rule regexes
/// match against — executable base name on Windows ("chrome.exe"), localized
/// app name on macOS ("Google Chrome"). The dedicated fields below are the
/// canonical identifiers for new rule tables.
#[derive(serde::Serialize, Default, Clone)]
pub struct ActiveWindowInfo {
    /// Windows: executable base name (e.g. `"chrome.exe"`).
    /// macOS:   localized app name (fallback for existing match regexes).
    pub process_name: String,

    /// macOS: `NSRunningApplication.bundleIdentifier` (e.g. `"com.google.Chrome"`).
    /// Windows: empty string.
    /// **Prefer this for new matching rules** — stable, language-independent.
    pub bundle_id: String,

    /// macOS: `NSRunningApplication.localizedName` (e.g. `"Google Chrome"`).
    /// Windows: empty string.
    /// **Never use for matching logic** — localized names vary by the user's
    /// system language ("Mail" / "Courrier" / "メール"). Logs and debug UI only.
    pub localized_name: String,

    /// Focused-window title. On macOS this requires Accessibility permission.
    /// Always a string; never null and never omitted from the JSON payload.
    /// Returns `""` on any failure path (no foreground app, permission denied,
    /// AX attribute missing, non-string value, etc.) — TS side treats `""` as
    /// "no title available" without special-case null handling.
    pub window_title: String,

    /// True when the foreground window is one of Spokn's own windows.
    pub is_self: bool,
}
