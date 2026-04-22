const STORAGE_KEY = "stt-snippets";

export interface Snippet {
  id: string;
  trigger: string;
  value: string;
}

export function getSnippets(): Snippet[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch { return []; }
}

function save(list: Snippet[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function addSnippet(trigger: string, value: string): Snippet {
  const list = getSnippets();
  const item: Snippet = { id: crypto.randomUUID(), trigger: trigger.trim(), value: value.trim() };
  list.push(item);
  save(list);
  return item;
}

export function removeSnippet(id: string): void {
  save(getSnippets().filter((s) => s.id !== id));
}

export function applySnippets(text: string, snippets: Snippet[]): string {
  let result = text;
  for (const s of snippets) {
    const escaped = s.trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), s.value);
  }
  return result;
}
