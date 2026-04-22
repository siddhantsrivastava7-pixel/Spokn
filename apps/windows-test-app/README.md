# STT Windows Test App

Internal Tauri + React desktop app for end-to-end testing of the offline STT pipeline.

**Not a production app.** Optimized for developer visibility and debuggability.

---

## Architecture

```
[Tauri window]
  └─ React UI (port 1420, Vite dev server)
       └─ /api/* proxied to Node.js backend (port 3001)
            └─ @stt/core → transcribeFile()
            └─ @stt/platform-windows → WindowsSTTRuntimeAdapter → whisper.cpp
```

The Tauri shell is minimal — just a window. All STT logic runs in the Node.js backend.

The React frontend never imports from `@stt/core` or `@stt/platform-windows` directly.  
All data flows via HTTP between frontend and the local Express server.

---

## How to run

### Prerequisites

1. [Rust + Tauri prerequisites](https://tauri.app/start/prerequisites/)
2. Node.js 18+
3. `whisper-cli.exe` installed (see `stt-platform-windows` README)
4. At least one model registered in `WindowsModelStore`

### Install

From the **monorepo root**:

```bash
npm install
npm run build:packages   # builds stt-core and stt-platform-windows
```

### Dev mode

```bash
# From monorepo root:
npm run dev

# Or from this app directory:
npm run dev
```

This starts:
- **Node.js backend** on `http://localhost:3001` (tsx watch, hot-reloads)
- **Tauri + Vite** on `http://localhost:1420`

The backend starts first. Tauri opens the window once Vite is ready.

### UI-only mode (no Tauri)

```bash
npm run dev:backend   # terminal 1
npm run dev:ui        # terminal 2, then open http://localhost:1420
```

---

## Connection to stt-core and stt-platform-windows

`src-node/pipeline.ts` is the integration point:

```ts
import { transcribeFile, chooseModel, mergeWithDefaults } from "@stt/core";
import { WindowsSTTRuntimeAdapter, getWindowsDeviceProfile } from "@stt/platform-windows";
```

The adapter singleton is created once per backend process:
```ts
const adapter = new WindowsSTTRuntimeAdapter();
```

Each `/api/transcribe` request:
1. Calls `chooseModel()` to get routing debug info
2. Calls `transcribeFile()` with the same settings
3. Returns `TranscriptionResult + ModelSelectionResult` as JSON

---

## Backend API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Device profile, installed models, whisper.cpp availability |
| GET | `/api/models` | List of installed model IDs |
| GET | `/api/device` | Windows device profile |
| POST | `/api/transcribe` | Run full pipeline — accepts multipart (file upload) or `audioPath` field |

### Transcribe request

**Multipart form fields:**

| Field | Type | Description |
|-------|------|-------------|
| `audio` | File (optional) | Upload audio file |
| `audioPath` | string (optional) | Absolute path on disk (used if no file upload) |
| `settings` | JSON string | `{ mode, language, timestamps, offlineOnly }` |
| `durationMs` | number (optional) | Audio duration hint |
| `userSpeechProfile` | JSON string (optional) | `{ countryCode, primaryLanguages, mixesLanguages }` |

---

## UI panels

- **Left**: Audio source (file path / upload / record) + settings + Transcribe button
- **Right → Transcript tab**: Full text, segments with timestamps + confidence coloring
- **Right → Debug tab**: Model selection result, routing reasons, applied biases, rejected candidates
- **Bottom**: Log panel with expandable stack traces for errors

---

## Assumptions

- Packages (`stt-core`, `stt-platform-windows`) are built before running (`npm run build:packages`)
- whisper.cpp processes `.wav` best; recorded audio is `.webm` — if whisper.cpp doesn't accept it, convert with ffmpeg first
- Audio file path typed into the text box must be accessible from the backend process (i.e., a local Windows path)
- Uploaded files are saved to `%TEMP%\stt-test-app-uploads\` and deleted after transcription

---

## Known limitations

- Recording output is `.webm` — whisper.cpp may reject it. Convert to WAV with ffmpeg if needed.
- No real-time streaming — full file must be processed before results appear
- The "Transcribing…" progress bar is indeterminate (no progress callbacks from whisper.cpp)
