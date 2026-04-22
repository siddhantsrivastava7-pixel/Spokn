import { useState, useRef, useEffect } from "react";
import { LANGUAGES, REGIONS, getLanguage } from "../lib/languages";

interface Props {
  selected: string[];
  onChange: (langs: string[]) => void;
}

export function LanguagePicker({ selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const isAuto = selected.length === 0 || selected.includes("auto");
  const displayNames = isAuto
    ? "Auto detect"
    : selected.map((c) => getLanguage(c)?.name ?? c).join(", ");

  function toggle(code: string) {
    if (code === "auto") {
      onChange(["auto"]);
      return;
    }
    const next = selected.filter((c) => c !== "auto");
    if (next.includes(code)) {
      const removed = next.filter((c) => c !== code);
      onChange(removed.length === 0 ? ["auto"] : removed);
    } else {
      onChange([...next, code]);
    }
  }

  const q = search.toLowerCase();
  const filtered = LANGUAGES.filter(
    (l) =>
      l.name.toLowerCase().includes(q) ||
      l.nativeName.toLowerCase().includes(q) ||
      l.code.toLowerCase().includes(q)
  );

  return (
    <div ref={panelRef} style={{ position: "relative" }}>
      {/* Trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "var(--surface-2)", border: "1px solid var(--border)",
          borderRadius: "var(--r-sm)", padding: "7px 10px", cursor: "pointer",
          fontFamily: "var(--font-sans)", fontSize: 11.5, color: "var(--text)",
          textAlign: "left",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {displayNames}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          style={{ flexShrink: 0, marginLeft: 6, transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms", color: "var(--text-4)" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Selected chips (when not auto) */}
      {!isAuto && selected.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
          {selected.map((c) => (
            <span key={c} style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              background: "var(--accent-soft)", border: "1px solid var(--accent-border)",
              borderRadius: 99, padding: "2px 8px", fontSize: 10,
              color: "var(--accent)", fontFamily: "var(--font-mono)",
            }}>
              {getLanguage(c)?.name ?? c}
              <button
                onClick={() => toggle(c)}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--accent)", lineHeight: 1, fontSize: 11 }}
              >×</button>
            </span>
          ))}
        </div>
      )}

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)",
          background: "var(--surface-2)", border: "1px solid var(--border)",
          borderRadius: "var(--r-md)", zIndex: 100, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          maxHeight: 280, display: "flex", flexDirection: "column", overflow: "hidden",
        }}>
          {/* Search */}
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
            <input
              autoFocus
              type="text"
              placeholder="Search languages…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: "100%", background: "var(--surface-3)", border: "1px solid var(--border)",
                borderRadius: "var(--r-sm)", padding: "5px 8px", fontSize: 11,
                color: "var(--text)", fontFamily: "var(--font-sans)", outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ overflowY: "auto", flex: 1 }}>
            {/* Auto detect option */}
            {!search && (
              <label style={{
                display: "flex", alignItems: "center", gap: 8, padding: "7px 12px",
                cursor: "pointer", borderBottom: "1px solid var(--border)",
                background: isAuto ? "var(--accent-soft)" : "transparent",
              }}>
                <input type="radio" checked={isAuto} onChange={() => onChange(["auto"])} style={{ accentColor: "var(--accent)" }} />
                <span style={{ fontSize: 12, color: isAuto ? "var(--accent)" : "var(--text)" }}>Auto detect</span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>recommended</span>
              </label>
            )}

            {/* Grouped languages */}
            {REGIONS.map((region) => {
              const langs = filtered.filter((l) => l.region === region);
              if (langs.length === 0) return null;
              return (
                <div key={region}>
                  {!search && (
                    <div style={{
                      padding: "5px 12px 2px", fontSize: 9, textTransform: "uppercase",
                      letterSpacing: "0.12em", color: "var(--text-4)", fontFamily: "var(--font-mono)",
                      fontWeight: 600,
                    }}>
                      {region}
                    </div>
                  )}
                  {langs.map((l) => {
                    const isChecked = selected.includes(l.code);
                    return (
                      <label key={l.code} style={{
                        display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
                        cursor: "pointer",
                        background: isChecked ? "var(--accent-soft)" : "transparent",
                      }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggle(l.code)}
                          style={{ accentColor: "var(--accent)" }}
                        />
                        <span style={{ fontSize: 11.5, color: isChecked ? "var(--accent)" : "var(--text)", flex: 1 }}>{l.name}</span>
                        <span style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{l.nativeName}</span>
                        {l.needsLargeModel && (
                          <span style={{ fontSize: 9, background: "var(--surface-3)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 4px", color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>large</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
