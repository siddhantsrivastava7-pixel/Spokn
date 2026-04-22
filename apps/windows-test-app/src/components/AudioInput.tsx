import { useRef, useEffect } from "react";
import type { UseRecordingReturn } from "../hooks/useRecording";

interface Props {
  audioPath: string;
  onAudioPathChange: (path: string) => void;
  onFileSelected: (file: File) => void;
  recording: UseRecordingReturn;
  onRecordingComplete: (blob: Blob) => void;
}

export function AudioInput({
  audioPath,
  onAudioPathChange,
  onFileSelected,
  recording,
  onRecordingComplete,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Notify parent when a recording finishes (blob becomes available after isRecording → false)
  useEffect(() => {
    if (recording.recordingBlob && !recording.isRecording) {
      onRecordingComplete(recording.recordingBlob);
      recording.clearRecording();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.recordingBlob, recording.isRecording]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    onFileSelected(file);
    onAudioPathChange(`[uploaded] ${file.name}`);
  }

  function handleStopRecording() {
    recording.stopRecording();
  }

  return (
    <div className="p-4 border-b border-gray-700">
      <div className="text-xs font-bold text-gray-400 uppercase mb-2">Audio Source</div>

      {/* Path input */}
      <div className="flex gap-1 mb-2">
        <input
          type="text"
          value={audioPath}
          onChange={(e) => onAudioPathChange(e.target.value)}
          placeholder="C:\path\to\audio.wav  or paste path here"
          className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-xs whitespace-nowrap"
          title="Browse for audio file"
        >
          Browse
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".wav,.mp3,.m4a,.flac,.ogg,.webm"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Recording controls */}
      <div className="flex items-center gap-2">
        {recording.isRecording ? (
          <>
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs text-red-400">
              Recording… {recording.durationSec}s
            </span>
            <button
              onClick={handleStopRecording}
              className="px-2 py-1 bg-red-700 hover:bg-red-600 rounded text-xs ml-auto"
            >
              Stop
            </button>
          </>
        ) : (
          <button
            onClick={() => void recording.startRecording()}
            className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-xs"
          >
            🎤 Record
          </button>
        )}
        {recording.error && (
          <span className="text-xs text-red-400 ml-2">{recording.error}</span>
        )}
      </div>

      {/* Active audio note */}
      {audioPath && (
        <div className="mt-2 text-xs text-green-400 truncate" title={audioPath}>
          ✓ {audioPath}
        </div>
      )}
    </div>
  );
}
