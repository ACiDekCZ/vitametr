/**
 * Unit tests for the pure slice of the theme helper: preference resolution,
 * the guarded system-scheme read, and the localStorage cache round-trip. The
 * DOM-touching parts (applyTheme / paint) are exercised by the e2e suite; here
 * we stub only the two globals the pure functions consult (matchMedia,
 * localStorage) so the logic is verified without a real browser.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_CACHE_KEY,
  readCachedTheme,
  resolveTheme,
  systemPrefersDark,
  writeCachedTheme,
} from '../theme';

/** Install a matchMedia stub that reports the given dark-scheme preference. */
function stubMatchMedia(prefersDark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('dark') ? prefersDark : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/** Install a minimal in-memory localStorage stub. */
function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveTheme', () => {
  it('passes explicit light/dark straight through', () => {
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('resolves auto to dark when the system prefers dark', () => {
    stubMatchMedia(true);
    expect(resolveTheme('auto')).toBe('dark');
  });

  it('resolves auto to light when the system prefers light', () => {
    stubMatchMedia(false);
    expect(resolveTheme('auto')).toBe('light');
  });

  it('resolves auto to light when matchMedia is unavailable', () => {
    // No matchMedia global installed: the guarded read must not throw.
    expect(resolveTheme('auto')).toBe('light');
  });
});

describe('systemPrefersDark', () => {
  it('reflects the matchMedia result', () => {
    stubMatchMedia(true);
    expect(systemPrefersDark()).toBe(true);
    stubMatchMedia(false);
    expect(systemPrefersDark()).toBe(false);
  });

  it('is false when matchMedia is unavailable', () => {
    expect(systemPrefersDark()).toBe(false);
  });
});

describe('theme cache round-trip', () => {
  it('writes and reads back a resolved theme', () => {
    const store = stubLocalStorage();
    writeCachedTheme('dark');
    expect(store.get(THEME_CACHE_KEY)).toBe('dark');
    expect(readCachedTheme()).toBe('dark');

    writeCachedTheme('light');
    expect(readCachedTheme()).toBe('light');
  });

  it('returns null for an absent or invalid cached value', () => {
    const store = stubLocalStorage();
    expect(readCachedTheme()).toBeNull();
    store.set(THEME_CACHE_KEY, 'purple');
    expect(readCachedTheme()).toBeNull();
  });

  it('returns null when localStorage is unavailable', () => {
    expect(readCachedTheme()).toBeNull();
  });
});
