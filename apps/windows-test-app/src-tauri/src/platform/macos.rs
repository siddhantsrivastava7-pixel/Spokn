// macOS platform bridges.
//
// Stage 4 (Accessibility permission probe) and Stage 6 (active-window read)
// land here. Stage 7 (CGEventTap typing guard) and Stage 8 (AX focused-text
// read) remain stubbed — they're easier to develop iteratively on actual
// hardware.
//
// Crate layout:
//   - Apple ObjC runtime via `objc2` + `objc2-app-kit` + `objc2-foundation`
//     for `NSWorkspace.frontmostApplication()`.
//   - `core-foundation` for CFString building.
//   - Manual `extern "C"` bindings for the three AX functions we need
//     (no separate crate — Apple exposes AX in the ApplicationServices
//     framework, which Tauri-bundled binaries always link).
//
// All AX pointer handling is contained in small safe wrappers below;
// nothing escapes unsafe out of this module.

#![allow(unsafe_op_in_unsafe_fn)]

use super::ActiveWindowInfo;
use std::ffi::c_void;

use core_foundation::base::TCFType;
use core_foundation::string::{CFString, CFStringRef};

// ── AX / CoreFoundation FFI ──────────────────────────────────────────────────
//
// AX returns opaque pointer types (`AXUIElementRef`) that are actually
// `CFTypeRef` under the hood — reference-counted via CFRetain/CFRelease.
// We model them as raw `*mut c_void` and release explicitly in each
// function once we're done.
//
// `AXError` is a plain `i32` where `0 == success`. For the attributes we
// query, failure typically means either the element is gone (app closed
// between queries) or the user has not granted Accessibility.

type AXUIElementRef = *mut c_void;
type AXError = i32;
const K_AX_ERROR_SUCCESS: AXError = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut *const c_void,
    ) -> AXError;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

#[inline]
unsafe fn cf_release(p: *const c_void) {
    if !p.is_null() {
        CFRelease(p);
    }
}

/// Read a reference-typed AX attribute (another AX element). The returned
/// pointer must be `cf_release`d by the caller.
///
/// `attr_name` is declared `&'static str` so we can use
/// `CFString::from_static_string` without an allocation — callers pass
/// string literals only.
unsafe fn ax_get_element_attr(
    element: AXUIElementRef,
    attr_name: &'static str,
) -> Option<AXUIElementRef> {
    if element.is_null() {
        return None;
    }
    let attr = CFString::from_static_string(attr_name);
    let mut out: *const c_void = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut out);
    if err != K_AX_ERROR_SUCCESS || out.is_null() {
        return None;
    }
    Some(out as AXUIElementRef)
}

/// Read a CFString-typed AX attribute. Ownership of the returned CFString
/// is taken over via `wrap_under_create_rule` so Drop handles release.
unsafe fn ax_get_string_attr(
    element: AXUIElementRef,
    attr_name: &'static str,
) -> Option<String> {
    if element.is_null() {
        return None;
    }
    let attr = CFString::from_static_string(attr_name);
    let mut out: *const c_void = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut out);
    if err != K_AX_ERROR_SUCCESS || out.is_null() {
        return None;
    }
    // The title attribute returns a CFStringRef. `wrap_under_create_rule`
    // transfers ownership of the +1 retain count; Drop releases it.
    let cf = CFString::wrap_under_create_rule(out as CFStringRef);
    Some(cf.to_string())
}

// ── Accessibility permission probe ───────────────────────────────────────────
//
// Stage 4. `AXIsProcessTrusted()` is non-prompting — it returns the current
// permission state without showing the user a dialog. Plan invariant
// (Stage 4 §startup-timing): on any unexpected probe error we collapse to
// `"denied"` so the TS side can't hang in the `"probing"` state. This
// function can't error (the FFI call itself is infallible) so all that
// remains is the bool → string mapping.

pub fn check_accessibility_permission() -> &'static str {
    // SAFETY: `AXIsProcessTrusted` takes no arguments, is thread-safe, and
    // has no state that can become invalid. Apple docs treat it as always
    // callable.
    let trusted = unsafe { AXIsProcessTrusted() };
    if trusted != 0 {
        "granted"
    } else {
        "denied"
    }
}

// ── Frontmost application via NSWorkspace ────────────────────────────────────
//
// `NSWorkspace.frontmostApplication()` returns the user-facing frontmost app
// (i.e. the one whose window has keyboard focus). It DOES NOT require any
// TCC permission — bundle identifier / localized name / PID are public
// metadata. Accessibility is only needed to read the window title via AX.

struct FrontApp {
    pid: i32,
    bundle_id: String,
    localized_name: String,
    executable_basename: String,
}

fn read_frontmost_app() -> Option<FrontApp> {
    use objc2_app_kit::{NSRunningApplication, NSWorkspace};
    use objc2_foundation::NSURL;

    // SAFETY: all `NSWorkspace` / `NSRunningApplication` accessors here are
    // autoreleasing ObjC methods. We hold references for the duration of this
    // function only — no cross-thread handoff, no stored pointers.
    unsafe {
        let workspace = NSWorkspace::sharedWorkspace();
        let running_app: objc2::rc::Retained<NSRunningApplication> =
            workspace.frontmostApplication()?;

        let pid = running_app.processIdentifier();

        let bundle_id = running_app
            .bundleIdentifier()
            .map(|s| s.to_string())
            .unwrap_or_default();

        let localized_name = running_app
            .localizedName()
            .map(|s| s.to_string())
            .unwrap_or_default();

        let executable_basename = running_app
            .executableURL()
            .and_then(|url: objc2::rc::Retained<NSURL>| {
                url.lastPathComponent().map(|s| s.to_string())
            })
            .unwrap_or_default();

        Some(FrontApp {
            pid,
            bundle_id,
            localized_name,
            executable_basename,
        })
    }
}

// ── Focused-window title via AX ──────────────────────────────────────────────
//
// Sequence:
//   1. `AXUIElementCreateApplication(pid)` → per-process AX handle.
//   2. Read `"AXFocusedWindow"` attribute → AX handle for the focused
//      window.
//   3. Read `"AXTitle"` attribute on that window → CFString title.
//
// Attribute names are passed as Rust &str; Apple exposes them as
// `#define kAXFooAttribute CFSTR("AXFoo")` macros in the headers, so
// there's no linkable symbol we could import — constructing CFStrings
// from the stable spelling is the canonical workaround.
//
// Every path cleans up every retained AX element it allocated. `None`
// anywhere short-circuits to an empty title, matching the cross-platform
// contract in `ActiveWindowInfo` (`window_title` is always a String, never
// null / omitted).

fn read_focused_window_title(pid: i32) -> String {
    unsafe {
        let app_elem = AXUIElementCreateApplication(pid);
        if app_elem.is_null() {
            return String::new();
        }

        let title = match ax_get_element_attr(app_elem, "AXFocusedWindow") {
            Some(window_elem) => {
                let t = ax_get_string_attr(window_elem, "AXTitle").unwrap_or_default();
                cf_release(window_elem as *const c_void);
                t
            }
            None => String::new(),
        };

        cf_release(app_elem as *const c_void);
        title
    }
}

// ── Public read_active_window_info ───────────────────────────────────────────

pub fn read_active_window_info(self_titles: &[String]) -> ActiveWindowInfo {
    let Some(front) = read_frontmost_app() else {
        return ActiveWindowInfo::default();
    };

    let window_title = read_focused_window_title(front.pid);

    // is_self: bundle ID is the stable / language-independent check; the
    // window-title fallback covers the edge case where the user renamed
    // the app bundle but bundleID is still the default.
    const OWN_BUNDLE_ID: &str = "app.spokn.desktop";
    let title_lc = window_title.to_lowercase();
    let is_self = front.bundle_id == OWN_BUNDLE_ID
        || self_titles
            .iter()
            .any(|t| !t.is_empty() && title_lc.contains(t));

    // process_name back-compat: existing Windows rule regexes match on
    // executable basename. We prefer the real executable name ("Slack")
    // when NSWorkspace gives it; fall back to localizedName so rules
    // never see an empty string when NSURL.lastPathComponent is missing.
    let process_name = if !front.executable_basename.is_empty() {
        front.executable_basename.clone()
    } else {
        front.localized_name.clone()
    };

    ActiveWindowInfo {
        process_name,
        bundle_id: front.bundle_id,
        localized_name: front.localized_name,
        window_title,
        is_self,
    }
}

// ── Focused-field text read — Stage 8 (deferred) ─────────────────────────────

pub fn read_focused_element_text_impl() -> Result<String, String> {
    // Stage 8 (stretch) will implement this via AXUIElementCopyAttributeValue
    // on the system-wide `AXFocusedUIElement` + `AXValue` / `AXSelectedText`.
    // Reliability varies widely across macOS apps (Cocoa text fields work;
    // Electron / Chrome surfaces are partial), so shipping this under an
    // opt-in toggle is a deliberate deferral.
    Err("read_focused_text is not yet implemented on macOS".into())
}

// ── Keyboard activity hook — Stage 7 (deferred) ──────────────────────────────

pub mod keyboard_activity {
    // Stage 7 replaces these with a CGEventTap-backed implementation.
    // `u64::MAX` is the "never observed a keystroke" sentinel that the
    // TS typing guard already handles.
    pub fn install() {}

    pub fn ms_since_last() -> u64 {
        u64::MAX
    }
}
