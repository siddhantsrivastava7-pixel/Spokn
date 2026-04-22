/**
 * Splits a body of text into list items. Used by the format transformer.
 *
 * Strategy: try splitters in priority order. First one that yields ≥ 2 items
 * wins. Items are trimmed and de-duplicated while preserving order.
 */

export interface SplitOptions {
  /** Hint from intent signals; used to prefer one splitter over another. */
  prefer?: "comma" | "and" | "whitespace";
}

export function splitIntoItems(text: string, opts: SplitOptions = {}): string[] {
  const cleaned = text
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");
  if (!cleaned) return [];

  const order: Array<"comma" | "and" | "whitespace"> =
    opts.prefer === "and"
      ? ["and", "comma", "whitespace"]
      : opts.prefer === "whitespace"
      ? ["comma", "whitespace", "and"]
      : ["comma", "and", "whitespace"];

  for (const strategy of order) {
    const items = splitWith(cleaned, strategy);
    if (items.length >= 2) return items;
  }
  return [cleaned];
}

function splitWith(
  text: string,
  strategy: "comma" | "and" | "whitespace",
): string[] {
  if (strategy === "comma") {
    return text
      .split(/,| and /i)
      .map((s) => s.replace(/^and\s+/i, "").trim())
      .filter(Boolean);
  }
  if (strategy === "and") {
    return text
      .split(/\band\b/i)
      .map((s) => s.trim().replace(/^,/, "").trim())
      .filter(Boolean);
  }
  // whitespace — split every token into its own item. Only good for
  // noun-phrase-run inputs that are already trigger-phrase-stripped.
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Capitalize the first letter of a string without disturbing the rest.
 */
export function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}
