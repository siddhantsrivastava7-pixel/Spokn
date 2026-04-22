// Windows platform bridges — extracted from `lib.rs` in Stage 1 of the macOS
// port. Behavior is identical to the pre-split code; only the module boundary
// changed. Callers reach these through `crate::platform::*` re-exports.

use super::ActiveWindowInfo;

/// Windows has no equivalent of macOS's Accessibility TCC gate — `enigo`'s
/// synthesized keystrokes work without user permission. Return "granted"
/// unconditionally so the TS-side permission plumbing stays inert on
/// Windows while remaining identical in shape to the macOS path.
pub fn check_accessibility_permission() -> &'static str {
    "granted"
}

// ── Foreground window inspection ─────────────────────────────────────────────
//
// Used by:
//   - Auto Context Mode (rule-based mapping from process → FlowContext)
//   - Cooperative cursor awareness (hold the queue when focus shifts)
//
// Sub-millisecond Win32 calls.

pub fn read_active_window_info(self_titles: &[String]) -> ActiveWindowInfo {
    use windows::Win32::Foundation::{CloseHandle, MAX_PATH};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    let mut info = ActiveWindowInfo::default();

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return info;
        }

        let title_len = GetWindowTextLengthW(hwnd) as usize;
        if title_len > 0 {
            let mut buf = vec![0u16; title_len + 1];
            let written = GetWindowTextW(hwnd, &mut buf) as usize;
            info.window_title = String::from_utf16_lossy(&buf[..written]);
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != 0 {
            if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut name_buf = vec![0u16; MAX_PATH as usize];
                let mut size = name_buf.len() as u32;
                if QueryFullProcessImageNameW(
                    handle,
                    PROCESS_NAME_FORMAT(0),
                    windows::core::PWSTR(name_buf.as_mut_ptr()),
                    &mut size,
                )
                .is_ok()
                {
                    let full = String::from_utf16_lossy(&name_buf[..size as usize]);
                    info.process_name = full
                        .rsplit(|c| c == '\\' || c == '/')
                        .next()
                        .unwrap_or(&full)
                        .to_string();
                }
                let _ = CloseHandle(handle);
            }
        }
    }

    // bundle_id / localized_name are macOS-only; left empty on Windows.

    let title_lc = info.window_title.to_lowercase();
    info.is_self = self_titles.iter().any(|t| !t.is_empty() && title_lc.contains(t));
    info
}

// ── Keyboard-activity hook (Flow Mode typing guard) ──────────────────────────
//
// Global low-level keyboard hook feeds `LAST_KEYSTROKE_MS`. TS side polls
// `get_last_keystroke_ms_ago` every 200ms; the typing-cooldown gate in
// useFlowMode raises the audio bar for utterances committed within the
// cooldown window.
//
// Privacy invariant: the callback writes ONE atomic timestamp and nothing
// else. Key codes, key names, and modifier state are NEVER stored,
// transmitted, or logged.
//
// Self-trigger filter: enigo (Ctrl+V/Enter) synthesizes keystrokes at the OS
// level, which the hook sees. `LLKHF_INJECTED` (flag 0x10) distinguishes
// real hardware keys from synthesized ones — we skip synthesized keys.

pub mod keyboard_activity {
    use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    // Epoch-millis of the last real (non-injected) keystroke. u64::MAX = never.
    static LAST_KEYSTROKE_MS: AtomicU64 = AtomicU64::new(u64::MAX);

    // Typing guard observability status — mirrors the macOS enum so the
    // Tauri command returns identical shapes. Windows only ever reports
    // "active" (hook install succeeded — no user permission required) or
    // "inactive_platform_stub" (install() not yet called).
    const STATUS_INACTIVE: u8 = 0;
    const STATUS_ACTIVE: u8 = 1;
    static HOOK_STATUS: AtomicU8 = AtomicU8::new(STATUS_INACTIVE);

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    pub fn ms_since_last() -> u64 {
        let last = LAST_KEYSTROKE_MS.load(Ordering::Relaxed);
        if last == u64::MAX {
            return u64::MAX;
        }
        now_ms().saturating_sub(last)
    }

    /// Returns the typing-guard status for observability / UI. Parallel to
    /// the macOS `status()` — Windows doesn't have a permission-denied state
    /// (no TCC gate for WH_KEYBOARD_LL), so the only outcomes are "active"
    /// once the hook is installed or "inactive_platform_stub" before.
    pub fn status() -> &'static str {
        match HOOK_STATUS.load(Ordering::Relaxed) {
            STATUS_ACTIVE => "active",
            _ => "inactive_platform_stub",
        }
    }

    /// Install the hook on a dedicated thread with its own message pump.
    /// Never returns on success — the thread lives for the app lifetime.
    /// Errors are logged; the typing guard silently stays idle if the hook
    /// fails (the TS poll treats that as "no typing detected").
    pub fn install() {
        thread::spawn(|| {
            use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
            use windows::Win32::UI::WindowsAndMessaging::{
                CallNextHookEx, GetMessageW, SetWindowsHookExW, HHOOK,
                KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL,
            };

            unsafe extern "system" fn hook_proc(
                code: i32,
                wparam: WPARAM,
                lparam: LPARAM,
            ) -> LRESULT {
                if code >= 0 {
                    let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
                    // Skip synthesized keys (our own enigo paste + enter).
                    if (info.flags & LLKHF_INJECTED).0 == 0 {
                        LAST_KEYSTROKE_MS.store(now_ms(), Ordering::Relaxed);
                    }
                }
                CallNextHookEx(HHOOK::default(), code, wparam, lparam)
            }

            unsafe {
                let hook = SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(hook_proc),
                    None,
                    0,
                );
                match hook {
                    Ok(_h) => {
                        HOOK_STATUS.store(STATUS_ACTIVE, Ordering::Relaxed);
                        // Keep the thread alive with a message pump — the hook
                        // fires in this thread's context.
                        let mut msg = MSG::default();
                        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                            // No dispatch needed — we only want the pump to
                            // run so the hook callback can be invoked.
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[keyboard_activity] SetWindowsHookExW failed: {e}"
                        );
                    }
                }
            }
        });
    }
}

// ── UI Automation: read focused element text (external edit capture) ─────
//
// Read-only. Never types, never selects, never clicks — strictly an
// accessibility API query. Called via `spawn_blocking` because COM calls can
// stall for tens of ms on busy apps.

pub fn read_focused_element_text_impl() -> Result<String, String> {
    use uiautomation::UIAutomation;
    let automation = UIAutomation::new().map_err(|e| format!("uia init: {e}"))?;
    let element = automation
        .get_focused_element()
        .map_err(|e| format!("uia focused: {e}"))?;
    // Prefer TextPattern if available — that's the canonical way to read
    // editable text fields. Fall back to get_name() for simpler controls.
    if let Ok(text_pattern) = element.get_pattern::<uiautomation::patterns::UITextPattern>() {
        if let Ok(range) = text_pattern.get_document_range() {
            if let Ok(text) = range.get_text(-1) {
                return Ok(text);
            }
        }
    }
    if let Ok(value_pattern) =
        element.get_pattern::<uiautomation::patterns::UIValuePattern>()
    {
        if let Ok(value) = value_pattern.get_value() {
            return Ok(value);
        }
    }
    if let Ok(name) = element.get_name() {
        return Ok(name);
    }
    Err("no readable text on focused element".into())
}
