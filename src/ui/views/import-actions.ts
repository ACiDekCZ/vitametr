/**
 * Import engine (redesign IA, screen 1) — shared between the Import page and the
 * (transitional) settings import section.
 *
 * These functions parse a file with the right import plugin and hand the
 * resulting proposals to the review pipeline, or route CSV to the column-mapping
 * screen. Behaviour is unchanged from when this lived in `settings.ts`: the same
 * toasts, the same navigation to `review` / `import-csv`, and the same modal
 * password flow for an encrypted backup or a protected PDF.
 *
 * `importKnownOnly` is persisted to `ProfileData` (`settings.importKnownOnly`)
 * and read/written via {@link getImportKnownOnly} / {@link setImportKnownOnly},
 * so the toggle survives a reload and is shared by any screen that reads it.
 */

import type { AppContext } from '../app-context';
import { PassphraseRequiredError, WrongPassphraseError } from '../../core/contracts';
import type { ImportPlugin } from '../../core/contracts';
import type { Metric, MetricId, ProposedMeasurement } from '../../core/types';
import type { StringKey } from '../../i18n/index';
import { importPluginById } from '../../plugins/registry';
import { detectFormat, isZip } from '../../plugins/detect';
import { listZipEntries, openZipEntry, type ZipEntry } from '../../plugins/import/zip';
import { parsePack, packMetricToSpec } from '../../plugins/import/pack';
import { setPendingImport, type PendingImportMeta } from './review';
import { setPendingCsv } from './import-csv';
import type { ReviewItem } from '../../core/contracts';
import { shouldShowImportFilter } from './import-filter-model';
import { downgradeHiddenResolutions } from './review-model';

// Import setting: skip proposals for metrics not already in the catalog (no new
// metrics get created). Persisted in ProfileData (`settings.importKnownOnly`);
// defaults to false when unset.
export function getImportKnownOnly(ctx: AppContext): boolean {
  return ctx.data().settings.importKnownOnly ?? false;
}

export function setImportKnownOnly(ctx: AppContext, on: boolean): void {
  ctx.mutate((d) => {
    d.settings.importKnownOnly = on;
  });
}

// Import setting: whether import recognition also considers metrics from
// currently-INACTIVE packs (so review can offer to reveal them). Persisted in
// ProfileData (`settings.offerHiddenMetrics`); defaults to true when unset.
export function getOfferHiddenMetrics(ctx: AppContext): boolean {
  return ctx.data().settings.offerHiddenMetrics ?? true;
}

export function setOfferHiddenMetrics(ctx: AppContext, on: boolean): void {
  ctx.mutate((d) => {
    d.settings.offerHiddenMetrics = on;
  });
}

/** Display name of a metric (built-in i18n name / custom name / key). */
function metricDisplayName(ctx: AppContext, metric: Metric): string {
  if (metric.customName) return metric.customName;
  if (metric.nameKey) return ctx.t(metric.nameKey as StringKey);
  return metric.key ?? '';
}

// ---------------------------------------------------------------------------
// Small DOM helpers (for the modal password prompt)
// ---------------------------------------------------------------------------

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textEl(tag: string, text: string, className?: string): HTMLElement {
  const node = el(tag, className);
  node.textContent = text;
  return node;
}

function button(label: string, className?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (className) b.className = className;
  return b;
}

function field(labelText: string): { wrap: HTMLElement; label: HTMLLabelElement } {
  const wrap = el('div', 'field');
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.append(label);
  return { wrap, label };
}

function passwordInput(ariaLabel: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'password';
  input.setAttribute('aria-label', ariaLabel);
  return input;
}

function inlineError(): HTMLElement {
  const p = el('p', 'settings-error pill above');
  p.style.display = 'none';
  return p;
}

function showError(node: HTMLElement, message: string): void {
  node.textContent = message;
  node.style.display = '';
}

function clearError(node: HTMLElement): void {
  node.textContent = '';
  node.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Import runners
// ---------------------------------------------------------------------------

export async function runImport(ctx: AppContext, file: File): Promise<void> {
  const plugin = importPluginById('json-backup');
  if (!plugin) return;
  const meta: PendingImportMeta = { pluginId: 'json-backup', fileName: file.name };
  try {
    const proposals = await plugin.parse({ kind: 'file', file }, { catalog: ctx.catalog() });
    handOff(ctx, proposals, meta);
  } catch (err) {
    // An encrypted backup with no password → ask for it in a modal, then retry.
    if (err instanceof PassphraseRequiredError) {
      renderImportPasswordPrompt(ctx, plugin, file, {
        requiredKey: 'backup.passwordRequired',
        enterKey: 'backup.enterPassword',
      }, meta);
      return;
    }
    throw err;
  }
}

/**
 * Auto-detect a dropped file's format and route it to the right importer. An
 * unrecognised file is refused with a toast rather than guessed at.
 */
export async function runAutoImport(ctx: AppContext, file: File): Promise<void> {
  const format = await detectFormat(file, ctx.data().importMappings ?? []);
  switch (format) {
    case 'pdf':
      return runPdfImport(ctx, file);
    case 'pack':
      return runPackImport(ctx, file);
    case 'json-backup':
      return runImport(ctx, file);
    case 'csv':
      return runCsvImport(ctx, file);
    case 'lab-text':
      return runPluginImport(ctx, 'lab-text', file);
    case 'fhir':
      return runPluginImport(ctx, 'fhir', file);
    case 'apple-health':
      return runPluginImport(ctx, 'apple-health', file);
    case 'hl7v2':
      return runPluginImport(ctx, 'hl7v2', file);
    default:
      // An unclassified ZIP that isn't an Apple Health export: if it holds a
      // single plausibly-importable file, extract it and re-detect.
      if (await isZip(file)) return runZipExtractImport(ctx, file);
      return runGenericFallback(ctx, file);
  }
}

/** Archive members that are never an importable payload (metadata/dirs). */
function isIgnorableEntry(entry: ZipEntry): boolean {
  const base = entry.name.split('/').pop() ?? entry.name;
  return (
    entry.name.endsWith('/') || // directory
    entry.uncompressedSize === 0 ||
    entry.name.startsWith('__MACOSX/') ||
    base === '.DS_Store' ||
    base === '' ||
    base.startsWith('._')
  );
}

/**
 * Generic single-file ZIP support: extract the one importable inner file into an
 * in-memory `File` and recurse into {@link runAutoImport} so it is detected and
 * routed like a dropped file. A zip with zero or several candidate files is
 * ambiguous and refused with the unknown-format toast rather than guessed at.
 * (The Apple Health export is handled earlier, by its own plugin, as a stream.)
 */
async function runZipExtractImport(ctx: AppContext, file: File): Promise<void> {
  let candidates: ZipEntry[];
  try {
    candidates = (await listZipEntries(file)).filter((e) => !isIgnorableEntry(e));
  } catch {
    ctx.toast(ctx.t('import.unsupportedArchive'), 'error');
    return;
  }
  if (candidates.length !== 1) {
    ctx.toast(ctx.t('import.unsupportedArchive'), 'error');
    return;
  }
  const entry = candidates[0];
  const stream = await openZipEntry(file, entry);
  const bytes = await new Response(stream).arrayBuffer();
  const innerName = entry.name.split('/').pop() ?? entry.name;
  const inner = new File([bytes], innerName);
  return runAutoImport(ctx, inner);
}

/** Upper size bound for the generic text fallback (a lab sheet is never huge). */
const FALLBACK_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Fallback for a file `detectFormat` could not classify: before giving up, run
 * the generic lab-text path (read as text, apply any declarative `importMappings`
 * plus the heuristic parser). A parseable text sheet yields proposals and hands
 * off to review exactly like a recognised `lab-text` file; a genuinely binary or
 * unparseable file yields nothing and gets the clear unknown-format toast. Files
 * above {@link FALLBACK_MAX_BYTES} are skipped so we never read a large blob into
 * a string just to fail.
 */
async function runGenericFallback(ctx: AppContext, file: File): Promise<void> {
  const plugin = importPluginById('lab-text');
  if (plugin && file.size <= FALLBACK_MAX_BYTES) {
    const proposals = await plugin.parse(
      { kind: 'file', file },
      { catalog: ctx.catalog(), importMappings: ctx.data().importMappings },
    );
    if (proposals.length > 0) {
      handOff(ctx, proposals, { pluginId: 'lab-text', fileName: file.name });
      return;
    }
  }
  ctx.toast(ctx.t('import.unrecognized'), 'error');
}

/**
 * Metric-pack import: register any new metric definitions (idempotent — a metric
 * already known by key or name is reused), then propose the pack's measurements
 * through the review pipeline. This is the modular "define metrics + values"
 * path: a pack can define number/text/enum/multi metrics with units and options.
 */
export async function runPackImport(ctx: AppContext, file: File): Promise<void> {
  const pack = parsePack(await file.text());
  const keyToId = new Map<string, MetricId>();
  let mappingsAdded = 0;

  ctx.mutate((data) => {
    // Register custom units (idempotent by code) — the engine reloads them.
    if (pack.units && pack.units.length > 0) {
      const existing = new Set((data.units ?? []).map((u) => u.code));
      const added = pack.units.filter((u) => !existing.has(u.code));
      if (added.length > 0) data.units = [...(data.units ?? []), ...added];
    }
    // Register declarative import mappings (idempotent by id) — an incoming
    // mapping replaces a same-id one so a pack can ship a fixed pattern.
    if (pack.importMappings && pack.importMappings.length > 0) {
      const byId = new Map((data.importMappings ?? []).map((m) => [m.id, m]));
      for (const m of pack.importMappings) {
        if (!byId.has(m.id)) mappingsAdded += 1;
        byId.set(m.id, m);
      }
      data.importMappings = [...byId.values()];
    }
    const catalog = ctx.catalog();
    for (const def of pack.metrics ?? []) {
      const existing = catalog.byKey(def.key) ?? catalog.resolveAlias(def.name);
      if (existing) {
        keyToId.set(def.key, existing.id);
        // Merge the pack's names/aliases onto the existing metric so a pack can
        // teach resolution for a metric that is already in the catalog (this is
        // how a lab-specific pack boosts name recognition without new metrics).
        for (const alias of [def.name, ...(def.aliases ?? [])]) {
          catalog.learnAlias(existing.id, alias);
        }
        continue;
      }
      const created = catalog.addUserMetric(packMetricToSpec(def, pack.id));
      keyToId.set(def.key, created.id);
    }
  });

  const packMeta: PendingImportMeta = { pluginId: 'pack', fileName: file.name };
  const proposals: ProposedMeasurement[] = (pack.measurements ?? []).map((m) => {
    const id = keyToId.get(m.metric);
    return {
      metric: id ? id : { unresolvedName: m.metric },
      ...(m.value !== undefined ? { value: m.value } : {}),
      ...(m.textValue !== undefined ? { textValue: m.textValue } : {}),
      ...(m.textValues !== undefined ? { textValues: m.textValues } : {}),
      ...(m.operator !== undefined ? { operator: m.operator } : {}),
      ...(m.unit !== undefined ? { unit: m.unit } : {}),
      ...(m.takenAt !== undefined ? { takenAt: m.takenAt } : {}),
      ...(m.timePrecision !== undefined ? { timePrecision: m.timePrecision } : {}),
      ...(m.refLow !== undefined ? { refLow: m.refLow } : {}),
      ...(m.refHigh !== undefined ? { refHigh: m.refHigh } : {}),
      ...(m.note !== undefined ? { note: m.note } : {}),
      confidence: 'high',
    };
  });
  // A pack with no measurements to review just confirms with a toast. When it
  // actually *defines* metrics or units, take the user to the Veličiny (metrics)
  // page so they can see what was added; a mapping-only pack (which adds nothing
  // visible there) keeps the earlier toast-and-stay behaviour. A pack that does
  // carry measurements still goes to review as usual.
  const definesMetricsOrUnits =
    (pack.metrics?.length ?? 0) > 0 || (pack.units?.length ?? 0) > 0;
  if (proposals.length === 0) {
    if (mappingsAdded > 0) {
      ctx.toast(ctx.t('import.mappingsAdded', { count: mappingsAdded }));
    } else if (definesMetricsOrUnits) {
      ctx.toast(ctx.t('import.packApplied'));
    }
    if (definesMetricsOrUnits) ctx.navigate('metrics-manage');
    return;
  }
  handOff(ctx, proposals, packMeta);
}

/**
 * PDF import with password support: a protected PDF triggers a modal password
 * prompt, mirroring the encrypted-backup flow. Any other failure surfaces the
 * generic PDF error toast.
 */
export async function runPdfImport(ctx: AppContext, file: File): Promise<void> {
  const plugin = importPluginById('pdf');
  if (!plugin) return;
  const meta: PendingImportMeta = { pluginId: 'pdf', fileName: file.name };
  ctx.toast(ctx.t('settings.pdfLoading'));
  try {
    const proposals = await plugin.parse(
      { kind: 'file', file },
      { catalog: ctx.catalog(), importMappings: ctx.data().importMappings },
    );
    handOff(ctx, proposals, meta);
  } catch (err) {
    if (err instanceof PassphraseRequiredError) {
      renderImportPasswordPrompt(ctx, plugin, file, {
        requiredKey: 'import.pdfPasswordRequired',
        enterKey: 'import.filePassword',
        onError: () => ctx.toast(ctx.t('settings.pdfError'), 'error'),
      }, meta);
      return;
    }
    ctx.toast(ctx.t('settings.pdfError'), 'error');
  }
}

/**
 * Modal password prompt for a password-protected import (an encrypted JSON
 * backup or a protected PDF). A native `<dialog>` in the top layer, appended to
 * `document.body` — so a re-render can never clobber a half-typed password.
 * Retries `plugin.parse` with the entered password; a wrong password shows
 * `backup.wrongPassword` and lets the user try again. `onError` handles any
 * non-password failure (e.g. an unreadable PDF). Not a blocking `window.prompt`
 * — a normal DOM element.
 */
function renderImportPasswordPrompt(
  ctx: AppContext,
  plugin: ImportPlugin,
  file: File,
  opts: { requiredKey: StringKey; enterKey: StringKey; onError?: (err: unknown) => void },
  meta: PendingImportMeta = {},
): void {
  const { t } = ctx;
  const dialog = document.createElement('dialog');
  dialog.className = 'modal';
  // Name the dialog by its heading text (distinct from the input's own label).
  dialog.setAttribute('aria-label', t(opts.requiredKey));
  // Always drop the node once the dialog closes (button, Esc or backdrop).
  dialog.addEventListener('close', () => dialog.remove());

  const box = el('div', 'modal-box');
  box.append(textEl('p', t(opts.requiredKey), 'muted'));

  const pw = field(t(opts.enterKey));
  const pwInput = passwordInput(t(opts.enterKey));
  pw.wrap.append(pwInput);

  const error = inlineError();
  const row = el('div', 'settings-choice');
  const cancel = button(t('common.cancel'));
  cancel.addEventListener('click', () => dialog.close());
  const confirm = button(t('common.confirm'), 'primary');

  const submit = (): void => {
    clearError(error);
    confirm.disabled = true;
    void (async () => {
      try {
        const proposals = await plugin.parse(
          { kind: 'file', file },
          {
            catalog: ctx.catalog(),
            password: pwInput.value,
            importMappings: ctx.data().importMappings,
          },
        );
        dialog.close();
        handOff(ctx, proposals, meta);
      } catch (err) {
        if (err instanceof WrongPassphraseError) {
          showError(error, t('backup.wrongPassword'));
          confirm.disabled = false;
          pwInput.select();
          return;
        }
        dialog.close();
        if (opts.onError) opts.onError(err);
        else throw err;
      }
    })();
  };
  confirm.addEventListener('click', submit);
  pwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  row.append(cancel, confirm);
  box.append(pw.wrap, error, row);
  dialog.append(box);
  document.body.append(dialog);
  dialog.showModal();
  pwInput.focus();
}

/** Run a file import plugin whose output goes straight to the review screen. */
export async function runPluginImport(
  ctx: AppContext,
  pluginId: string,
  file: File,
): Promise<void> {
  const plugin = importPluginById(pluginId);
  if (!plugin) return;
  const proposals = await plugin.parse(
    { kind: 'file', file },
    { catalog: ctx.catalog(), importMappings: ctx.data().importMappings },
  );
  handOff(ctx, proposals, { pluginId, fileName: file.name });
}

/**
 * Normalize + resolve against the catalog into review items, then navigate.
 * When `importKnownOnly` is on, proposals are filtered first to those that
 * already resolve to a real catalog metric — unresolved names and dangling
 * ids are dropped rather than turned into new metrics.
 */
function handOff(
  ctx: AppContext,
  proposals: Awaited<ReturnType<ImportPlugin['parse']>>,
  meta: PendingImportMeta = {},
): void {
  const filtered = getImportKnownOnly(ctx)
    ? proposals.filter(
        (p) => typeof p.metric === 'string' && ctx.catalog().byId(p.metric) !== undefined,
      )
    : proposals;
  const items = ctx.pipeline().prepare(filtered, { catalog: ctx.catalog() });
  dispatchPreparedImport(ctx, items, meta);
}

/**
 * Route a prepared review batch to the pre-import filter step or straight to
 * review. Shared by every import path (via {@link handOff}) AND the CSV
 * column-mapping screen, so the generic "What to import" decision lives in ONE
 * place: a big batch (per {@link shouldShowImportFilter}) gets the filter step, a
 * small one goes straight to review with no extra friction. The batch is stored
 * before navigating so either destination can read it.
 */
export function dispatchPreparedImport(
  ctx: AppContext,
  items: ReviewItem[],
  meta: PendingImportMeta = {},
): void {
  // Compose the offerHiddenMetrics gate here — the one choke point every import
  // path (file imports via handOff AND the CSV column-mapping screen) funnels
  // through. When hidden metrics must NOT be offered, downgrade any resolution
  // that landed on a currently-hidden metric to unresolved (create-new / skip).
  // When they ARE offered (default), the review row surfaces the hidden-pack
  // state itself.
  const gated = getOfferHiddenMetrics(ctx)
    ? items
    : downgradeHiddenResolutions(items, ctx.data(), ctx.catalog(), (m) => metricDisplayName(ctx, m));
  setPendingImport(gated, meta);
  ctx.navigate(shouldShowImportFilter(gated) ? 'import-filter' : 'review');
}

export async function runCsvImport(ctx: AppContext, file: File): Promise<void> {
  // Hand the raw text to the column-mapping screen; it builds proposals there.
  const text = await file.text();
  setPendingCsv(text, file.name);
  ctx.navigate('import-csv');
}
