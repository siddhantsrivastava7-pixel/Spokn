import type { DetectedIntent, SessionContext } from "../types";

export const DEFAULT_STICKY_WINDOW_MS = 60_000;
export const RECENT_INTENT_WINDOW = 5;
const RECENT_BIAS_INCREMENT = 0.1;
const RECENT_BIAS_CAP = 0.2;

/** True when `lastIntentAt` is within the sticky window relative to `now`. */
export function isWithinStickyWindow(
  ctx: SessionContext | undefined,
  now: number,
): boolean {
  if (!ctx?.lastIntent || !ctx.lastIntentAt) return false;
  const window = ctx.stickyWindowMs ?? DEFAULT_STICKY_WINDOW_MS;
  const lastAt = Date.parse(ctx.lastIntentAt);
  if (Number.isNaN(lastAt)) return false;
  return now - lastAt <= window;
}

/**
 * Session bias: when the recent-intent window contains ≥ 2 of the same
 * list-type intent, the next classification nudges that intent's score
 * upward. Capped to prevent lock-in.
 */
export function recentIntentBias(
  ctx: SessionContext | undefined,
): Partial<Record<DetectedIntent, number>> {
  if (!ctx?.recentIntents || ctx.recentIntents.length < 2) return {};
  const counts = new Map<DetectedIntent, number>();
  for (const i of ctx.recentIntents) {
    counts.set(i, (counts.get(i) ?? 0) + 1);
  }
  const bias: Partial<Record<DetectedIntent, number>> = {};
  for (const [intent, n] of counts) {
    if (n < 2) continue;
    if (!isListLike(intent)) continue;
    bias[intent] = Math.min(RECENT_BIAS_CAP, (n - 1) * RECENT_BIAS_INCREMENT);
  }
  return bias;
}

export function isListLike(intent: DetectedIntent): boolean {
  return (
    intent === "bullet_list" ||
    intent === "numbered_list" ||
    intent === "todo_list"
  );
}

/**
 * Updates a session context object after a new intent is detected. Pure —
 * returns a new object. Caller owns persistence.
 */
export function updateSessionContext(
  ctx: SessionContext | undefined,
  newIntent: DetectedIntent,
  now: Date = new Date(),
): SessionContext {
  const base: SessionContext = ctx ? { ...ctx } : {};
  const recent = [newIntent, ...(base.recentIntents ?? [])].slice(
    0,
    RECENT_INTENT_WINDOW,
  );
  return {
    ...base,
    lastIntent: newIntent,
    lastIntentAt: now.toISOString(),
    recentIntents: recent,
  };
}
