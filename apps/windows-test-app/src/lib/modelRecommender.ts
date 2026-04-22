/**
 * Download catalog — maps stt-core model IDs to their download sources.
 * Recommendation logic lives in stt-core; this file only knows WHERE to get files.
 *
 * backendId: "whisper-cpp"     → manual GGUF download stored in Windows model store
 * backendId: "transformers-js" → auto-downloaded by HF library to hf-cache on first use
 */

const HF_GGUF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export interface ModelDownloadInfo {
  id: string;
  label: string;
  sizeMB: number;
  backendId: "whisper-cpp" | "transformers-js";
  /** Only set for whisper-cpp models */
  url?: string;
  /** Only set for whisper-cpp models */
  filename?: string;
  /** Only set for transformers-js models */
  huggingFaceId?: string;
}

export const MODEL_CATALOG: ModelDownloadInfo[] = [
  // ── whisper-cpp (GGUF, manual download) ─────────────────────────────────────
  { id: "whisper-tiny",           backendId: "whisper-cpp", label: "Whisper Tiny",            sizeMB: 77,   url: `${HF_GGUF}/ggml-tiny.bin`,               filename: "ggml-tiny.bin" },
  { id: "whisper-base",           backendId: "whisper-cpp", label: "Whisper Base",            sizeMB: 148,  url: `${HF_GGUF}/ggml-base.bin`,               filename: "ggml-base.bin" },
  { id: "whisper-small",          backendId: "whisper-cpp", label: "Whisper Small",           sizeMB: 488,  url: `${HF_GGUF}/ggml-small.bin`,              filename: "ggml-small.bin" },
  { id: "whisper-medium",         backendId: "whisper-cpp", label: "Whisper Medium",          sizeMB: 1530, url: `${HF_GGUF}/ggml-medium.bin`,             filename: "ggml-medium.bin" },
  { id: "whisper-large-v3-turbo", backendId: "whisper-cpp", label: "Whisper Large v3 Turbo",  sizeMB: 1620, url: `${HF_GGUF}/ggml-large-v3-turbo.bin`,    filename: "ggml-large-v3-turbo.bin" },
  { id: "whisper-turbo",          backendId: "whisper-cpp", label: "Whisper Turbo",           sizeMB: 809,  url: `${HF_GGUF}/ggml-large-v3-turbo-q5_0.bin`, filename: "ggml-large-v3-turbo-q5_0.bin" },
  { id: "whisper-large-v3",       backendId: "whisper-cpp", label: "Whisper Large v3",        sizeMB: 2880, url: `${HF_GGUF}/ggml-large-v3.bin`,           filename: "ggml-large-v3.bin" },

  // ── transformers-js (ONNX, auto-downloaded by HF library on first inference) ─
  { id: "sense-voice-small",                       backendId: "transformers-js", label: "SenseVoice Small",                sizeMB: 270,  huggingFaceId: "FunAudioLLM/SenseVoiceSmall" },
  { id: "whisper-large-v3-turbo-transformers",     backendId: "transformers-js", label: "Whisper Large v3 Turbo (ONNX)",   sizeMB: 1620, huggingFaceId: "onnx-community/whisper-large-v3-turbo" },
];

export function getDownloadInfo(modelId: string): ModelDownloadInfo | undefined {
  return MODEL_CATALOG.find((m) => m.id === modelId);
}
