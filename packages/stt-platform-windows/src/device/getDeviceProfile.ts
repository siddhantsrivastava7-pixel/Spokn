import * as os from "os";
import { getWindowsDeviceProfile } from "./getWindowsDeviceProfile";
import { getMacOSDeviceProfile } from "./getMacOSDeviceProfile";
import type { DeviceProfile } from "@stt/core";

/**
 * Cross-platform entry point — picks the real OS detector by `process.platform`.
 *
 * Callers (e.g. `pipeline.ts`) should prefer this over the OS-specific
 * exports so downstream code doesn't need to branch. The OS-specific
 * functions remain exported for direct use (tests, advanced consumers).
 *
 * Linux / other: no dedicated detector yet — returns a conservative baseline
 * derived from `os.totalmem()` + logical-core count. Enough for routing;
 * swap in a real detector when Linux becomes a shipping target.
 */
export async function getDeviceProfile(): Promise<DeviceProfile> {
  if (process.platform === "win32") {
    return getWindowsDeviceProfile();
  }
  if (process.platform === "darwin") {
    return getMacOSDeviceProfile();
  }
  // Linux / other POSIX — conservative defaults.
  const ramMB = Math.round(os.totalmem() / (1024 * 1024));
  const logicalCores = os.cpus().length;
  const cpuTier = logicalCores >= 8 ? "mid" : logicalCores >= 4 ? "mid" : "low";
  return {
    platform: "linux",
    cpuTier,
    ramMB,
    storageAvailableMB: 10_240,
    batterySaverActive: false,
    lowPowerMode: false,
    hasGpu: false,
    gpuVendor: "unknown",
    gpuVramMB: 0,
    cudaRuntimeAvailable: false,
    osVersion: os.release(),
  };
}
