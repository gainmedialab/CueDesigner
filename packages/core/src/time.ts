/** Format file-relative seconds as mm:ss.mmm */
export function formatAbsoluteTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  const whole = Math.floor(rem);
  const ms = Math.round((rem - whole) * 1000);
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/** Parse mm:ss or mm:ss.mmm (and bare seconds) to seconds. */
export function parseAbsoluteTime(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }
  const m = trimmed.match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const minutes = Number.parseInt(m[1]!, 10);
  const seconds = Number.parseInt(m[2]!, 10);
  const ms = m[3] ? Number.parseInt(m[3].padEnd(3, "0"), 10) : 0;
  if (seconds >= 60) return null;
  return minutes * 60 + seconds + ms / 1000;
}

export function clampTime(t: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return Math.max(0, t);
  return Math.min(Math.max(0, t), durationSec);
}
