import { afterEach, describe, expect, it } from 'vitest';
import {
  getLastDataRoute,
  isDataRoute,
  rememberDataRoute,
  resetLastDataRoute,
} from '../data-nav';

afterEach(() => resetLastDataRoute());

describe('data-nav last-used tab memory', () => {
  it('defaults to entry', () => {
    expect(getLastDataRoute()).toBe('entry');
  });

  it('recognises only the three data routes', () => {
    expect(isDataRoute('entry')).toBe(true);
    expect(isDataRoute('import')).toBe(true);
    expect(isDataRoute('export')).toBe(true);
    expect(isDataRoute('overview')).toBe(false);
    expect(isDataRoute('import-csv')).toBe(false);
    expect(isDataRoute('review')).toBe(false);
  });

  it('remembers the last visited data route', () => {
    rememberDataRoute('import');
    expect(getLastDataRoute()).toBe('import');
    rememberDataRoute('export');
    expect(getLastDataRoute()).toBe('export');
  });

  it('ignores non-data routes, keeping the previous tab', () => {
    rememberDataRoute('import');
    rememberDataRoute('overview');
    rememberDataRoute('review');
    expect(getLastDataRoute()).toBe('import');
  });
});
