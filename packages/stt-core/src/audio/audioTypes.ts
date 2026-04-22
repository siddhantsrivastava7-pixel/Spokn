export interface AudioChunk {
  /** Platform-agnostic reference, same shape as TranscriptionInput.audioPath */
  audioPath: string;
  startMs: number;
  endMs: number;
  index: number;
}

export interface ChunkPlan {
  chunks: AudioChunk[];
  totalDurationMs: number;
  chunkDurationMs: number;
}

export interface NormalizationOptions {
  targetSampleRate: number;
  targetChannels: 1 | 2;
  targetBitDepth: 16 | 32;
}

export const DEFAULT_NORMALIZATION: NormalizationOptions = {
  targetSampleRate: 16_000,
  targetChannels: 1,
  targetBitDepth: 16,
};
