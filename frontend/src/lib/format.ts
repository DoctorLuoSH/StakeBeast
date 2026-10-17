/** Small display formatters shared across pages. */

/** `0x1234…abcd` style truncation for wallet addresses. */
export function shortAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** Format a remaining millisecond duration as `HH:MM:SS` (or `MM:SS` under an hour). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours <= 0) return `${mm}:${ss}`;
  return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
}
