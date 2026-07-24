/**
 * Pure slice of the shared value+unit formatter (spec §1d): power parsing,
 * operator prefixing, decimal forwarding, and the string / markup forms. The
 * DOM builder (`valueWithUnitEl`) is exercised by the review/timeline e2e.
 */

import { describe, expect, it } from 'vitest';

import { unitSegments, valueWithUnitText } from '../format-value';

/** Deterministic number formatting, independent of the ambient locale. */
const raw = (v: number, decimals?: number): string =>
  decimals === undefined ? String(v) : v.toFixed(decimals);

describe('unitSegments', () => {
  it('parses the ASCII power form 10*9/L', () => {
    expect(unitSegments('10*9/L')).toEqual([{ text: '10' }, { sup: '9' }, { text: '/L' }]);
  });

  it('parses the pre-composed unicode form 10⁹/l identically', () => {
    expect(unitSegments('10⁹/l')).toEqual([{ text: '10' }, { sup: '9' }, { text: '/l' }]);
  });

  it('parses a two-digit exponent 10*12/L', () => {
    expect(unitSegments('10*12/L')).toEqual([{ text: '10' }, { sup: '12' }, { text: '/L' }]);
  });

  it('handles a superscript in the middle (m²)', () => {
    expect(unitSegments('ml/min/1.73m²')).toEqual([
      { text: 'ml/min/1.73m' },
      { sup: '2' },
    ]);
  });

  it('leaves a plain unit as a single text segment', () => {
    expect(unitSegments('mmol/l')).toEqual([{ text: 'mmol/l' }]);
  });
});

describe('valueWithUnitText', () => {
  it('renders number + unit with a separating space', () => {
    expect(valueWithUnitText({ value: 8.56, unit: '10⁹/l', formatNumber: raw })).toBe('8.56 10⁹/l');
  });

  it('normalises the ASCII power form to unicode in plain text', () => {
    expect(valueWithUnitText({ value: 8.56, unit: '10*9/L', formatNumber: raw })).toBe('8.56 10⁹/L');
  });

  it('emits <sup> markup for powers when markup is requested', () => {
    expect(valueWithUnitText({ value: 8.56, unit: '10*9/L', markup: true, formatNumber: raw })).toBe(
      '8.56 10<sup>9</sup>/L',
    );
  });

  it('prefixes the operator before the number', () => {
    expect(valueWithUnitText({ value: 3, operator: '<', unit: 'pocet/uL', formatNumber: raw })).toBe(
      '< 3 pocet/uL',
    );
  });

  it('forwards fixed decimals to the number formatter', () => {
    expect(valueWithUnitText({ value: 5, unit: 'mmol/l', decimals: 2, formatNumber: raw })).toBe(
      '5.00 mmol/l',
    );
  });

  it('omits the unit (and trailing space) when none is given', () => {
    expect(valueWithUnitText({ value: 42, formatNumber: raw })).toBe('42');
  });

  it('escapes literal text in markup mode but keeps the sup structure', () => {
    const esc = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(
      valueWithUnitText({ value: 1, operator: '<', unit: '10*9/L', markup: true, escape: esc, formatNumber: raw }),
    ).toBe('&lt; 1 10<sup>9</sup>/L');
  });
});
