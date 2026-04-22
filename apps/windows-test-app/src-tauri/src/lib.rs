use std::sync::Mutex;
use std::time::Duration;
use arboard::Clipboard;
use enigo::{Enigo, Key, Keyboard, Settings};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

// ── Backend sidecar port handshake ────────────────────────────────────────────
//
// The Node backend is bundled as `binaries/spokn-backend` and spawned by Tauri
// at startup. We invoke it with `--port=0`, which tells the backend to bind to
// a random free port and print a `SPOKN_PORT=<n>` line on stdout. We parse that
// line here and expose the port to the frontend via `get_backend_port`.

struct BackendPort(Mutex<Option<u16>>);

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

/// Wraps bare single-key shortcuts in Ctrl+Shift to avoid intercepting typing.
fn safe_global_key(key: &str) -> String {
    if key.contains('+') {
        key.to_lowercase()
    } else {
        format!("ctrl+shift+{}", key.to_lowercase())
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
    let pad_bottom = 60.0 * scale; // clears the Windows taskbar
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

#[tauri::command]
fn inject_text(text: String) -> Result<(), String> {
    // Write to clipboard
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(&text).map_err(|e| e.to_string())?;

    // Small delay so the clipboard write settles before apps read it
    std::thread::sleep(Duration::from_millis(150));

    // Simulate Ctrl+V into whatever window is currently focused
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.key(Key::Control, enigo::Direction::Press).map_err(|e| e.to_string())?;
    enigo.key(Key::Unicode('v'), enigo::Direction::Click).map_err(|e| e.to_string())?;
    enigo.key(Key::Control, enigo::Direction::Release).map_err(|e| e.to_string())?;

    Ok(())
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
        .invoke_handler(tauri::generate_handler![
            register_shortcuts, inject_text,
            show_overlay, hide_overlay, set_overlay_state, send_overlay_levels,
            overlay_ready, request_stop_from_overlay,
            get_backend_port,
        ])
        .setup(|app| {
            // Spawn the bundled Node backend as a sidecar. `--port=0` → the
            // backend binds to a random free port and announces it via stdout
            // as `SPOKN_PORT=<n>`. We stash the port in app state so the
            // frontend can discover it via `get_backend_port`.
            let sidecar = app
                .shell()
                .sidecar("spokn-backend")
                .map_err(|e| format!("sidecar lookup failed: {e}"))?
                .args(["--port=0"]);
            let (mut rx, _child) = sidecar
                .spawn()
                .map_err(|e| format!("sidecar spawn failed: {e}"))?;
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

            // System tray
            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Spokn STT")
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
