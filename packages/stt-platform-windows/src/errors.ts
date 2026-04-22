export class ModelNotInstalledError extends Error {
  readonly modelId: string;
  constructor(modelId: string) {
    super(`Model not installed: "${modelId}". Add the model file to the Windows model store.`);
    this.name = "ModelNotInstalledError";
    this.modelId = modelId;
  }
}

export class ModelFileNotFoundError extends Error {
  readonly modelId: string;
  readonly expectedPath: string;
  constructor(modelId: string, expectedPath: string) {
    super(`Model file missing for "${modelId}" at path: ${expectedPath}`);
    this.name = "ModelFileNotFoundError";
    this.modelId = modelId;
    this.expectedPath = expectedPath;
  }
}

export class BackendBinaryMissingError extends Error {
  readonly binaryPath: string;
  constructor(binaryPath: string) {
    // On macOS/Linux the caller (`ensureBinary`'s POSIX branch) supplies a
    // multi-line hint as the `binaryPath` — it's the whole install-guidance
    // block, not a path. The generic tail was trimmed because it used to
    // assume `whisper-cli.exe` even on macOS. Use the supplied message
    // verbatim; producers are responsible for making it useful.
    super(`whisper.cpp binary not available. ${binaryPath}`);
    this.name = "BackendBinaryMissingError";
    this.binaryPath = binaryPath;
  }
}

export interface ExecutionErrorContext {
  executable: string;
  args: string[];
  exitCode: number;
  stderr: string;
}

export class BackendExecutionError extends Error {
  readonly context: ExecutionErrorContext;
  constructor(message: string, context: ExecutionErrorContext) {
    super(message);
    this.name = "BackendExecutionError";
    this.context = context;
  }
}

export class OutputParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "OutputParseError";
    this.raw = raw;
  }
}

export class UnsupportedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRequestError";
  }
}
