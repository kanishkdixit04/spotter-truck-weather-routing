import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { geocode } from "../api";
import type { Place } from "../types";

interface Props { label: string; mark: string; value: Place | null; onChange: (p: Place | null) => void }

export default function PlaceInput({ label, mark, value, onChange }: Props) {
  const [text, setText] = useState(value?.label ?? "");
  const [options, setOptions] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const ctl = useRef<AbortController>();

  // Follow a place chosen from outside (swap, example links). Typing clears the value, which must not wipe the text.
  useEffect(() => { if (value) setText(value.label); }, [value]);

  function onType(v: string) {
    setText(v);
    onChange(null);
    ctl.current?.abort();
    if (v.trim().length < 2) { setOptions([]); setSearching(false); return; }
    const c = (ctl.current = new AbortController());
    setSearching(true);
    setFailed(false);
    const t = setTimeout(() => {
      geocode(v, c.signal)
        .then((r) => { setOptions(r); setActive(0); setOpen(true); setSearching(false); })
        .catch((e) => { if (e.name !== "AbortError") { setSearching(false); setFailed(true); setOptions([]); setOpen(true); } });
    }, 150);
    c.signal.addEventListener("abort", () => clearTimeout(t));
  }

  function pick(p: Place) {
    onChange(p); setText(p.label); setOpen(false);
  }

  return (
    <label className="place">
      <span className="lab">{label}</span>
      <div className="combo">
        <b className="mark" aria-hidden>{mark}</b>
        <input
          value={text}
          placeholder="City or address"
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-busy={searching}
          onChange={(e) => onType(e.target.value)}
          onFocus={() => options.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === "Enter" && options[active]) { e.preventDefault(); pick(options[active]); }
            if (e.key === "Escape") setOpen(false);
          }}
        />
        {searching && <Loader2 className="spin searching" size={16} aria-hidden />}
        {open && (options.length > 0 || failed || (!searching && !value && text.trim().length >= 2)) && (
          <ul className="options" role="listbox">
            {options.map((o, i) => (
              <li key={o.label + i} role="option" aria-selected={i === active}
                  className={i === active ? "on" : ""} onMouseDown={() => pick(o)}>
                {o.label}
              </li>
            ))}
            {options.length === 0 && <li className="empty" role="status">{failed ? "Search is unavailable. Try again in a moment." : "No places found. Try a city name."}</li>}
          </ul>
        )}
      </div>
    </label>
  );
}
