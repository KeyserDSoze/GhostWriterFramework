import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface GhostPosition {
  x: number;
  y: number;
}

const COLORS = ["#2dd4bf", "#60a5fa", "#c084fc", "#fb7185", "#fbbf24", "#4ade80"];

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function nextPerimeterPosition(): GhostPosition {
  switch (Math.floor(Math.random() * 4)) {
    case 0:
      return { x: randomBetween(12, 88), y: randomBetween(9, 18) };
    case 1:
      return { x: randomBetween(83, 91), y: randomBetween(20, 78) };
    case 2:
      return { x: randomBetween(12, 88), y: randomBetween(82, 90) };
    default:
      return { x: randomBetween(9, 17), y: randomBetween(20, 78) };
  }
}

export function WanderingAuthGhost() {
  const { t } = useTranslation();
  const [position, setPosition] = useState<GhostPosition>({ x: 14, y: 18 });
  const [color, setColor] = useState(COLORS[0]);
  const [flashing, setFlashing] = useState(false);
  const flashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const move = () => setPosition(nextPerimeterPosition());
    const firstMove = window.setTimeout(move, 100);
    const interval = window.setInterval(move, 2_900);
    return () => {
      window.clearTimeout(firstMove);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => () => {
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
  }, []);

  function flash() {
    let nextColor = COLORS[Math.floor(Math.random() * COLORS.length)] ?? COLORS[0];
    if (nextColor === color) nextColor = COLORS[(COLORS.indexOf(color) + 1) % COLORS.length] ?? COLORS[0];
    setColor(nextColor);
    setFlashing(false);
    window.requestAnimationFrame(() => setFlashing(true));
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashing(false), 620);
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <button
        type="button"
        className="auth-wandering-ghost pointer-events-auto absolute h-16 w-16 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        style={{ left: `${position.x}%`, top: `${position.y}%`, color }}
        data-flashing={flashing ? "true" : "false"}
        onClick={flash}
        aria-label={t("auth.catchGhost")}
      >
        <span className="auth-ghost-glow absolute inset-1 rounded-full bg-current blur-xl" />
        <svg className="relative h-full w-full drop-shadow-lg" viewBox="0 0 64 64" aria-hidden="true">
          <path
            d="M13 50V29C13 18.5 21.5 10 32 10s19 8.5 19 19v21l-6-5-6 6-7-6-7 6-6-6-6 5Z"
            fill="currentColor"
            fillOpacity="0.2"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
          />
          <ellipse cx="25" cy="29" rx="2.5" ry="3.5" fill="currentColor" />
          <ellipse cx="39" cy="29" rx="2.5" ry="3.5" fill="currentColor" />
          <path d="M28 38c2.5 2 5.5 2 8 0" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.5" />
        </svg>
      </button>
    </div>
  );
}
