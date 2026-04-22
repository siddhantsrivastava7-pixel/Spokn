import { useState, useEffect } from "react";
import type { AppSettings } from "../lib/types";
import { getLearnedVocab, clearLearnedVocab } from "../lib/learnedVocab";

interface Props {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  installedModels: string[];
  learnedVocabVersion?: number; // bump to refresh display after learning
}

const MODES: { value: AppSettings["mode"]; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "best_accuracy", label: "Best Accuracy" },
];

const LANGUAGES: { value: AppSettings["language"]; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
  { value: "hinglish", label: "Hinglish" },
  { value: "multilingual", label: "Multilingual" },
];

export function SettingsPanel({ settings, onChange, installedModels, learnedVocabVersion }: Props) {
  const [learnedWords, setLearnedWords] = useState<string[]>([]);

  useEffect(() => {
    setLearnedWords(getLearnedVocab());
  }, [learnedVocabVersion]);

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  function handleClearVocab() {
    clearLearnedVocab();
    setLearnedWords([]);
  }

  return (
    <div className="p-4 border-b border-gray-700 space-y-3">
      <div className="text-xs font-bold text-gray-400 uppercase">Settings</div>

      <div>
        <label className="text-xs text-gray-400 block mb-1">Mode</label>
        <select
          value={settings.mode}
          onChange={(e) => set("mode", e.target.value as AppSettings["mode"])}
          className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-blue-500"
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-xs text-gray-400 block mb-1">Language</label>
        <select
          value={settings.language}
          onChange={(e) => set("language", e.target.value as AppSettings["language"])}
          className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-blue-500"
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="timestamps"
          checked={settings.timestamps}
          onChange={(e) => set("timestamps", e.target.checked)}
          className="accent-blue-500"
        />
        <label htmlFor="timestamps" className="text-xs text-gray-300 cursor-pointer">
          Timestamps
        </label>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="offlineOnly"
          checked={settings.offlineOnly}
          onChange={(e) => set("offlineOnly", e.target.checked)}
          className="accent-blue-500"
        />
        <label htmlFor="offlineOnly" className="text-xs text-gray-300 cursor-pointer">
          Offline only
        </label>
      </div>

      {installedModels.length > 0 && (
        <div>
          <div className="text-xs text-gray-400 mb-1">
            Installed models ({installedModels.length})
          </div>
          <div className="space-y-0.5">
            {installedModels.map((id) => (
              <div key={id} className="text-xs text-green-400">• {id}</div>
            ))}
          </div>
        </div>
      )}

      {installedModels.length === 0 && (
        <div className="text-xs text-yellow-400">
          ⚠ No models installed. Register models via WindowsModelStore.
        </div>
      )}

      {/* Prompt / self-learning */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">
          Vocabulary prompt
          <span className="ml-1 text-gray-600">(biases decoder)</span>
        </label>
        <textarea
          value={settings.prompt ?? ""}
          onChange={(e) => set("prompt", e.target.value || undefined)}
          placeholder="e.g. STT, speech to text, API, React"
          rows={2}
          className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-blue-500 resize-none"
        />
      </div>

      {learnedWords.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-400">
              Learned vocab ({learnedWords.length})
            </span>
            <button
              onClick={handleClearVocab}
              className="text-xs text-gray-600 hover:text-red-400 transition-colors"
            >
              clear
            </button>
          </div>
          <div className="text-xs text-blue-300 leading-relaxed break-words">
            {learnedWords.join(", ")}
          </div>
        </div>
      )}
    </div>
  );
}
