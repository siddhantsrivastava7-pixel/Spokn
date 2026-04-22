import type { IntentDetection } from "../types";
import type { CorrectionLogEntry } from "../postprocessing/processTypes";
import { capitalizeFirst, splitIntoItems } from "./textSegmenters";
import { findTriggerMatches } from "./intentClassifier";

export interface FormatTransformerInput {
  /** Input text to format. Should be `correctedText` (post-cleanup). */
  text: string;
  intent: IntentDetection;
  /** Pipeline depth; light mode suppresses structural templates. */
  depth: "light" | "full";
}

export interface FormatTransformerResult {
  output: string;
  scaffolding: CorrectionLogEntry[];
}

const FULL_MODE_THRESHOLD = 0.6;
const LIGHT_MODE_THRESHOLD = 0.3;

/**
 * Reshapes `text` per detected intent. Confidence bands:
 *   - ≥ 0.6 AND depth === "full": full-mode templates (bullets, email, etc.)
 *   - 0.3 ≤ c < 0.6 OR depth === "light": light-mode — paragraph with
 *     commas/line breaks but no checkboxes / templates.
 *   - < 0.3: identity.
 *
 * Scaffolding tokens (subject, greeting, signoff, headers, bullet symbols)
 * are the only insertions permitted, and each is audit-logged with
 * `kind: "scaffolding"`.
 */
export function transformToFormat(
  input: FormatTransformerInput,
): FormatTransformerResult {
  const { text, intent, depth } = input;
  const scaffolding: CorrectionLogEntry[] = [];

  if (!text.trim() || intent.confidence < LIGHT_MODE_THRESHOLD) {
    return { output: text, scaffolding };
  }

  const fullMode = depth === "full" && intent.confidence >= FULL_MODE_THRESHOLD;

  switch (intent.intent) {
    case "paragraph":
      return { output: text, scaffolding };
    case "bullet_list":
      return fullMode
        ? renderBullets(text, intent, "•", scaffolding)
        : renderLightList(text, intent, scaffolding);
    case "numbered_list":
      return fullMode
        ? renderNumbered(text, intent, scaffolding)
        : renderLightList(text, intent, scaffolding);
    case "todo_list":
      return fullMode
        ? renderTodo(text, intent, scaffolding)
        : renderLightList(text, intent, scaffolding);
    case "email":
      return fullMode
        ? renderEmail(text, scaffolding)
        : { output: text, scaffolding };
    case "message":
      return fullMode
        ? renderMessage(text, scaffolding)
        : { output: text, scaffolding };
    case "meeting_notes":
      return fullMode
        ? renderMeetingNotes(text, scaffolding)
        : renderLightList(text, intent, scaffolding);
  }
}

// ── Full-mode renderers ─────────────────────────────────────────────────────

function renderBullets(
  text: string,
  intent: IntentDetection,
  bullet: string,
  scaffolding: CorrectionLogEntry[],
): FormatTransformerResult {
  const stripped = stripTrigger(text);
  const preferredStrategy = pickSplitStrategy(intent);
  const items = splitIntoItems(stripped, { prefer: preferredStrategy });
  if (items.length < 2) {
    return { output: text, scaffolding };
  }
  for (let i = 0; i < items.length; i++) {
    scaffolding.push({
      kind: "scaffolding",
      from: "",
      to: `${bullet} `,
      mode: "scaffolding",
    });
  }
  const lines = items.map((it) => `${bullet} ${capitalizeFirst(it)}`);
  return { output: lines.join("\n"), scaffolding };
}

function renderNumbered(
  text: string,
  intent: IntentDetection,
  scaffolding: CorrectionLogEntry[],
): FormatTransformerResult {
  const stripped = stripTrigger(text);
  const items = splitIntoItems(stripped, { prefer: pickSplitStrategy(intent) });
  if (items.length < 2) return { output: text, scaffolding };
  for (let i = 0; i < items.length; i++) {
    scaffolding.push({
      kind: "scaffolding",
      from: "",
      to: `${i + 1}. `,
      mode: "scaffolding",
    });
  }
  const lines = items.map((it, i) => `${i + 1}. ${capitalizeFirst(it)}`);
  return { output: lines.join("\n"), scaffolding };
}

function renderTodo(
  text: string,
  intent: IntentDetection,
  scaffolding: CorrectionLogEntry[],
): FormatTransformerResult {
  const stripped = stripTrigger(text);
  const items = splitIntoItems(stripped, { prefer: pickSplitStrategy(intent) });
  if (items.length < 2) return { output: text, scaffolding };
  for (const _ of items) {
    scaffolding.push({
      kind: "scaffolding",
      from: "",
      to: "- [ ] ",
      mode: "scaffolding",
    });
  }
  const lines = items.map((it) => `- [ ] ${capitalizeFirst(it)}`);
  return { output: lines.join("\n"), scaffolding };
}

function renderEmail(
  text: string,
  scaffolding: CorrectionLogEntry[],
): FormatTransformerResult {
  const { recipient, body } = parseEmail(text);
  const lines = [
    "Subject: Update",
    "",
    `Hi ${recipient},`,
    "",
    body,
    "",
    "Best,",
    "[User]",
  ];
  scaffolding.push(
    {
      kind: "scaffolding",
      from: "",
      to: "Subject: Update",
      mode: "scaffolding",
    },
    {
      kind: "scaffolding",
      from: "",
      to: `Hi ${recipient},`,
      mode: "scaffolding",
    },
    { kind: "scaffolding", from: "", to: "Best,\n[User]", mode: "scaffolding" },
  );
  return { output: lines.join("\n"), scaffolding };
}

function renderMessage(
  text: string,
  scaffolding: CorrectionLogEntry[],
): FormatTransformerResult {
  const { recipient, body } = parseMessage(text);
  const lines = [`Hi ${recipient},`, "", body];
  scaffolding.push({
    kind: "scaffolding",
    from: "",
    to: `Hi ${recipient},`,
    mode: "scaffolding",
  });
  return { output: lines.join("\n"), scaffolding };
}

function renderMeetingNotes(
  text: string,
  scaffolding: CorrectionLogEntry[],
): FormatTransformerResult {
  const stripped = stripTrigger(text);
  const sentences = stripped
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().replace(/[.!?]+$/, ""))
    .filter(Boolean);
  const items = sentences.length >= 2 ? sentences : splitIntoItems(stripped);
  if (items.length === 0) return { output: text, scaffolding };
  scaffolding.push(
    { kind: "scaffolding", from: "", to: "Meeting Notes", mode: "scaffolding" },
    ...items.map(
      (): CorrectionLogEntry => ({
        kind: "scaffolding",
        from: "",
        to: "• ",
        mode: "scaffolding",
      }),
    ),
  );
  const lines = ["Meeting Notes", "", ...items.map((it) => `• ${capitalizeFirst(it)}`)];
  return { output: lines.join("\n"), scaffolding };
}

// ── Light-mode renderer ─────────────────────────────────────────────────────

function renderLightList(
  text: string,
  _intent: IntentDetection,
  _scaffolding: CorrectionLogEntry[],
): FormatTransformerResult {
  // Do NOT add bullets or checkboxes. Just split sentences into lines.
  const lines = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length < 2) return { output: text, scaffolding: [] };
  return { output: lines.join("\n"), scaffolding: [] };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pickSplitStrategy(intent: IntentDetection): "comma" | "and" | "whitespace" {
  if (intent.signals.structural.includes("comma_chain")) return "comma";
  if (intent.signals.structural.includes("and_chain")) return "and";
  if (intent.signals.structural.includes("noun_phrase_run")) return "whitespace";
  return "comma";
}

function stripTrigger(text: string): string {
  const matches = findTriggerMatches(text);
  if (matches.length === 0) return text;
  const first = matches[0]!;
  return (text.slice(0, first.start) + text.slice(first.end)).trim();
}

function parseEmail(text: string): { recipient: string; body: string } {
  const recipient = extractRecipient(text) ?? "there";
  const saying = /\b(saying|that)\b\s*/i.exec(text);
  let body: string;
  if (saying) {
    body = text.slice(saying.index + saying[0].length).trim();
  } else {
    const stripped = stripTrigger(text);
    body = stripped.replace(new RegExp(`^${escape(recipient)}\\s*,?`, "i"), "").trim();
  }
  body = body.replace(/[.!?]*$/, "") + ".";
  return { recipient: capitalizeFirst(recipient), body };
}

function parseMessage(text: string): { recipient: string; body: string } {
  // "message to X that Y" / "text X saying Y".
  const msgMatch = /\bmessage to (\S+)\b/i.exec(text);
  const textMatch = /\btext (\S+) saying\b/i.exec(text);
  const hit = msgMatch ?? textMatch;
  if (hit) {
    const recipient = capitalizeFirst(hit[1]!);
    const after = text.slice(hit.index + hit[0].length);
    const body = after.replace(/^\s*(that|saying)\s+/i, "").trim().replace(/[.!?]*$/, "") + ".";
    return { recipient, body };
  }
  return { recipient: "there", body: text };
}

function extractRecipient(text: string): string | undefined {
  const m = /\bemail to (\S+)/i.exec(text);
  return m?.[1]?.replace(/[^\p{L}]/gu, "");
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
