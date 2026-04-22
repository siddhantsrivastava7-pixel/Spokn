import { useState, useCallback } from "react";
import type { LogEntry } from "../lib/types";

let _idCounter = 0;

export function useLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const addLog = useCallback(
    (level: LogEntry["level"], message: string, detail?: string) => {
      const entry: LogEntry = {
        id: String(++_idCounter),
        level,
        message,
        timestamp: new Date().toLocaleTimeString(),
        detail,
      };
      setLogs((prev) => [...prev, entry]);
    },
    []
  );

  const clearLogs = useCallback(() => setLogs([]), []);

  return { logs, addLog, clearLogs };
}
