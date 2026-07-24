/**
 * Unit tests for the DOM-free settings logic (K8b).
 */

import { describe, it, expect } from 'vitest';
import type { Source, SourceId } from '../../../core/types';
import type { StringKey } from '../../../i18n/index';
import {
  autoLockOptions,
  buildExportFilename,
  buildSource,
  makeSourceId,
  profileDisplayName,
  securityActions,
  slugify,
  sourceKindOptions,
  sourceNameExists,
  validateNewPassphrase,
} from '../settings-model';

// Minimal translator stub: only the default-name key is exercised here.
const tStub = (key: StringKey): string => (key === 'profile.defaultName' ? 'My profile' : key);

describe('autoLockOptions', () => {
  it('offers Never/1/5/10/30 with Never first and 0 minutes', () => {
    const opts = autoLockOptions();
    expect(opts.map((o) => o.minutes)).toEqual([0, 1, 5, 10, 30]);
    expect(opts[0].labelKey).toBe('settings.autoLockOff');
    expect(opts[0].params).toBeUndefined();
  });

  it('carries the {minutes} placeholder for timed options', () => {
    const five = autoLockOptions().find((o) => o.minutes === 5);
    expect(five?.labelKey).toBe('settings.autoLockMinutes');
    expect(five?.params).toEqual({ minutes: 5 });
  });
});

describe('slugify', () => {
  it('folds diacritics, lowercases and dashes non-alphanumerics', () => {
    expect(slugify('Můj Profil!')).toBe('muj-profil');
  });

  it('trims leading/trailing dashes and collapses runs', () => {
    expect(slugify('  --A  B--  ')).toBe('a-b');
  });

  it('returns empty string when nothing survives', () => {
    expect(slugify('***')).toBe('');
  });
});

describe('profileDisplayName', () => {
  it('shows a non-empty name verbatim', () => {
    expect(profileDisplayName('Milan', tStub)).toBe('Milan');
  });

  it('trims surrounding whitespace of a real name', () => {
    expect(profileDisplayName('  Milan  ', tStub)).toBe('Milan');
  });

  it('falls back to the localized default for an empty name', () => {
    expect(profileDisplayName('', tStub)).toBe('My profile');
  });

  it('falls back to the localized default for a whitespace-only name', () => {
    expect(profileDisplayName('   ', tStub)).toBe('My profile');
  });

  it('falls back to the localized default for an absent name', () => {
    expect(profileDisplayName(undefined, tStub)).toBe('My profile');
  });
});

describe('buildExportFilename', () => {
  it('builds a json backup filename', () => {
    expect(buildExportFilename('json-backup', 'My Profile')).toBe(
      'vitametr-my-profile-json-backup.json',
    );
  });

  it('builds a csv filename', () => {
    expect(buildExportFilename('csv', 'My Profile')).toBe('vitametr-my-profile-csv.csv');
  });

  it('falls back to "profile" when the name slugs to empty', () => {
    expect(buildExportFilename('csv', '***')).toBe('vitametr-profile-csv.csv');
  });
});

describe('sourceKindOptions', () => {
  it('lists every source kind with its i18n label key, in order', () => {
    const opts = sourceKindOptions();
    expect(opts.map((o) => o.kind)).toEqual([
      'lab',
      'doctor',
      'device',
      'app',
      'manual',
      'other',
    ]);
    expect(opts[0].labelKey).toBe('source.kind.lab');
    expect(opts[5].labelKey).toBe('source.kind.other');
  });
});

describe('makeSourceId', () => {
  it('slugs the name into a stable base id', () => {
    expect(makeSourceId([], 'Synlab Praha')).toBe('source-synlab-praha');
  });

  it('appends a numeric suffix on collision', () => {
    const existing = ['source-lab' as SourceId, 'source-lab-2' as SourceId];
    expect(makeSourceId(existing, 'Lab')).toBe('source-lab-3');
  });

  it('uses a generic base when the name has no alphanumerics', () => {
    expect(makeSourceId([], '***')).toBe('source-source');
  });
});

describe('buildSource', () => {
  it('returns undefined for a blank name', () => {
    expect(buildSource([], '   ', 'lab')).toBeUndefined();
  });

  it('trims the name and mints a unique id', () => {
    const existing: Source[] = [{ id: 'source-lab' as SourceId, name: 'Lab', kind: 'lab' }];
    const created = buildSource(existing, '  Lab  ', 'doctor');
    expect(created).toEqual({ id: 'source-lab-2', name: 'Lab', kind: 'doctor' });
  });
});

describe('sourceNameExists', () => {
  const existing: Source[] = [
    { id: 'source-lab' as SourceId, name: 'Synlab', kind: 'lab' },
    { id: 'source-doc' as SourceId, name: 'Dr. Nováková', kind: 'doctor' },
  ];

  it('matches an existing name case-insensitively and trimmed', () => {
    expect(sourceNameExists(existing, '  synlab ')).toBe(true);
    expect(sourceNameExists(existing, 'SYNLAB')).toBe(true);
  });

  it('returns false for a name that does not exist', () => {
    expect(sourceNameExists(existing, 'Other lab')).toBe(false);
  });

  it('never treats a blank name as a duplicate', () => {
    expect(sourceNameExists(existing, '   ')).toBe(false);
  });

  it('excludes the source being renamed (a no-op rename is allowed)', () => {
    // Renaming "Synlab" to itself must not count as a duplicate.
    expect(sourceNameExists(existing, 'Synlab', 'source-lab' as SourceId)).toBe(false);
    // But colliding with a different source's name still does.
    expect(sourceNameExists(existing, 'Dr. Nováková', 'source-lab' as SourceId)).toBe(true);
  });
});

describe('securityActions', () => {
  it('offers only "set a password" when there is no password', () => {
    for (const mode of ['plaintext', 'unknown'] as const) {
      const a = securityActions(mode);
      expect(a.enableEncryption).toBe(true);
      // Nothing password-specific is shown when none exists.
      expect(a.changePassphrase).toBe(false);
      expect(a.disableEncryption).toBe(false);
      expect(a.lockNow).toBe(false);
    }
  });

  it('offers change / remove / lock only when encrypted', () => {
    const a = securityActions('encrypted');
    expect(a.enableEncryption).toBe(false);
    expect(a.changePassphrase).toBe(true);
    expect(a.disableEncryption).toBe(true);
    expect(a.lockNow).toBe(true);
  });
});

describe('validateNewPassphrase', () => {
  it('rejects a short passphrase', () => {
    expect(validateNewPassphrase('abc', 'abc')).toBe('weak');
  });

  it('rejects a mismatch', () => {
    expect(validateNewPassphrase('abcdef', 'abcdeg')).toBe('mismatch');
  });

  it('accepts a long matching passphrase', () => {
    expect(validateNewPassphrase('abcdef', 'abcdef')).toBeUndefined();
  });
});
