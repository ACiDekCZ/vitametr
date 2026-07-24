/**
 * i18n runtime: string lookup with interpolation and Intl-based formatting.
 * All user-facing text must go through t() — no hardcoded strings in views.
 */

import { en } from './en';
import { cs } from './cs';
import type { TimePrecision } from '../core/types';

export type StringKey = keyof typeof en;
export type Locale = 'cs' | 'en';

const TABLES: Record<Locale, Record<StringKey, string>> = { en, cs };
const INTL_TAGS: Record<Locale, string> = { cs: 'cs-CZ', en: 'en-US' };

let currentLocale: Locale = 'en';

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

/** Map a BCP 47 tag (e.g. navigator.language) to a supported locale. */
export function detectLocale(tag?: string): Locale {
  const candidate = tag ?? (typeof navigator !== 'undefined' ? navigator.language : 'en');
  return candidate.toLowerCase().startsWith('cs') ? 'cs' : 'en';
}

/** Translate a key, interpolating {placeholders} from params. */
export function t(key: StringKey, params?: Record<string, string | number>): string {
  const template = TABLES[currentLocale][key] ?? TABLES.en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Pick the right plural form for `n` in the active locale, then translate it.
 * Czech distinguishes one / few (2–4) / many (5+, and 0), which the `Intl`
 * categories one/few/other cover; English collapses to one/other. `forms` names
 * the key for each of those three buckets (English typically points few and many
 * at the same "N things" string).
 */
export function plural(
  n: number,
  forms: { one: StringKey; few: StringKey; many: StringKey },
  params?: Record<string, string | number>,
): string {
  const category = new Intl.PluralRules(INTL_TAGS[currentLocale]).select(n);
  const key = category === 'one' ? forms.one : category === 'few' ? forms.few : forms.many;
  return t(key, params);
}

/** Locale-aware number formatting (decimal comma in Czech). */
export function formatNumber(value: number, decimals?: number): string {
  return new Intl.NumberFormat(INTL_TAGS[currentLocale], {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals ?? 6,
  }).format(value);
}

/** Format an ISO timestamp respecting the measurement's time precision. */
export function formatDateTime(iso: string, precision: TimePrecision): string {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions =
    precision === 'date'
      ? { year: 'numeric', month: 'numeric', day: 'numeric' }
      : { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat(INTL_TAGS[currentLocale], options).format(date);
}
