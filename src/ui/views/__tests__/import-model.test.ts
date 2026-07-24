/**
 * Unit tests for the DOM-free Import page descriptors (redesign IA, screen 1).
 */

import { describe, it, expect } from 'vitest';
import { ACCEPT_AUTO, FORMAT_CARDS, type FormatId } from '../import-model';

describe('FORMAT_CARDS', () => {
  it('lists the eight formats in the mockup order', () => {
    expect(FORMAT_CARDS.map((c) => c.id)).toEqual<FormatId[]>([
      'pdf',
      'csv',
      'json',
      'fhir',
      'apple',
      'hl7',
      'pack',
      'manual',
    ]);
  });

  it('has a unique id and a unique tag per card', () => {
    const ids = FORMAT_CARDS.map((c) => c.id);
    const tags = FORMAT_CARDS.map((c) => c.tag);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('carries a name and description i18n key for every card', () => {
    for (const card of FORMAT_CARDS) {
      expect(card.nameKey).toMatch(/^import\.card\./);
      expect(card.descKey).toMatch(/^import\.card\./);
    }
  });

  it('gives every file-picker card a non-empty accept string', () => {
    for (const card of FORMAT_CARDS) {
      if (card.action.kind === 'navigate') continue;
      expect(card.accept, card.id).toBeTruthy();
      expect(card.accept, card.id).toContain('.');
    }
  });

  it('routes the manual card to the entry route with no file picker', () => {
    const manual = FORMAT_CARDS.find((c) => c.id === 'manual');
    expect(manual?.action).toEqual({ kind: 'navigate', route: 'entry' });
    expect(manual?.accept).toBeUndefined();
  });

  it('maps the structured formats to their import plugins', () => {
    const byId = (id: FormatId) => FORMAT_CARDS.find((c) => c.id === id)?.action;
    expect(byId('fhir')).toEqual({ kind: 'plugin', pluginId: 'fhir' });
    expect(byId('apple')).toEqual({ kind: 'plugin', pluginId: 'apple-health' });
    expect(byId('hl7')).toEqual({ kind: 'plugin', pluginId: 'hl7v2' });
    expect(byId('pdf')).toEqual({ kind: 'pdf' });
    expect(byId('pack')).toEqual({ kind: 'pack' });
    expect(byId('json')).toEqual({ kind: 'json' });
    expect(byId('csv')).toEqual({ kind: 'csv' });
  });

  it('offers every detectable extension in the auto accept string', () => {
    for (const ext of ['.pdf', '.json', '.csv', '.xml', '.hl7', '.txt']) {
      expect(ACCEPT_AUTO).toContain(ext);
    }
  });
});
