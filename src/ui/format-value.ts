/**
 * Shared value + unit typography (spec §1d).
 *
 * One place that renders a numeric reading as `number unit` with consistent
 * typography across the app (review, timeline, metric detail, report, export):
 * the number in a tabular-nums span (optionally emphasised or warn-coloured),
 * a space, then the unit muted and a step smaller. Powers are rendered with a
 * real `<sup>` element (`10⁹/l`) instead of relying on a mix of unicode
 * superscript glyphs — both the UCUM-ish `10*9/L` form and the pre-composed
 * `10⁹/l` display form parse to the same segments.
 *
 * Pure apart from element creation. Number formatting goes through
 * `formatNumber` (or a caller-supplied override, so a plugin can keep its own
 * locale tag); unit display strings are resolved by the caller via the units
 * engine and passed in.
 */

import { formatNumber as defaultFormatNumber } from '../i18n/index';

/** Digit → unicode superscript, for normalising `10*9` into `10⁹`. */
const TO_SUPERSCRIPT: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
};

/** Unicode superscript → digit, for tokenising a display string. */
const FROM_SUPERSCRIPT: Record<string, string> = Object.fromEntries(
  Object.entries(TO_SUPERSCRIPT).map(([digit, sup]) => [sup, digit]),
);

/** A run of plain text, or a run of exponent digits to render in a `<sup>`. */
export type UnitSegment = { text: string } | { sup: string };

/**
 * Fold the ASCII power notation `…*<digits>` (e.g. `10*9`, `10*12`) into the
 * pre-composed unicode superscript form so the tokeniser has a single case to
 * handle. Anything already in superscript form is left untouched.
 */
function normalizePowers(display: string): string {
  return display.replace(/\*(\d+)/g, (_match, digits: string) =>
    [...digits].map((d) => TO_SUPERSCRIPT[d] ?? d).join(''),
  );
}

/**
 * Split a unit display string into text / superscript segments. `10*9/L` and
 * `10⁹/l` both yield `[{text:'10'},{sup:'9'},{text:'/l'|'/L'}]`.
 */
export function unitSegments(display: string): UnitSegment[] {
  const normalized = normalizePowers(display);
  const segments: UnitSegment[] = [];
  let text = '';
  let sup = '';
  const flushText = (): void => {
    if (text) {
      segments.push({ text });
      text = '';
    }
  };
  const flushSup = (): void => {
    if (sup) {
      segments.push({ sup });
      sup = '';
    }
  };
  for (const ch of normalized) {
    const digit = FROM_SUPERSCRIPT[ch];
    if (digit !== undefined) {
      flushText();
      sup += digit;
    } else {
      flushSup();
      text += ch;
    }
  }
  flushText();
  flushSup();
  return segments;
}

export interface ValueUnitOptions {
  /** The value to render; the caller has already converted/rounded it. */
  value: number;
  /** Resolved unit *display* string (e.g. `mmol/l`, `10⁹/l`). Omit for none. */
  unit?: string;
  /** Censoring operator such as `<` or `>`, shown before the number. */
  operator?: string;
  /** Fixed fraction digits; defaults to the number formatter's own choice. */
  decimals?: number;
  /** Emphasise the number (weight 800 + accent) — the differing part. */
  emphasis?: boolean;
  /** Colour the number in the warn/out-of-range colour. */
  warn?: boolean;
  /** Extra class on the wrapper span. */
  wrapClass?: string;
  /** Extra class on the number span (e.g. to preserve an existing hook). */
  valueClass?: string;
  /** Extra class on the unit span (e.g. to preserve an existing hook). */
  unitClass?: string;
  /** Number formatter override (a plugin may pin its own locale). */
  formatNumber?: (value: number, decimals?: number) => string;
}

/** Join a base class with an optional extra, dropping empties. */
function cls(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}

/** The operator prefix, with a trailing space when present. */
function operatorPrefix(operator?: string): string {
  return operator ? `${operator} ` : '';
}

/**
 * Build a `<span class="value-unit">` with the number and (optionally) the unit,
 * powers rendered via `<sup>`. A literal space separates number and unit so the
 * text content and clipboard copy read naturally.
 */
export function valueWithUnitEl(options: ValueUnitOptions): HTMLElement {
  const fmt = options.formatNumber ?? defaultFormatNumber;
  const wrap = document.createElement('span');
  wrap.className = cls('value-unit', options.wrapClass);
  if (options.emphasis) wrap.classList.add('value-unit--emph');
  if (options.warn) wrap.classList.add('value-unit--warn');

  const num = document.createElement('span');
  num.className = cls('value-unit__num', options.valueClass);
  num.textContent = `${operatorPrefix(options.operator)}${fmt(options.value, options.decimals)}`;
  wrap.append(num);

  if (options.unit) {
    wrap.append(document.createTextNode(' '));
    const unit = document.createElement('span');
    unit.className = cls('value-unit__unit', options.unitClass);
    for (const seg of unitSegments(options.unit)) {
      if ('sup' in seg) {
        const sup = document.createElement('sup');
        sup.textContent = seg.sup;
        unit.append(sup);
      } else {
        unit.append(document.createTextNode(seg.text));
      }
    }
    wrap.append(unit);
  }
  return wrap;
}

export interface ValueUnitTextOptions extends ValueUnitOptions {
  /** Emit `<sup>` markup for powers (HTML contexts such as the export report). */
  markup?: boolean;
  /** Escape literal text (used with `markup` for untrusted HTML contexts). */
  escape?: (text: string) => string;
}

/**
 * The plain-text (or HTML-markup) equivalent of {@link valueWithUnitEl}, for
 * plugins and the export report that assemble HTML strings. With `markup: true`
 * exponents become `<sup>` runs; otherwise the unit keeps unicode superscripts.
 */
export function valueWithUnitText(options: ValueUnitTextOptions): string {
  const fmt = options.formatNumber ?? defaultFormatNumber;
  const esc = options.escape ?? ((text: string) => text);
  const numText = esc(`${operatorPrefix(options.operator)}${fmt(options.value, options.decimals)}`);
  if (!options.unit) return numText.trim();

  let unitText: string;
  if (options.markup) {
    unitText = unitSegments(options.unit)
      .map((seg) => ('sup' in seg ? `<sup>${esc(seg.sup)}</sup>` : esc(seg.text)))
      .join('');
  } else {
    unitText = normalizePowers(options.unit);
  }
  return `${numText} ${unitText}`.trim();
}
