#!/usr/bin/env node
// Package the bundled macOS whisper runtime into the Tauri resources dir.
//
// What this script does, in order:
//
//   1. Resolve a source tree containing a built whisper.cpp distribution.
//      Default source is a local Homebrew install (whisper-cpp + ggml + libomp).
//      Override by setting SPOKN_WHISPER_SRC_PREFIX to a custom tree with the
//      same shape (bin/whisper-cli, lib/libwhisper.1.dylib, lib/libggml*.dylib,
//      libexec/libggml-*.so).
//
//   2. Clean + copy files into
//      apps/windows-test-app/src-tauri/resources/whisper/
//      under the canonical layout:
//          bin/whisper-cli
//          lib/libwhisper.1.dylib, libggml.0.dylib, libggml-base.0.dylib, libomp.dylib
//          libexec/libggml-metal.so, libggml-blas.so, libggml-cpu-apple_*.so
//
//   3. Rewrite dynamic-library install names with `install_name_tool` so
//      nothing references `/opt/homebrew/...` anymore. Absolute references
//      become `@rpath/<basename>` and we add rpath entries so `@rpath`
//      resolves to the bundle's `whisper/lib/` at runtime.
//
//   4. Verify with `otool -L` that zero `/opt/homebrew` refs remain. Script
//      exits non-zero if any slip through — fails loudly rather than
//      shipping a broken bundle.
//
//   5. Optionally codesign each binary with the identity from the
//      SPOKN_CODESIGN_IDENTITY env var. Ad-hoc signature (-) is the default
//      so the binary is valid on the dev machine; a real Developer ID
//      signing pass belongs in the `tauri build` release pipeline, not here.
//
// Idempotent: re-running on the same source produces byte-identical output
// (barring codesign seals, which change per run). Refuses to run off macOS.
//
// This script is a dev tool. It's run manually before `tauri build` for
// distribution. It does NOT run on `tauri dev` — dev runs fall through to
// the Homebrew probe in binaryManager.ts.

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as os from "node:os";

// ── Boilerplate ──────────────────────────────────────────────────────────────

if (process.platform !== "darwin") {
  console.error("[package-whisper] refusing to run off macOS — no-op.");
  process.exit(0);
}

for (const tool of ["install_name_tool", "otool", "codesign"]) {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
  } catch {
    console.error(
      `[package-whisper] required tool not on PATH: ${tool}\n` +
        `Install Xcode Command Line Tools: xcode-select --install`,
    );
    process.exit(1);
  }
}

// Use fileURLToPath so spaces in the repo path ("STT CORE") aren't left as
// %20 — path.resolve would otherwise emit directories with literal "%20"
// in the name and we'd silently write to the wrong tree.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const DEST = path.join(APP_DIR, "src-tauri", "resources", "whisper");

const log = (msg) => console.log(`[package-whisper] ${msg}`);

// ── Source resolution ────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
}

function brewPrefix(formula) {
  return run("brew", ["--prefix", formula]);
}

function resolveSource() {
  const override = process.env.SPOKN_WHISPER_SRC_PREFIX;
  if (override) {
    log(`source: SPOKN_WHISPER_SRC_PREFIX=${override}`);
    const binaryPath = path.join(override, "bin", "whisper-cli");
    if (!existsSync(binaryPath)) {
      throw new Error(
        `SPOKN_WHISPER_SRC_PREFIX set to ${override} but no whisper-cli at ${binaryPath}`,
      );
    }
    return {
      kind: "prefix",
      whisperCliBin: binaryPath,
      whisperLibDir: path.join(override, "lib"),
      ggmlLibDir: path.join(override, "lib"),
      ggmlLibexecDir: path.join(override, "libexec"),
      libompDylib: path.join(override, "lib", "libomp.dylib"),
    };
  }

  // Default: assemble from Homebrew. whisper-cpp + ggml + libomp are
  // separate formulae; brew --prefix resolves each to its canonical Cellar
  // symlink so we stay version-independent.
  let whisperPrefix, ggmlPrefix, libompPrefix;
  try {
    whisperPrefix = brewPrefix("whisper-cpp");
    ggmlPrefix = brewPrefix("ggml");
    libompPrefix = brewPrefix("libomp");
  } catch (err) {
    throw new Error(
      `Homebrew formulae not installed. Install first:\n` +
        `  brew install whisper-cpp libomp\n` +
        `Or set SPOKN_WHISPER_SRC_PREFIX to a pre-built tree.\n` +
        `Underlying error: ${err.message}`,
    );
  }
  log(`source: whisper-cpp=${whisperPrefix}`);
  log(`source: ggml=${ggmlPrefix}`);
  log(`source: libomp=${libompPrefix}`);
  return {
    kind: "homebrew",
    whisperCliBin: path.join(whisperPrefix, "bin", "whisper-cli"),
    whisperLibDir: path.join(whisperPrefix, "lib"),
    ggmlLibDir: path.join(ggmlPrefix, "lib"),
    ggmlLibexecDir: path.join(ggmlPrefix, "libexec"),
    libompDylib: path.join(libompPrefix, "lib", "libomp.dylib"),
  };
}

// ── Copy + layout ────────────────────────────────────────────────────────────

const PLACEHOLDER_CONTENTS =
  "Placeholder — keeps the Tauri resource glob non-empty on fresh clones.\n" +
  "Overwritten every time scripts/package-whisper-macos.mjs runs.\n" +
  "Not harmful in the shipped bundle — see resources/README.md.\n";

async function clean() {
  await fs.rm(DEST, { recursive: true, force: true });
  for (const sub of ["bin", "lib", "libexec"]) {
    await fs.mkdir(path.join(DEST, sub), { recursive: true });
    // Tauri's per-subdir globs (`bin/*`, `lib/*`, `libexec/*`) require at
    // least one file in each dir. The PLACEHOLDERs are restored on every
    // run so Tauri builds cleanly both immediately after this script and
    // on a fresh clone before the script has been run.
    await fs.writeFile(
      path.join(DEST, sub, "PLACEHOLDER"),
      PLACEHOLDER_CONTENTS,
    );
  }
}

async function copyFile(src, dst, mode) {
  await fs.copyFile(src, dst);
  if (mode !== undefined) await fs.chmod(dst, mode);
}

async function stage(src) {
  // whisper-cli
  const dstBin = path.join(DEST, "bin", "whisper-cli");
  await copyFile(src.whisperCliBin, dstBin, 0o755);
  log(`copied: bin/whisper-cli`);

  // whisper dylib — note the canonical "1" in libwhisper.1.dylib is the
  // versioned name that the binary references; copy that specific symlink
  // target (resolveSymlink) so we don't ship a broken link.
  //
  // Mode: Homebrew files are 0444 (read-only), which breaks Tauri's
  // bundle.resources copy step later. Force 0644 so Tauri can re-copy.
  // install_name_tool + codesign both need write access during this
  // script, then the bundle copies cleanly afterwards.
  const libwhisperSrc = await resolveSymlink(
    path.join(src.whisperLibDir, "libwhisper.1.dylib"),
  );
  await copyFile(libwhisperSrc, path.join(DEST, "lib", "libwhisper.1.dylib"), 0o644);

  // ggml dylibs (same "0" versioned-name convention)
  for (const name of ["libggml.0.dylib", "libggml-base.0.dylib"]) {
    const srcPath = await resolveSymlink(path.join(src.ggmlLibDir, name));
    await copyFile(srcPath, path.join(DEST, "lib", name), 0o644);
  }
  log(`copied: lib/*.dylib (whisper + ggml)`);

  // libomp — optional; only copy if present. Needed by the
  // libggml-cpu-apple_* backends on Apple Silicon. Without it, those
  // backends fail to load but Metal still works, so the app transcribes.
  if (existsSync(src.libompDylib)) {
    const libompSrc = await resolveSymlink(src.libompDylib);
    await copyFile(libompSrc, path.join(DEST, "lib", "libomp.dylib"), 0o644);
    log(`copied: lib/libomp.dylib`);
  } else {
    log(`skipped: libomp.dylib (not found — CPU backends may not load)`);
  }

  // ggml backend plugins
  const backendEntries = await fs.readdir(src.ggmlLibexecDir);
  for (const name of backendEntries) {
    if (!name.startsWith("libggml-") || !name.endsWith(".so")) continue;
    await copyFile(
      path.join(src.ggmlLibexecDir, name),
      path.join(DEST, "libexec", name),
      0o755,
    );
  }
  log(`copied: libexec/libggml-*.so (${backendEntries.length} plugin(s))`);
}

async function resolveSymlink(p) {
  // Homebrew's `lib` dir contains symlinks like libwhisper.1.dylib →
  // ../libwhisper.1.8.4.dylib. realpath gives us the actual file.
  try {
    const real = await fs.realpath(p);
    return real;
  } catch {
    return p;
  }
}

// ── Install-name rewriting ───────────────────────────────────────────────────
//
// Goal: every non-system reference in the shipped binaries must resolve via
// the app bundle, not /opt/homebrew. We rewrite absolute refs to
// `@rpath/<basename>` and add rpaths so `@rpath` resolves to our lib dir.
//
// Rpath geometry (at runtime, inside Spokn.app/Contents/Resources/whisper):
//   bin/whisper-cli          → rpath `@executable_path/../lib`   → resolves to  lib/
//   lib/libwhisper.1.dylib   → rpath `@loader_path`              → resolves to  lib/ (self dir)
//   lib/libggml.0.dylib      → rpath `@loader_path`              → resolves to  lib/
//   libexec/libggml-*.so     → rpath `@loader_path/../lib`       → resolves to  lib/

function installNameTool(args) {
  // install_name_tool mutates in place. -change is idempotent only if the
  // path to rewrite still matches; after rewrite the next invocation with
  // the same old→new pair fails silently (new path doesn't match), which
  // is OK for our single-pass use.
  execFileSync("install_name_tool", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function hasRpath(file, rpath) {
  const out = execFileSync("otool", ["-l", file], { encoding: "utf8" });
  // Each LC_RPATH block contains a `path <value>` line.
  const re = /LC_RPATH[\s\S]*?path (.+?) \(offset/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    if (m[1].trim() === rpath) return true;
  }
  return false;
}

function addRpath(file, rpath) {
  if (hasRpath(file, rpath)) return;
  installNameTool(["-add_rpath", rpath, file]);
}

const REWRITES = [
  // /opt/homebrew/opt/whisper-cpp/lib/libwhisper.1.dylib → @rpath/libwhisper.1.dylib
  {
    match: (p) => /\/opt\/homebrew\/.*\/libwhisper\.1\.dylib$/.test(p),
    to: "@rpath/libwhisper.1.dylib",
  },
  {
    match: (p) => /\/opt\/homebrew\/.*\/libggml\.0\.dylib$/.test(p),
    to: "@rpath/libggml.0.dylib",
  },
  {
    match: (p) => /\/opt\/homebrew\/.*\/libggml-base\.0\.dylib$/.test(p),
    to: "@rpath/libggml-base.0.dylib",
  },
  {
    match: (p) => /\/opt\/homebrew\/.*\/libomp\.dylib$/.test(p),
    to: "@rpath/libomp.dylib",
  },
];

function currentDeps(file) {
  const out = execFileSync("otool", ["-L", file], { encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.replace(/\(.+\)\s*$/, "").trim())
    .filter((line) => line.length > 0);
}

function rewriteDylibRefs(file) {
  const deps = currentDeps(file);
  for (const dep of deps) {
    const rule = REWRITES.find((r) => r.match(dep));
    if (!rule) continue;
    if (dep === rule.to) continue;
    installNameTool(["-change", dep, rule.to, file]);
  }
}

function setSelfName(file, name) {
  installNameTool(["-id", name, file]);
}

async function rewriteAll() {
  const whisperCli = path.join(DEST, "bin", "whisper-cli");
  const libwhisper = path.join(DEST, "lib", "libwhisper.1.dylib");
  const libggml = path.join(DEST, "lib", "libggml.0.dylib");
  const libggmlBase = path.join(DEST, "lib", "libggml-base.0.dylib");
  const libomp = path.join(DEST, "lib", "libomp.dylib");

  // Binary: rewrite external refs, add rpath to siblings.
  rewriteDylibRefs(whisperCli);
  addRpath(whisperCli, "@executable_path/../lib");

  // Dylibs: rewrite their own `id` + any external refs, add self-local rpath.
  for (const lib of [libwhisper, libggml, libggmlBase]) {
    setSelfName(lib, `@rpath/${path.basename(lib)}`);
    rewriteDylibRefs(lib);
    addRpath(lib, "@loader_path");
  }
  if (existsSync(libomp)) {
    setSelfName(libomp, "@rpath/libomp.dylib");
    addRpath(libomp, "@loader_path");
  }

  // Backends: add rpath `@loader_path/../lib` so `@rpath/libggml-base.0.dylib`
  // resolves to our lib dir. libggml-cpu-apple_*.so also need libomp
  // rewriting since its hardcoded Homebrew path was the one we saw.
  // Skip PLACEHOLDER (text file — install_name_tool would refuse it).
  const libexecDir = path.join(DEST, "libexec");
  for (const name of await fs.readdir(libexecDir)) {
    if (!name.endsWith(".so")) continue;
    const pluginPath = path.join(libexecDir, name);
    rewriteDylibRefs(pluginPath);
    addRpath(pluginPath, "@loader_path/../lib");
  }
  log(`rewrote install names + added rpaths`);
}

// ── Verify ───────────────────────────────────────────────────────────────────

async function verifyNoHomebrewLeaks() {
  const failures = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // Skip text placeholders — otool would error on non-Mach-O input.
      if (!(entry.name.endsWith(".dylib") || entry.name.endsWith(".so") ||
            entry.name === "whisper-cli")) {
        continue;
      }
      const out = execFileSync("otool", ["-L", full], { encoding: "utf8" });
      if (/\/opt\/homebrew\//.test(out)) {
        failures.push(full);
      }
    }
  }
  await walk(DEST);
  if (failures.length > 0) {
    console.error(
      `[package-whisper] FAILED — these files still reference /opt/homebrew:`,
    );
    for (const f of failures) {
      console.error(`  ${f}`);
      const out = execFileSync("otool", ["-L", f], { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        if (line.includes("/opt/homebrew/")) console.error(`      ${line.trim()}`);
      }
    }
    process.exit(1);
  }
  log(`verify: zero /opt/homebrew references in staged tree`);
}

// ── Codesign ─────────────────────────────────────────────────────────────────
//
// Dev default: ad-hoc sign with `-`. Enough for `cargo run` / `tauri dev`
// on the packaging machine and for running the unsigned app locally.
// Real Developer ID signing + notarization belongs in the `tauri build`
// release pipeline (Tauri handles the main .app; our resources ride along).

function codesignAll(identity) {
  const iterable = [path.join(DEST, "bin", "whisper-cli")];
  for (const sub of ["lib", "libexec"]) {
    const dir = path.join(DEST, sub);
    for (const name of execFileSync("ls", [dir], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)) {
      // Only Mach-O objects are signable; skip the PLACEHOLDER text file
      // (and anything else that's not a dylib or loadable bundle).
      if (!(name.endsWith(".dylib") || name.endsWith(".so"))) continue;
      iterable.push(path.join(dir, name));
    }
  }
  for (const file of iterable) {
    execFileSync(
      "codesign",
      ["--force", "--sign", identity, "--timestamp=none", file],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  }
  log(`codesigned ${iterable.length} binaries with identity="${identity}"`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const src = resolveSource();
  await clean();
  await stage(src);
  await rewriteAll();
  await verifyNoHomebrewLeaks();

  const identity = process.env.SPOKN_CODESIGN_IDENTITY ?? "-";
  codesignAll(identity);

  const dstBin = path.join(DEST, "bin", "whisper-cli");
  log(`done — ${dstBin}`);
  log(`arch: ${os.arch()}   source: ${src.kind}`);
  log(`staged at: ${DEST}`);
}

main().catch((err) => {
  console.error(`[package-whisper] ${err.message}`);
  process.exit(1);
});
