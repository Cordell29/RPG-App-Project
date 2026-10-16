import { MAX_LEVEL, XP_THRESHOLDS } from './constants.ts';

/** d20 ability modifier: 10–11 → 0, 18 → +4, 1 → −5. */
export function statModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]!) level = i + 1;
  }
  return Math.min(level, MAX_LEVEL);
}

/** Max-HP gained per level: 5 + CON modifier, minimum 1. */
export function hpPerLevel(con: number): number {
  return Math.max(1, 5 + statModifier(con));
}
