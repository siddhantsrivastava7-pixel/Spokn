import * as path from "path";
import { getTempDir } from "./pathUtils";
import { ensureDir, deleteFile } from "./fsUtils";

let _counter = 0;

export async function makeTempPath(ext: string): Promise<string> {
  await ensureDir(getTempDir());
  const name = `stt_${Date.now()}_${++_counter}${ext}`;
  return path.join(getTempDir(), name);
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  await deleteFile(filePath);
}
