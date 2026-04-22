import type {
  HealthStatus,
  TranscribeResult,
  TranscribeRequest,
  PerModeRecommendations,
  ApiError,
  Transcript,
} from "./types";

// In dev mode Vite proxies /api → localhost:3001.
// In the packaged app, the Node backend is spawned as a Tauri sidecar on a
// random port. We discover that port once via the `get_backend_port` command
// and cache the base URL for all subsequent requests.
let _apiBasePromise: Promise<string> | null = null;

function isTauriRuntime(): boolean {
  return (
    window.location.protocol === "tauri:" ||
    window.location.hostname === "tauri.localhost"
  );
}

async function resolveApiBase(): Promise<string> {
  if (!isTauriRuntime()) return "";
  const { invoke } = await import("@tauri-apps/api/core");
  const port = await invoke<number>("get_backend_port");
  return `http://127.0.0.1:${port}`;
}

function getApiBase(): Promise<string> {
  if (!_apiBasePromise) _apiBasePromise = resolveApiBase();
  return _apiBasePromise;
}

export async function apiUrl(path: string): Promise<string> {
  const base = await getApiBase();
  return `${base}${path}`;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: ApiError = { error: `HTTP ${res.status}` };
    try {
      body = (await res.json()) as ApiError;
    } catch {
      // ignore parse error — use default
    }
    const err = new Error(body.error);
    (err as Error & { errorType?: string; detail?: string }).errorType = body.errorType;
    (err as Error & { detail?: string }).detail = body.stack;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function fetchHealth(): Promise<HealthStatus> {
  const res = await fetch(await apiUrl("/api/health"));
  return handleResponse<HealthStatus>(res);
}

export async function fetchModels(): Promise<string[]> {
  const res = await fetch(await apiUrl("/api/models"));
  return handleResponse<string[]>(res);
}

export async function registerModel(
  modelId: string,
  filePath: string,
  displayName?: string
): Promise<void> {
  const res = await fetch(await apiUrl("/api/register-model"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId, filePath, displayName }),
  });
  await handleResponse<{ ok: boolean }>(res);
}

export async function unregisterModel(modelId: string): Promise<void> {
  const res = await fetch(await apiUrl(`/api/register-model/${encodeURIComponent(modelId)}`), {
    method: "DELETE",
  });
  await handleResponse<{ ok: boolean }>(res);
}

export interface ModelCompatibilityEntry {
  modelId: string;
  displayName: string;
  sizeMB: number;
  compatible: boolean;
  /** Human-readable reason when `compatible` is false; null otherwise. */
  reason: string | null;
}

export async function fetchModelCatalog(): Promise<ModelCompatibilityEntry[]> {
  const res = await fetch(await apiUrl("/api/models/catalog"));
  return handleResponse<ModelCompatibilityEntry[]>(res);
}

export async function fetchRecommendations(langs: string[]): Promise<PerModeRecommendations> {
  const params = new URLSearchParams({ langs: langs.join(",") });
  const res = await fetch(await apiUrl(`/api/models/recommend?${params.toString()}`));
  return handleResponse<PerModeRecommendations>(res);
}

export interface DownloadCallbacks {
  onProgress: (percent: number, downloadedMB: number, totalMB: number) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

/** Returns a cancel function. Uses SSE streaming. */
export function downloadModel(
  modelId: string,
  url: string,
  filename: string,
  displayName: string | undefined,
  cb: DownloadCallbacks
): () => void {
  const params = new URLSearchParams({ modelId, url, filename });
  if (displayName) params.set("displayName", displayName);

  // EventSource needs its URL synchronously, but our API base is resolved
  // asynchronously (backend port handshake). Wrap so cancel works even if
  // the caller bails before the URL resolves.
  let es: EventSource | null = null;
  let cancelled = false;

  void apiUrl(`/api/models/download?${params.toString()}`).then((url) => {
    if (cancelled) return;
    es = new EventSource(url);

    es.addEventListener("progress", (e: MessageEvent) => {
      const { downloaded, total, percent } = JSON.parse(e.data as string) as {
        downloaded: number; total: number; percent: number;
      };
      cb.onProgress(percent, downloaded / 1_000_000, total / 1_000_000);
    });

    es.addEventListener("done", () => { es?.close(); cb.onDone(); });

    es.addEventListener("error", (e: Event) => {
      es?.close();
      try {
        cb.onError((JSON.parse((e as MessageEvent).data as string) as { message: string }).message);
      } catch {
        cb.onError("Download failed");
      }
    });
  }).catch((err: unknown) => {
    if (!cancelled) {
      cb.onError(err instanceof Error ? err.message : String(err));
    }
  });

  return () => {
    cancelled = true;
    es?.close();
  };
}

// ── Feedback loop ───────────────────────────────────────────────────────────

export interface FeedbackPayload {
  id?: string;
  rawText: string;
  formattedOutput: string;
  userCorrected: string;
  detectedIntent: string;
  intentConfidence?: number;
  corrections?: unknown[];
  language?: string;
}

export async function submitFeedback(payload: FeedbackPayload): Promise<void> {
  const res = await fetch(await apiUrl("/api/feedback"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await handleResponse<{ ok: boolean }>(res);
}

export async function clearFeedback(): Promise<void> {
  const res = await fetch(await apiUrl("/api/feedback"), { method: "DELETE" });
  await handleResponse<{ ok: boolean }>(res);
}

export interface FeedbackSummary {
  count: number;
  entries: unknown[];
  adaptiveRules: null | {
    fillerExceptions: string[];
    hinglishDictionaryOverrides: Record<string, string>;
    intentBias: Record<string, number>;
  };
}

export async function fetchFeedback(limit?: number): Promise<FeedbackSummary> {
  const qs = limit !== undefined ? `?limit=${limit}` : "";
  const res = await fetch(await apiUrl(`/api/feedback${qs}`));
  return handleResponse<FeedbackSummary>(res);
}

export async function transcribe(req: TranscribeRequest, signal?: AbortSignal): Promise<TranscribeResult> {
  const form = new FormData();

  if (req.audioFile) {
    form.append("audio", req.audioFile, req.audioFile.name);
  } else if (req.audioPath) {
    form.append("audioPath", req.audioPath);
  } else {
    throw new Error("No audio source specified");
  }

  form.append("settings", JSON.stringify(req.settings));

  if (req.durationMs !== undefined) {
    form.append("durationMs", String(req.durationMs));
  }
  if (req.userSpeechProfile) {
    form.append("userSpeechProfile", JSON.stringify(req.userSpeechProfile));
  }
  if (req.processingMode) {
    form.append("processingMode", req.processingMode);
  }
  if (req.postProcessing) {
    form.append("postProcessing", JSON.stringify(req.postProcessing));
  }

  const res = await fetch(await apiUrl("/api/transcribe"), {
    method: "POST",
    body: form,
    signal,
  });

  return handleResponse<TranscribeResult>(res);
}

export interface TranscribeStreamCallbacks {
  onPartial: (partial: Transcript) => void;
  /** Fires exactly once with the final result (same payload the non-stream API returns). */
  onFinal: (result: TranscribeResult) => void;
  /** Fires on fatal error before `onFinal`. */
  onError?: (err: Error) => void;
}

/**
 * Streams partials via SSE. Writes v1/v2 transcripts into `onPartial`, then
 * the complete TranscribeResult into `onFinal`. Returns a cancel function.
 *
 * Backwards-compatible: callers who prefer the one-shot JSON path should use
 * `transcribe()` instead.
 */
export function transcribeStreaming(
  req: TranscribeRequest,
  cb: TranscribeStreamCallbacks,
): () => void {
  const form = new FormData();
  if (req.audioFile) {
    form.append("audio", req.audioFile, req.audioFile.name);
  } else if (req.audioPath) {
    form.append("audioPath", req.audioPath);
  } else {
    cb.onError?.(new Error("No audio source specified"));
    return () => {};
  }
  form.append("settings", JSON.stringify(req.settings));
  if (req.durationMs !== undefined) form.append("durationMs", String(req.durationMs));
  if (req.userSpeechProfile) form.append("userSpeechProfile", JSON.stringify(req.userSpeechProfile));
  if (req.processingMode) form.append("processingMode", req.processingMode);
  if (req.postProcessing) form.append("postProcessing", JSON.stringify(req.postProcessing));
  form.append("stream", "1");

  const controller = new AbortController();

  void (async () => {
    try {
      const res = await fetch(await apiUrl("/api/transcribe"), {
        method: "POST",
        body: form,
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as ApiError;
          message = body.error ?? message;
        } catch {
          // ignore
        }
        cb.onError?.(new Error(message));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines.
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          dispatchSseEvent(rawEvent, cb);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      cb.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return () => controller.abort();
}

function dispatchSseEvent(raw: string, cb: TranscribeStreamCallbacks): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;
  let data: unknown;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  if (event === "partial") {
    cb.onPartial(data as Transcript);
  } else if (event === "final") {
    cb.onFinal(data as TranscribeResult);
  } else if (event === "error") {
    const errObj = data as { error?: string };
    cb.onError?.(new Error(errObj.error ?? "Streaming error"));
  }
}
