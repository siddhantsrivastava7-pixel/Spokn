import * as fs from "fs";
import * as path from "path";
import type { FeedbackEntry, FeedbackStore } from "@stt/core";
import { ensureDir, fileExists } from "../utils/fsUtils";
import { getFeedbackDir, getFeedbackFilePath } from "../utils/pathUtils";

/**
 * Append-only JSONL store for user feedback events.
 *
 * - File:  %LOCALAPPDATA%/stt-platform-windows/feedback/entries.jsonl
 * - Format: one JSON object per line (newline-delimited).
 * - Malformed lines are ignored on read — we never throw on load.
 * - No size cap today; add a rotation pass later if this gets big.
 */
export interface WindowsFeedbackStoreOptions {
  /** Override the file path (tests). */
  filePath?: string;
}

export class WindowsFeedbackStore implements FeedbackStore {
  private readonly filePath: string;

  constructor(opts: WindowsFeedbackStoreOptions = {}) {
    this.filePath = opts.filePath ?? getFeedbackFilePath();
  }

  async append(entry: FeedbackEntry): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    const line = JSON.stringify(entry) + "\n";
    await fs.promises.appendFile(this.filePath, line, "utf-8");
  }

  async list(limit?: number): Promise<FeedbackEntry[]> {
    if (!(await fileExists(this.filePath))) return [];
    const raw = await fs.promises.readFile(this.filePath, "utf-8");
    const entries: FeedbackEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as FeedbackEntry);
      } catch {
        // Skip malformed lines rather than failing the whole read.
      }
    }
    if (typeof limit === "number" && limit >= 0 && entries.length > limit) {
      return entries.slice(entries.length - limit);
    }
    return entries;
  }

  async clear(): Promise<void> {
    if (!(await fileExists(this.filePath))) return;
    await fs.promises.unlink(this.filePath);
  }

  /** Current file path; useful for diagnostics. */
  getFilePath(): string {
    return this.filePath;
  }

  /** Default storage directory. */
  static defaultDir(): string {
    return getFeedbackDir();
  }
}
