// Rule-based mapping from foreground window info → FlowContext.
// Pure function. No AI. Easily extensible by adding entries to RULES.

import type { FlowContext } from "./flowToneMapping";

export interface ActiveWindowInfo {
  /**
   * Windows: executable basename (e.g. "slack.exe").
   * macOS:   executable basename from NSRunningApplication.executableURL
   *          (e.g. "Slack"), falling back to localized name.
   * Existing Windows rule regexes key on this — kept back-compatible.
   */
  processName: string;
  /**
   * macOS: NSRunningApplication.bundleIdentifier (e.g. "com.tinyspeck.slackmacgap").
   * Windows: empty string.
   * **Preferred** identifier for new rules — stable across localizations
   * and versions, unlike executable names or titles.
   */
  bundleId: string;
  /**
   * macOS: NSRunningApplication.localizedName (e.g. "Slack").
   * Windows: empty string.
   * **Debug / logs only.** Never match on this — localized names vary by
   * the user's system language ("Mail" / "Courrier" / "メール").
   */
  localizedName: string;
  /** Full window title, may be empty. */
  windowTitle: string;
  /** True when the foreground window is Spokn itself. */
  isSelf: boolean;
}

interface ProcessRule {
  /** Exe basename match (Windows-first). Optional when bundleId is set. */
  exe?: RegExp;
  /** Exact bundleId match (macOS-first). Case-sensitive — Apple uses
   *  reverse-DNS identifiers verbatim. */
  bundleId?: RegExp;
  context: FlowContext;
  /** Optional title check. Required for browser-based rules so Gmail-in-
   *  Chrome routes to email without dragging all Chrome tabs along. */
  titleHint?: RegExp;
}

const RULES: readonly ProcessRule[] = [
  // ── Chat ───────────────────────────────────────────────────────────────────
  // Windows
  { exe: /slack\.exe$/i,    context: "chat" },
  { exe: /discord\.exe$/i,  context: "chat" },
  { exe: /teams\.exe$/i,    context: "chat" },
  { exe: /ms-teams\.exe$/i, context: "chat" },
  { exe: /whatsapp\.exe$/i, context: "chat" },
  { exe: /telegram\.exe$/i, context: "chat" },
  { exe: /signal\.exe$/i,   context: "chat" },
  // macOS bundle IDs
  { bundleId: /^com\.tinyspeck\.slackmacgap$/,        context: "chat" }, // Slack
  { bundleId: /^com\.microsoft\.teams(2)?$/,          context: "chat" }, // Teams (and v2)
  { bundleId: /^com\.hnc\.Discord$/,                  context: "chat" }, // Discord
  { bundleId: /^com\.apple\.(iChat|MobileSMS)$/,      context: "chat" }, // Messages
  { bundleId: /^net\.whatsapp\.WhatsApp/,             context: "chat" }, // WhatsApp (desktop + MAS variants)
  { bundleId: /^(ru\.keepcoder\.Telegram|org\.telegram\.desktop)$/, context: "chat" },
  { bundleId: /^org\.whispersystems\.signal-desktop$/, context: "chat" }, // Signal

  // ── Email ──────────────────────────────────────────────────────────────────
  // Windows
  { exe: /outlook\.exe$/i,     context: "email" },
  { exe: /thunderbird\.exe$/i, context: "email" },
  // macOS bundle IDs
  { bundleId: /^com\.apple\.mail$/,                     context: "email" }, // Apple Mail
  { bundleId: /^com\.microsoft\.Outlook$/,              context: "email" }, // Outlook for Mac
  { bundleId: /^com\.readdle\.smartemail-Mac$/,         context: "email" }, // Spark
  { bundleId: /^org\.mozilla\.thunderbird$/,            context: "email" }, // Thunderbird
  { bundleId: /^com\.airmailapp\.airmail2-Mac$/,        context: "email" }, // Airmail
  { bundleId: /^com\.freron\.MailMate$/,                context: "email" }, // MailMate

  // ── Notes / docs ───────────────────────────────────────────────────────────
  // Windows
  { exe: /notion\.exe$/i,     context: "notes" },
  { exe: /obsidian\.exe$/i,   context: "notes" },
  { exe: /winword\.exe$/i,    context: "notes" },
  { exe: /onenote\.exe$/i,    context: "notes" },
  { exe: /code\.exe$/i,       context: "notes" },
  { exe: /notepad\.exe$/i,    context: "notes" },
  { exe: /notepad\+\+\.exe$/i, context: "notes" },
  // macOS bundle IDs
  { bundleId: /^com\.apple\.Notes$/,         context: "notes" }, // Apple Notes
  { bundleId: /^com\.apple\.TextEdit$/,      context: "notes" }, // TextEdit
  { bundleId: /^com\.microsoft\.Word$/,      context: "notes" }, // Word
  { bundleId: /^com\.microsoft\.onenote\.mac$/, context: "notes" },
  { bundleId: /^notion\.id$/,                context: "notes" }, // Notion
  { bundleId: /^md\.obsidian$/,              context: "notes" }, // Obsidian
  { bundleId: /^com\.microsoft\.VSCode$/,    context: "notes" },
  { bundleId: /^com\.bear-writer$/,          context: "notes" }, // Bear
  { bundleId: /^com\.evernote\.Evernote$/,   context: "notes" },

  // ── Browsers with title-hint routing ───────────────────────────────────────
  // Windows
  { exe: /chrome\.exe$|msedge\.exe$|firefox\.exe$|brave\.exe$|arc\.exe$/i,
    context: "email", titleHint: /gmail|outlook|mail\.|inbox/i },
  { exe: /chrome\.exe$|msedge\.exe$|firefox\.exe$|brave\.exe$|arc\.exe$/i,
    context: "notes", titleHint: /notion|google docs|obsidian|onenote|evernote|bear/i },
  { exe: /chrome\.exe$|msedge\.exe$|firefox\.exe$|brave\.exe$|arc\.exe$/i,
    context: "chat",  titleHint: /slack|discord|teams|whatsapp|messenger|telegram/i },
  // macOS browser bundle IDs — same title-hint routing.
  // Safari's bundle is com.apple.Safari; Chrome com.google.Chrome; Firefox
  // org.mozilla.firefox; Edge com.microsoft.edgemac; Brave com.brave.Browser;
  // Arc company.thebrowser.Browser.
  { bundleId: /^(com\.apple\.Safari|com\.google\.Chrome|org\.mozilla\.firefox|com\.microsoft\.edgemac|com\.brave\.Browser|company\.thebrowser\.Browser)$/,
    context: "email", titleHint: /gmail|outlook|mail\.|inbox/i },
  { bundleId: /^(com\.apple\.Safari|com\.google\.Chrome|org\.mozilla\.firefox|com\.microsoft\.edgemac|com\.brave\.Browser|company\.thebrowser\.Browser)$/,
    context: "notes", titleHint: /notion|google docs|obsidian|onenote|evernote|bear/i },
  { bundleId: /^(com\.apple\.Safari|com\.google\.Chrome|org\.mozilla\.firefox|com\.microsoft\.edgemac|com\.brave\.Browser|company\.thebrowser\.Browser)$/,
    context: "chat",  titleHint: /slack|discord|teams|whatsapp|messenger|telegram/i },
];

const FALLBACK: FlowContext = "chat";

export function inferContext(info: ActiveWindowInfo): FlowContext {
  // Need *some* identifier — either a process name (Windows) or a bundle
  // id (macOS). Empty info (off-screen, no foreground app) → chat fallback.
  if (!info.processName && !info.bundleId) return FALLBACK;
  for (const rule of RULES) {
    // Match either the exe regex against processName OR the bundleId regex
    // against bundleId. A rule with both is allowed but rare — either may
    // fire independently.
    const exeHit = rule.exe && info.processName && rule.exe.test(info.processName);
    const bidHit = rule.bundleId && info.bundleId && rule.bundleId.test(info.bundleId);
    if (!exeHit && !bidHit) continue;
    if (rule.titleHint && !rule.titleHint.test(info.windowTitle)) continue;
    return rule.context;
  }
  return FALLBACK;
}
