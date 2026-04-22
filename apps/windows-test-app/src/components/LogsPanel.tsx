import { useRef, useEffect, useState } from "react";
import { ITerminal, IChevronDown } from "./Icons";
import type { LogEntry } from "../lib/types";

interface Props {
  logs: LogEntry[];
  onClear: () => void;
}

export function LogsPanel({ logs, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs, open]);

  return (
    <div className={`logs ${open ? "open" : ""}`}>
      <div className="logs-head" onClick={() => setOpen((v) => !v)}>
        <div className="logs-title">
          <ITerminal size={12} /> Logs
          <span className="logs-count">{logs.length}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {open && (
            <button
              className="logs-clear"
              onClick={(e) => { e.stopPropagation(); onClear(); }}
            >
              clear
            </button>
          )}
          <span className="logs-chev"><IChevronDown size={14} /></span>
        </div>
      </div>
      {open && (
        <div className="logs-body" ref={bodyRef}>
          {logs.map((l) => (
            <div className="log-line" key={l.id}>
              <span className="log-t">{l.timestamp.slice(11, 19)}</span>
              <span className={`log-lvl ${l.level}`}>{l.level}</span>
              <span className="log-msg">{l.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
