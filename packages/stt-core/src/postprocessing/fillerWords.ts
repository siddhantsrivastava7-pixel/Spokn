/**
 * Filler-word dictionary. All matches are case-insensitive.
 *
 * Two tiers:
 *   - `ALWAYS_FILLERS`: disfluencies that are always safe to remove.
 *   - `CONTEXTUAL_FILLERS`: words that double as meaningful English. Only
 *     removed when the context guard says they're non-meaningful.
 */
export const ALWAYS_FILLERS: readonly string[] = [
  "uh",
  "um",
  "er",
  "hmm",
  "ah",
  "uhh",
  "umm",
  "erm",
  "mmm",
];

export const CONTEXTUAL_FILLERS: readonly string[] = [
  "like",
  // Multi-word — handled specially during grammar cleanup.
];

/**
 * Verb stems that invalidate filler removal of "like":
 *   "looks like a bug" / "feels like forever" — "like" is meaningful there.
 */
export const LIKE_BLOCKING_PRECEDING_VERBS: readonly string[] = [
  "look",
  "looks",
  "looking",
  "looked",
  "feel",
  "feels",
  "feeling",
  "felt",
  "sound",
  "sounds",
  "sounded",
  "seem",
  "seems",
  "seemed",
  "act",
  "acts",
  "acting",
  "acted",
  "taste",
  "tastes",
  "smell",
  "smells",
  // "I" as pronoun often precedes meaningful "like": "I like cookies".
  "i",
];

/**
 * Multi-word contextual fillers: phrases that may or may not be meaningful.
 *   "you know what" / "you know the thing" → meaningful, skip.
 *   Otherwise "you know" is filler.
 */
export const YOU_KNOW_MEANINGFUL_FOLLOWERS: readonly string[] = [
  "what",
  "how",
  "why",
  "when",
  "where",
  "who",
  "the",
  "a",
  "an",
  "that",
  "this",
  "these",
  "those",
  "my",
  "your",
  "his",
  "her",
  "our",
  "their",
  "if",
  "whether",
];

export const ALWAYS_FILLERS_SET = new Set<string>(
  ALWAYS_FILLERS.map((w) => w.toLowerCase()),
);

export const LIKE_BLOCKING_SET = new Set<string>(
  LIKE_BLOCKING_PRECEDING_VERBS.map((w) => w.toLowerCase()),
);

export const YOU_KNOW_MEANINGFUL_FOLLOWERS_SET = new Set<string>(
  YOU_KNOW_MEANINGFUL_FOLLOWERS.map((w) => w.toLowerCase()),
);
