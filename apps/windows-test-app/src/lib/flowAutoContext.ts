// Rule-based mapping from foreground window info → FlowContext.
// Pure function. No AI. Easily extensible by adding entries to RULES.

import type { FlowContext } from "./flowToneMapping";

export interface ActiveWindowInfo {
  /** Just the executable basename, e.g. "slack.exe". */
  processName: string;
  /** Full window title, may be empty. */
  windowTitle: string;
  /** True when the foreground window is Spokn itself. */
  isSelf: boolean;
}

interface ProcessRule {
  exe: RegExp;
  context: FlowContext;
  /** Optional title check. Required for browser-based rules so Gmail-in-Chrome
   *  routes to email without dragging all Chrome tabs along. */
  titleHint?: RegExp;
}

const RULES: readonly ProcessRule[] = [
  // Chat
  { exe: /slack\.exe$/i, context: "chat" },
  { exe: /discord\.exe$/i, context: "chat" },
  { exe: /teams\.exe$/i, context: "chat" },
  { exe: /ms-teams\.exe$/i, context: "chat" },
  { exe: /whatsapp\.exe$/i, context: "chat" },
  { exe: /telegram\.exe$/i, context: "chat" },
  { exe: /signal\.exe$/i, context: "chat" },

  // Email
  { exe: /outlook\.exe$/i, context: "email" },
  { exe: /thunderbird\.exe$/i, context: "email" },

  // Notes / docs
  { exe: /notion\.exe$/i, context: "notes" },
  { exe: /obsidian\.exe$/i, context: "notes" },
  { exe: /winword\.exe$/i, context: "notes" },
  { exe: /onenote\.exe$/i, context: "notes" },
  { exe: /code\.exe$/i, context: "notes" },
  { exe: /notepad\.exe$/i, context: "notes" },
  { exe: /notepad\+\+\.exe$/i, context: "notes" },

  // Browser-aware: title-hints route web apps to the right context.
  { exe: /chrome\.exe$|msedge\.exe$|firefox\.exe$|brave\.exe$|arc\.exe$/i, context: "email", titleHint: /gmail|outlook|mail\.|inbox/i },
  { exe: /chrome\.exe$|msedge\.exe$|firefox\.exe$|brave\.exe$|arc\.exe$/i, context: "notes", titleHint: /notion|google docs|obsidian|onenote|evernote|bear/i },
  { exe: /chrome\.exe$|msedge\.exe$|firefox\.exe$|brave\.exe$|arc\.exe$/i, context: "chat",  titleHint: /slack|discord|teams|whatsapp|messenger|telegram/i },
];

const FALLBACK: FlowContext = "chat";

export function inferContext(info: ActiveWindowInfo): FlowContext {
  if (!info.processName) return FALLBACK;
  for (const rule of RULES) {
    if (!rule.exe.test(info.processName)) continue;
    if (rule.titleHint && !rule.titleHint.test(info.windowTitle)) continue;
    return rule.context;
  }
  return FALLBACK;
}
