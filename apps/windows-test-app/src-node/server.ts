import express from "express";
import cors from "cors";
import multer from "multer";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import {
  runTranscription,
  getInstalledModels,
  getDevice,
  isBackendAvailable,
  getBackendPath,
  registerModel,
  unregisterModel,
  getRecommendations,
  getModelCatalogCompatibility,
  initBinary,
  getBinaryVariant,
  appendFeedback,
  clearFeedback,
  listFeedback,
  currentAdaptiveRules,
} from "./pipeline";
import { getModelsDir, sanitizeModelId } from "@stt/platform-windows";

// Port resolution: in dev mode we pin to 3001 so the Vite proxy can target
// a known address. When launched as a packaged sidecar, the Tauri Rust side
// passes `--port=0` and parses the actual port from our stdout handshake.
function resolvePort(): number {
  const arg = process.argv.find((a) => a.startsWith("--port="));
  if (arg) {
    const parsed = Number.parseInt(arg.slice("--port=".length), 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const env = process.env.SPOKN_PORT;
  if (env) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 3001;
}
const PORT = resolvePort();
const TEMP_DIR = path.join(os.tmpdir(), "spokn-uploads");

// ── Download security ─────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'http://localhost:1420',   // Vite dev (Tauri dev mode)
  'http://127.0.0.1:1420',   // Vite dev (alt hostname)
  'tauri://localhost',       // Tauri production, Windows
  'https://tauri.localhost', // Tauri v2 alternate scheme
  'http://tauri.localhost',  // Tauri v2 http alternate
];

const ALLOWED_DOWNLOAD_HOSTS = [
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "cdn-lfs-us-1.huggingface.co",
];

const ALLOWED_DOWNLOAD_HOST_FAMILIES = [
  "huggingface.co",
  "xethub.hf.co",
];

function isAllowedDownloadHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    ALLOWED_DOWNLOAD_HOSTS.includes(normalized) ||
    ALLOWED_DOWNLOAD_HOST_FAMILIES.some(
      (family) => normalized === family || normalized.endsWith(`.${family}`)
    )
  );
}

function assertDownloadUrl(url: string, base?: string): string {
  let parsed: URL;
  try { parsed = new URL(url, base); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS downloads are allowed');
  if (!isAllowedDownloadHost(parsed.hostname)) {
    throw new Error(`Download host not allowed: ${parsed.hostname}`);
  }
  return parsed.href;
}
fs.mkdirSync(TEMP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: TEMP_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".audio";
    cb(null, `upload_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
// CORS only prevents *reading* blocked responses; this actively rejects browser
// requests from unlisted origins before any route handler runs.
// Requests without an Origin header (curl, same-process calls) are allowed.
app.use((req, res, next) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (origin !== undefined && !ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
});
app.use(express.json());

// ── Health ──────────────────────────────────────────────────────────────────

app.get("/api/health", async (_req, res) => {
  try {
    const [device, installedModels, backendAvailable, binaryVariant] = await Promise.all([
      getDevice(),
      getInstalledModels(),
      isBackendAvailable(),
      getBinaryVariant(),
    ]);

    res.json({
      ok: true,
      device,
      installedModels,
      backendAvailable,
      backendPath: getBackendPath(),
      binaryVariant: binaryVariant ?? "cpu",
      gpuAcceleration: binaryVariant === "cuda11" || binaryVariant === "cuda12",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── Models ──────────────────────────────────────────────────────────────────

app.get("/api/models", async (_req, res) => {
  try {
    const models = await getInstalledModels();
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Device ──────────────────────────────────────────────────────────────────

app.get("/api/device", async (_req, res) => {
  try {
    const device = await getDevice();
    res.json(device);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Transcribe ───────────────────────────────────────────────────────────────
// Accepts:
//   multipart/form-data with optional `audio` file field
//   + JSON fields: settings (string), audioPath (string), durationMs (number)
//
// If an audio file is uploaded, it is saved to a temp path and used.
// If audioPath is provided, it is used directly (no upload needed).

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  let audioPath: string;
  let uploadedTempPath: string | null = null;

  if (req.file) {
    audioPath = req.file.path;
    uploadedTempPath = req.file.path;
  } else if (req.body.audioPath) {
    audioPath = req.body.audioPath as string;
  } else {
    res.status(400).json({ error: "No audio source provided. Send 'audioPath' or upload an audio file." });
    return;
  }

  let settings: Record<string, unknown> = {};
  try {
    settings = req.body.settings ? (JSON.parse(req.body.settings as string) as Record<string, unknown>) : {};
  } catch {
    res.status(400).json({ error: "Invalid settings JSON" });
    return;
  }

  const durationMs = req.body.durationMs ? Number(req.body.durationMs) : undefined;

  let userSpeechProfile: Record<string, unknown> | undefined;
  try {
    userSpeechProfile = req.body.userSpeechProfile
      ? (JSON.parse(req.body.userSpeechProfile as string) as Record<string, unknown>)
      : undefined;
  } catch {
    userSpeechProfile = undefined;
  }

  const rawProcessingMode = req.body.processingMode as string | undefined;
  const processingMode =
    rawProcessingMode === "instant" ||
    rawProcessingMode === "balanced" ||
    rawProcessingMode === "accuracy"
      ? rawProcessingMode
      : undefined;

  let postProcessing: Record<string, unknown> | undefined;
  try {
    postProcessing = req.body.postProcessing
      ? (JSON.parse(req.body.postProcessing as string) as Record<string, unknown>)
      : undefined;
  } catch {
    postProcessing = undefined;
  }

  // SSE streaming is opt-in via Accept header or a `stream=1` form field.
  // Without it, we return a single JSON result for backward compat.
  const streaming =
    (req.headers.accept ?? "").includes("text/event-stream") ||
    req.body.stream === "1" ||
    req.body.stream === "true";

  if (streaming) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let cancelled = false;
    req.on("close", () => {
      cancelled = true;
    });

    try {
      const result = await runTranscription({
        audioPath,
        durationMs,
        settings: settings as Parameters<typeof runTranscription>[0]["settings"],
        userSpeechProfile: userSpeechProfile as Parameters<typeof runTranscription>[0]["userSpeechProfile"],
        processingMode,
        postProcessing: postProcessing as Parameters<typeof runTranscription>[0]["postProcessing"],
        onPartial: (partial) => {
          if (cancelled) return;
          writeEvent("partial", partial);
        },
      });
      if (!cancelled) {
        writeEvent("final", result);
      }
    } catch (err) {
      if (!cancelled) {
        const message = err instanceof Error ? err.message : String(err);
        const name = err instanceof Error ? err.constructor.name : "Error";
        writeEvent("error", { error: message, errorType: name });
      }
    } finally {
      if (uploadedTempPath) {
        fs.unlink(uploadedTempPath, () => {});
      }
      res.end();
    }
    return;
  }

  try {
    const result = await runTranscription({
      audioPath,
      durationMs,
      settings: settings as Parameters<typeof runTranscription>[0]["settings"],
      userSpeechProfile: userSpeechProfile as Parameters<typeof runTranscription>[0]["userSpeechProfile"],
      processingMode,
      postProcessing: postProcessing as Parameters<typeof runTranscription>[0]["postProcessing"],
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.constructor.name : "Error";
    res.status(500).json({ error: message, errorType: name, stack: err instanceof Error ? err.stack : undefined });
  } finally {
    // Clean up uploaded temp file after transcription
    if (uploadedTempPath) {
      fs.unlink(uploadedTempPath, () => {});
    }
  }
});

// ── Feedback loop ────────────────────────────────────────────────────────────

app.post("/api/feedback", async (req, res) => {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Invalid feedback payload" });
    return;
  }
  const requiredKeys = [
    "rawText",
    "formattedOutput",
    "userCorrected",
    "detectedIntent",
  ] as const;
  for (const k of requiredKeys) {
    if (typeof body[k] !== "string") {
      res.status(400).json({ error: `Missing or invalid field: ${k}` });
      return;
    }
  }
  const now = new Date().toISOString();
  const entry: Parameters<typeof appendFeedback>[0] = {
    id: typeof body["id"] === "string" && body["id"].length > 0
      ? (body["id"] as string)
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    recordedAt: typeof body["recordedAt"] === "string" ? (body["recordedAt"] as string) : now,
    rawText: body["rawText"] as string,
    formattedOutput: body["formattedOutput"] as string,
    userCorrected: body["userCorrected"] as string,
    detectedIntent: body["detectedIntent"] as Parameters<typeof appendFeedback>[0]["detectedIntent"],
    intentConfidence:
      typeof body["intentConfidence"] === "number" ? (body["intentConfidence"] as number) : 0,
    corrections: Array.isArray(body["corrections"])
      ? (body["corrections"] as Parameters<typeof appendFeedback>[0]["corrections"])
      : [],
    language: typeof body["language"] === "string" ? (body["language"] as string) : undefined,
  };
  try {
    await appendFeedback(entry);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.delete("/api/feedback", async (_req, res) => {
  try {
    await clearFeedback();
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get("/api/feedback", async (req, res) => {
  const limitRaw = req.query["limit"];
  const limit = typeof limitRaw === "string" ? Number(limitRaw) : undefined;
  try {
    const entries = await listFeedback(Number.isFinite(limit) ? limit : undefined);
    const rules = await currentAdaptiveRules();
    res.json({ count: entries.length, entries, adaptiveRules: rules ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ── Model management ─────────────────────────────────────────────────────────

app.post("/api/register-model", async (req, res) => {
  const { modelId, filePath, displayName } = req.body as {
    modelId?: string;
    filePath?: string;
    displayName?: string;
  };

  if (!modelId || !filePath) {
    res.status(400).json({ error: "modelId and filePath are required" });
    return;
  }

  if (!fs.existsSync(filePath)) {
    res.status(400).json({ error: `File not found: ${filePath}` });
    return;
  }

  try {
    await registerModel(modelId, filePath, displayName);
    res.json({ ok: true, modelId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/register-model/:modelId", async (req, res) => {
  try {
    await unregisterModel(req.params.modelId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Model recommendations ─────────────────────────────────────────────────────
// GET /api/models/recommend?langs=hi,en&countryCode=IN
// Returns best model per mode (fast/balanced/best_accuracy/auto) for this user.

// Returns every catalog model with a hard device-compatibility flag + reason.
// The frontend uses this to disable Download for models that would exceed
// RAM / storage / CPU budget on this machine.
app.get("/api/models/catalog", async (_req, res) => {
  try {
    const entries = await getModelCatalogCompatibility();
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/models/recommend", async (req, res) => {
  try {
    const langsParam = (req.query.langs as string) ?? "auto";
    const langs = langsParam.split(",").map((l) => l.trim()).filter(Boolean);
    const result = await getRecommendations(langs);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Model download (SSE) ──────────────────────────────────────────────────────
// GET /api/models/download?modelId=&url=&filename=&displayName=
// Streams download progress as Server-Sent Events.

app.get("/api/models/download", async (req, res) => {
  const { modelId, url, filename, displayName } = req.query as Record<string, string>;
  if (!modelId || !url || !filename) {
    res.status(400).json({ error: "modelId, url, and filename are required" });
    return;
  }

  try { assertDownloadUrl(url); } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Route downloaded models through the platform-aware app-data resolver so
  // macOS writes under `~/Library/Application Support/spokn/models/…` and
  // Windows continues to use `%LOCALAPPDATA%/stt-platform-windows/models/…`.
  const modelDir = path.join(getModelsDir(), sanitizeModelId(modelId));
  fs.mkdirSync(modelDir, { recursive: true });

  // Reject filenames containing path separators; path.resolve containment is the backstop.
  if (!filename || path.basename(filename) !== filename) {
    res.status(400).json({ error: 'Invalid filename: must be a plain filename with no path separators' });
    return;
  }
  const destPath = path.join(modelDir, filename);
  if (!path.resolve(destPath).startsWith(path.resolve(modelDir) + path.sep)) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }

  let aborted = false;
  let activeHttpReq: { destroy(err?: Error): void } | null = null;

  req.on("close", () => {
    aborted = true;
    activeHttpReq?.destroy(new Error("Client disconnected"));
  });

  const download = (targetUrl: string, redirects = 0): Promise<void> =>
    new Promise((resolve, reject) => {
      if (aborted) { reject(new Error("Cancelled")); return; }
      if (redirects > 10) { reject(new Error("Too many redirects")); return; }
      const proto = targetUrl.startsWith("https") ? https : http;
      const httpReq = proto.get(targetUrl, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          try {
            const next = assertDownloadUrl(response.headers.location ?? '', targetUrl);
            response.resume();
            download(next, redirects + 1).then(resolve).catch(reject);
          } catch (e) {
            response.resume();
            reject(e);
          }
          return;
        }
        if (!response.statusCode || response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode ?? "?"} downloading model`));
          return;
        }
        const total = parseInt(response.headers["content-length"] ?? "0", 10);
        let downloaded = 0;
        const file = fs.createWriteStream(destPath);
        response.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          if (total > 0) {
            send("progress", {
              downloaded,
              total,
              percent: Math.round((downloaded / total) * 100),
            });
          }
        });
        response.pipe(file);
        file.on("finish", () => resolve());
        file.on("error", reject);
        response.on("error", reject);
      });
      activeHttpReq = httpReq;
      httpReq.on("error", reject);
    });

  try {
    await download(url);
    if (!aborted) {
      await registerModel(modelId, destPath, displayName);
      send("done", { path: destPath, modelId });
    }
  } catch (err) {
    if (!aborted) {
      send("error", { message: err instanceof Error ? err.message : String(err) });
    }
    fs.unlink(destPath, () => {});
  } finally {
    res.end();
  }
});

// ── Recording upload ─────────────────────────────────────────────────────────
// Accepts a raw audio blob and returns a temp path for subsequent transcription.

app.post("/api/upload-recording", upload.single("audio"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No audio file in request" });
    return;
  }
  res.json({ path: req.file.path, originalName: req.file.originalname });
});

// ── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  const actualPort =
    typeof address === 'object' && address !== null ? address.port : PORT;

  // Handshake line consumed by the Tauri Rust host when launched as a sidecar.
  // Keep the exact prefix stable — the Rust parser matches on it.
  console.log(`SPOKN_PORT=${actualPort}`);
  console.log(`[spokn-backend] listening on http://127.0.0.1:${actualPort}`);
  console.log(`[spokn-backend] temp uploads: ${TEMP_DIR}`);

  // Initialise the whisper-cli binary in the background:
  //   - Windows: download the right CUDA/BLAS/CPU variant from GitHub.
  //   - macOS / Linux: probe known install locations (Homebrew, managed bin
  //     dir, WHISPER_CPP_BIN). No download path — whisper.cpp publishes no
  //     POSIX binaries.
  void initBinary((msg) => console.log(`[spokn-binary] ${msg}`)).then((variant) => {
    console.log(`[spokn-binary] ready — variant: ${variant}`);
  }).catch((err) => {
    // The error message from BackendBinaryMissingError already carries
    // platform-appropriate install hints — just forward it. No generic
    // `.exe`-flavored tail.
    console.warn(`[spokn-binary] unavailable: ${String(err)}`);
  });
});

function shutdown(signal: string): void {
  console.log(`[spokn-backend] received ${signal} — shutting down`);
  server.close(() => process.exit(0));
  // Hard-exit if close takes too long (stuck SSE connections, etc.)
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
