import * as path from "path";
import { getBinDir } from "../utils/pathUtils";
import { fileExists } from "../utils/fsUtils";
import { execProcess } from "../utils/execProcess";
import { buildWhisperArgs } from "./buildWhisperArgs";
import { parseWhisperJsonFile } from "./parseWhisperOutput";
import { BackendBinaryMissingError } from "../errors";
import type { LocalSTTBackend, BackendTranscriptionRequest, BackendTranscriptionResponse } from "./backendTypes";

/**
 * Default whisper.cpp binary filename for the current platform.
 * macOS / Linux ship the CLI as `whisper-cli`; Windows ships `whisper-cli.exe`.
 * Exported so `binaryManager` and tests can reference the same spelling.
 */
export const DEFAULT_BINARY_NAME =
  process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

export interface WhisperCppBackendOptions {
  /**
   * Absolute path to the whisper-cli executable. Default per platform:
   *   - Windows: `%LOCALAPPDATA%/stt-platform-windows/bin/whisper-cli.exe`
   *   - macOS:   `~/Library/Application Support/spokn/bin/whisper-cli`
   *   - Linux:   `~/.local/share/spokn/bin/whisper-cli`
   * Can also be set via the WHISPER_CPP_BIN environment variable, which is
   * the primary install-path escape hatch for macOS until we ship a bundled
   * binary or in-app download.
   */
  binaryPath?: string;
  /** Process timeout in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
}

export class WhisperCppBackend implements LocalSTTBackend {
  readonly name = "whisper.cpp";

  private readonly binaryPath: string;
  private readonly timeoutMs: number;

  constructor(options: WhisperCppBackendOptions = {}) {
    this.binaryPath =
      options.binaryPath ??
      process.env["WHISPER_CPP_BIN"] ??
      path.join(getBinDir(), DEFAULT_BINARY_NAME);

    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async isAvailable(): Promise<boolean> {
    return fileExists(this.binaryPath);
  }

  async transcribe(
    req: BackendTranscriptionRequest
  ): Promise<BackendTranscriptionResponse> {
    if (!(await this.isAvailable())) {
      throw new BackendBinaryMissingError(this.binaryPath);
    }

    const args = buildWhisperArgs(req);

    // whisper-cli writes <audioPath>.json automatically when -oj is passed.
    // We run the process and then read that file.
    await execProcess(this.binaryPath, args, {
      timeoutMs: this.timeoutMs,
      cwd: path.dirname(req.audioPath),
    });

    return parseWhisperJsonFile(req.audioPath);
  }

  getBinaryPath(): string {
    return this.binaryPath;
  }
}
