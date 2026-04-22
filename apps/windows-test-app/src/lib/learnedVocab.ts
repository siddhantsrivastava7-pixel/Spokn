const STORAGE_KEY = "stt-learned-vocab";
const MAX_TERMS = 40;

// Common words not worth adding to the prompt
const STOPWORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with",
  "is","was","are","were","be","been","being","have","has","had","do","does",
  "did","will","would","could","should","may","might","shall","can","this",
  "that","these","those","it","its","i","you","he","she","we","they","my",
  "your","his","her","our","their","me","him","us","them","what","which",
  "who","how","when","where","why","not","no","yes","so","if","as","up",
  "out","just","about","into","than","then","there","here","also","all",
  "some","such","now","new","let","see","get","got","go","come","know",
  "think","look","want","give","take","make","say","said","like","time",
  "one","two","three","four","five","six","seven","eight","nine","ten",
]);

function loadTerms(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveTerms(terms: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(terms));
  } catch {
    // storage full — ignore
  }
}

/** Extract significant words from a transcript for the vocab pool. */
function extractTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

/**
 * Called after each successful transcription.
 * Adds new significant words to the persisted vocab pool.
 */
export function learnFromTranscript(text: string): void {
  const existing = new Set(loadTerms());
  const newTerms = extractTerms(text).filter((w) => !existing.has(w));
  if (newTerms.length === 0) return;

  const merged = [...existing, ...newTerms];
  saveTerms(merged.slice(-MAX_TERMS));
}

/**
 * Called when the user saves corrections to a transcript.
 * Learns words from the corrected text and removes words that only appeared
 * in the original (i.e. words the user deleted / replaced — likely wrong).
 */
export function learnFromCorrections(originalText: string, correctedText: string): void {
  const originalWords = new Set(extractTerms(originalText));
  const correctedWords = new Set(extractTerms(correctedText));

  // Words removed by the user — remove from vocab so they stop being reinforced
  const removedWords = [...originalWords].filter((w) => !correctedWords.has(w));
  if (removedWords.length > 0) {
    const removedSet = new Set(removedWords);
    saveTerms(loadTerms().filter((w) => !removedSet.has(w)));
  }

  // Words in corrected output — all are user-verified, learn them
  learnFromTranscript(correctedText);
}

/** Removes specific words from the learned vocab pool. */
export function unlearnWords(words: string[]): void {
  const bad = new Set(words.map((w) => w.toLowerCase()));
  saveTerms(loadTerms().filter((w) => !bad.has(w)));
}

/**
 * Returns the current learned vocab as a comma-separated prompt string,
 * optionally combined with a user-supplied manual prefix.
 */
export function buildPrompt(manualPrompt?: string): string {
  const learned = loadTerms();
  const parts: string[] = [];
  if (manualPrompt?.trim()) parts.push(manualPrompt.trim());
  if (learned.length > 0) parts.push(learned.join(", "));
  return parts.join(". ");
}

/** Returns the current learned vocab list for display. */
export function getLearnedVocab(): string[] {
  return loadTerms();
}

/** Clears the learned vocab pool. */
export function clearLearnedVocab(): void {
  localStorage.removeItem(STORAGE_KEY);
}
