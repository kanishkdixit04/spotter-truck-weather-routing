import type { LayerKey } from "./types";

export const LEVELS = [
  { key: "low", label: "Low", color: "#5bb98c" },
  { key: "moderate", label: "Moderate", color: "#e3b341" },
  { key: "high", label: "High", color: "#ee8a3c" },
  { key: "severe", label: "Severe", color: "#e5484d" },
  { key: "no_travel", label: "No travel", color: "#b388f5" },
] as const;
/** Level of a checkpoint for the layer on show: overall risk, or just wind, rain or snow. */
export const layerLevel = (c: { risk: { level: number; factors: { wind: number; rain: number; snow: number } } }, layer: LayerKey) =>
  layer === "risk" ? c.risk.level : c.risk.factors[layer];
export const levelColor = (l: number) => LEVELS[Math.max(0, Math.min(4, Math.round(l)))].color;

// Value at which each layer reaches level 0..4 (same thresholds as the risk table).
export const LAYER_STOPS: Record<LayerKey, number[]> = {
  risk: [0, 1, 2, 3, 4],
  wind: [0, 25, 35, 45, 55],
  rain: [0, 0.1, 0.25, 0.5, 1],
  snow: [0, 0.5, 1, 2, 3],
};
export const LAYER_UNIT: Record<LayerKey, string> = { risk: "", wind: "mph", rain: "in/hr", snow: "in/hr" };

const rgb = LEVELS.map((l) => [1, 3, 5].map((i) => parseInt(l.color.slice(i, i + 2), 16)));

/** Position 0..4 of a value on the layer's level ramp (continuous). */
export function rampPos(layer: LayerKey, v: number): number {
  const s = LAYER_STOPS[layer];
  let i = 0;
  while (i < 3 && v >= s[i + 1]) i++;
  return i + Math.max(0, Math.min(1, (v - s[i]) / (s[i + 1] - s[i])));
}

/** RGBA (0-255) for a heat value: colour from the level ramp, fading in with severity. */
export function heatColor(layer: LayerKey, v: number): [number, number, number, number] {
  const pos = rampPos(layer, v);
  const i = Math.min(3, Math.floor(pos)), t = pos - i;
  const c = rgb[i].map((a, k) => a + (rgb[i + 1][k] - a) * t);
  // Calm weather stays see-through; the opacity climbs with each level so trouble spots stand out.
  const A = [16, 110, 180, 215, 235];
  if (layer !== "risk" && pos < 1) {
    // Single-factor layers show their own intensity even below the first threshold (a 12 mph breeze is visible),
    // but a truly dry or calm cell stays clear.
    return [c[0], c[1], c[2], Math.round((22 + 88 * pos) * Math.min(1, pos * 12))];
  }
  return [c[0], c[1], c[2], Math.round(A[i] + (A[i + 1] - A[i]) * t)];
}
