import { useState, useCallback, useRef } from "react";
import { transcribe as apiTranscribe, transcribeStreaming } from "../lib/api";
import type {
  ModelSelectionResult,
  Transcript,
  TranscribeRequest,
  TranscribeResult,
} from "../lib/types";

type Status = "idle" | "uploading" | "transcribing" | "done" | "error";

export interface UseTranscriptionReturn {
  result: TranscribeResult | null;
  status: Status;
  error: string | null;
  errorDetail?: string;
  run: (req: TranscribeRequest) => Promise<TranscribeResult | null>;
  clear: () => void;
}

export function useTranscription(
  onLog: (level: "info" | "warn" | "error", msg: string, detail?: string) => void,
  opts?: { streaming?: boolean },
): UseTranscriptionReturn {
  const streaming = opts?.streaming ?? true;
  const [result, setResult] = useState<TranscribeResult | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
  const activeControllerRef = useRef<AbortController | null>(null);
  const cancelStreamRef = useRef<(() => void) | null>(null);
  const requestIdRef = useRef(0);

  const run = useCallback(
    async (req: TranscribeRequest): Promise<TranscribeResult | null> => {
      activeControllerRef.current?.abort();
      cancelStreamRef.current?.();
      const controller = new AbortController();
      activeControllerRef.current = controller;
      const requestId = ++requestIdRef.current;

      setStatus(req.audioFile ? "uploading" : "transcribing");
      setError(null);
      setErrorDetail(undefined);
      setResult(null);

      onLog("info", `Starting transcription — audio: ${req.audioPath ?? req.audioFile?.name ?? "upload"}`);
      onLog("info", `Settings: mode=${req.settings.mode} lang=${req.settings.language} timestamps=${req.settings.timestamps}`);

      if (!streaming) {
        try {
          setStatus("transcribing");
          const res = await apiTranscribe(req, controller.signal);
          if (requestId !== requestIdRef.current) return null;
          setResult(res);
          setStatus("done");
          onLog("info", `Done in ${res.processingTimeMs}ms — model: ${res.modelId} — chunks: ${res.chunksProcessed}`);
          return res;
        } catch (err) {
          return handleError(err, requestId);
        }
      }

      return new Promise<TranscribeResult | null>((resolve) => {
        setStatus("transcribing");
        const cancel = transcribeStreaming(req, {
          onPartial: (partial) => {
            if (requestId !== requestIdRef.current) return;
            setResult(synthesizeResult(partial));
            onLog("info", `partial v${partial.version ?? "?"} — ${partial.segments.length} segments`);
          },
          onFinal: (res) => {
            if (requestId !== requestIdRef.current) return;
            setResult(res);
            setStatus("done");
            onLog("info", `Done in ${res.processingTimeMs}ms — model: ${res.modelId} — chunks: ${res.chunksProcessed}`);
            resolve(res);
          },
          onError: (err) => {
            const settled = handleError(err, requestId);
            resolve(settled);
          },
        });
        cancelStreamRef.current = cancel;
        // If caller aborts, cancel the stream too.
        controller.signal.addEventListener("abort", () => {
          cancel();
          resolve(null);
        });
      });

      function handleError(err: unknown, id: number): TranscribeResult | null {
        if ((err as Error).name === "AbortError") {
          if (id === requestIdRef.current) {
            setStatus("idle");
            setError(null);
            setErrorDetail(undefined);
          }
          return null;
        }
        if (id !== requestIdRef.current) return null;
        const msg = err instanceof Error ? err.message : String(err);
        const detail = (err as Error & { detail?: string }).detail;
        setError(msg);
        setErrorDetail(detail);
        setStatus("error");
        onLog("error", msg, detail);
        return null;
      }
    },
    [onLog, streaming]
  );

  const clear = useCallback(() => {
    requestIdRef.current += 1;
    activeControllerRef.current?.abort();
    cancelStreamRef.current?.();
    activeControllerRef.current = null;
    cancelStreamRef.current = null;
    setResult(null);
    setStatus("idle");
    setError(null);
    setErrorDetail(undefined);
  }, []);

  return { result, status, error, errorDetail, run, clear };
}

/**
 * Build a minimal TranscribeResult wrapping a streaming partial so the UI
 * that expects the non-streaming shape can render it unchanged. Routing
 * details are reconstructed best-effort from the partial's metadata.
 */
function synthesizeResult(partial: Transcript): TranscribeResult {
  const meta = (partial.metadata ?? {}) as Record<string, unknown>;
  const routing: ModelSelectionResult = {
    selectedModel: {
      id: partial.modelId,
      displayName: partial.modelId,
      sizeMB: 0,
    },
    resolvedMode: {
      mode: (typeof meta["resolvedMode"] === "string" ? meta["resolvedMode"] : partial.mode) as string,
      reason: typeof meta["modeReason"] === "string" ? (meta["modeReason"] as string) : "",
    },
    selectionReasons: Array.isArray(meta["selectionReasons"])
      ? (meta["selectionReasons"] as string[])
      : [],
    fallbackCandidates: Array.isArray(meta["fallbackCandidates"])
      ? (meta["fallbackCandidates"] as string[]).map((id) => ({
          id,
          displayName: id,
          sizeMB: 0,
        }))
      : [],
    rejectedCandidates: [],
    appliedBiases: Array.isArray(meta["appliedBiases"])
      ? (meta["appliedBiases"] as string[])
      : [],
  };
  return {
    transcript: partial,
    processingTimeMs: partial.latencyMs ?? 0,
    modelId: partial.modelId,
    chunksProcessed: 1,
    routing,
  };
}
