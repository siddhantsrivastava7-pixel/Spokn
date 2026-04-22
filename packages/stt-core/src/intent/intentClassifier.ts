import type { DetectedIntent, IntentDetection, IntentSignals } from "../types";
import type { IntentClassifierInput, TriggerMatch } from "./intentTypes";
import {
  computeStructuralSignals,
  type StructuralSignals,
} from "./structuralHeuristics";
import {
  isListLike,
  isWithinStickyWindow,
  recentIntentBias,
} from "./sessionContext";

const TRIGGER_STRONG = 0.9;
const TRIGGER_WEAK = 0.7;
const STRUCTURAL_WEIGHT = 0.6;
const LENGTH_WEIGHT = 0.3;
const LIST_STYLE_BIAS = 0.15;
const ADAPTIVE_CAP = 0.2;

interface TriggerPattern {
  pattern: RegExp;
  intent: DetectedIntent;
  weight: number;
}

/**
 * Keyword trigger patterns. Order matters only for attribution — scores are
 * summed per intent, and the highest-total intent wins.
 */
const TRIGGERS: TriggerPattern[] = [
  // email
  { pattern: /\bwrite (an? )?email to\b/i, intent: "email", weight: TRIGGER_STRONG },
  { pattern: /\bdraft (an? )?email\b/i, intent: "email", weight: TRIGGER_STRONG },
  { pattern: /\bsend (an? )?email\b/i, intent: "email", weight: TRIGGER_STRONG },
  // message
  { pattern: /\bmessage to\b/i, intent: "message", weight: TRIGGER_STRONG },
  { pattern: /\btext \S+ saying\b/i, intent: "message", weight: TRIGGER_STRONG },
  // meeting_notes
  { pattern: /\bmeeting notes\b/i, intent: "meeting_notes", weight: TRIGGER_STRONG },
  { pattern: /\bnotes from (the |this |our )?meeting\b/i, intent: "meeting_notes", weight: TRIGGER_STRONG },
  { pattern: /\bminutes of\b/i, intent: "meeting_notes", weight: TRIGGER_STRONG },
  // todo_list
  { pattern: /\btodo\b/i, intent: "todo_list", weight: TRIGGER_STRONG },
  { pattern: /\bto[- ]do list\b/i, intent: "todo_list", weight: TRIGGER_STRONG },
  { pattern: /\btask list\b/i, intent: "todo_list", weight: TRIGGER_STRONG },
  { pattern: /\bmy tasks\b/i, intent: "todo_list", weight: TRIGGER_STRONG },
  // numbered_list
  { pattern: /\bnumbered list\b/i, intent: "numbered_list", weight: TRIGGER_STRONG },
  { pattern: /\bnumber them\b/i, intent: "numbered_list", weight: TRIGGER_STRONG },
  { pattern: /\blist them (1 2 3|one two three)\b/i, intent: "numbered_list", weight: TRIGGER_STRONG },
  // bullet_list
  { pattern: /\bbullet (points|list)\b/i, intent: "bullet_list", weight: TRIGGER_STRONG },
  { pattern: /\bgrocery list\b/i, intent: "bullet_list", weight: TRIGGER_STRONG },
  { pattern: /\bshopping list\b/i, intent: "bullet_list", weight: TRIGGER_STRONG },
  { pattern: /\bmake a list\b/i, intent: "bullet_list", weight: TRIGGER_STRONG },
  { pattern: /\blist of /i, intent: "bullet_list", weight: TRIGGER_WEAK },
];

export function findTriggerMatches(text: string): TriggerMatch[] {
  const matches: TriggerMatch[] = [];
  for (const { pattern, intent, weight } of TRIGGERS) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.push({
        phrase: m[0],
        start: m.index,
        end: m.index + m[0].length,
        intent,
        weight,
      });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

export function classifyIntent(
  input: IntentClassifierInput,
  now: number = Date.now(),
): IntentDetection {
  const triggers = findTriggerMatches(input.text);
  const structural = computeStructuralSignals(input.text, input.segments);

  const scores: Partial<Record<DetectedIntent, number>> = {};
  const signals: IntentSignals = {
    triggers: triggers.map((t) => t.phrase),
    structural: structural.fired.filter((s) => !s.startsWith("length:")),
    lengthPattern: structural.lengthPattern,
  };

  // 1. Keyword triggers.
  for (const m of triggers) {
    scores[m.intent] = (scores[m.intent] ?? 0) + m.weight;
  }

  // 2. Structural signals.
  addStructuralScores(scores, structural);

  // 3. Length pattern.
  if (structural.lengthPattern === "uniform_short") {
    scores["bullet_list"] = (scores["bullet_list"] ?? 0) + LENGTH_WEIGHT;
  } else if (structural.lengthPattern === "long_form") {
    scores["paragraph"] = (scores["paragraph"] ?? 0) + LENGTH_WEIGHT;
  }

  // 4. Style preference bias for list intents.
  if (input.stylePreferences?.prefersLists) {
    for (const i of ["bullet_list", "todo_list", "numbered_list"] as const) {
      scores[i] = (scores[i] ?? 0) + LIST_STYLE_BIAS;
    }
  }

  // 5. Session recent-intent bias (list-types only).
  const recentBias = recentIntentBias(input.sessionContext);
  for (const [intent, bias] of Object.entries(recentBias) as Array<
    [DetectedIntent, number]
  >) {
    scores[intent] = (scores[intent] ?? 0) + bias;
  }

  // 6. Adaptive bias from user feedback, capped.
  if (input.adaptiveBias) {
    for (const [intent, bias] of Object.entries(input.adaptiveBias) as Array<
      [DetectedIntent, number]
    >) {
      const capped = Math.max(-ADAPTIVE_CAP, Math.min(ADAPTIVE_CAP, bias));
      scores[intent] = (scores[intent] ?? 0) + capped;
    }
  }

  // Pick the winner.
  let bestIntent: DetectedIntent = "paragraph";
  let bestScore = 0;
  for (const [intent, score] of Object.entries(scores) as Array<[DetectedIntent, number]>) {
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }
  const normalizedScore = Math.min(1, bestScore);

  // Session stickiness when no clear winner.
  if (bestScore < 0.3 && isWithinStickyWindow(input.sessionContext, now)) {
    const sticky = input.sessionContext!.lastIntent!;
    if (sticky !== "paragraph" || isListLike(sticky)) {
      return {
        intent: sticky,
        confidence: 0.3,
        signals,
        carriedFromSession: true,
      };
    }
  }

  if (bestScore < 0.3) {
    return {
      intent: "paragraph",
      confidence: normalizedScore,
      signals,
    };
  }

  return {
    intent: bestIntent,
    confidence: normalizedScore,
    signals,
  };
}

function addStructuralScores(
  scores: Partial<Record<DetectedIntent, number>>,
  structural: StructuralSignals,
): void {
  if (structural.nounPhraseRun || structural.commaChain || structural.andChain) {
    scores["bullet_list"] = (scores["bullet_list"] ?? 0) + STRUCTURAL_WEIGHT;
  }
  if (structural.imperative) {
    // Imperative tone is a stronger signal than list shape — a line of commands
    // is a todo list even when written with commas. Edge over list-shape.
    scores["todo_list"] = (scores["todo_list"] ?? 0) + STRUCTURAL_WEIGHT + 0.1;
  }
}
