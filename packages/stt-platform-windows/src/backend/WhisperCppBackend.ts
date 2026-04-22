import * as path from "path";
import { getBinDir } from "../utils/pathUtils";
import { fileExists } from "../utils/fsUtils";
import { execProcess } from "../utils/execProcess";
import { buildWhisperArgs } from "./buildWhisperArgs";
import { parseWhisperJsonFile } from "./parseWhisperOutput";
import { BackendBinaryMissingError } from "../errors";
import type { LocalSTTBackend, BackendTranscriptionRequest, BackendTranscriptionResponse } from "./backendTypes";

const DEFAULT_BINARY_NAME = "whisper-cli.exe";

export interface WhisperCppBackendOptions {
  /**
   * Absolute path to whisper-cli.exe.
   * Defaults to %LOCALAPPDATA%/stt-platform-windows/bin/whisper-cli.exe.
   * Can also be set via WHISPER_CPP_BIN environment variable.
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
