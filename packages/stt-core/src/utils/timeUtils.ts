/** Converts milliseconds to a human-readable "m:ss" string. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Returns current UTC time as an ISO 8601 string. */
export function nowISO(): string {
  return new Date().toISOString();
}
