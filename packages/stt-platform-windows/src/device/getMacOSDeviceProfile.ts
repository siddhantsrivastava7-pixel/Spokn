import * as os from "os";
import { execProcess } from "../utils/execProcess";
import type { DeviceProfile, CpuTier, GpuVendor } from "@stt/core";

/**
 * Returns a `DeviceProfile` for the current macOS machine.
 *
 * Lightweight detection — `os` module for RAM / CPU count, `sysctl` +
 * `df` for storage + CPU-brand refinement, `pmset` for low-power mode.
 * Everything has a fast fallback so first-request latency stays low.
 *
 * GPU model: we don't try to enumerate discrete GPUs here. Apple Silicon
 * Macs have integrated Metal (always present); Intel Macs may have an
 * AMD dGPU plus Intel iGPU, but whisper.cpp on macOS uses Metal which
 * accesses whichever GPU the OS chooses. Reporting `vendor: "apple"` on
 * Apple Silicon and `"intel"` on older Intel Macs is the minimum useful
 * signal; VRAM is intentionally 0 (unified memory on AS, unknown on Intel).
 */
export async function getMacOSDeviceProfile(): Promise<DeviceProfile> {
  const ramMB = Math.round(os.totalmem() / (1024 * 1024));

  const [cpuTier, storageAvailableMB, lowPowerMode, gpu] = await Promise.all([
    detectCpuTier(),
    getStorageAvailableMB(),
    isLowPowerModeActive(),
    detectGpu(),
  ]);

  return {
    platform: "macos",
    cpuTier,
    ramMB,
    storageAvailableMB,
    batterySaverActive: lowPowerMode,
    lowPowerMode,
    hasGpu: gpu.hasGpu,
    gpuVendor: gpu.vendor,
    gpuVramMB: gpu.vramMB,
    cudaRuntimeAvailable: false,
    osVersion: os.release(),
  };
}

async function detectCpuTier(): Promise<CpuTier> {
  try {
    const logicalCores = os.cpus().length;

    // Apple Silicon core counts: M1 = 8 (4P+4E), M1 Pro/Max = 10, M2 = 8,
    // M3 = 8, M2/M3 Pro = 10–12, Max = 12–16, Ultra = 20–24. Intel Macs
    // range 4–16. 16+ logical → high; 10+ → high (modern M-series Pro/Max);
    // 8 logical → mid (baseline M1/M2/M3); anything less → low.
    if (logicalCores >= 16) return "high";
    if (logicalCores >= 10) return "high";
    if (logicalCores >= 8) return "mid";
    if (logicalCores >= 4) return "mid";
    return "low";
  } catch {
    return "mid";
  }
}

async function getStorageAvailableMB(): Promise<number> {
  try {
    // `df -k /` → "Filesystem 1024-blocks Used Available …"; Available is
    // column 4. We parse the second line.
    const result = await execProcess("df", ["-k", "/"], { timeoutMs: 3_000 });
    const lines = result.stdout.trim().split(/\r?\n/);
    const dataLine = lines[1];
    if (dataLine) {
      const cols = dataLine.split(/\s+/);
      const availableKB = Number(cols[3]);
      if (Number.isFinite(availableKB)) {
        return Math.round(availableKB / 1024);
      }
    }
  } catch {
    // df may not be in PATH in some stripped-down sandboxes
  }
  return 10_240;
}

interface GpuInfo {
  hasGpu: boolean;
  vendor: GpuVendor;
  vramMB: number;
}

async function detectGpu(): Promise<GpuInfo> {
  // `sysctl hw.optional.arm64` → 1 on Apple Silicon, 0 or missing on Intel.
  // That's enough to pick between "apple" (integrated Metal GPU) and "intel".
  // We avoid `system_profiler SPDisplaysDataType` — it's slow (100s of ms)
  // and parseable output varies across macOS releases.
  try {
    const result = await execProcess("sysctl", ["-n", "hw.optional.arm64"], {
      timeoutMs: 2_000,
    });
    const isAppleSilicon = result.stdout.trim() === "1";
    if (isAppleSilicon) {
      return { hasGpu: true, vendor: "apple", vramMB: 0 };
    }
  } catch {
    // fall through
  }

  // Intel Mac — Metal still works (whisper.cpp supports it), but the vendor
  // reporting is Intel iGPU as the conservative choice. A dedicated AMD
  // would be detectable via system_profiler if needed, but for routing
  // decisions in stt-core, `hasGpu: true, vendor: "intel"` is sufficient.
  return { hasGpu: true, vendor: "intel", vramMB: 0 };
}

async function isLowPowerModeActive(): Promise<boolean> {
  try {
    // `pmset -g` prints the current power-management settings. When Low
    // Power Mode is on, a line containing "lowpowermode 1" appears.
    const result = await execProcess("pmset", ["-g"], { timeoutMs: 3_000 });
    return /lowpowermode\s+1/.test(result.stdout);
  } catch {
    return false;
  }
}
