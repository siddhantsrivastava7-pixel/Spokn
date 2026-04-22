// Spokn macOS runtime adapter — Stage 1 scaffold.
//
// This package exists so the workspace structure is ready when later stages
// wire macOS-native pieces in. Stage 1 ships only the pieces that genuinely
// differ from Windows:
//
//   - pathUtils        → `~/Library/Application Support/spokn/` vs %LOCALAPPDATA%
//   - device profile   → `os`-module baseline; no wmic equivalent
//
// The backend classes (WhisperCppBackend, MultiBackendAdapter, ModelStore,
// FeedbackStore, binaryManager) are NOT re-ported here yet — most of their
// bodies are platform-agnostic once the app-data path is swapped. A dedicated
// follow-up will either:
//   (a) generalize `@stt/platform-windows` into `@stt/platform-local` so both
//       OSes share one implementation keyed on `getAppDataRoot()`, or
//   (b) port the classes verbatim into this package.
//
// Until that lands, pipeline.ts on macOS still imports `@stt/platform-windows`;
// wiring it to pick this package comes in Stage 5 (Flow Mode parity) once a
// macOS machine is available to exercise the full backend path.

// Paths
export {
  getAppDataRoot,
  getModelsDir,
  getModelDir,
  getBinDir,
  getTempDir,
  getFeedbackDir,
  getFeedbackFilePath,
  getManifestPath,
  sanitizeModelId,
} from "./utils/pathUtils";

// Device profile (Stage 1 stub)
export { getMacOSDeviceProfile } from "./device/getMacOSDeviceProfile";
