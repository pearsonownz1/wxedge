import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPts(pts: number | null | undefined): string {
  if (pts === null || pts === undefined) return "—";
  return pts > 0 ? `+${pts.toFixed(1)}` : pts.toFixed(1);
}

export function formatTemp(temp: number | null | undefined): string {
  if (temp === null || temp === undefined) return "—";
  return `${temp.toFixed(1)}°F`;
}

export function formatPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "—";
  return `${pct.toFixed(0)}%`;
}
