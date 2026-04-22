import type {
  DetectedIntent,
  IntentDetection,
  ScoredSegment,
  SessionContext,
  UserStylePreferences,
} from "../types";

export interface IntentClassifierInput {
  text: string;
  segments?: ScoredSegment[];
  sessionContext?: SessionContext;
  stylePreferences?: UserStylePreferences;
  /** Adaptive bias derived from user feedback; capped at ±0.2 by the classifier. */
  adaptiveBias?: Partial<Record<DetectedIntent, number>>;
}

export type IntentClassifier = (input: IntentClassifierInput) => IntentDetection;

/** Where in the text a trigger was matched — useful for text stripping. */
export interface TriggerMatch {
  phrase: string;
  start: number;
  end: number;
  intent: DetectedIntent;
  weight: number;
}
