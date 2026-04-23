# Bundled resources for Tauri

This directory is consumed by `tauri.conf.json`'s `bundle.resources` entry.
Everything below `whisper/` is copied into the packaged app bundle at:

- **macOS**: `Spokn.app/Contents/Resources/whisper/`
- **Windows**: `<exe-dir>/resources/whisper/` (currently unused — Windows uses
  the in-app download flow; see `packages/stt-platform-windows/src/binary/binaryManager.ts`)

The `whisper/` directory is gitignored (see `.gitignore`). It's populated
just before `tauri build` by:

```sh
npm run --workspace=apps/windows-test-app package:whisper:macos
```

That script copies whisper-cli + its dylibs + the ggml backend plugins
out of a local source (Homebrew by default) and rewrites dynamic-library
install names so the binary resolves everything within the app bundle
instead of `/opt/homebrew`. The layout the script produces:

```
whisper/
├── bin/
│   └── whisper-cli
├── lib/
│   ├── libwhisper.1.dylib
│   ├── libggml.0.dylib
│   └── libggml-base.0.dylib
└── backends/
    ├── libggml-blas.so
    ├── libggml-metal.so
    └── libggml-cpu-apple_*.so
```

At runtime:
- Rust's `setup()` in `lib.rs` resolves `resource_dir()/whisper/bin/whisper-cli`
  and sets `SPOKN_BUNDLED_WHISPER_CLI` for the backend sidecar.
- The Node backend's POSIX probe prefers that path over Homebrew or `$PATH`.

If `whisper/` is absent (typical for `tauri dev` on a dev machine) the env
vars aren't set and the backend falls through to its usual probe chain
(`WHISPER_CPP_BIN`, managed bin dir, Homebrew).
