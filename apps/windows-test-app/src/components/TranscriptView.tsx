import { useState, useRef, useEffect } from "react";
import type { TranscribeResult } from "../lib/types";
import { learnFromCorrections } from "../lib/learnedVocab";

interface Props {
  result: TranscribeResult;
  showTimestamps: boolean;
  onClear: () => void;
  onVocabUpdated?: () => void;
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ms3 = ms % 1000;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms3).padStart(3, "0")}`;
}

export function TranscriptView({ result, showTimestamps, onClear, onVocabUpdated }: Props) {
  const [showSegments, setShowSegments] = useState(false);
  const [editedText, setEditedText] = useState(result.transcript.fullText);
  const [savedConfirm, setSavedConfirm] = useState(false);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const { transcript, processingTimeMs, chunksProcessed } = result;
  const originalText = transcript.fullText;
  const isDirty = editedText !== originalText;

  // Reset edited text when a new result comes in
  useEffect(() => {
    setEditedText(result.transcript.fullText);
    setSavedConfirm(false);
  }, [result.transcript.fullText]);

  useEffect(() => {
    if (textAreaRef.current) {
      textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight;
    }
  }, [originalText]);

  function copyTranscript() {
    void navigator.clipboard.writeText(editedText);
  }

  function saveCorrections() {
    learnFromCorrections(originalText, editedText);
    setSavedConfirm(true);
    onVocabUpdated?.();
    setTimeout(() => setSavedConfirm(false), 2000);
  }

  return (
    <div className="h-full flex flex-col gap-3">
      {/* Meta bar */}
      <div className="flex items-center gap-3 text-xs text-gray-400 flex-wrap">
        <span>Model: <span className="text-blue-400">{transcript.modelId}</span></span>
        <span>Lang: <span className="text-gray-200">{transcript.language}</span></span>
        <span>Mode: <span className="text-gray-200">{transcript.mode}</span></span>
        <span>Duration: <span className="text-gray-200">{(transcript.durationMs / 1000).toFixed(1)}s</span></span>
        <span>Processed: <span className="text-gray-200">{(processingTimeMs / 1000).toFixed(2)}s</span></span>
        <span>Chunks: <span className="text-gray-200">{chunksProcessed}</span></span>
        <span>Segments: <span className="text-gray-200">{transcript.segments.length}</span></span>
      </div>

      {/* Full text */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 font-bold uppercase">Full Transcript</span>
            {isDirty && (
              <span className="text-xs text-yellow-400">edited</span>
            )}
          </div>
          <div className="flex gap-2">
            {isDirty && (
              <button
                onClick={saveCorrections}
                className="text-xs px-2 py-0.5 bg-blue-700 hover:bg-blue-600 rounded text-white font-bold"
              >
                {savedConfirm ? "Saved!" : "Save corrections"}
              </button>
            )}
            <button
              onClick={copyTranscript}
              className="text-xs px-2 py-0.5 bg-gray-700 hover:bg-gray-600 rounded"
            >
              Copy
            </button>
            <button
              onClick={onClear}
              className="text-xs px-2 py-0.5 bg-gray-700 hover:bg-gray-600 rounded"
            >
              Clear
            </button>
          </div>
        </div>
        <textarea
          ref={textAreaRef}
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          className="flex-1 w-full bg-gray-900 border border-gray-700 rounded p-3 text-sm text-gray-100 leading-relaxed resize-none focus:outline-none font-sans focus:border-blue-600"
          placeholder="Transcript will appear here…"
          spellCheck={false}
        />
        {isDirty && (
          <p className="text-xs text-gray-500 mt-1">
            Edit mistakes above, then click "Save corrections" — fixed words go into your vocab prompt automatically.
          </p>
        )}
      </div>

      {/* Segments */}
      <div>
        <button
          onClick={() => setShowSegments((v) => !v)}
          className="text-xs text-gray-400 hover:text-gray-200 font-bold uppercase mb-2"
        >
          {showSegments ? "▼" : "►"} Segments ({transcript.segments.length})
        </button>

        {showSegments && (
          <div className="max-h-48 overflow-y-auto space-y-1 border border-gray-700 rounded p-2">
            {transcript.segments.map((seg, i) => (
              <div
                key={i}
                className="flex gap-2 text-xs py-0.5 border-b border-gray-800 last:border-0"
              >
                {showTimestamps && (
                  <span className="text-blue-400 whitespace-nowrap font-mono shrink-0">
                    {formatMs(seg.startMs)} – {formatMs(seg.endMs)}
                  </span>
                )}
                {seg.confidence !== undefined && (
                  <span
                    className={`shrink-0 font-mono ${
                      seg.confidence > 0.85 ? "text-green-400" : seg.confidence > 0.6 ? "text-yellow-400" : "text-red-400"
                    }`}
                  >
                    {(seg.confidence * 100).toFixed(0)}%
                  </span>
                )}
                <span className="text-gray-200">{seg.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
