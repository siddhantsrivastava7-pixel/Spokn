#!/usr/bin/env node
// Compile src-node/server.ts into a standalone executable named
// `spokn-backend-<rust-target-triple>[.exe]`. Tauri's externalBin resolver
// looks up the bin by that exact suffix, so we match Rust's host triple.
//
// Supports Windows (x86_64) and macOS (Apple Silicon + Intel). Cross-compile
// from Windows to macOS or vice versa is not supported by this script — it
// builds for the host triple only. Universal-binary packaging is a future
// follow-up (see plan file).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const ENTRY = join(APP_ROOT, "src-node", "server.ts");
const OUT_DIR = join(APP_ROOT, "src-tauri", "binaries");

function rustHostTriple() {
  const r = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      "rustc not found on PATH — required to determine host triple for sidecar naming.\n" +
      (r.stderr || ""),
    );
  }
  const match = r.stdout.match(/^host:\s*(\S+)/m);
  if (!match) throw new Error("Could not parse host from `rustc -vV` output");
  return match[1];
}

function bunTargetFor(triple) {
  // Map Rust target triples → bun --target values.
  if (triple.startsWith("x86_64-pc-windows")) return "bun-windows-x64";
  if (triple.startsWith("aarch64-pc-windows")) return "bun-windows-x64"; // bun ships no arm64-windows yet
  if (triple === "aarch64-apple-darwin") return "bun-darwin-arm64";
  if (triple === "x86_64-apple-darwin") return "bun-darwin-x64";
  throw new Error(`No bun --target mapping for host triple: ${triple}`);
}

const triple = rustHostTriple();
const bunTarget = bunTargetFor(triple);
// Tauri appends `.exe` to the externalBin path on Windows and leaves it
// bare on Unix — match that so the sidecar lookup resolves on both.
const exeSuffix = process.platform === "win32" ? ".exe" : "";
const finalPath = join(OUT_DIR, `spokn-backend-${triple}${exeSuffix}`);

mkdirSync(OUT_DIR, { recursive: true });
if (existsSync(finalPath)) rmSync(finalPath);

const tmpOut = join(OUT_DIR, `spokn-backend${exeSuffix}`);

// Resolve bun.exe absolutely — on Windows, the default user install is at
// %USERPROFILE%\.bun\bin\bun.exe. Absolute path + `shell: false` avoids a
// Node-on-Windows flake where nested npm→cmd→node→spawnSync layers can hand
// bun back a null exit code even on success when `stdio: "inherit"` is used.
function resolveBun() {
  if (process.platform !== "win32") return "bun";
  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "bun.exe") : null,
    join(os.homedir(), ".bun", "bin", "bun.exe"),
    "bun.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === "bun.exe") return c; // fall back to PATH lookup
    if (existsSync(c)) return c;
  }
  return "bun.exe";
}

const bunCmd = resolveBun();
const args = [
  "build",
  "--compile",
  `--target=${bunTarget}`,
  ENTRY,
  "--outfile",
  tmpOut,
];

console.log(`[build-backend] ${bunCmd} ${args.join(" ")}`);
// Pipe bun's stdio through explicitly instead of inheriting. On Windows,
// inherited stdio handles through npm→cmd→node sometimes cause bun to exit
// with a null signal after a successful compile. We forward manually and
// treat a null exit code with a produced output file as success.
const r = spawnSync(bunCmd, args, {
  stdio: ["ignore", "pipe", "pipe"],
  cwd: APP_ROOT,
  encoding: "utf8",
});
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
const producedFile = existsSync(tmpOut);
if (r.status !== 0 && !(r.status === null && producedFile)) {
  throw new Error(
    `bun build failed with exit code ${r.status ?? "null"} (signal=${r.signal ?? "none"}, produced=${producedFile})`,
  );
}

// bun --compile writes to the path given; rename to the Tauri-expected suffix.
if (!existsSync(tmpOut)) {
  throw new Error(`Expected compiled binary at ${tmpOut}`);
}
renameSync(tmpOut, finalPath);
console.log(`[build-backend] wrote ${finalPath}`);
