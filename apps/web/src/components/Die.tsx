import { useEffect, useRef, useState } from 'react';

/** Face outlines per die type, in a 100×100 box. Purely visual. */
const SHAPES: Record<number, { outer: string; facets?: string[]; textY: number }> = {
  4: { outer: '50,8 94,88 6,88', facets: ['50,8 50,62', '50,62 94,88', '50,62 6,88'], textY: 70 },
  6: { outer: '12,12 88,12 88,88 12,88', facets: ['12,12 26,26', '88,12 74,26', '88,88 74,74', '12,88 26,74'], textY: 58 },
  8: { outer: '50,4 94,50 50,96 6,50', facets: ['6,50 94,50'], textY: 46 },
  10: { outer: '50,4 92,40 50,96 8,40', facets: ['8,40 50,58 92,40', '50,58 50,96'], textY: 48 },
  12: {
    outer: '50,4 93,35 77,90 23,90 7,35',
    facets: ['50,22 72,40 64,68 36,68 28,40 50,22'],
    textY: 56,
  },
  20: {
    outer: '50,3 92,27 92,73 50,97 8,73 8,27',
    facets: [
      '50,24 74,66 26,66 50,24',
      '50,3 50,24',
      '92,27 74,66',
      '8,27 26,66',
      '92,73 74,66',
      '8,73 26,66',
      '50,97 74,66',
      '50,97 26,66',
      '8,27 50,24 92,27',
    ],
    textY: 57,
  },
};

function shapeFor(sides: number) {
  if (sides === 100) return SHAPES[10]!;
  return SHAPES[sides] ?? SHAPES[20]!;
}

export interface DieProps {
  sides: number;
  /** The server's result. The animation always lands here. */
  value: number | null;
  /** Changes whenever a new live roll should animate (e.g. the event seq). */
  rollKey?: number | null;
  size?: number;
  dimmed?: boolean;
}

/**
 * Cosmetic die. While tumbling it flickers through random faces (display only; the
 * real roll came from the server), then settles on `value`.
 */
export function Die({ sides, value, rollKey, size = 96, dimmed }: DieProps) {
  const [shown, setShown] = useState<number | null>(value);
  const [phase, setPhase] = useState<'idle' | 'rolling' | 'landed'>('idle');
  const lastKey = useRef(rollKey);

  useEffect(() => {
    if (rollKey == null || rollKey === lastKey.current) {
      setShown(value);
      return;
    }
    lastKey.current = rollKey;
    setPhase('rolling');
    const flicker = setInterval(() => setShown(1 + Math.floor(Math.random() * sides)), 70);
    const done = setTimeout(() => {
      clearInterval(flicker);
      setShown(value);
      setPhase('landed');
    }, 1200);
    return () => {
      clearInterval(flicker);
      clearTimeout(done);
    };
  }, [rollKey, value, sides]);

  const shape = shapeFor(sides);
  const crit = phase === 'landed' && sides === 20 && value === 20;
  const fumble = phase === 'landed' && sides === 20 && value === 1;
  const cls = phase === 'rolling' ? 'die-rolling' : crit ? 'die-crit' : fumble ? 'die-fumble' : '';
  const label = value == null ? `d${sides}` : `d${sides} showing ${value}`;
  const text = shown ?? (sides === 100 ? '%' : sides);
  const fontSize = String(text).length >= 3 ? 22 : 30;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={cls}
      style={{ opacity: dimmed ? 0.4 : 1, overflow: 'visible' }}
      data-testid="die"
      data-value={phase === 'rolling' ? '' : (value ?? '')}
    >
      <polygon points={shape.outer} fill="var(--t-die-face)" stroke="var(--t-die-edge)" strokeWidth="3" strokeLinejoin="round" />
      {shape.facets?.map((f) => (
        <polyline key={f} points={f} fill="none" stroke="var(--t-die-edge)" strokeWidth="1.5" opacity="0.7" />
      ))}
      <text
        x="50"
        y={shape.textY}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize}
        fontWeight="700"
        fill="var(--t-die-text)"
        style={{ fontFamily: 'var(--t-font-display)' }}
      >
        {text}
      </text>
    </svg>
  );
}
