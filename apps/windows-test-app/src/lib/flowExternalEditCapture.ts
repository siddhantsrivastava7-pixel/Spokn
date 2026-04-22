// External-edit capture. After Flow Mode injects text into a target app, the
// user may edit it in place (e.g. fix a transcription slip). This module
// reads the focused field's current text via UI Automation, diffs it against
// what we injected, and writes the diff as a UserCorrection to the feedback
// store so `deriveReplacementRules` can promote repeated corrections into
// adaptive replacements.
//
// Guiding principle: when uncertain, drop. We skip reconciliation on
// fingerprint mismatch (user switched apps), stale entries (> 15 s old),
// and low Jaccard / too-many-token diffs. The feedback store gets only
// high-confidence edit pairs.

import {
  FLOW_EXT_EDIT_MAX_AGE_MS,
  FLOW_EXT_EDIT_MAX_TOKENS,
  FLOW_EXT_EDIT_MIN_JACCARD,
  FLOW_EXT_EDIT_RING_SIZE,
  FLOW_EXT_EDIT_SETTLE_MS,
} from "./flowConstants";
import type { ActiveWindowInfo } from "./flowAutoContext";
import { flowLog } from "./flowObservability";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

// Allowlist lives right next to normalizeFingerprint so any tuning is a
// one-line diff with full context. Do NOT widen to arbitrary dash-suffixes;
// many apps embed semantic content after a dash (e.g. "foo.ts - VS Code").
const COSMETIC_TITLE_SUFFIXES: readonly string[] = [
  " - Google Chrome",
  " - Mozilla Firefox",
  " - Microsoft Edge",
  " — Mozilla Firefox",
  " - Brave",
  " - Arc",
];

const UNREAD_COUNTER_RE = /^\(\d+\)\s+/;
const UNSAVED_MARKER_TRAIL_RE = /(\s+[*•—])\s*$/;

interface InjectionEntry {
  messageId: string;
  injectedText: string;
  injectedAt: number;
  targetFingerprint: string;
  rawProcessName: string;
  rawWindowTitle: string;
  settleTimer: ReturnType<typeof setTimeout> | null;
}

export interface ExternalEditCaptureDeps {
  invoke: Invoke;
  /** Current active window — used to compute the reconciliation-time
   *  fingerprint so we can match against the stored one. */
  currentActiveWindow: () => ActiveWindowInfo | null;
  /** Whether we're running inside Tauri (UIA + invoke available). When false,
   *  recording still accumulates for tests but no reconciliation fires. */
  isTauri: boolean;
  /** Persist a captured edit. Decoupled from api.ts so tests can mock trivially.
   *  Errors are swallowed and logged via flowLog.extEditSkipped("read_failed"). */
  postFeedback: (payload: FeedbackPayload) => Promise<void>;
}

export interface ExternalEditCapture {
  /** Record that we just injected `text` into the currently-focused app. */
  recordInjection(messageId: string, text: string): void;
  /** Called on focus-context change. Reconcile the prior window's last
   *  injection (if fingerprint matches) before the app forgets about it. */
  onFocusChange(prev: ActiveWindowInfo | null): Promise<void>;
  /** Cancel any pending settle timers. Called on Flow stop. */
  stop(): void;
}

export function normalizeFingerprint(
  processName: string,
  windowTitle: string,
): string {
  let title = windowTitle
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFC");

  if (UNREAD_COUNTER_RE.test(title)) {
    const next = title.replace(UNREAD_COUNTER_RE, "");
    flowLog.fingerprintNormalized(windowTitle, next, "unread_counter");
    title = next;
  }

  const unsavedMatch = title.match(UNSAVED_MARKER_TRAIL_RE);
  if (unsavedMatch) {
    const next = title.slice(0, title.length - unsavedMatch[0].length).trimEnd();
    flowLog.fingerprintNormalized(windowTitle, next, "unsaved_marker");
    title = next;
  }

  for (const suffix of COSMETIC_TITLE_SUFFIXES) {
    if (title.endsWith(suffix)) {
      const next = title.slice(0, title.length - suffix.length).trimEnd();
      flowLog.fingerprintNormalized(windowTitle, next, `cosmetic_suffix:${suffix.trim()}`);
      title = next;
      break;
    }
  }

  return `${processName.toLowerCase()}\x1f${title}`;
}

export function createExternalEditCapture(
  deps: ExternalEditCaptureDeps,
): ExternalEditCapture {
  const ring: InjectionEntry[] = [];

  function pushEntry(entry: InjectionEntry) {
    ring.push(entry);
    while (ring.length > FLOW_EXT_EDIT_RING_SIZE) {
      const evicted = ring.shift();
      if (evicted?.settleTimer) clearTimeout(evicted.settleTimer);
    }
  }

  function findMatchingEntry(fp: string): InjectionEntry | null {
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i]!.targetFingerprint === fp) return ring[i]!;
    }
    return null;
  }

  async function reconcile(entry: InjectionEntry): Promise<void> {
    // Clear the settle timer so we don't double-fire.
    if (entry.settleTimer) {
      clearTimeout(entry.settleTimer);
      entry.settleTimer = null;
    }

    // Time-decay gate.
    if (Date.now() - entry.injectedAt > FLOW_EXT_EDIT_MAX_AGE_MS) {
      flowLog.extEditSkipped(entry.messageId, "stale");
      removeEntry(entry);
      return;
    }

    // Fingerprint gate.
    const active = deps.currentActiveWindow();
    if (!active || active.isSelf) {
      flowLog.extEditSkipped(entry.messageId, "fingerprint_mismatch");
      removeEntry(entry);
      return;
    }
    const currentFp = normalizeFingerprint(active.processName, active.windowTitle);
    if (currentFp !== entry.targetFingerprint) {
      flowLog.extEditSkipped(entry.messageId, "fingerprint_mismatch");
      removeEntry(entry);
      return;
    }

    if (!deps.isTauri) {
      removeEntry(entry);
      return;
    }

    // Read the focused field's current text.
    let fieldText: string;
    try {
      const result = await deps.invoke("read_focused_text");
      fieldText = typeof result === "string" ? result : "";
    } catch {
      flowLog.extEditSkipped(entry.messageId, "read_failed");
      removeEntry(entry);
      return;
    }

    if (!fieldText || !entry.injectedText) {
      flowLog.extEditSkipped(entry.messageId, "empty");
      removeEntry(entry);
      return;
    }

    const diff = diffTokens(entry.injectedText, fieldText);
    if (diff.changes.length === 0) {
      // Exact match — no correction happened.
      removeEntry(entry);
      return;
    }
    if (diff.changes.length > FLOW_EXT_EDIT_MAX_TOKENS) {
      flowLog.extEditSkipped(entry.messageId, "too_many_changes");
      removeEntry(entry);
      return;
    }
    if (diff.jaccard < FLOW_EXT_EDIT_MIN_JACCARD) {
      flowLog.extEditSkipped(entry.messageId, "low_jaccard");
      removeEntry(entry);
      return;
    }

    // Write to the feedback store via the backend.
    try {
      await deps.postFeedback({
        id: entry.messageId,
        rawText: entry.injectedText,
        formattedOutput: fieldText,
        userCorrected: fieldText,
        detectedIntent: "paragraph",
        intentConfidence: 0,
        corrections: diff.changes.map((c) => ({
          original: c.from,
          corrected: c.to,
        })),
      });
      flowLog.extEditCaptured(entry.messageId, diff.changes.length);
    } catch (e) {
      void e;
      flowLog.extEditSkipped(entry.messageId, "read_failed");
    }

    removeEntry(entry);
  }

  function removeEntry(entry: InjectionEntry) {
    const idx = ring.indexOf(entry);
    if (idx >= 0) {
      if (entry.settleTimer) clearTimeout(entry.settleTimer);
      ring.splice(idx, 1);
    }
  }

  function recordInjection(messageId: string, text: string): void {
    const active = deps.currentActiveWindow();
    if (!active || active.isSelf) return;
    if (!text || text.trim().length === 0) return;
    const fp = normalizeFingerprint(active.processName, active.windowTitle);

    // Supersede any prior entry for the same fingerprint — the new injection
    // represents the latest "intended state" of that field, and we diff
    // against that, not against an intermediate append.
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i]!.targetFingerprint === fp) {
        if (ring[i]!.settleTimer) clearTimeout(ring[i]!.settleTimer!);
        ring.splice(i, 1);
      }
    }

    const entry: InjectionEntry = {
      messageId,
      injectedText: text,
      injectedAt: Date.now(),
      targetFingerprint: fp,
      rawProcessName: active.processName,
      rawWindowTitle: active.windowTitle,
      settleTimer: null,
    };
    entry.settleTimer = setTimeout(() => {
      void reconcile(entry);
    }, FLOW_EXT_EDIT_SETTLE_MS);
    pushEntry(entry);
  }

  async function onFocusChange(prev: ActiveWindowInfo | null): Promise<void> {
    if (!prev) return;
    const fp = normalizeFingerprint(prev.processName, prev.windowTitle);
    const entry = findMatchingEntry(fp);
    if (!entry) return;
    // We fire reconcile directly here — but note that `currentActiveWindow()`
    // has already changed to the new app. reconcile's fingerprint check will
    // correctly skip because the current FP won't match the stored one. That
    // IS correct: we can't read the prior app's text once focus moved away.
    // The fingerprint-mismatch skip preserves auditability.
    await reconcile(entry);
  }

  function stop(): void {
    for (const entry of ring) {
      if (entry.settleTimer) clearTimeout(entry.settleTimer);
    }
    ring.length = 0;
  }

  return { recordInjection, onFocusChange, stop };
}

// ── Diff helpers (exported for tests) ────────────────────────────────────

export interface TokenChange {
  from: string;
  to: string;
}

export interface DiffResult {
  changes: TokenChange[];
  jaccard: number;
}

/** Word-level diff. Changes are collected as same-position substitutions
 *  (LCS-aligned). Pure adds/deletes at the edges count as changes too. */
export function diffTokens(a: string, b: string): DiffResult {
  const aTokens = tokenize(a);
  const bTokens = tokenize(b);

  // Jaccard on lowercased token sets — similarity across the whole field,
  // not positional alignment.
  const aSet = new Set(aTokens.map((t) => t.toLowerCase()));
  const bSet = new Set(bTokens.map((t) => t.toLowerCase()));
  let intersect = 0;
  for (const t of aSet) if (bSet.has(t)) intersect++;
  const unionSize = aSet.size + bSet.size - intersect;
  const jaccard = unionSize === 0 ? 1 : intersect / unionSize;

  // LCS-based alignment to produce positional substitutions.
  const changes = alignByLCS(aTokens, bTokens);
  return { changes, jaccard };
}

function tokenize(s: string): string[] {
  return s.split(/\s+/).filter((t) => t.length > 0);
}

function alignByLCS(a: readonly string[], b: readonly string[]): TokenChange[] {
  const m = a.length;
  const n = b.length;
  // DP table — O(m*n), fine for texts with dozens of tokens.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase()) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to produce aligned pairs.
  const pairs: Array<{ a: string | null; b: string | null }> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase()) {
      pairs.push({ a: a[i - 1]!, b: b[j - 1]! });
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      pairs.push({ a: a[i - 1]!, b: null });
      i--;
    } else {
      pairs.push({ a: null, b: b[j - 1]! });
      j--;
    }
  }
  while (i > 0) {
    pairs.push({ a: a[i - 1]!, b: null });
    i--;
  }
  while (j > 0) {
    pairs.push({ a: null, b: b[j - 1]! });
    j--;
  }
  pairs.reverse();

  // Collapse runs of removed-then-added into paired substitutions.
  const changes: TokenChange[] = [];
  let pendingRemoved: string[] = [];
  let pendingAdded: string[] = [];
  const flush = () => {
    while (pendingRemoved.length > 0 || pendingAdded.length > 0) {
      const from = pendingRemoved.shift() ?? "";
      const to = pendingAdded.shift() ?? "";
      changes.push({ from, to });
    }
  };
  for (const p of pairs) {
    if (p.a !== null && p.b !== null) {
      flush();
      continue;
    }
    if (p.a !== null) pendingRemoved.push(p.a);
    else if (p.b !== null) pendingAdded.push(p.b);
  }
  flush();
  return changes;
}

// ── Feedback payload ─────────────────────────────────────────────────────

export interface FeedbackPayload {
  id: string;
  rawText: string;
  formattedOutput: string;
  userCorrected: string;
  detectedIntent: string;
  intentConfidence: number;
  corrections: Array<{ original: string; corrected: string }>;
}
