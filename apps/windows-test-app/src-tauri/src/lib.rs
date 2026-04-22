use std::sync::Mutex;
use std::time::Duration;
use arboard::Clipboard;
use enigo::{Enigo, Key, Keyboard, Settings};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

// Per-OS bridges for foreground window, typing guard, and focused text read.
// Each OS has its own module under `platform/`; the routing lives there so
// the command surface below stays free of `cfg` gates.
mod platform;
use platform::ActiveWindowInfo;

// ── Backend sidecar port handshake ────────────────────────────────────────────
//
// The Node backend is bundled as `binaries/spokn-backend` and spawned by Tauri
// at startup. We invoke it with `--port=0`, which tells the backend to bind to
// a random free port and print a `SPOKN_PORT=<n>` line on stdout. We parse that
// line here and expose the port to the frontend via `get_backend_port`.

struct BackendPort(Mutex<Option<u16>>);

// Holds the sidecar `CommandChild` handle so we can explicitly kill the Node
// backend on app exit. Without this, `app.exit(0)` calls `std::process::exit`
// which skips Drop, and on Windows the child process outlives the parent —
// holding `spokn-backend.exe` open and breaking reinstalls / clean shutdown.
struct BackendChild(Mutex<Option<CommandChild>>);

/// Kill the spawned backend sidecar if one is alive. Idempotent — safe to
/// call from multiple exit paths (tray Quit, RunEvent::Exit, main-window
/// CloseRequested when we transition to real-close). Errors are logged but
/// never propagated; we never want to block shutdown on cleanup failures.
fn kill_backend(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<BackendChild>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                if let Err(e) = child.kill() {
                    eprintln!("[spokn-backend] kill failed: {e}");
                } else {
                    eprintln!("[spokn-backend] terminated via kill_backend");
                }
            }
        }
    }
}

#[tauri::command]
async fn get_backend_port(
    port: tauri::State<'_, BackendPort>,
) -> Result<u16, String> {
    // Backend spawn is async; the frontend calls this shortly after window
    // load. Poll for up to ~5s so we don't race the first render.
    for _ in 0..50 {
        if let Some(p) = *port.0.lock().unwrap() {
            return Ok(p);
        }
        tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(100));
        })
        .await
        .ok();
    }
    Err("Backend did not report a port in time".into())
}

// ── Overlay cached state ──────────────────────────────────────────────────────

struct OverlayState {
    last_state:  String,
    last_levels: Option<Vec<f32>>,
}

// ── Shortcut registration ─────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct ShortcutEntry {
    pub id: String,
    pub key: String,
}

/// Wraps bare single-key shortcuts in a safe chord so we don't intercept
/// regular typing. Chord follows platform convention: Ctrl+Shift on Windows,
/// Cmd+Shift on macOS. Callers that already pass a full chord (anything
/// containing '+') are forwarded as-is and only lowercased — the global-
/// shortcut plugin accepts both `ctrl+...` and `cmd+...` tokens cross-OS.
fn safe_global_key(key: &str) -> String {
    if key.contains('+') {
        key.to_lowercase()
    } else {
        #[cfg(target_os = "macos")]
        let prefix = "cmd+shift+";
        #[cfg(not(target_os = "macos"))]
        let prefix = "ctrl+shift+";
        format!("{}{}", prefix, key.to_lowercase())
    }
}

#[tauri::command]
fn register_shortcuts(
    app: tauri::AppHandle,
    shortcuts: Vec<ShortcutEntry>,
) -> Result<(), String> {
    // Clear previous registrations
    let _ = app.global_shortcut().unregister_all();

    for entry in shortcuts {
        let safe = safe_global_key(&entry.key);
        let id = entry.id.clone();
        let app_handle = app.clone();

        app.global_shortcut()
            .on_shortcut(safe.as_str(), move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = app_handle.emit("shortcut-triggered", &id);
                }
            })
            .map_err(|e| format!("Failed to register '{}': {}", safe, e))?;
    }

    Ok(())
}

// ── Recording overlay ─────────────────────────────────────────────────────────

/// Returns the (x, y) position in **physical pixels** for the overlay, anchored
/// to the bottom-right corner of whichever monitor the main window is on.
/// Falls back to (100, 100) if monitor detection fails.
fn overlay_position(app: &tauri::AppHandle) -> (f64, f64) {
    let fallback = (100.0_f64, 100.0_f64);
    let Some(main_win) = app.get_webview_window("main") else {
        eprintln!("[overlay] no main window — using fallback position");
        return fallback;
    };
    let monitor = match main_win.current_monitor() {
        Ok(Some(m)) => m,
        other => {
            eprintln!("[overlay] monitor detection returned {:?} — using fallback", other.map(|o| o.is_none()));
            return fallback;
        }
    };
    let scale  = monitor.scale_factor();
    let pos    = monitor.position();   // PhysicalPosition<i32>
    let size   = monitor.size();       // PhysicalSize<u32>
    // inner_size(260, 48) is logical → multiply by scale for physical extent
    let ow = 260.0 * scale;
    let oh =  48.0 * scale;
    let pad_right  = 20.0 * scale;
    // Bottom padding clears the OS chrome: Windows taskbar (~40px) vs macOS
    // Dock/menubar (Dock is side or auto-hide for most users, menubar is top).
    #[cfg(target_os = "macos")]
    let pad_bottom = 20.0 * scale;
    #[cfg(not(target_os = "macos"))]
    let pad_bottom = 60.0 * scale;
    let x = pos.x as f64 + size.width  as f64 - ow - pad_right;
    let y = pos.y as f64 + size.height as f64 - oh - pad_bottom;
    eprintln!(
        "[overlay] monitor {}×{} at ({},{}) scale={:.2} → overlay at ({:.0},{:.0})",
        size.width, size.height, pos.x, pos.y, scale, x, y
    );
    (x, y)
}

#[tauri::command]
fn show_overlay(app: tauri::AppHandle) -> Result<(), String> {
    let Some(overlay) = app.get_webview_window("overlay") else {
        return Err("overlay window not created at startup".into());
    };
    if let Ok(mut s) = app.state::<Mutex<OverlayState>>().lock() {
        s.last_state  = "recording".to_string();
        s.last_levels = None;
    }
    let (x, y) = overlay_position(&app);
    let _ = overlay.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
    overlay.show().map_err(|e| e.to_string())?;
    overlay
        .eval("window.setState && window.setState('recording')")
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_overlay(app: tauri::AppHandle) -> Result<(), String> {
    eprintln!("[overlay] hide_overlay invoked");
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay.hide().map_err(|e| e.to_string())?;
        eprintln!("[overlay] hidden");
    } else {
        eprintln!("[overlay] hide_overlay: window not found (already destroyed?)");
    }
    Ok(())
}

// ── Overlay state + levels ────────────────────────────────────────────────────

#[tauri::command]
fn set_overlay_state(app: tauri::AppHandle, state: String) -> Result<(), String> {
    eprintln!("[overlay] set_overlay_state → {state}");
    if let Ok(mut s) = app.state::<Mutex<OverlayState>>().lock() {
        s.last_state = state.clone();
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay.eval(&format!("window.setState && window.setState('{}')", state))
            .map_err(|e| e.to_string())?;
    } else {
        eprintln!("[overlay] set_overlay_state: window not found — state dropped");
    }
    Ok(())
}

#[tauri::command]
fn send_overlay_levels(app: tauri::AppHandle, levels: Vec<f32>) -> Result<(), String> {
    if let Ok(mut s) = app.state::<Mutex<OverlayState>>().lock() {
        s.last_levels = Some(levels.clone());
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let json = serde_json::to_string(&levels).map_err(|e| e.to_string())?;
        overlay.eval(&format!("window.setLevels && window.setLevels({})", json))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Overlay ready handshake ───────────────────────────────────────────────────

#[tauri::command]
fn overlay_ready(app: tauri::AppHandle) -> Result<(), String> {
    let Some(overlay) = app.get_webview_window("overlay") else { return Ok(()); };
    let (cached_state, cached_levels) = {
        let managed = app.state::<Mutex<OverlayState>>();
        let s = managed.lock().unwrap_or_else(|e| e.into_inner());
        (s.last_state.clone(), s.last_levels.clone())
    };
    overlay.eval(&format!("window.setState && window.setState('{}')", cached_state))
        .map_err(|e| e.to_string())?;
    if let Some(levels) = cached_levels {
        let json = serde_json::to_string(&levels).map_err(|e| e.to_string())?;
        overlay.eval(&format!("window.setLevels && window.setLevels({})", json))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Overlay → main stop request ───────────────────────────────────────────────

#[tauri::command]
fn request_stop_from_overlay(app: tauri::AppHandle) -> Result<(), String> {
    eprintln!("[overlay] request_stop_from_overlay");
    app.emit("overlay:stop", ()).map_err(|e| e.to_string())
}

// ── Text injection ────────────────────────────────────────────────────────────
//
// Modifier resolution: `enigo::Key::Meta` maps to Cmd on macOS and the Win
// key on Windows, while `Key::Control` is uniformly Ctrl. Paste/select-all on
// macOS use Cmd; on Windows they use Ctrl. The helper below keeps call sites
// free of cfg blocks.

#[inline]
fn primary_modifier() -> Key {
    #[cfg(target_os = "macos")]
    {
        Key::Meta
    }
    #[cfg(not(target_os = "macos"))]
    {
        Key::Control
    }
}

#[tauri::command]
fn inject_text(text: String) -> Result<(), String> {
    // Write to clipboard
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(&text).map_err(|e| e.to_string())?;

    // Small delay so the clipboard write settles before apps read it
    std::thread::sleep(Duration::from_millis(150));

    // Simulate Cmd+V (macOS) / Ctrl+V (Windows) into the focused window.
    let modifier = primary_modifier();
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.key(modifier, enigo::Direction::Press).map_err(|e| e.to_string())?;
    enigo.key(Key::Unicode('v'), enigo::Direction::Click).map_err(|e| e.to_string())?;
    enigo.key(modifier, enigo::Direction::Release).map_err(|e| e.to_string())?;

    Ok(())
}

/// Full-buffer replace used by Flow Mode corrections. Performs Cmd/Ctrl+A,
/// then writes the new text to clipboard, then Cmd/Ctrl+V. The TS-side queue
/// schedules these to coalesce rapid corrections into a single re-paste.
#[tauri::command]
fn inject_full_replace(text: String) -> Result<(), String> {
    let modifier = primary_modifier();
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    // Cmd/Ctrl+A — select everything in the focused field
    enigo.key(modifier, enigo::Direction::Press).map_err(|e| e.to_string())?;
    enigo.key(Key::Unicode('a'), enigo::Direction::Click).map_err(|e| e.to_string())?;
    enigo.key(modifier, enigo::Direction::Release).map_err(|e| e.to_string())?;

    // Tiny pause so the selection registers before paste in laggy apps
    std::thread::sleep(Duration::from_millis(40));

    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(&text).map_err(|e| e.to_string())?;

    std::thread::sleep(Duration::from_millis(80));

    enigo.key(modifier, enigo::Direction::Press).map_err(|e| e.to_string())?;
    enigo.key(Key::Unicode('v'), enigo::Direction::Click).map_err(|e| e.to_string())?;
    enigo.key(modifier, enigo::Direction::Release).map_err(|e| e.to_string())?;

    Ok(())
}

/// Press a submit-style key in the focused app. Used by Flow Mode's voice
/// send command. Accepted primitives:
///
///   - `"Enter"`      — plain Return
///   - `"CtrlEnter"`  — Ctrl+Return on every platform (Ctrl chords still
///                       work on macOS keyboards; some apps bind to them).
///   - `"CmdEnter"`   — Cmd+Return. Mapped to the Win key on Windows, which
///                       is almost never useful — TS side is responsible
///                       for only dispatching this on macOS.
///   - `"ShiftEnter"` — Shift+Return (newline vs. submit distinction in
///                       some chat apps).
///
/// The Rust layer stays "dumb": it does not remap modifiers based on host
/// OS. `flowSendMap.ts` is the single source of truth for which primitive
/// to dispatch per FlowContext + platform.
///
/// The TS-side queue guarantees: (a) any prior paste has drained, (b) any
/// coalesce/settle timer has fired, (c) the buffer is visible in the target
/// app. This command only presses the key.
#[tauri::command]
fn send_key(key: String) -> Result<(), String> {
    // Extra settle beyond what the queue already gave us — chat apps in
    // particular can swallow an Enter if it fires within a few ms of the paste.
    std::thread::sleep(Duration::from_millis(80));

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    /// Press-modifier → click Return → release-modifier as a single chord.
    fn chord(enigo: &mut Enigo, modifier: Key) -> Result<(), String> {
        enigo.key(modifier, enigo::Direction::Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Return, enigo::Direction::Click).map_err(|e| e.to_string())?;
        enigo.key(modifier, enigo::Direction::Release).map_err(|e| e.to_string())?;
        Ok(())
    }

    match key.as_str() {
        "Enter" => {
            enigo.key(Key::Return, enigo::Direction::Click).map_err(|e| e.to_string())?;
        }
        "CtrlEnter"  => chord(&mut enigo, Key::Control)?,
        "CmdEnter"   => chord(&mut enigo, Key::Meta)?,
        "ShiftEnter" => chord(&mut enigo, Key::Shift)?,
        _ => return Err(format!("unsupported send key: {key}")),
    }
    Ok(())
}

// ── Foreground window inspection (Flow Mode) ─────────────────────────────────
//
// Used by:
//   - Auto Context Mode (rule-based mapping from process → FlowContext)
//   - Cooperative cursor awareness (hold the queue when focus shifts)
//
// The per-OS impl lives in `platform/{windows,macos}.rs`. On Windows the call
// is a sub-millisecond Win32 sequence; on macOS (Stage 6) it's NSWorkspace +
// an AX read for the focused window title.

fn self_window_titles(app: &tauri::AppHandle) -> Vec<String> {
    let mut titles = Vec::new();
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(t) = w.title() {
            titles.push(t.to_lowercase());
        }
    }
    if let Some(w) = app.get_webview_window("overlay") {
        if let Ok(t) = w.title() {
            if !t.is_empty() {
                titles.push(t.to_lowercase());
            }
        }
    }
    // Fallback identifier — overlay window has empty title, so include the app name
    titles.push("spokn".to_string());
    titles
}

#[tauri::command]
fn get_active_window_info(app: tauri::AppHandle) -> ActiveWindowInfo {
    let titles = self_window_titles(&app);
    platform::read_active_window_info(&titles)
}

#[tauri::command]
fn is_target_focused(app: tauri::AppHandle) -> bool {
    let titles = self_window_titles(&app);
    let info = platform::read_active_window_info(&titles);
    !info.is_self && !info.process_name.is_empty()
}

// ── Keyboard-activity hook (Flow Mode typing guard) ──────────────────────────
//
// Global keyboard hook feeds a `LAST_KEYSTROKE_MS` atomic in the platform
// module. TS side polls `get_last_keystroke_ms_ago` every 200ms; the
// typing-cooldown gate in useFlowMode raises the audio bar for utterances
// committed within the cooldown window.
//
// Privacy invariant (enforced per-OS): the callback writes ONE atomic
// timestamp and nothing else. Key codes, key names, and modifier state are
// NEVER stored, transmitted, or logged.

/// Milliseconds since the last real (non-injected) keystroke. Returns
/// `u64::MAX` when no keystroke has been observed this session — the TS
/// side treats that as "never" and never flags the typing-cooldown gate.
#[tauri::command]
fn get_last_keystroke_ms_ago() -> u64 {
    platform::keyboard_activity::ms_since_last()
}

// ── Accessibility permission (macOS) ─────────────────────────────────────────
//
// macOS requires user-granted Accessibility permission for synthesized
// keystrokes (text injection) and focused-text AX reads. The TS side calls
// this command at startup and on focus-regain, maintains an
// `accessibilityReady` flag, and suspends the injection queue when the
// permission is denied. See plan file §Stage 4 for the full contract.
//
// Windows has no equivalent gate — `platform::check_accessibility_permission`
// returns `"granted"` unconditionally, so the whole plumbing stays inert on
// Windows while remaining uniform in shape across platforms.
//
// Return values: `"granted"` | `"denied"`.
#[tauri::command]
fn check_accessibility_permission() -> &'static str {
    platform::check_accessibility_permission()
}

// ── Read focused element text (external edit capture) ───────────────────────
//
// Read-only. Never types, never selects, never clicks — strictly an
// accessibility API query. Runs on a blocking pool because the underlying
// call (Windows UI Automation / macOS AX) can stall for tens of ms on busy
// apps. Per-OS impl lives in `platform/{windows,macos}.rs`.

/// Read the current text of the focused field via the platform's accessibility
/// API. Returns an error string when no text is available — callers should
/// treat that as "skip reconciliation" rather than a hard failure.
#[tauri::command]
async fn read_focused_text() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(platform::read_focused_element_text_impl)
        .await
        .map_err(|e| format!("focused-text join: {e}"))?
}

// ── App entry ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Mutex::new(OverlayState {
            last_state:  "recording".to_string(),
            last_levels: None,
        }))
        .manage(BackendPort(Mutex::new(None)))
        .manage(BackendChild(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            register_shortcuts, inject_text, inject_full_replace, send_key,
            show_overlay, hide_overlay, set_overlay_state, send_overlay_levels,
            overlay_ready, request_stop_from_overlay,
            get_backend_port,
            get_active_window_info, is_target_focused,
            get_last_keystroke_ms_ago, read_focused_text,
            check_accessibility_permission,
        ])
        .setup(|app| {
            // Start the global keyboard-activity hook on a dedicated thread.
            // Feeds the typing-cooldown gate in Flow Mode. Never stores any
            // key content — only the timestamp of the last real keystroke.
            platform::keyboard_activity::install();

            // Spawn the bundled Node backend as a sidecar. `--port=0` → the
            // backend binds to a random free port and announces it via stdout
            // as `SPOKN_PORT=<n>`. We stash the port in app state so the
            // frontend can discover it via `get_backend_port`.
            let sidecar = app
                .shell()
                .sidecar("spokn-backend")
                .map_err(|e| format!("sidecar lookup failed: {e}"))?
                .args(["--port=0"]);
            let (mut rx, child) = sidecar
                .spawn()
                .map_err(|e| format!("sidecar spawn failed: {e}"))?;
            // Park the child handle in app state so the tray Quit handler
            // (and the RunEvent::Exit callback below) can explicitly kill it.
            if let Some(state) = app.try_state::<BackendChild>() {
                *state.0.lock().unwrap() = Some(child);
            }
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            let line = line.trim();
                            if let Some(rest) = line.strip_prefix("SPOKN_PORT=") {
                                if let Ok(port) = rest.trim().parse::<u16>() {
                                    if let Some(state) =
                                        app_handle.try_state::<BackendPort>()
                                    {
                                        *state.0.lock().unwrap() = Some(port);
                                        eprintln!("[spokn-backend] port = {port}");
                                    }
                                }
                            } else if !line.is_empty() {
                                eprintln!("[spokn-backend] {line}");
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            eprintln!("[spokn-backend:err] {}", line.trim());
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!(
                                "[spokn-backend] exited code={:?} signal={:?}",
                                payload.code, payload.signal,
                            );
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // System tray — left-click reveals the main window, right-click
            // opens a menu with Show / Quit so users can fully exit without
            // going through Task Manager.
            let show_item = MenuItem::with_id(app, "tray_show", "Show Spokn", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray_quit", "Quit Spokn", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Spokn STT")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray_show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "tray_quit" => {
                        // Kill the backend BEFORE exit — app.exit(0) bypasses
                        // Drop, so the sidecar would otherwise outlive us.
                        kill_backend(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            let _ = tray; // keep alive

            // Hide to tray instead of closing
            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window_clone.hide();
                }
            });

            // Pre-create the overlay window at startup. Tauri 2 only navigates
            // WebviewWindowBuilder to its URL reliably when the window is built
            // during setup; building from a command leaves the webview blank.
            // Start hidden; `show_overlay` positions and reveals it on demand.
            tauri::WebviewWindowBuilder::new(
                app.handle(),
                "overlay",
                tauri::WebviewUrl::App("src/overlay/index.html".into()),
            )
            .title("")
            .inner_size(260.0, 48.0)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .transparent(true)
            .visible(false)
            .build()
            .map_err(|e| format!("overlay window build failed: {e}"))?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Belt-and-suspenders: whenever the app is about to exit — tray
            // Quit, OS shutdown, any future explicit app.exit() — make sure
            // the backend sidecar dies with us. Idempotent with the tray
            // handler's explicit kill_backend call.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                kill_backend(app_handle);
            }
        });
}
