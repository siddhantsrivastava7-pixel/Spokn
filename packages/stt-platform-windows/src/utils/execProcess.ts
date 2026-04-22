import { spawn } from "child_process";
import { BackendExecutionError } from "../errors";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
}

/**
 * Spawns a child process and collects its output.
 * Rejects with BackendExecutionError on non-zero exit or timeout.
 */
export async function execProcess(
  executable: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 300_000, cwd } = options;

    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new BackendExecutionError(
          `Process timed out after ${timeoutMs}ms: ${executable}`,
          { executable, args, exitCode: -1, stderr: "" }
        )
      );
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new BackendExecutionError(
          `Failed to spawn process: ${err.message}`,
          { executable, args, exitCode: -1, stderr: err.message }
        )
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      if (exitCode !== 0) {
        reject(
          new BackendExecutionError(
            `Process exited with code ${exitCode}: ${executable}\n${stderr.trim()}`,
            { executable, args, exitCode, stderr }
          )
        );
        return;
      }

      resolve({ stdout, stderr, exitCode });
    });
  });
}
