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
    super(
      `whisper.cpp binary not found at: ${binaryPath}\n` +
      `Place whisper-cli.exe in the bin directory or set WHISPER_CPP_BIN env var.`
    );
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
