import type { Transcript } from "../types";

/** Serializes a Transcript to a JSON string. */
export function serializeTranscript(transcript: Transcript): string {
  return JSON.stringify(transcript, null, 2);
}

/** Deserializes a JSON string back to a Transcript. Throws on invalid input. */
export function deserializeTranscript(json: string): Transcript {
  const parsed = JSON.parse(json);

  // Basic structural guard — not a full runtime schema validator
  const required: (keyof Transcript)[] = [
    "id",
    "fullText",
    "language",
    "modelId",
    "mode",
    "durationMs",
    "segments",
    "createdAt",
    "metadata",
  ];

  for (const key of required) {
    if (parsed[key] === undefined) {
      throw new Error(`Deserialized transcript is missing required field: "${key}"`);
    }
  }

  return parsed as Transcript;
}

/** Returns a plain text export suitable for copy/paste or file export. */
export function exportAsPlainText(transcript: Transcript): string {
  const header = [
    `Transcript`,
    `Language: ${transcript.language}`,
    `Duration: ${(transcript.durationMs / 1000).toFixed(1)}s`,
    `Model: ${transcript.modelId}`,
    `Created: ${transcript.createdAt}`,
    `---`,
  ].join("\n");

  return `${header}\n\n${transcript.fullText}`;
}

/** Returns an SRT-formatted string when timestamp segments are available. */
export function exportAsSRT(transcript: Transcript): string {
  if (transcript.segments.length === 0) return "";

  return transcript.segments
    .map((seg, i) => {
      const start = msToSRTTime(seg.startMs);
      const end = msToSRTTime(seg.endMs);
      return `${i + 1}\n${start} --> ${end}\n${seg.text.trim()}\n`;
    })
    .join("\n");
}

function msToSRTTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":") + `,${String(millis).padStart(3, "0")}`;
}
