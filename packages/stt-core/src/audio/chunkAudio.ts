import type { ChunkPlan, AudioChunk } from "./audioTypes";

/**
 * Produces a chunk plan describing how to split a long audio file.
 * Does not read or write any audio bytes — the runtime bridge uses the plan
 * to seek and extract actual audio segments.
 */
export function planChunks(params: {
  audioPath: string;
  totalDurationMs: number;
  chunkDurationMs: number;
}): ChunkPlan {
  const { audioPath, totalDurationMs, chunkDurationMs } = params;

  if (chunkDurationMs <= 0) {
    throw new Error("chunkDurationMs must be > 0");
  }

  const chunks: AudioChunk[] = [];
  let startMs = 0;
  let index = 0;

  while (startMs < totalDurationMs) {
    const endMs = Math.min(startMs + chunkDurationMs, totalDurationMs);
    chunks.push({ audioPath, startMs, endMs, index });
    startMs = endMs;
    index++;
  }

  return { chunks, totalDurationMs, chunkDurationMs };
}

/** Returns true if the audio is short enough to skip chunking. */
export function needsChunking(
  durationMs: number,
  chunkDurationMs: number
): boolean {
  return durationMs > chunkDurationMs;
}
