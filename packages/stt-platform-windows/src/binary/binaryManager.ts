import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { getBinDir } from "../utils/pathUtils";
import { fileExists, ensureDir, readJsonFile, writeJsonFile } from "../utils/fsUtils";
import { execProcess } from "../utils/execProcess";
import type { DeviceProfile } from "@stt/core";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BinaryVariant = "cpu" | "blas" | "cuda11" | "cuda12";

interface BinaryManifest {
  version: string;
  variant: BinaryVariant;
  binaryPath: string;
  installedAt: string;
}

export interface EnsureBinaryResult {
  binaryPath: string;
  variant: BinaryVariant;
  alreadyInstalled: boolean;
}

// ── GitHub release resolution ─────────────────────────────────────────────────

const REPO = "ggml-org/whisper.cpp";

// Asset name patterns per variant — matched against GitHub release assets
const ASSET_PATTERNS: Record<BinaryVariant, RegExp> = {
  cuda12: /whisper-cublas-12/i,
  cuda11: /whisper-cublas-11/i,
  blas:   /whisper-blas-bin/i,
  cpu:    /^whisper-bin-x64\.zip$/i,
};

interface GithubRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  return new Promise((resolve, reject) => {
    https.get(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { "User-Agent": "stt-platform-windows" } },
      (res) => {
        let data = "";
        res.on("data", (c: string) => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data) as GithubRelease); }
          catch { reject(new Error("Failed to parse GitHub release response")); }
        });
        res.on("error", reject);
      }
    ).on("error", reject);
  });
}

function findAssetUrl(release: GithubRelease, variant: BinaryVariant): string | null {
  const pattern = ASSET_PATTERNS[variant];
  const asset = release.assets.find((a) => pattern.test(a.name));
  return asset?.browser_download_url ?? null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Picks the best whisper-cli binary for this device and ensures it's installed.
 * Downloads from the latest whisper.cpp GitHub release.
 * Falls back automatically on any failure: cuda12 → cuda11 → blas → cpu.
 */
export async function ensureBinary(
  device: DeviceProfile,
  onProgress?: (msg: string) => void
): Promise<EnsureBinaryResult> {
  const manifestPath = path.join(getBinDir(), "binary-manifest.json");
  const desired = chooseBinaryVariant(device);

  // Return early if already installed with same variant and version
  try {
    const manifest = await readJsonFile<BinaryManifest>(manifestPath);
    if (manifest.variant === desired && await fileExists(manifest.binaryPath)) {
      return { binaryPath: manifest.binaryPath, variant: desired, alreadyInstalled: true };
    }
  } catch { /* proceed to download */ }

  onProgress?.("Fetching latest whisper.cpp release info…");
  const release = await fetchLatestRelease();
  onProgress?.(`Latest: ${release.tag_name}`);

  const order = fallbackOrder(desired);
  for (const variant of order) {
    const url = findAssetUrl(release, variant);
    if (!url) {
      onProgress?.(`No ${variant} asset in this release — skipping`);
      continue;
    }
    try {
      onProgress?.(`Downloading whisper-cli (${variantLabel(variant)}) from ${release.tag_name}…`);
      const binaryPath = await downloadAndExtract(url, variant, onProgress);
      const manifest: BinaryManifest = {
        version: release.tag_name,
        variant,
        binaryPath,
        installedAt: new Date().toISOString(),
      };
      await writeJsonFile(manifestPath, manifest);
      onProgress?.(`whisper-cli ready — ${variantLabel(variant)} (${release.tag_name})`);
      return { binaryPath, variant, alreadyInstalled: false };
    } catch (err) {
      onProgress?.(`${variantLabel(variant)} failed: ${String(err)} — trying next`);
    }
  }

  throw new Error("All whisper-cli download attempts failed. Check your internet connection.");
}

/** Returns which binary variant is installed, or null if none. */
export async function getInstalledVariant(): Promise<BinaryVariant | null> {
  const manifestPath = path.join(getBinDir(), "binary-manifest.json");
  try {
    const manifest = await readJsonFile<BinaryManifest>(manifestPath);
    if (await fileExists(manifest.binaryPath)) return manifest.variant;
  } catch { /* not installed */ }
  return null;
}

/** Picks the ideal variant for this device. */
export function chooseBinaryVariant(device: DeviceProfile): BinaryVariant {
  const isNvidia = device.gpuVendor === "nvidia" && (device.gpuVramMB ?? 0) >= 2_048;
  const cuda = (device as DeviceProfile & { cudaRuntimeAvailable?: boolean }).cudaRuntimeAvailable;

  if (isNvidia && cuda) {
    // Prefer CUDA 12 (more modern), fall back to CUDA 11 handled via fallbackOrder
    return "cuda12";
  }

  // BLAS binary (v1.8.4) crashes with large models (GGML_ASSERT in ggml-backend.cpp).
  // CPU binary is fully stable across all model sizes.
  return "cpu";
}

/** Returns true if CUDA runtime DLLs are present on this machine. */
export async function hasCudaRuntime(): Promise<boolean> {
  const candidates = [
    "C:\\Windows\\System32\\cudart64_12.dll",
    "C:\\Windows\\System32\\cudart64_110.dll",
    "C:\\Windows\\System32\\cudart64_11.dll",
  ];
  for (const p of candidates) {
    if (await fileExists(p)) return true;
  }
  try {
    await execProcess("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// ── Internals ─────────────────────────────────────────────────────────────────

function fallbackOrder(preferred: BinaryVariant): BinaryVariant[] {
  if (preferred === "cuda12") return ["cuda12", "cuda11", "blas", "cpu"];
  if (preferred === "cuda11") return ["cuda11", "blas", "cpu"];
  if (preferred === "blas")   return ["blas", "cpu"];
  return ["cpu"];
}

function variantLabel(v: BinaryVariant): string {
  return { cuda12: "CUDA 12", cuda11: "CUDA 11", blas: "BLAS (CPU)", cpu: "CPU" }[v];
}

async function downloadAndExtract(
  url: string,
  variant: BinaryVariant,
  onProgress?: (msg: string) => void
): Promise<string> {
  const binDir = getBinDir();
  await ensureDir(binDir);

  const zipPath = path.join(binDir, `whisper-${variant}.zip`);
  const extractDir = path.join(binDir, `whisper-${variant}`);

  await downloadFile(url, zipPath, (pct) => onProgress?.(`  ${pct}%…`));

  await ensureDir(extractDir);
  try {
    await execProcess("tar", ["-xf", zipPath, "-C", extractDir], { timeoutMs: 60_000 });
  } catch {
    await execProcess("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${extractDir}'`,
    ], { timeoutMs: 60_000 });
  }

  const binaryPath = await findBinary(extractDir);
  if (!binaryPath) throw new Error(`whisper-cli.exe not found in extracted archive`);

  const destPath = path.join(binDir, "whisper-cli.exe");
  await fs.promises.copyFile(binaryPath, destPath);

  // Copy DLLs (CUDA/BLAS DLLs must sit next to the exe)
  const dllDir = path.dirname(binaryPath);
  const entries = await fs.promises.readdir(dllDir);
  for (const entry of entries) {
    if (entry.toLowerCase().endsWith(".dll")) {
      await fs.promises.copyFile(
        path.join(dllDir, entry),
        path.join(binDir, entry)
      ).catch(() => {});
    }
  }

  await fs.promises.rm(zipPath, { force: true });
  await fs.promises.rm(extractDir, { recursive: true, force: true });

  return destPath;
}

async function findBinary(dir: string): Promise<string | null> {
  const NAMES = ["whisper-cli.exe", "main.exe"];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const name of NAMES) {
    const match = entries.find((e) => e.isFile() && e.name.toLowerCase() === name.toLowerCase());
    if (match) return path.join(dir, match.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findBinary(path.join(dir, entry.name));
      if (found) return found;
    }
  }
  return null;
}

function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (targetUrl: string, redirects = 0) => {
      if (redirects > 10) { reject(new Error("Too many redirects")); return; }
      const client = targetUrl.startsWith("https://") ? https : http;
      client.get(targetUrl, { headers: { "User-Agent": "stt-platform-windows" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode ?? "?"} for ${targetUrl}`));
          return;
        }
        const total = Number(res.headers["content-length"] ?? 0);
        let received = 0;
        const file = fs.createWriteStream(destPath);
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0) onProgress?.(Math.round((received / total) * 100));
        });
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", (err) => { fs.unlink(destPath, () => {}); reject(err); });
        res.on("error", reject);
      }).on("error", reject);
    };
    follow(url);
  });
}
