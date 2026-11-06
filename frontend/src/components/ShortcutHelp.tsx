import { useEffect, useRef } from "react";
import { X } from "lucide-react";

const KEYS: [string, string][] = [
  ["Space", "Play or pause the forecast"],
  ["Left, Right", "Step the forecast 1 hour (hold Shift for 6)"],
  ["[ and ]", "Switch between Risk, Wind, Rain and Snow"],
  ["A, B, C", "Select a route"],
  ["/", "Jump to the From field"],
  ["?", "Show this list"],
];

export default function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <header><h2>Keyboard shortcuts</h2><button ref={close} className="icon-close" aria-label="Close" onClick={onClose}><X size={18} /></button></header>
        <dl>{KEYS.map(([k, d]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>)}</dl>
      </div>
    </div>
  );
}
