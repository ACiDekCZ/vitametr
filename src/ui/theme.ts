/**
 * Appearance (light / dark) application.
 *
 * The stylesheet is driven entirely by `document.documentElement.dataset.theme`
 * (see styles.css): there is no `prefers-color-scheme` media query in the CSS.
 * This module owns that attribute — it resolves the user's `ThemePref` (which
 * may be `auto`) to a concrete `light` | `dark`, writes it onto <html>, keeps
 * the `theme-color` meta in sync, and — while the preference is `auto` —
 * re-applies live when the OS scheme changes.
 *
 * A tiny slice of the resolved value is cached in localStorage under a fixed,
 * non-sensitive key (only the two literals `'light'` / `'dark'` are stored) so
 * the very first paint — the onboarding / lock screen, which renders *before*
 * the encrypted profile is unlocked and its settings become available — already
 * shows the right theme with no flash of the wrong one.
 */

export type ThemePref = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** localStorage key holding the last resolved theme (non-sensitive). */
export const THEME_CACHE_KEY = 'vitametr.theme';

/** Surface colours fed to the `theme-color` meta, matching --bg per theme. */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: '#f4f7f7',
  dark: '#131b1d',
};

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Resolve a preference to a concrete theme. `auto` consults the OS via
 * matchMedia; `light`/`dark` pass straight through. Pure w.r.t. the DOM apart
 * from the matchMedia read, and guarded so it never throws in a headless env.
 */
export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemPrefersDark() ? 'dark' : 'light';
}

/** Whether the OS currently prefers a dark scheme (false when unavailable). */
export function systemPrefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** Read the cached resolved theme, or `null` when absent/unreadable. */
export function readCachedTheme(): ResolvedTheme | null {
  try {
    const v = localStorage.getItem(THEME_CACHE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/** Persist the resolved theme for the next boot's first paint. */
export function writeCachedTheme(theme: ResolvedTheme): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    // Private mode / disabled storage: caching is a nicety, not a requirement.
  }
}

let mediaQuery: MediaQueryList | null = null;
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null;

/** Stop listening for OS scheme changes (used when leaving `auto`). */
function unsubscribeSystem(): void {
  if (mediaQuery && mediaListener) {
    mediaQuery.removeEventListener('change', mediaListener);
  }
  mediaQuery = null;
  mediaListener = null;
}

/** While in `auto`, re-apply whenever the OS scheme flips. */
function subscribeSystem(): void {
  if (typeof matchMedia !== 'function') return;
  if (mediaQuery) return; // already subscribed
  try {
    mediaQuery = matchMedia(DARK_QUERY);
  } catch {
    mediaQuery = null;
    return;
  }
  mediaListener = () => paint('auto');
  mediaQuery.addEventListener('change', mediaListener);
}

/** Write the resolved theme onto <html> and sync the theme-color meta + cache. */
function paint(pref: ThemePref): ResolvedTheme {
  const theme = resolveTheme(pref);
  const root = document.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLOR[theme];

  writeCachedTheme(theme);
  return theme;
}

/**
 * Apply a preference: paint <html>, keep the OS subscription only while `auto`,
 * and return the concrete theme that is now in effect.
 */
export function applyTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'auto') subscribeSystem();
  else unsubscribeSystem();
  return paint(pref);
}

/**
 * Boot paint before any profile is unlocked: use the cached resolved theme when
 * present (avoids a flash), otherwise fall back to the live OS preference. Does
 * not subscribe — the reconciling `applyTheme(settings.theme)` after unlock owns
 * the `auto` subscription.
 */
export function applyBootTheme(): ResolvedTheme {
  const cached = readCachedTheme();
  return paint(cached ?? (systemPrefersDark() ? 'dark' : 'light'));
}

/**
 * Briefly enable a colour transition for a user-initiated theme change, so the
 * swap eases rather than snaps. Never used during boot (which must be instant).
 */
export function animateThemeChange(): void {
  const root = document.documentElement;
  root.classList.add('theme-anim');
  window.setTimeout(() => root.classList.remove('theme-anim'), 200);
}
