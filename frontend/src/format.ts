export const fmtDur = (s: number) => {
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
/** Signed duration, e.g. "+1h 10m" or "-25m". */
export const fmtDelta = (s: number) => {
  const m = Math.round(Math.abs(s) / 60);
  const body = m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
  return `${s < 0 ? "-" : "+"}${body}`;
};
export const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
export const fmtDay = (ts: number) =>
  new Date(ts * 1000).toLocaleString([], { weekday: "short", hour: "numeric" });
export const fmtMi = (m: number) => `${Math.round(m).toLocaleString()} mi`;

/** Local datetime-local value + the browser's UTC offset, e.g. 2026-11-06T09:30:00-05:00 */
export function toIsoWithOffset(local: string): string {
  const d = new Date(local);
  const off = -d.getTimezoneOffset();
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${local.length === 16 ? local + ":00" : local}${off >= 0 ? "+" : "-"}${p(off / 60)}:${p(off % 60)}`;
}
/** Unix seconds to the value a datetime-local input expects (browser time zone). */
export function toLocalInput(ts: number): string {
  const d = new Date(ts * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function defaultDeparture(): string {
  const d = new Date(Date.now() + 3600e3);
  d.setMinutes(0, 0, 0);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
