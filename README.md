# Spokn

Offline speech-to-text for Windows. Everything runs locally — no audio, no transcripts, no metadata ever leaves your machine.

## Download

Grab the latest Windows installer from the [Releases page](https://github.com/siddhantsrivastava7-pixel/Spokn/releases/latest).

Run the `.exe` and follow the onboarding — Spokn picks the best speech model for your language and hardware, and downloads it on first launch (one-time, a few hundred MB depending on model).

**Requirements:** Windows 10/11, ~2 GB free disk, 4 GB RAM minimum.

## What it does

- Push-to-talk transcription via a global hotkey
- Pastes the transcript into whatever app is focused
- Runs a local [whisper.cpp](https://github.com/ggerganov/whisper.cpp) backend, auto-selecting the CUDA / Vulkan / CPU variant that fits your GPU
- Picks Whisper, Parakeet, or Moonshine based on device profile + language

## Project layout

```
packages/
  stt-core/              TypeScript engine: model registry, routing, post-processing
  stt-platform-windows/  Windows runtime adapter (whisper.cpp CLI, GPU detection)
apps/
  windows-test-app/      Tauri + React desktop app (published as "Spokn")
```

## Build from source

```bash
npm ci
npm run build:packages
cd apps/windows-test-app
npx tauri build
```

Requires Node 20+, [Bun](https://bun.sh) (used to compile the Node backend into a sidecar `.exe`), and the Rust toolchain. The release installer is produced by [`.github/workflows/release.yml`](.github/workflows/release.yml) on every `v*` tag.

## License

[MIT](LICENSE). Bundled third-party components: whisper.cpp (MIT), Whisper model weights (MIT, OpenAI), Parakeet / Moonshine (permissive — see upstream).
