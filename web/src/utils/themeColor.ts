/**
 * Theme accent color management.
 *
 * The accent color is stored in localStorage (for instant startup) and in
 * the backend app_settings (for cross-device sync). On load, it overrides
 * the --accent CSS variables so the entire UI adapts live.
 */

import { api } from '../api';

const STORAGE_KEY = 'zfs_accent_color';
const DEFAULT_ACCENT = '#6366f1';

/** Convert a hex color (#rrggbb) to {r, g, b}. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Darken a hex color by a factor (0-1, lower = darker). */
function darken(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = Math.round(rgb.r * factor);
  const g = Math.round(rgb.g * factor);
  const b = Math.round(rgb.b * factor);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Apply the accent color to CSS variables on :root. */
export function applyAccentColor(hex: string) {
  const root = document.documentElement;
  const rgb = hexToRgb(hex);
  if (!rgb) return;

  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-hover', darken(hex, 0.8));
  root.style.setProperty('--accent-dim', `rgba(${rgb.r},${rgb.g},${rgb.b},0.10)`);
  root.style.setProperty('--accent-mid', `rgba(${rgb.r},${rgb.g},${rgb.b},0.20)`);
  root.style.setProperty('--border-focus', `rgba(${rgb.r},${rgb.g},${rgb.b},0.5)`);
}

/** Get the stored accent color (localStorage first). */
export function getAccentColor(): string {
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_ACCENT;
}

/** Save the accent color to localStorage, apply it, and persist to backend. */
export async function setAccentColor(hex: string) {
  localStorage.setItem(STORAGE_KEY, hex);
  applyAccentColor(hex);
  try {
    await api.setAccentColor(hex);
  } catch { /* backend save is best-effort */ }
}

/** Apply the stored color on app startup. Also syncs from backend. */
export function initAccentColor() {
  // 1. Apply from localStorage synchronously — instant, no network, no flash
  const color = getAccentColor();
  applyAccentColor(color);

  // 2. Defer backend sync to idle time so it never blocks page load.
  //    Uses requestIdleCallback if available, falls back to setTimeout.
  const syncFromBackend = () => {
    api.getAccentColor().then(r => {
      if (r.color && r.color.toLowerCase() !== color.toLowerCase()) {
        localStorage.setItem(STORAGE_KEY, r.color);
        applyAccentColor(r.color);
      }
    }).catch(() => {});
  };

  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(syncFromBackend, { timeout: 2000 });
  } else {
    setTimeout(syncFromBackend, 0);
  }
}

/** Preset colors for the picker. */
export const ACCENT_PRESETS = [
  '#6366f1', // Indigo (default)
  '#8b5cf6', // Violet
  '#a855f7', // Purple
  '#ec4899', // Pink
  '#ef4444', // Red
  '#f97316', // Orange
  '#f59e0b', // Amber
  '#eab308', // Yellow
  '#22c55e', // Green
  '#10b981', // Emerald
  '#14b8a6', // Teal
  '#06b6d4', // Cyan
  '#3b82f6', // Blue
  '#64748b', // Slate
];
