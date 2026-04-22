import type { RuntimeTranscriptionResponse } from "../types";
import type { SegmentTranscriptionParams } from "./pipelineTypes";

/**
 * Calls the runtime adapter for a single audio segment (or the full file).
 * Keeps the pipeline layer thin — all model inference happens inside the adapter.
 */
export async function transcribeSegment(
  params: SegmentTranscriptionParams
): Promise<RuntimeTranscriptionResponse> {
  const { runtimeAdapter, audioPath, modelId, language, timestamps, startMs, endMs, sampleRate, prompt } =
    params;

  const response = await runtimeAdapter.transcribe({
    modelId,
    audioPath,
    language,
    timestamps,
    startMs,
    endMs,
    sampleRate,
    prompt,
  });

  return response;
}
