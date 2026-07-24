/**
 * Shared source picker (component).
 *
 * A single pill `<select>` — leading option (None or the built-in Manual entry),
 * every existing source, then "+ New source…" which reveals a name input and a
 * kind pill-select. One implementation used by the import review screen, manual
 * entry, the measurement edit row and the timeline bulk-change dialog, so the
 * source UX lives in exactly one place (no four copies).
 *
 * The component owns its own reveal state; callers read the current selection via
 * `getSelection()` or resolve it to a concrete source with `resolve()` (see
 * `source-picker-model`). Every user string is passed in by the caller (already
 * translated) so this file stays i18n-free.
 */

import type { AppContext } from '../app-context';
import type { SourceId, SourceKind } from '../../core/types';
import { sourceKindOptions } from '../views/settings-model';
import {
  resolveSourceSelection,
  type ResolvedSource,
  type SourceSelection,
} from './source-picker-model';
import './source-picker.css';

/** Sentinel option values (never collide with real source ids). */
const SEL_NONE = '__none__';
const SEL_MANUAL = '__manual__';
const SEL_NEW = '__new__';

export interface SourcePickerOptions {
  /** Initial selection. */
  initial: SourceSelection;
  /** Leading option: 'none' (→ no source) or 'manual' (→ the built-in manual source). */
  emptyMode: 'none' | 'manual';
  /** Translated label for the leading option ("None" / "Manual entry"). */
  emptyLabel: string;
  /** Translated label for the "create new source" option. */
  newLabel: string;
  /** Translated placeholder for the new-source name input. */
  namePlaceholder: string;
  /** Translated aria-label for the new-source name input. */
  nameAriaLabel: string;
  /** Translated aria-label for the new-source kind select. */
  kindAriaLabel: string;
  /** Translated aria-label for the main select. */
  selectAriaLabel: string;
  /**
   * Translated name to give a freshly-created manual source when `emptyMode`
   * is 'manual' and none exists yet (passed through to the resolver).
   */
  manualName?: string;
  /** Extra class(es) on the `<select>` (settings-inline-select is always added). */
  selectClass?: string;
  /** Optional id for the `<select>`. */
  selectId?: string;
  /** Extra class(es) on the new-source reveal container. */
  newFormClass?: string;
  /** Extra class(es) on the new-source name input. */
  nameInputClass?: string;
  /** Extra class(es) on the new-source kind select. */
  kindSelectClass?: string;
  /** Notified after any change (callers that re-render elsewhere can react). */
  onChange?: (selection: SourceSelection) => void;
}

export interface SourcePicker {
  /** The picker's root element (select + new-source form). */
  el: HTMLElement;
  /** Current raw selection. */
  getSelection(): SourceSelection;
  /** Resolve the current selection to a concrete source (see the model). */
  resolve(): ResolvedSource;
}

function classOf(...names: (string | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

export function sourcePicker(ctx: AppContext, opts: SourcePickerOptions): SourcePicker {
  const sources = ctx.data().sources;
  // A manual leading option represents the built-in manual source itself, so it
  // is not repeated in the existing-sources list below.
  const listed = opts.emptyMode === 'manual' ? sources.filter((s) => s.kind !== 'manual') : sources;

  let selection: SourceSelection = opts.initial;

  const root = document.createElement('div');
  root.className = 'source-picker';

  const select = document.createElement('select');
  select.className = classOf('settings-inline-select', opts.selectClass);
  if (opts.selectId) select.id = opts.selectId;
  select.setAttribute('aria-label', opts.selectAriaLabel);

  const emptyValue = opts.emptyMode === 'manual' ? SEL_MANUAL : SEL_NONE;
  select.add(new Option(opts.emptyLabel, emptyValue));
  for (const src of listed) {
    const label =
      src.name.trim() || ctx.t(`source.kind.${src.kind}` as Parameters<AppContext['t']>[0]);
    select.add(new Option(label, src.id));
  }
  select.add(new Option(opts.newLabel, SEL_NEW));

  // ---- New-source sub-form (name + kind), revealed only in "new" mode. ------
  const newForm = document.createElement('div');
  newForm.className = classOf('source-picker-new', opts.newFormClass);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = classOf('source-picker-name', opts.nameInputClass);
  nameInput.placeholder = opts.namePlaceholder;
  nameInput.setAttribute('aria-label', opts.nameAriaLabel);
  nameInput.value = selection.mode === 'new' ? selection.name : '';

  const kindSelect = document.createElement('select');
  kindSelect.className = classOf('settings-inline-select', opts.kindSelectClass);
  kindSelect.setAttribute('aria-label', opts.kindAriaLabel);
  for (const opt of sourceKindOptions()) kindSelect.add(new Option(ctx.t(opt.labelKey), opt.kind));
  kindSelect.value = selection.mode === 'new' ? selection.kind : 'lab';

  newForm.append(nameInput, kindSelect);

  const syncForm = (): void => {
    newForm.hidden = selection.mode !== 'new';
  };

  // Seed the select value from the initial selection. A stale existing id (or a
  // manual id excluded from the list) leaves the select on its first option, so
  // reconcile the selection back from the select afterwards.
  if (selection.mode === 'existing') select.value = selection.sourceId;
  else if (selection.mode === 'new') select.value = SEL_NEW;
  else select.value = emptyValue;
  if (selection.mode === 'existing' && select.value !== selection.sourceId) readSelect();
  syncForm();

  function readSelect(): void {
    const v = select.value;
    if (v === SEL_NONE) selection = { mode: 'none' };
    else if (v === SEL_MANUAL) selection = { mode: 'manual' };
    else if (v === SEL_NEW)
      selection = { mode: 'new', name: nameInput.value, kind: kindSelect.value as SourceKind };
    else selection = { mode: 'existing', sourceId: v as SourceId };
  }

  select.addEventListener('change', () => {
    readSelect();
    syncForm();
    opts.onChange?.(getSelection());
  });
  nameInput.addEventListener('input', () => {
    if (selection.mode === 'new') {
      selection = { ...selection, name: nameInput.value };
      opts.onChange?.(getSelection());
    }
  });
  kindSelect.addEventListener('change', () => {
    if (selection.mode === 'new') {
      selection = { ...selection, kind: kindSelect.value as SourceKind };
      opts.onChange?.(getSelection());
    }
  });

  root.append(select, newForm);

  function getSelection(): SourceSelection {
    return { ...selection };
  }

  return {
    el: root,
    getSelection,
    resolve: () => resolveSourceSelection(ctx.data().sources, getSelection(), opts.manualName),
  };
}
