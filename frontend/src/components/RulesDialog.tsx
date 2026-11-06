import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { LEVELS } from "../risk";

// The brief's rule table, shown as data so a driver (or a reviewer) can check the scoring against the app.
const TABLE: [string, string[]][] = [
  ["Wind, mph", ["under 25", "25 to 34", "35 to 44", "45 to 54", "55 or more"]],
  ["Rain, in/hr", ["under 0.10", "0.10 to 0.25", "0.25 to 0.50", "0.50 to 1.00", "over 1.00"]],
  ["Snow, in/hr", ["under 0.5", "0.5 to 1.0", "1.0 to 2.0", "2.0 to 3.0", "over 3.0"]],
];
const LOAD = [
  "55 mph wind or more is No Travel for any load.",
  "45 to 54 mph wind with a load over 30,000 lb is No Travel.",
  "35 to 44 mph wind with a load over 40,000 lb is Severe.",
];

export default function RulesDialog({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-label="How risk is scored" onClick={(e) => e.stopPropagation()}>
        <header><h2>How risk is scored</h2><button ref={close} className="icon-close" aria-label="Close" onClick={onClose}><X size={18} /></button></header>
        <p className="rules-lead">Every checkpoint gets the worst result of wind, rain, snow and the load rule. A range includes its lower number: exactly 35 mph is High.</p>
        <div className="rules-scroll">
          <table className="rules">
            <thead>
              <tr><th scope="col">Condition</th>{LEVELS.map((l) => <th scope="col" key={l.key}><i className="sw" style={{ background: l.color }} />{l.label}</th>)}</tr>
            </thead>
            <tbody>{TABLE.map(([name, cells]) => <tr key={name}><th scope="row">{name}</th>{cells.map((c) => <td key={c}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <h3>Load rules</h3>
        <ul>{LOAD.map((l) => <li key={l}>{l}</li>)}</ul>
        <h3>Choosing a route</h3>
        <p className="rules-lead">Fewest Severe miles first, then fewest High miles, then the lowest average risk, then the shortest time. Miles of No Travel are counted before Severe, since they are worse.</p>
      </div>
    </div>
  );
}
