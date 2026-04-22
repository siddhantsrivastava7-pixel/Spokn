# stt-platform-windows

Windows runtime adapter for [`@stt/core`](../stt-core). Enables fully offline, local speech-to-text transcription on Windows by implementing the `STTRuntimeAdapter` seam from core and delegating inference to **whisper.cpp**.

---

## Architecture

```
@stt/core (platform-agnostic)
  └─ STTRuntimeAdapter (interface)
        └─ WindowsSTTRuntimeAdapter   ← this package
              ├─ WindowsModelStore    — manages local model files
              └─ LocalSTTBackend (interface)
                    └─ WhisperCppBackend  — first implementation
```

`@stt/core` owns: routing, settings, chunk planning, transcript normalization.  
This package owns: model file management, whisper.cpp process execution, output parsing.

---

## How to use

```ts
import { transcribeFile } from "@stt/core";
import { WindowsSTTRuntimeAdapter, getWindowsDeviceProfile } from "@stt/platform-windows";

const runtimeAdapter = new WindowsSTTRuntimeAdapter();
const deviceProfile = await getWindowsDeviceProfile();

const result = await transcribeFile({
  input: {
    audioPath: "C:/recordings/sample.wav",
    durationMs: 42000,
  },
  settings: {
    mode: "auto",
    language: "hinglish",
    timestamps: true,
    offlineOnly: true,
  },
  deviceProfile,
  runtimeAdapter,
  userSpeechProfile: {
    countryCode: "IN",
    primaryLanguages: ["en", "hi"],
    mixesLanguages: true,
  },
});

console.log(result.transcript.fullText);
```

---

## Model storage

Models are stored at:

```
%LOCALAPPDATA%\stt-platform-windows\models\<model-id>\<model-file>.gguf
```

A `manifest.json` in the models root tracks installed models.

### Registering a model

Download a GGUF weight file from your chosen source, then:

```ts
const store = runtimeAdapter.getModelStore();
await store.registerModel(
  "whisper-turbo",
  "C:/Downloads/ggml-whisper-turbo.gguf",
  "Whisper Turbo"
);
```

The model id must match an id registered in the `@stt/core` model registry.

---

## whisper.cpp invocation

This package calls `whisper-cli.exe` (the main CLI binary from the whisper.cpp project).

### Binary location

Place `whisper-cli.exe` at:

```
%LOCALAPPDATA%\stt-platform-windows\bin\whisper-cli.exe
```

Or override the path via environment variable:

```
WHISPER_CPP_BIN=C:\tools\whisper-cli.exe
```

Or pass it explicitly:

```ts
import { WhisperCppBackend } from "@stt/platform-windows";

const backend = new WhisperCppBackend({
  binaryPath: "C:\\tools\\whisper-cli.exe",
  timeoutMs: 120_000,
});
const adapter = new WindowsSTTRuntimeAdapter({ backend });
```

### CLI flags used

| Flag | Purpose |
|---|---|
| `-f <audio>` | Input audio file |
| `-m <model>` | GGUF model path |
| `-l <lang>` | Language code (`auto` for multilingual/hinglish) |
| `-oj` | Write JSON output to `<audio>.json` |
| `--no-prints` | Suppress progress bar noise on stderr |
| `--split-on-word` | Finer segment boundaries when timestamps requested |
| `--offset-t <ms>` | Start offset for chunk transcription |
| `--duration <ms>` | Duration for chunk transcription |

Output is parsed from the JSON file whisper-cli writes alongside the audio.

### Output format

whisper.cpp JSON (`-oj`) is written to `<audioPath>.json` and contains:

```json
{
  "result": { "language": "english" },
  "transcription": [
    {
      "offsets": { "from": 0, "to": 3120 },
      "timestamps": { "from": "00:00:00,000", "to": "00:00:03,120" },
      "text": " Hello world",
      "tokens": [{ "text": "Hello", "p": 0.95 }]
    }
  ]
}
```

Token probabilities (`p`) are averaged into a per-segment `confidence` value. If tokens are absent, confidence is omitted rather than faked.

---

## Swapping the backend

`WhisperCppBackend` implements `LocalSTTBackend`. To use a different inference backend:

```ts
import type { LocalSTTBackend, BackendTranscriptionRequest, BackendTranscriptionResponse } from "@stt/platform-windows";

class MyCustomBackend implements LocalSTTBackend {
  readonly name = "my-backend";
  async isAvailable() { return true; }
  async transcribe(req: BackendTranscriptionRequest): Promise<BackendTranscriptionResponse> {
    // ...
  }
}

const adapter = new WindowsSTTRuntimeAdapter({ backend: new MyCustomBackend() });
```

---

## Limitations (v0.1)

- No model download logic — models must be placed manually or via `store.registerModel()`.
- Audio must already be a format whisper.cpp accepts (WAV 16 kHz mono recommended). Audio normalization is the caller's responsibility; `@stt/core` has normalization helpers.
- Confidence is only available when whisper.cpp is built with token probability output (default in recent builds).
- whisper.cpp binary must be obtained and placed separately.
- Battery/power detection is approximate (checks active power scheme name).

---

## Future extension points

- Model downloader / installer via `WindowsModelStore.registerModel()`
- GPU / CUDA backend via a separate `LocalSTTBackend` implementation
- faster-whisper or Whisper.NET as alternative backends
- Audio normalization pre-pass using ffmpeg
- Streaming transcription once whisper.cpp supports it stably
