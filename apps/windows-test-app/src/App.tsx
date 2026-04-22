import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { LeftPanel } from "./components/LeftPanel";
import { Workspace } from "./components/Workspace";
import { LogsPanel } from "./components/LogsPanel";
import { ModelManagerModal } from "./components/ModelManager";
import { Onboarding, needsOnboarding, getSavedLangs } from "./components/Onboarding";
import { useRecording } from "./hooks/useRecording";
import { useMicDevices } from "./hooks/useMicDevices";
import { useTranscription } from "./hooks/useTranscription";
import { useLogs } from "./hooks/useLogs";
import { useFlowMode } from "./hooks/useFlowMode";
import { useAccessibilityPermission } from "./hooks/useAccessibilityPermission";
import { fetchHealth } from "./lib/api";
import { buildPrompt, getLearnedVocab, clearLearnedVocab } from "./lib/learnedVocab";
import { getSnippets, addSnippet, removeSnippet } from "./lib/snippets";
import { toWhisperLang } from "./lib/languages";
import { inferContext } from "./lib/flowAutoContext";
import { flowLog } from "./lib/flowObservability";
import type { Snippet } from "./lib/snippets";
import type { DeviceInfo } from "./lib/types";
import type { Mode, FlowContextChoice } from "./components/LeftPanel";
import type { FlowContext } from "./lib/flowToneMapping";
import type { WaveformVariant } from "./components/Waveform";

const isTauri = "__TAURI_INTERNALS__" in window;

export type AppState = "idle" | "recording" | "processing" | "done" | "error";

const ACCENT_COLORS = ["violet", "blue", "cyan", "amber", "neutral"] as const;
type Accent = typeof ACCENT_COLORS[number];
type ShortcutId = "record" | "upload" | "transcribe" | "clear" | "flow";

const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  record: "Ctrl+Shift+R",
  upload: "Ctrl+Shift+U",
  transcribe: "Ctrl+Enter",
  clear: "Ctrl+Backspace",
  flow: "Ctrl+Shift+F",
};

const SHORTCUT_LABELS: Record<ShortcutId, string> = {
  record: "Record / Stop",
  upload: "Upload file",
  transcribe: "Transcribe",
  clear: "Clear",
  flow: "Flow Mode",
};

function normalizeShortcutValue(shortcut: string): string {
  return shortcut.includes("+") ? shortcut : `Ctrl+Shift+${shortcut}`;
}

function normalizeShortcutMap(shortcuts: Record<ShortcutId, string>): Record<ShortcutId, string> {
  return {
    record: normalizeShortcutValue(shortcuts.record),
    upload: normalizeShortcutValue(shortcuts.upload),
    transcribe: normalizeShortcutValue(shortcuts.transcribe),
    clear: normalizeShortcutValue(shortcuts.clear),
    flow: normalizeShortcutValue(shortcuts.flow),
  };
}

function modeToSetting(m: Mode): "auto" | "fast" | "balanced" | "best_accuracy" {
  if (m === "Fast") return "fast";
  if (m === "Balanced") return "balanced";
  if (m === "Best") return "best_accuracy";
  return "auto";
}

export default function App() {
  const [onboarding, setOnboarding] = useState(() => needsOnboarding());

  const { logs, addLog, clearLogs } = useLogs();
  const recording = useRecording();
  const { devices: micDevices, refresh: refreshMics } = useMicDevices();
  const [selectedMicId, setSelectedMicId] = useState("");
  const { result, status, error, run, clear } = useTranscription(addLog);

  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [mode, setMode] = useState<Mode>("Auto");
  const [langs, setLangs] = useState<string[]>(() => getSavedLangs());
  const [timestamps, setTimestamps] = useState(true);
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [modelManagerOpen, setModelManagerOpen] = useState(false);
  const [learnedVocabVersion, setLearnedVocabVersion] = useState(0);
  const learnedWords = useMemo(() => getLearnedVocab(), [learnedVocabVersion]);

  const [snippetVersion, setSnippetVersion] = useState(0);
  const snippets = useMemo<Snippet[]>(() => getSnippets(), [snippetVersion]);

  function handleAddSnippet(trigger: string, value: string) {
    addSnippet(trigger, value);
    setSnippetVersion((v) => v + 1);
  }
  function handleRemoveSnippet(id: string) {
    removeSnippet(id);
    setSnippetVersion((v) => v + 1);
  }

  // Tweaks
  const [accent, setAccent] = useState<Accent>("violet");
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [waveformVariant, setWaveformVariant] = useState<WaveformVariant>("ripple");

  // ── Flow Mode state ─────────────────────────────────────────────────────
  const [flowContext, setFlowContext] = useState<FlowContextChoice>(() => {
    try {
      const v = localStorage.getItem("stt-flow-context") as FlowContextChoice | null;
      if (v === "auto" || v === "chat" || v === "email" || v === "notes") return v;
    } catch { /* ignore */ }
    return "auto";
  });
  useEffect(() => {
    try { localStorage.setItem("stt-flow-context", flowContext); } catch { /* ignore */ }
  }, [flowContext]);

  // Latest active-window info, polled by useFlowMode's awareness layer.
  // We also re-poll here so the LeftPanel can show "auto · email" before
  // the first utterance lands.
  const [latestWindowInfo, setLatestWindowInfo] = useState<{ processName: string; windowTitle: string; isSelf: boolean } | null>(null);

  function resolveFlowContext(): FlowContext {
    if (flowContext !== "auto") return flowContext;
    if (latestWindowInfo) {
      const ctx = inferContext(latestWindowInfo);
      flowLog.contextResolved("auto", ctx, latestWindowInfo.processName, latestWindowInfo.windowTitle);
      return ctx;
    }
    return "chat";
  }

  // Brief overlay nack pulse, then revert to whatever the active state was.
  const nackOverlay = useCallback(() => {
    if (!isTauri) return;
    let prevState: string | null = null;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        await invoke("set_overlay_state", { state: "nack" });
        prevState = "recording";
      } catch { /* ignore */ }
      setTimeout(async () => {
        try {
          await invoke("set_overlay_state", { state: prevState ?? "recording" });
        } catch { /* ignore */ }
      }, 400);
    })();
  }, []);

  // Brief positive confirmation pulse when a voice send fires successfully.
  // Distinct from nack so the user can hear/see the difference — critical for
  // earphone-first workflows where the user isn't watching the screen.
  const sendOkOverlay = useCallback(() => {
    if (!isTauri) return;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        await invoke("set_overlay_state", { state: "send_ok" });
      } catch { /* ignore */ }
      setTimeout(async () => {
        try {
          await invoke("set_overlay_state", { state: "quiet" });
        } catch { /* ignore */ }
      }, 500);
    })();
  }, []);

  // Accessibility permission probe. Seeded before the Flow Mode queue is
  // constructed — matches the Stage 4 startup-timing invariant. On Windows
  // this resolves to "granted" immediately and stays there; the whole
  // permission pipeline is inert. On macOS (Stage 6+) it reflects the real
  // `AXIsProcessTrusted()` probe and pushes events on focus regain.
  const accessibility = useAccessibilityPermission();

  const flow = useFlowMode({
    resolveContext: resolveFlowContext,
    // Overlay sync used to live here; it's now centralized in the useEffect
    // below so the accessibility-denied path and the Flow-state path share
    // one source of truth and can't disagree on the final overlay state.
    nack: nackOverlay,
    sendOk: sendOkOverlay,
    accessibilityStatus: accessibility.status,
  });

  // Single source of truth for the overlay state. Accessibility denial has
  // priority — when blocked, the overlay holds at `blocked` regardless of
  // whether Flow Mode is recording, quiet, or idle. When permission is
  // restored, the overlay reflects the current Flow state (or "hiding" if
  // Flow is idle). Runs whether or not the overlay is visible — the Rust
  // side caches the last state and re-applies it when the window reveals.
  useEffect(() => {
    if (!isTauri) return;
    const flowState = flow.state;
    const overlayState =
      accessibility.status === "denied" ? "blocked" :
      flowState === "recording" ? "recording" :
      flowState === "quiet" ? "quiet" :
      flowState === "transcribing" || flowState === "stopping" ? "transcribing" :
      "hiding";
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("set_overlay_state", { state: overlayState }).catch(() => {})
    );
  }, [accessibility.status, flow.state]);

  // Shortcuts
  const [shortcuts, setShortcuts] = useState<Record<ShortcutId, string>>(() => {
    try {
      const saved = localStorage.getItem("stt-shortcuts");
      const merged = saved ? { ...DEFAULT_SHORTCUTS, ...JSON.parse(saved) } : DEFAULT_SHORTCUTS;
      return normalizeShortcutMap(merged);
    } catch { return DEFAULT_SHORTCUTS; }
  });
  const [bindingKey, setBindingKey] = useState<ShortcutId | null>(null);
  const isBusy = status === "uploading" || status === "transcribing";

  function saveShortcuts(next: Record<ShortcutId, string>) {
    const normalized = normalizeShortcutMap(next);
    setShortcuts(normalized);
    localStorage.setItem("stt-shortcuts", JSON.stringify(normalized));
  }

  function keyEventToString(e: KeyboardEvent): string {
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
    if (e.shiftKey) mods.push("Shift");
    if (e.altKey) mods.push("Alt");
    const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    return [...mods, key].join("+");
  }

  useEffect(() => {
    if (!bindingKey) return;
    const capture = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setBindingKey(null); return; }
      if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      saveShortcuts({ ...shortcuts, [bindingKey]: keyEventToString(e) });
      setBindingKey(null);
    };
    window.addEventListener("keydown", capture, { capture: true });
    return () => window.removeEventListener("keydown", capture, { capture: true });
  }, [bindingKey, shortcuts]);

  // Register global shortcuts with Tauri (system-level, works when app is in background)
  useEffect(() => {
    if (!isTauri) return;
    const entries = (Object.keys(shortcuts) as ShortcutId[]).map((id) => ({
      id,
      key: shortcuts[id],
    }));
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("register_shortcuts", { shortcuts: entries })
        .then(() => addLog("info", `Global shortcuts registered: ${entries.map(e => e.key).join(", ")}`))
        .catch((e: unknown) => addLog("warn", `Global shortcut registration failed: ${String(e)}`))
    );
  }, [shortcuts]);

  // Stable refs so global shortcut listener always calls the latest handler
  const handleRecordRef = useRef<() => void>(() => {});
  const handleTranscribeRef = useRef<() => void>(() => {});
  const handleClearRef = useRef<() => void>(() => {});
  const handleFlowToggleRef = useRef<() => void>(() => {});
  const hasAudioRef = useRef(false);

  // Listen for global shortcut events fired by Tauri (registered once, uses refs)
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
      import("@tauri-apps/api/event").then(({ listen }) => {
        listen<string>("shortcut-triggered", (e) => {
          const id = e.payload as ShortcutId;
          if (id === "record") handleRecordRef.current();
          else if (id === "upload") triggerUploadPicker();
          else if (id === "transcribe") { if (hasAudioRef.current) handleTranscribeRef.current(); }
          else if (id === "clear") handleClearRef.current();
          else if (id === "flow") handleFlowToggleRef.current();
        }).then((fn) => { unlisten = fn; });
      });
    return () => unlisten?.();
  }, [recording.isRecording, isBusy]);

  // Overlay stop-button click is forwarded as an "overlay:stop" event from Rust.
  // Route it through handleRecordRef so the behavior matches the main Stop button
  // exactly — including the synchronous set_overlay_state("transcribing") call.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("overlay:stop", () => {
        if (recording.isRecording) handleRecordRef.current();
      }).then((fn) => { unlisten = fn; });
    });
    return () => unlisten?.();
  }, [recording.isRecording]);

  // Apply accent to root
  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);

  // Derive appState
  const appState: AppState = (() => {
    if (recording.isRecording) return "recording";
    if (status === "uploading" || status === "transcribing") return "processing";
    if (status === "done") return "done";
    if (status === "error") return "error";
    return "idle";
  })();

  const hasAudio = !!audioFile || !!recording.recordingBlob;

  const refreshHealth = useCallback(() => {
    void fetchHealth()
      .then((h) => {
        setInstalledModels(h.installedModels);
        setDevice(h.device);
        addLog("info", `Backend ready · ${h.installedModels.length} model(s) installed`);
        if (!h.backendAvailable) addLog("warn", `whisper-cli not found at: ${h.backendPath}`);
      })
      .catch((err: Error) => addLog("error", `Backend unreachable: ${err.message}`));
  }, [addLog]);

  useEffect(() => { refreshHealth(); }, [refreshHealth]);

  // ── Canonical text injection ─────────────────────────────────────────────
  //
  // Invariant: the ONLY string that gets injected is `typingText`, the
  // current editable-textarea value in Workspace. It's lifted here via
  // onTypingTextChange. We never read from transcript.fullText or
  // transcript.correctedText for injection — those are pipeline outputs;
  // `typingText = applySnippets(correctedText, snippets) + user edits`.
  //
  // Two modes:
  //   - "auto"   : inject after a short stability window with no edits
  //   - "review" : never auto-inject; user clicks "Type now"
  const [typingText, setTypingText] = useState("");
  const [autoInjectMode, setAutoInjectMode] = useState<"auto" | "review">(() => {
    try {
      const v = localStorage.getItem("stt-inject-mode");
      return v === "review" ? "review" : "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    try { localStorage.setItem("stt-inject-mode", autoInjectMode); } catch { /* ignore */ }
  }, [autoInjectMode]);

  // Stability debounce — timer re-arms on every typingText change.
  // Short enough to feel immediate, long enough that a fast edit cancels it.
  const INJECT_STABILITY_MS = 400;
  const lastInjectedIdRef = useRef<string | null>(null);
  const injectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doInject = useCallback(async (text: string, transcriptId: string) => {
    if (!isTauri) return;
    if (!text.trim()) return;
    if (lastInjectedIdRef.current === transcriptId) return; // idempotent per transcription
    lastInjectedIdRef.current = transcriptId;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("inject_text", { text });
      addLog("info", `Typed into focused window · ${text.length} chars`);
    } catch (e) {
      addLog("warn", `Text injection failed: ${String(e)}`);
    }
  }, [addLog]);

  // Reset the per-transcription injection flag on a new run.
  useEffect(() => {
    if (status === "uploading" || status === "transcribing") {
      lastInjectedIdRef.current = null;
    }
  }, [status]);

  // Auto-inject: debounced after status → "done", re-arms on every edit.
  useEffect(() => {
    if (injectTimerRef.current) {
      clearTimeout(injectTimerRef.current);
      injectTimerRef.current = null;
    }
    if (!isTauri) return;
    if (status !== "done") return;
    if (autoInjectMode !== "auto") return;
    if (!result) return;
    if (lastInjectedIdRef.current === result.transcript.id) return;
    if (!typingText.trim()) return;

    const transcriptId = result.transcript.id;
    const textAtStart = typingText;
    injectTimerRef.current = setTimeout(() => {
      injectTimerRef.current = null;
      void doInject(textAtStart, transcriptId);
    }, INJECT_STABILITY_MS);

    return () => {
      if (injectTimerRef.current) {
        clearTimeout(injectTimerRef.current);
        injectTimerRef.current = null;
      }
    };
  }, [isTauri, status, result?.transcript.id, typingText, autoInjectMode, doInject]);

  // Esc cancels a pending auto-inject (gives users an out when they change
  // their mind during the stability window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && injectTimerRef.current) {
        clearTimeout(injectTimerRef.current);
        injectTimerRef.current = null;
        addLog("info", "Auto-type cancelled");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addLog]);

  // Explicit user confirmation — bypasses the debounce. Used by the
  // "Type now" button in review mode and as an always-available escape hatch.
  const manualInject = useCallback(() => {
    if (injectTimerRef.current) {
      clearTimeout(injectTimerRef.current);
      injectTimerRef.current = null;
    }
    if (!result) return;
    void doInject(typingText, result.transcript.id);
  }, [doInject, typingText, result]);

  // Stream mic levels to overlay while recording
  // 9 log-spaced bands from 128 FFT bins (fftSize=256 @ ~44 kHz → bin≈172 Hz)
  const OVERLAY_BANDS: [number, number][] = [
    [1, 3], [4, 6], [7, 10], [11, 15], [16, 22],
    [23, 31], [32, 43], [44, 59], [60, 80],
  ];
  useEffect(() => {
    if (!isTauri || !recording.isRecording) return;
    let invokeF: ((cmd: string, args: unknown) => Promise<unknown>) | null = null;
    import("@tauri-apps/api/core").then(({ invoke }) => { invokeF = invoke as typeof invokeF; });
    const freqData = new Uint8Array(128);
    const id = setInterval(() => {
      const analyser = recording.analyserRef.current;
      if (!invokeF || !analyser) return;
      analyser.getByteFrequencyData(freqData);
      const levels = OVERLAY_BANDS.map(([lo, hi]) => {
        let sum = 0;
        const end = Math.min(hi, freqData.length - 1);
        for (let j = lo; j <= end; j++) sum += freqData[j] ?? 0;
        return sum / ((end - lo + 1) * 255);
      });
      void invokeF("send_overlay_levels", { levels });
    }, 50);
    return () => clearInterval(id);
  }, [recording.isRecording, isTauri]);

  // Track whether the overlay is currently shown so we only hide when necessary
  const overlayShownRef = useRef(false);
  // Track whether we've seen an active state since the overlay was shown.
  // Prevents the initial idle tick (between show_overlay and isRecording flipping
  // true) from triggering the hide effect.
  const overlayHasBeenActiveRef = useRef(false);

  useEffect(() => {
    if (appState === "recording" || appState === "processing") {
      overlayHasBeenActiveRef.current = true;
    }
  }, [appState]);

  // Hide overlay whenever we leave an active overlay state.
  // We send state="hiding" so the overlay JS can animate its fade before the
  // Tauri window actually hides — the overlay invokes hide_overlay itself after ~220ms.
  //
  // Two tricky cases this guards against:
  //   1. On START: overlayShownRef flips to true before React flushes
  //      isRecording=true, so appState is briefly "idle". Without the
  //      hasBeenActive guard, we would immediately hide the overlay we just showed.
  //   2. On STOP with audio: appState=idle for one render tick between
  //      stopRecording() and the auto-transcribe effect kicking status→uploading.
  //      If we hide there, the user never sees the "transcribing" visual.
  useEffect(() => {
    if (!isTauri) return;
    if (!overlayShownRef.current) return;
    const terminal = appState === "done" || appState === "error";
    const idleAfterActive =
      appState === "idle" &&
      overlayHasBeenActiveRef.current &&
      !recording.recordingBlob;
    if (terminal || idleAfterActive) {
      overlayShownRef.current = false;
      overlayHasBeenActiveRef.current = false;
      import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("set_overlay_state", { state: "hiding" })
      );
    }
  }, [appState, recording.recordingBlob]);

  // When recording stops and blob is ready → auto-transcribe
  useEffect(() => {
    if (!recording.isRecording && recording.recordingBlob && status === "idle") {
      const blob = recording.recordingBlob;
      const file = new File([blob], `recording_${Date.now()}.wav`, { type: "audio/wav" });
      addLog("info", `Recording captured: ${file.name} (${(file.size / 1024).toFixed(0)} KB) · mic: ${recording.activeMicLabel || "unknown"}`);
      setAudioFile(file);
      const effectivePrompt = buildPrompt() || undefined;
      void run({
        audioFile: file,
        settings: {
          mode: modeToSetting(mode),
          language: toWhisperLang(langs),
          timestamps,
          offlineOnly: true,
          prompt: effectivePrompt,
        },
      });
    }
  }, [recording.recordingBlob]);

  function handleRecord() {
    if (isBusy) return;
    if (recording.isRecording) {
      recording.stopRecording();
      if (isTauri) import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_overlay_state", { state: "transcribing" }));
    } else {
      clear();
      setAudioFile(null);
      recording.clearRecording();
      // Fire show_overlay *before* getUserMedia so the capsule paints with zero
      // perceived latency. The overlay's idle state renders instantly; audio
      // init catches up in the background.
      if (isTauri) {
        overlayShownRef.current = true;
        import("@tauri-apps/api/core")
          .then(({ invoke }) => invoke("show_overlay"))
          .then(() => addLog("info", "show_overlay OK"))
          .catch((e: unknown) => addLog("error", `show_overlay failed: ${String(e)}`));
      }
      recording.startRecording(selectedMicId || undefined)
        .then(() => { refreshMics(); })
        .catch((e: Error) => addLog("error", e.message));
    }
  }

  function handleUpload(file: File) {
    clear();
    recording.clearRecording();
    setAudioFile(file);
    addLog("info", `File selected: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
  }

  function triggerUploadPicker() {
    if (recording.isRecording || isBusy) return;
    document.getElementById("upload-trigger")?.click();
  }

  function handleTranscribe() {
    if (recording.isRecording || isBusy) return;
    if (!audioFile) { addLog("warn", "No audio source"); return; }
    const effectivePrompt = buildPrompt() || undefined;
    void run({
      audioFile,
      settings: {
        mode: modeToSetting(mode),
        language: toWhisperLang(langs),
        timestamps,
        offlineOnly: true,
        prompt: effectivePrompt,
      },
    });
  }

  function handleClear() {
    if (recording.isRecording) return;
    clear();
    setAudioFile(null);
    recording.clearRecording();
  }

  // ── Flow Mode handlers ──────────────────────────────────────────────────
  const handleFlowToggle = useCallback(() => {
    if (!flow.isActive) {
      // Mutual exclusion: don't start Flow during a classic recording.
      if (recording.isRecording || isBusy) {
        addLog("warn", "Cannot start Flow while a classic recording or transcription is active");
        return;
      }
      // Show overlay first so the visual paints immediately.
      if (isTauri) {
        overlayShownRef.current = true;
        void import("@tauri-apps/api/core").then(({ invoke }) => invoke("show_overlay")).catch(() => {});
      }
      void flow.start({
        langs,
        selectedMicId: selectedMicId || undefined,
        contextOverride: flowContext,
      }).then(() => {
        addLog("info", `Flow Mode started · context=${flowContext}`);
      }).catch((e) => {
        addLog("error", `Flow Mode start failed: ${String(e)}`);
      });
    } else {
      void flow.stop().then(() => {
        addLog("info", "Flow Mode stopped");
      });
    }
  }, [flow, recording.isRecording, isBusy, langs, selectedMicId, flowContext, addLog]);

  // Poll active window for the picker preview and the auto-context resolver.
  useEffect(() => {
    if (!isTauri) return;
    if (!flow.isActive && flowContext !== "auto") return;
    let cancelled = false;
    let invokeF: ((cmd: string, args?: unknown) => Promise<unknown>) | null = null;
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      invokeF = invoke as typeof invokeF;
    });
    const tick = async () => {
      if (cancelled || !invokeF) return;
      try {
        const raw = (await invokeF("get_active_window_info")) as {
          process_name: string; window_title: string; is_self: boolean;
        } | null;
        if (raw && !cancelled) {
          setLatestWindowInfo({ processName: raw.process_name ?? "", windowTitle: raw.window_title ?? "", isSelf: !!raw.is_self });
        }
      } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [flow.isActive, flowContext]);

  // While Flow is active, stream waveform levels to the overlay (same loop
  // pattern as classic mode, but reading from flow.analyserRef).
  useEffect(() => {
    if (!isTauri || !flow.isActive) return;
    let invokeF: ((cmd: string, args: unknown) => Promise<unknown>) | null = null;
    void import("@tauri-apps/api/core").then(({ invoke }) => { invokeF = invoke as typeof invokeF; });
    const freqData = new Uint8Array(128);
    const id = setInterval(() => {
      const analyser = flow.analyserRef.current;
      if (!invokeF || !analyser) return;
      analyser.getByteFrequencyData(freqData);
      const levels = OVERLAY_BANDS.map(([lo, hi]) => {
        let sum = 0;
        const end = Math.min(hi, freqData.length - 1);
        for (let j = lo; j <= end; j++) sum += freqData[j] ?? 0;
        return sum / ((end - lo + 1) * 255);
      });
      void invokeF("send_overlay_levels", { levels });
    }, 50);
    return () => clearInterval(id);
  }, [flow.isActive, flow.analyserRef]);

  // Hide overlay when Flow stops.
  useEffect(() => {
    if (!isTauri) return;
    if (flow.isActive) return;
    if (!overlayShownRef.current) return;
    // Only hide if classic isn't using the overlay either.
    if (recording.isRecording || appState === "processing") return;
    overlayShownRef.current = false;
    overlayHasBeenActiveRef.current = false;
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("set_overlay_state", { state: "hiding" })
    ).catch(() => {});
  }, [flow.isActive, recording.isRecording, appState]);

  // Keep Tauri shortcut refs in sync with latest handlers
  handleRecordRef.current = handleRecord;
  handleTranscribeRef.current = handleTranscribe;
  handleClearRef.current = handleClear;
  handleFlowToggleRef.current = handleFlowToggle;
  hasAudioRef.current = hasAudio;

  // Keyboard shortcuts
  useEffect(() => {
    if (bindingKey) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
        const pressed = keyEventToString(e);
        if (pressed === shortcuts.record) { e.preventDefault(); handleRecord(); }
        else if (pressed === shortcuts.upload) { e.preventDefault(); triggerUploadPicker(); }
        else if (pressed === shortcuts.transcribe) { e.preventDefault(); if (hasAudio) handleTranscribe(); }
        else if (pressed === shortcuts.clear) { e.preventDefault(); handleClear(); }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
  }, [recording.isRecording, hasAudio, audioFile, mode, langs, timestamps, shortcuts, bindingKey, isBusy]);

  if (onboarding) {
    return (
      <Onboarding
        onComplete={(selectedLangs) => {
          setLangs(selectedLangs);
          setOnboarding(false);
          // Trigger a health refresh so the main app knows about any downloaded model
          refreshHealth();
        }}
      />
    );
  }

  return (
    <div className="app">
      {accessibility.status === "denied" && (
        <div
          role="alert"
          aria-live="polite"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9000,
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "rgba(180, 90, 40, 0.95)",
            color: "#fff",
            fontSize: 12.5,
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            boxShadow: "0 1px 8px rgba(0, 0, 0, 0.35)",
            borderBottom: "1px solid rgba(255, 255, 255, 0.15)",
          }}
        >
          <strong style={{ fontWeight: 600 }}>Accessibility required</strong>
          <span style={{ opacity: 0.9, flex: 1 }}>
            Grant Spokn access in System Settings → Privacy → Accessibility so
            it can type into other apps. Flow Mode is suspended until then.
          </span>
          <button
            onClick={accessibility.reprobe}
            style={{
              background: "rgba(255, 255, 255, 0.15)",
              color: "#fff",
              border: "1px solid rgba(255, 255, 255, 0.35)",
              borderRadius: 4,
              padding: "4px 10px",
              fontSize: 11,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Check again
          </button>
        </div>
      )}
      <LeftPanel
        mode={mode} setMode={setMode}
        langs={langs} setLangs={setLangs}
        timestamps={timestamps} setTimestamps={setTimestamps}
        appState={appState}
        hasAudio={hasAudio}
        installedModels={installedModels}
        onRecord={handleRecord}
        onUpload={handleUpload}
        onTranscribe={handleTranscribe}
        onManageModels={() => setModelManagerOpen(true)}
        learnedWords={learnedWords}
        snippets={snippets}
        onClearVocab={() => { clearLearnedVocab(); setLearnedVocabVersion((v) => v + 1); }}
        onAddSnippet={handleAddSnippet}
        onRemoveSnippet={handleRemoveSnippet}
        shortcuts={shortcuts}
        flowActive={flow.isActive}
        flowContext={flowContext}
        flowResolvedContext={flow.resolvedContext}
        onFlowToggle={handleFlowToggle}
        onFlowContextChange={setFlowContext}
      />

      <div style={{ display: "grid", gridTemplateRows: "1fr auto", minHeight: 0, overflow: "hidden" }}>
        <Workspace
          appState={appState}
          result={result}
          error={error}
          durationSec={recording.durationSec}
          mode={mode}
          langs={langs}
          shortcuts={shortcuts}
          showTimestamps={timestamps}
          waveformVariant={waveformVariant}
          snippets={snippets}
          onRecord={handleRecord}
          onUploadClick={triggerUploadPicker}
          onVocabUpdated={() => setLearnedVocabVersion((v) => v + 1)}
          onTypingTextChange={setTypingText}
          injectMode={autoInjectMode}
          onTypeNow={manualInject}
          flowBufferText={flow.bufferText}
          flowActive={flow.isActive}
        />
        <LogsPanel logs={logs} onClear={clearLogs} />
      </div>

      {/* Tweaks FAB */}
      <button className="tweaks-fab" onClick={() => setTweaksOpen((v) => !v)} title="Customize">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="12" cy="12" r="3" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" opacity="0.5" />
        </svg>
      </button>

      {tweaksOpen && (
        <div className="tweaks-panel">
          <div className="tweaks-head">
            <span className="tweaks-title">Settings</span>
            <button style={{ background: "none", border: "none", color: "var(--text-4)", cursor: "pointer" }} onClick={() => setTweaksOpen(false)}>✕</button>
          </div>
          {micDevices.length > 0 && (
            <div className="tweaks-row">
              <div className="tweaks-label">Microphone</div>
              <select
                value={selectedMicId}
                onChange={(e) => setSelectedMicId(e.target.value)}
                style={{
                  marginTop: 6, width: "100%", padding: "5px 8px",
                  fontSize: 10.5, fontFamily: "var(--font-mono)",
                  background: "var(--surface-2)", color: "var(--text-3)",
                  border: "1px solid var(--border)", borderRadius: "var(--r-sm)", cursor: "pointer",
                }}
              >
                {micDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                ))}
              </select>
            </div>
          )}
          <div className="tweaks-row">
            <div className="tweaks-label">Accent color</div>
            <div className="swatches">
              {ACCENT_COLORS.map((c) => (
                <button key={c} className={`swatch ${accent === c ? "active" : ""}`} data-v={c} onClick={() => setAccent(c)}>
                  {accent === c ? "✓" : ""}
                </button>
              ))}
            </div>
          </div>
          <div className="tweaks-row">
            <div className="tweaks-label">Waveform</div>
            <div className="seg" style={{ marginTop: 4 }}>
              {(["ripple", "bars", "pulse", "line"] as WaveformVariant[]).map((v) => (
                <button key={v} className={waveformVariant === v ? "active" : ""} onClick={() => setWaveformVariant(v)} style={{ fontSize: 10 }}>
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div className="tweaks-row">
            <div className="tweaks-label">Auto-type after transcribing</div>
            <div className="seg" style={{ marginTop: 4 }}>
              <button
                className={autoInjectMode === "auto" ? "active" : ""}
                onClick={() => setAutoInjectMode("auto")}
                style={{ fontSize: 10 }}
                title="Automatically type into the focused window after a short stability window"
              >
                auto
              </button>
              <button
                className={autoInjectMode === "review" ? "active" : ""}
                onClick={() => setAutoInjectMode("review")}
                style={{ fontSize: 10 }}
                title="Review the transcript and press Type now to inject"
              >
                review
              </button>
            </div>
          </div>
          <div className="tweaks-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div className="tweaks-label">Keyboard shortcuts</div>
              <button
                onClick={() => saveShortcuts(DEFAULT_SHORTCUTS)}
                style={{ background: "none", border: "none", color: "var(--text-4)", cursor: "pointer", fontSize: 10, fontFamily: "var(--font-mono)", padding: 0 }}
              >
                reset
              </button>
            </div>
            {(Object.keys(SHORTCUT_LABELS) as ShortcutId[]).map((id) => (
              <div key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--font-mono)" }}>{SHORTCUT_LABELS[id]}</span>
                <button
                  onClick={() => setBindingKey(bindingKey === id ? null : id)}
                  style={{
                    fontSize: 10, fontFamily: "var(--font-mono)", padding: "2px 7px",
                    background: bindingKey === id ? "var(--accent)" : "var(--surface-3)",
                    color: bindingKey === id ? "#fff" : "var(--text-2)",
                    border: "1px solid var(--border)", borderRadius: "var(--r-sm)", cursor: "pointer",
                    minWidth: 80, textAlign: "center",
                  }}
                >
                  {bindingKey === id ? "press key…" : shortcuts[id]}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {modelManagerOpen && (
        <ModelManagerModal
          installedModels={installedModels}
          langs={langs}
          device={device}
          onClose={() => setModelManagerOpen(false)}
          onRefresh={() => { refreshHealth(); setModelManagerOpen(false); }}
        />
      )}
    </div>
  );
}
