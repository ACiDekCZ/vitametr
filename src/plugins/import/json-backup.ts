/**
 * JSON backup import plugin (step K7).
 *
 * Restores a Vitametr backup produced by `jsonBackupExportPlugin`. Per design
 * (§5.1) a restore is an import like any other and flows through the review
 * pipeline; it never writes storage directly. Each backed-up measurement becomes
 * a high-confidence proposal whose metric is already a resolved MetricId, so the
 * pipeline restores the meaningful fields losslessly (value, operator, unit,
 * takenAt/precision, reference range, note, and the original rawText).
 *
 * What the pipeline intentionally re-derives rather than restores: the record id,
 * createdAt/modifiedAt and status (a restored record is re-confirmed at commit
 * time). The measurement's source is surfaced as `sourceName` for the review UI /
 * caller to map back onto a SourceId; the pipeline itself assigns source via
 * `commit`'s defaults.
 *
 * Accepts a `file` (reads its text) or, for convenience/testing, a `data` input
 * carrying the already-parsed backup object.
 */

import type { ImportContext, ImportInput, ImportPlugin } from '../../core/contracts.js';
import type { ProposedMeasurement } from '../../core/types.js';
import { CURRENT_SCHEMA_VERSION } from '../../core/types.js';
import { PassphraseRequiredError } from '../../core/contracts.js';
import { openWithPassphrase } from '../../storage/crypto.js';
import {
  BACKUP_FORMAT,
  ENCRYPTED_BACKUP_FORMAT,
  type EncryptedBackup,
  type VitametrBackup,
} from '../export/json-backup.js';

function isBackup(value: unknown): value is VitametrBackup {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { format?: unknown }).format === BACKUP_FORMAT &&
    Array.isArray((value as { measurements?: unknown }).measurements) &&
    Array.isArray((value as { sources?: unknown }).sources)
  );
}

function isEncryptedBackup(value: unknown): value is EncryptedBackup {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { format?: unknown }).format === ENCRYPTED_BACKUP_FORMAT &&
    typeof (value as { ciphertext?: unknown }).ciphertext === 'string'
  );
}

async function readBackup(input: ImportInput, password?: string): Promise<VitametrBackup> {
  let raw: unknown;
  if (input.kind === 'file') {
    // File and Blob both expose .text().
    const text = await input.file.text();
    raw = JSON.parse(text);
  } else {
    raw = typeof input.data === 'string' ? JSON.parse(input.data) : input.data;
  }
  // A password-protected backup: decrypt to the plain backup JSON first. Without
  // a password we signal the caller (UI) to prompt for one and retry.
  if (isEncryptedBackup(raw)) {
    if (password === undefined || password === '') {
      throw new PassphraseRequiredError('This backup is password-protected');
    }
    const plain = await openWithPassphrase(raw, password); // throws WrongPassphraseError
    raw = JSON.parse(new TextDecoder().decode(plain));
  }
  if (!isBackup(raw)) {
    throw new Error('not a Vitametr backup file');
  }
  // Forward-compatibility guard: refuse a backup whose data schema is NEWER
  // than this build understands, rather than restore it partially. Older
  // schemas are fine — measurements reference version-stable metric ids.
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Backup schema version ${raw.schemaVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}; update the app to restore it.`,
    );
  }
  return raw;
}

export const jsonBackupImportPlugin: ImportPlugin = {
  id: 'json-backup',
  nameKey: 'import.json-backup',
  kind: 'file',
  accepts: ['.json', 'application/json'],

  async parse(input: ImportInput, ctx: ImportContext): Promise<ProposedMeasurement[]> {
    const backup = await readBackup(input, ctx.password);

    const sourceName = new Map(backup.sources.map((s) => [s.id, s.name]));

    return backup.measurements.map((m): ProposedMeasurement => {
      const name = m.sourceId !== undefined ? sourceName.get(m.sourceId) : undefined;
      return {
        // The backup stores a concrete MetricId; keep it resolved.
        metric: m.metricId,
        value: m.value,
        ...(m.operator !== undefined ? { operator: m.operator } : {}),
        unit: m.unit,
        takenAt: m.takenAt,
        timePrecision: m.timePrecision,
        ...(m.refLow !== undefined ? { refLow: m.refLow } : {}),
        ...(m.refHigh !== undefined ? { refHigh: m.refHigh } : {}),
        ...(m.refText !== undefined ? { refText: m.refText } : {}),
        ...(name !== undefined ? { sourceName: name } : {}),
        ...(m.note !== undefined ? { note: m.note } : {}),
        ...(m.origin?.rawText !== undefined ? { rawText: m.origin.rawText } : {}),
        confidence: 'high',
      };
    });
  },
};
