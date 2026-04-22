// Context → submit-key mapping for the voice "send" command.
//
// MVP rule: only chat contexts auto-send. Email is deliberately Noop — the
// cost of an accidentally-sent email is high and irreversible. A future
// iteration can add a confirmation layer before auto-dispatch.

import type { FlowContext } from "./flowToneMapping";

export type SendKey = "Enter" | "CtrlEnter" | "Noop";

export function sendKeyForContext(ctx: FlowContext): SendKey {
  switch (ctx) {
    case "chat":
      return "Enter";
    case "email":
      // MVP: never auto-send an email. Text still types into the compose
      // window; the user presses send manually.
      return "Noop";
    case "notes":
      // Enter would insert a newline, not submit.
      return "Noop";
  }
}
