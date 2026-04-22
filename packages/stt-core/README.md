# stt-core

Platform-agnostic offline speech-to-text engine. This package is the reusable core SDK — not an app, not a UI, not a platform bridge. It handles model registry, capability-based routing, transcription orchestration, and output normalization. Platform bridges (Windows, macOS, iOS, Android) plug in via the `STTRuntimeAdapter` interface.

---

## Architecture

```
packages/stt-core/
  src/
    types/         — all shared interfaces and primitives
    models/        — model registry + capability helpers
    settings/      — schema, defaults, validation
    routing/       — capability-based model selection
    audio/         — chunk planning, merge helpers, normalization contracts
    pipeline/      — orchestration (transcribeFile entry point)
    transcript/    — schema, utilities, serializer, SRT/text export
    storage/       — abstract storage contracts (no implementations)
    utils/         — id generation, time formatting
    index.ts       — public API surface
  tests/
    routing.test.ts
    settings.test.ts
    transcript.test.ts
```

### Key design decisions

**Runtime adapter pattern** — `stt-core` never calls native APIs directly. All inference is delegated to an `STTRuntimeAdapter` that each platform bridge implements. This is the only integration point between the core and a concrete platform.

**Capability-based routing** — model selection is driven by device profile traits (RAM, CPU tier, storage) and model capability metadata, not hardcoded names. Adding a new model means adding a registry entry, not changing routing logic.

**Stable user-facing modes** — `auto | fast | balanced | best_accuracy` are the stable public contract. Internally they map to capability rankings. If a better model ships, swap the registry entry; the app API stays the same.

**Contracts, not implementations, for storage** — `ModelStorage`, `TranscriptStorage`, and `SettingsStorage` are TypeScript interfaces. Platform bridges implement them using whatever persistence mechanism fits (SQLite, MMKV, NSUserDefaults, etc.).

---

## Quick start

### 1. Implement the runtime adapter for your platform

```ts
import type { STTRuntimeAdapter, RuntimeTranscriptionRequest, RuntimeTranscriptionResponse } from "@stt/core";

class MyNativeBridge implements STTRuntimeAdapter {
  async getAvailableModelIds(): Promise<string[]> {
    return NativeSTT.listInstalledModels();
  }

  async isModelInstalled(modelId: string): Promise<boolean> {
    return NativeSTT.isInstalled(modelId);
  }

  async transcribe(req: RuntimeTranscriptionRequest): Promise<RuntimeTranscriptionResponse> {
    return NativeSTT.run(req);
  }
}
```

### 2. Transcribe a file

```ts
import { transcribeFile, mergeWithDefaults } from "@stt/core";
import type { DeviceProfile } from "@stt/core";

const deviceProfile: DeviceProfile = {
  platform: "macos",
  cpuTier: "high",
  ramMB: 16384,
  storageAvailableMB: 50000,
  batterySaverActive: false,
  lowPowerMode: false,
  hasNeuralEngine: true,
};

const result = await transcribeFile({
  input: {
    audioPath: "/path/to/recording.wav",
    durationMs: 120_000,
    sampleRate: 16000,
  },
  settings: mergeWithDefaults({ mode: "balanced", language: "en" }),
  deviceProfile,
  runtimeAdapter: new MyNativeBridge(),
});

console.log(result.transcript.fullText);
console.log(`Processed in ${result.processingTimeMs}ms using ${result.modelId}`);
```

### 3. Export a transcript

```ts
import { exportAsSRT, exportAsPlainText, serializeTranscript } from "@stt/core";

const srt = exportAsSRT(result.transcript);
const txt = exportAsPlainText(result.transcript);
const json = serializeTranscript(result.transcript);
```

---

## Model registry

The registry ships with these placeholder entries. Real weight files are loaded by the runtime bridge.

| ID | Display Name | Size | Latency | Languages |
|---|---|---|---|---|
| `whisper-turbo` | Whisper Turbo | 809 MB | fast | multilingual |
| `whisper-large-v3` | Whisper Large v3 | 2880 MB | slow | multilingual |
| `parakeet-v3` | Parakeet v3 | 490 MB | realtime | en |
| `moonshine-base` | Moonshine Base | 195 MB | realtime | en |

Register additional models at runtime:

```ts
import { registerModel } from "@stt/core";

registerModel({
  id: "my-custom-model",
  displayName: "My Custom Model",
  sizeMB: 300,
  capabilities: { ... },
});
```

---

## Settings

```ts
import { DEFAULT_SETTINGS, validateSettings, mergeWithDefaults } from "@stt/core";

const settings = mergeWithDefaults({
  mode: "best_accuracy",
  language: "hi",
  timestamps: true,
  offlineOnly: true,
});

const { valid, errors } = validateSettings(settings);
```

**Supported modes:** `auto | fast | balanced | best_accuracy`  
**Supported languages:** `auto | en | hi | hinglish | multilingual`

---

## Routing

```ts
import { chooseModel, resolveMode } from "@stt/core";

const resolvedMode = resolveMode("auto", deviceProfile); // → "balanced" or "best_accuracy" etc.
const { selectedModel, reason, fallbackCandidates, incompatibilityNotes } =
  chooseModel(settings, deviceProfile, installedModelIds);
```

---

## Storage contracts

Implement these interfaces in your platform bridge. `stt-core` depends on them as abstractions only.

```ts
import type { ModelStorage, TranscriptStorage, SettingsStorage } from "@stt/core";
```

---

## Development

```bash
npm install
npm run build       # compile TypeScript
npm run typecheck   # type-check without emitting
npm test            # run Jest test suite
```

---

## Boundaries

This package does **not**:
- perform model inference
- access the microphone or filesystem
- use cloud APIs
- contain UI
- contain platform-native code

Everything outside these boundaries belongs in a platform bridge that consumes this package.
