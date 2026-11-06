import { ArrowDownUp, Loader2 } from "lucide-react";
import PlaceInput from "./PlaceInput";
import type { Place } from "../types";

export interface FormState {
  origin: Place | null; destination: Place | null; departure: string;
  load: number; interval: 10 | 25 | 50; hos: boolean;
}
const PRESETS = [["Empty", 0], ["15k", 15000], ["30k", 30000], ["42k", 42000]] as const;
const EXAMPLES: { name: string; o: Place; d: Place }[] = [
  { name: "Chicago to Denver", o: { label: "Chicago, Illinois", lat: 41.8781, lon: -87.6298 }, d: { label: "Denver, Colorado", lat: 39.7392, lon: -104.9903 } },
  { name: "Seattle to Salt Lake City", o: { label: "Seattle, Washington", lat: 47.6062, lon: -122.3321 }, d: { label: "Salt Lake City, Utah", lat: 40.7608, lon: -111.891 } },
  { name: "Dallas to Atlanta", o: { label: "Dallas, Texas", lat: 32.7767, lon: -96.797 }, d: { label: "Atlanta, Georgia", lat: 33.749, lon: -84.388 } },
];

/** Same window the API accepts: from an hour ago to 7 days ahead. */
function bounds() {
  const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return { min: iso(new Date(Date.now() - 3600e3)), max: iso(new Date(Date.now() + 7 * 864e5)) };
}

interface Props { form: FormState; set: (f: FormState) => void; loading: boolean; onSubmit: () => void }

export default function TripForm({ form, set, loading, onSubmit }: Props) {
  const up = (p: Partial<FormState>) => set({ ...form, ...p });
  const ready = form.origin && form.destination && form.departure;
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); if (ready && !loading) onSubmit(); }}>
      <div className="od">
        <PlaceInput label="From" mark="A" value={form.origin} onChange={(origin) => up({ origin })} />
        <button type="button" className="swap" aria-label="Swap origin and destination"
                onClick={() => up({ origin: form.destination, destination: form.origin })}>
          <ArrowDownUp size={15} strokeWidth={1.75} />
        </button>
        <PlaceInput label="To" mark="B" value={form.destination} onChange={(destination) => up({ destination })} />
      </div>
      <p className="try">
        Try{" "}
        {EXAMPLES.map((x, i) => (
          <span key={x.name}>
            <button type="button" className="link" onClick={() => up({ origin: x.o, destination: x.d })}>{x.name}</button>
            {i < EXAMPLES.length - 1 ? ", " : ""}
          </span>
        ))}
      </p>

      <div className="grid2">
        <label className="field">
          <span className="lab">Departure</span>
          <input type="datetime-local" value={form.departure} min={bounds().min} max={bounds().max} required
                 onChange={(e) => up({ departure: e.target.value })} />
        </label>
        <label className="field">
          <span className="lab">Load, lb</span>
          <input type="number" min={0} max={80000} step={500} inputMode="numeric" value={form.load}
                 onChange={(e) => up({ load: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
      </div>
      <div className="seg small" role="group" aria-label="Load presets">
        {PRESETS.map(([n, v]) => (
          <button type="button" key={n} aria-pressed={form.load === v} className={form.load === v ? "on" : ""} onClick={() => up({ load: v })}>{n}</button>
        ))}
      </div>

      <div className="field">
        <span className="lab">Weather check every</span>
        <div className="seg" role="radiogroup" aria-label="Checkpoint spacing">
          {([10, 25, 50] as const).map((n) => (
            <button type="button" key={n} role="radio" aria-checked={form.interval === n}
                    className={form.interval === n ? "on" : ""} onClick={() => up({ interval: n })}>{n} mi</button>
          ))}
        </div>
      </div>

      <label className="switch">
        <input type="checkbox" checked={form.hos} onChange={(e) => up({ hos: e.target.checked })} />
        <i aria-hidden />
        <span>Driver breaks and rest<small>30 min after 8 h at the wheel, 10 h after 11 h</small></span>
      </label>

      <button className="primary" disabled={!ready || loading}>
        {loading && <Loader2 className="spin" size={16} strokeWidth={2} />}
        {loading ? "Reading the forecast" : "Compare routes"}
      </button>
      {!ready && !loading && (
        <p className="hint" role="status">
          {!form.origin || !form.destination ? "Pick a start and an end from the suggestions." : "Set a departure between now and 7 days ahead."}
        </p>
      )}
    </form>
  );
}
