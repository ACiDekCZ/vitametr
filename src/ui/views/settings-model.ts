/**
 * Settings screen (K8b) — DOM-free view model.
 *
 * Pure helpers the settings view builds on: the auto-lock option list, export
 * filename construction, the source-kind option list, deterministic source-id
 * minting, and the security-action visibility decision. No DOM, no clock, no
 * storage, no randomness — everything is derived from the arguments so it can be
 * unit-tested in a node environment.
 */

import type { Source, SourceId, SourceKind } from '../../core/types';
import type { StringKey } from '../../i18n/index';

/** Translate callback the view passes in (matches `AppContext.t`). */
type Translate = (key: StringKey, params?: Record<string, string | number>) => string;

// ---------------------------------------------------------------------------
// Profile name
// ---------------------------------------------------------------------------

/**
 * The profile name to show. A non-empty (trimmed) stored name is shown verbatim;
 * an empty/whitespace/absent name falls back to the localized default. The
 * localized literal is never stored — only computed at display time.
 */
export function profileDisplayName(name: string | undefined, t: Translate): string {
  return name?.trim() || t('profile.defaultName');
}

// ---------------------------------------------------------------------------
// Auto-lock
// ---------------------------------------------------------------------------

/** One selectable auto-lock timeout. `minutes === 0` means "never lock". */
export interface AutoLockOption {
  minutes: number;
  /** i18n key for the label; `params` feeds its {minutes} placeholder. */
  labelKey: StringKey;
  params?: { minutes: number };
}

/** Preset auto-lock timeouts, longest-lived ("Never") first. */
export function autoLockOptions(): AutoLockOption[] {
  const minutes = [0, 1, 5, 10, 30];
  return minutes.map((m) =>
    m === 0
      ? { minutes: 0, labelKey: 'settings.autoLockOff' as StringKey }
      : { minutes: m, labelKey: 'settings.autoLockMinutes' as StringKey, params: { minutes: m } },
  );
}

// ---------------------------------------------------------------------------
// Export filenames
// ---------------------------------------------------------------------------

/** Export kinds that map 1:1 to the registered export plugins. */
export type ExportKind = 'json-backup' | 'csv';

const EXPORT_EXTENSION: Record<ExportKind, string> = {
  'json-backup': 'json',
  csv: 'csv',
};

/**
 * Filesystem-safe slug of a free-text name: fold to ASCII-ish lowercase,
 * collapse every run of non-alphanumeric characters to a single dash, and trim
 * leading/trailing dashes. Deterministic; no locale or clock involved.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build a download filename for an export, e.g.
 * `vitametr-my-profile-json-backup.json`. Carries no timestamp on purpose —
 * the model has no injected clock and guessing one is disallowed.
 */
export function buildExportFilename(kind: ExportKind, profileName: string): string {
  const slug = slugify(profileName) || 'profile';
  return `vitametr-${slug}-${kind}.${EXPORT_EXTENSION[kind]}`;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** All source kinds in stable display order, paired with their i18n labels. */
export interface SourceKindOption {
  kind: SourceKind;
  labelKey: StringKey;
}

export function sourceKindOptions(): SourceKindOption[] {
  const kinds: SourceKind[] = ['lab', 'doctor', 'device', 'app', 'manual', 'other'];
  return kinds.map((kind) => ({ kind, labelKey: `source.kind.${kind}` as StringKey }));
}

/**
 * Mint a deterministic, collision-free SourceId from the existing ids and the
 * new source's name (no Math.random / Date.now). Base is `source-<slug>`; on a
 * collision a numeric suffix is appended until unique.
 */
export function makeSourceId(existingIds: readonly SourceId[], name: string): SourceId {
  const taken = new Set<string>(existingIds);
  const base = `source-${slugify(name) || 'source'}`;
  if (!taken.has(base)) return base as SourceId;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}` as SourceId;
}

/**
 * Whether a source with the given name already exists (case-insensitive,
 * trimmed). Feeds the add / rename duplicate guard. A blank trimmed name is
 * never a duplicate — the blank-name guard handles that separately. `excludeId`
 * skips one source (the one being renamed) so a no-op rename is not rejected.
 */
export function sourceNameExists(
  existing: readonly Source[],
  name: string,
  excludeId?: SourceId,
): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  return existing.some((s) => s.id !== excludeId && s.name.trim().toLowerCase() === needle);
}

/**
 * Build a new Source from user input, or undefined when the name is blank.
 * Pure: the caller persists the result inside `ctx.mutate`.
 */
export function buildSource(
  existing: readonly Source[],
  name: string,
  kind: SourceKind,
): Source | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const id = makeSourceId(
    existing.map((s) => s.id),
    trimmed,
  );
  return { id, name: trimmed, kind };
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

/**
 * Encryption mode of the current profile. `unknown` is used when the mode
 * cannot be determined from the store contract (see the view's note): the
 * StoreApi exposes only `status()` ('unlocked' in both modes) and no explicit
 * mode flag, so the view treats the mode as unknown.
 */
export type EncryptionMode = 'encrypted' | 'plaintext' | 'unknown';

/** Which security actions the view should offer for a given mode. */
export interface SecurityActions {
  /** Set a password (turn encryption on) — only when there is no password yet. */
  enableEncryption: boolean;
  /** Change / remove the password and lock — only when encrypted. */
  changePassphrase: boolean;
  disableEncryption: boolean;
  lockNow: boolean;
}

/**
 * A single "protect with a password" switch drives everything. When there is no
 * password (plaintext or an undetectable profile) the only action is to set one;
 * showing "current password" / "change password" there is nonsensical. When the
 * profile is encrypted, offer change, remove, and lock — but not a redundant
 * "enable".
 */
export function securityActions(mode: EncryptionMode): SecurityActions {
  const encrypted = mode === 'encrypted';
  return {
    enableEncryption: !encrypted,
    changePassphrase: encrypted,
    disableEncryption: encrypted,
    lockNow: encrypted,
  };
}

/** Minimum passphrase length (mirrors the onboarding bootstrap rule). */
export const MIN_PASSPHRASE_LENGTH = 6;

export type PassphraseIssue = 'weak' | 'mismatch';

/** Validate a new passphrase and its repeat; undefined means it is acceptable. */
export function validateNewPassphrase(next: string, repeat: string): PassphraseIssue | undefined {
  if (next.length < MIN_PASSPHRASE_LENGTH) return 'weak';
  if (next !== repeat) return 'mismatch';
  return undefined;
}
