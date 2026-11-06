import type { Place } from "./types";

export interface RecentTrip { name: string; o: Place; d: Place }
const KEY = "recent-trips";
const city = (p: Place) => p.label.split(",")[0];

export function loadRecent(): RecentTrip[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((t) => t?.o?.label && t?.d?.label).slice(0, 4) : [];
  } catch {
    return []; // storage blocked or corrupted: just no history
  }
}

/** Newest first, no duplicates, at most four. */
export function rememberTrip(o: Place, d: Place): RecentTrip[] {
  const name = `${city(o)} to ${city(d)}`;
  const list = [{ name, o, d }, ...loadRecent().filter((t) => t.name !== name)].slice(0, 4);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
  return list;
}
