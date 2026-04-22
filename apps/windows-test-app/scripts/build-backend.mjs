#!/usr/bin/env node
// Compile src-node/server.ts into a standalone Windows executable named
// `spokn-backend-<rust-target-triple>.exe`. Tauri's externalBin resolver
// looks up the bin by that exact suffix, so we match Rust's host triple.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

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
  // Map Rust target triples → bun --target values. Only Windows x64 is
  // supported on the release path today; expand here when other triples are
  // added to CI.
  if (triple.startsWith("x86_64-pc-windows")) return "bun-windows-x64";
  if (triple.startsWith("aarch64-pc-windows")) return "bun-windows-x64"; // bun ships no arm64-windows yet
  throw new Error(`No bun --target mapping for host triple: ${triple}`);
}

const triple = rustHostTriple();
const bunTarget = bunTargetFor(triple);
const finalPath = join(OUT_DIR, `spokn-backend-${triple}.exe`);

mkdirSync(OUT_DIR, { recursive: true });
if (existsSync(finalPath)) rmSync(finalPath);

const tmpOut = join(OUT_DIR, "spokn-backend.exe");

const bunCmd = process.platform === "win32" ? "bun.exe" : "bun";
const args = [
  "build",
  "--compile",
  `--target=${bunTarget}`,
  ENTRY,
  "--outfile",
  tmpOut,
];

console.log(`[build-backend] ${bunCmd} ${args.join(" ")}`);
const r = spawnSync(bunCmd, args, { stdio: "inherit", cwd: APP_ROOT });
if (r.status !== 0) {
  throw new Error(`bun build failed with exit code ${r.status ?? "null"}`);
}

// bun --compile writes to the path given; rename to the Tauri-expected suffix.
if (!existsSync(tmpOut)) {
  throw new Error(`Expected compiled binary at ${tmpOut}`);
}
renameSync(tmpOut, finalPath);
console.log(`[build-backend] wrote ${finalPath}`);
