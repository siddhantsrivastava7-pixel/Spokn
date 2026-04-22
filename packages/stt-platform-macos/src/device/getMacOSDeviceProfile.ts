import * as os from "os";
import type { DeviceProfile, CpuTier } from "@stt/core";

// Stage 1 stub. Returns a conservative mid-tier profile derived from `os`
// module values only — no `system_profiler` / `ioreg` / Metal probes yet.
// Stage 7 replaces this with a real macOS implementation that queries
// hardware details and detects Apple Silicon GPU tiers via Metal.
//
// Keeping this a pure-`os` implementation means it never blocks on an
// external process and is safe to call from the backend startup path while
// the real detection path is being developed.
export async function getMacOSDeviceProfile(): Promise<DeviceProfile> {
  const ramMB = Math.round(os.totalmem() / (1024 * 1024));
  const cpuTier = detectCpuTier();

  return {
    platform: "macos",
    cpuTier,
    ramMB,
    // Conservative placeholder — 10 GB is enough headroom for any of the
    // shipping whisper.cpp models. Real disk-space probe arrives in Stage 7.
    storageAvailableMB: 10_240,
    // macOS surfaces low-power state via a per-process flag
    // (`NSProcessInfo.processInfo.isLowPowerModeEnabled`); reading it needs
    // Objective-C bindings the backend doesn't load. Default to false and
    // revisit once those bindings exist for another purpose.
    batterySaverActive: false,
    lowPowerMode: false,
    // Apple Silicon always has a usable GPU via Metal, but stt-core's GPU
    // model is CUDA/Vulkan-shaped. Leave hasGpu=false for now — Stage 7
    // wires a dedicated Metal path instead of shoehorning it into the
    // CUDA-runtime flag.
    hasGpu: false,
    gpuVendor: "unknown",
    gpuVramMB: 0,
    cudaRuntimeAvailable: false,
    osVersion: os.release(),
  };
}

function detectCpuTier(): CpuTier {
  try {
    const cpus = os.cpus();
    const logicalCores = cpus.length;
    // Apple Silicon M-series reports accurate core counts; Intel Macs too.
    // Speed is reported in MHz but the value is less reliable than cores
    // across Apple chips, so we key on core count first.
    if (logicalCores >= 10) return "high"; // M1 Pro/Max+, M3+, Intel high-end
    if (logicalCores >= 8) return "mid";   // M1/M2 base, older i7
    if (logicalCores >= 4) return "mid";
    return "low";
  } catch {
    return "mid";
  }
}
