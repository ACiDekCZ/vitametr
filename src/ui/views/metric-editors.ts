/**
 * Shared metric metadata editors — the repeatable chip / row editors used by
 * BOTH the metric detail (Veličiny page) and the "Add metric" dialog.
 *
 * Each editor renders into a caller-owned container and manages its own local
 * re-render on every add / remove, so a value can be added repeatedly without
 * the surrounding view repainting. The caller supplies the data source (`list`)
 * and the commit callbacks (`add` / `remove` / …); the editor stays agnostic to
 * whether those persist immediately (the detail, via the catalog) or accumulate
 * into in-memory arrays (the add dialog). After a successful add the focus
 * returns to the "+ add" chip so values can be chained quickly.
 *
 * Behaviour is identical everywhere: Enter or the ✓ button commits, Escape (or
 * an empty blur) cancels, × removes. All user-facing text goes through `t`.
 */

import type { AppContext } from '../app-context';
import { SEEDED_TAG_IDS, WATCHED_TAG, isWatchedAlias, tagLabel } from '../../core/tags';

type Translate = AppContext['t'];

// ---------------------------------------------------------------------------
// Small DOM helpers (local — the module is self-contained)
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

// ---------------------------------------------------------------------------
// Generic single-value chip list (aliases, tags)
// ---------------------------------------------------------------------------

interface ChipListOptions {
  container: HTMLElement;
  t: Translate;
  /** Label of the trailing "+ add" chip (and its editor's aria/confirm label). */
  addLabel: string;
  /** Placeholder / aria-label for the inline text input. */
  placeholder: string;
  /** Optional datalist id offering suggestions (tags). */
  datalistId?: string;
  /** Current stored raw values. Read fresh on every re-render. */
  list: () => string[];
  /** Map a raw stored value to its display label (tags → localized). */
  display?: (value: string) => string;
  /** Normalize the typed input before committing (default: trim). */
  normalize?: (raw: string) => string;
  add: (value: string) => void;
  remove: (value: string) => void;
  /** Side effect after any committed change (repaint filters/list). */
  onChange?: () => void;
}

function chipList(opts: ChipListOptions): void {
  const { container, t } = opts;
  const normalize = opts.normalize ?? ((raw: string): string => raw.trim());

  const focusAdd = (): void => {
    container.querySelector<HTMLElement>('.metric-chip-add')?.focus();
  };

  const render = (): void => {
    container.replaceChildren();
    for (const value of opts.list()) {
      container.append(renderChip(value));
    }
    container.append(renderAddChip());
  };

  const renderChip = (value: string): HTMLElement => {
    const chip = el('span', 'metric-chip');
    chip.append(textEl('span', opts.display ? opts.display(value) : value, 'metric-chip-text'));
    const remove = button('×', 'metric-chip-remove');
    remove.setAttribute('aria-label', t('common.remove'));
    remove.addEventListener('click', () => {
      opts.remove(value);
      render();
      focusAdd();
      opts.onChange?.();
    });
    chip.append(remove);
    return chip;
  };

  const renderAddChip = (): HTMLButtonElement => {
    const add = button(opts.addLabel, 'metric-chip metric-chip-add');
    add.addEventListener('click', () => {
      const editor = el('span', 'metric-chip metric-chip-editor');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'metric-chip-input';
      input.placeholder = opts.placeholder;
      input.setAttribute('aria-label', opts.placeholder);
      if (opts.datalistId) input.setAttribute('list', opts.datalistId);

      let finished = false;
      const finish = (save: boolean): void => {
        if (finished) return;
        finished = true;
        const value = normalize(input.value);
        const committed = save && value !== '';
        if (committed) opts.add(value);
        render();
        if (committed) {
          focusAdd();
          opts.onChange?.();
        }
      };

      // Explicit confirm keeps the commit off focus/blur timing; Enter also
      // commits, Escape or an empty blur cancels (a typed value waits for the
      // confirm so a blur racing the commit can never drop it).
      const confirm = button('✓', 'metric-chip-confirm');
      confirm.setAttribute('aria-label', opts.addLabel);
      confirm.addEventListener('click', () => finish(true));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      });
      input.addEventListener('blur', () => {
        if (input.value.trim() === '') finish(false);
      });

      editor.append(input, confirm);
      container.replaceChild(editor, add);
      input.focus();
    });
    return add;
  };

  render();
}

/** Resolve a typed tag to a seeded id when it matches a label/id, else raw. */
export function resolveTagInput(raw: string, t: Translate): string {
  const s = raw.trim();
  if (s === '') return '';
  // The reserved "watched" tag: match its id, its localized label, or a raw
  // "Sledované"/"Watched" duplicate — all canonicalize to WATCHED_TAG.
  if (isWatchedAlias(s) || tagLabel(WATCHED_TAG, t).toLowerCase() === s.toLowerCase()) {
    return WATCHED_TAG;
  }
  const lower = s.toLowerCase();
  for (const seeded of SEEDED_TAG_IDS) {
    if (seeded === lower || tagLabel(seeded, t).toLowerCase() === lower) return seeded;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Alias chips — free-text recognised names
// ---------------------------------------------------------------------------

export interface AliasChipsOptions {
  container: HTMLElement;
  t: Translate;
  list: () => string[];
  add: (value: string) => void;
  remove: (value: string) => void;
  onChange?: () => void;
}

export function aliasChips(o: AliasChipsOptions): void {
  chipList({
    container: o.container,
    t: o.t,
    addLabel: o.t('metrics.aliasAdd'),
    placeholder: o.t('metrics.aliasPlaceholder'),
    list: o.list,
    add: o.add,
    remove: o.remove,
    onChange: o.onChange,
  });
}

// ---------------------------------------------------------------------------
// Tag chips — seeded-vocabulary suggestions + free text
// ---------------------------------------------------------------------------

export interface TagChipsOptions {
  container: HTMLElement;
  t: Translate;
  /** Datalist id offering the seeded tag vocabulary. */
  datalistId?: string;
  list: () => string[];
  add: (value: string) => void;
  remove: (value: string) => void;
  onChange?: () => void;
}

export function tagChips(o: TagChipsOptions): void {
  chipList({
    container: o.container,
    t: o.t,
    addLabel: o.t('metrics.tagAdd'),
    placeholder: o.t('metrics.tagPlaceholder'),
    datalistId: o.datalistId,
    list: o.list,
    display: (tag) => tagLabel(tag, o.t),
    normalize: (raw) => resolveTagInput(raw, o.t),
    add: o.add,
    remove: o.remove,
    onChange: o.onChange,
  });
}

// ---------------------------------------------------------------------------
// External-code rows — the special-cased LOINC plus a repeatable list of
// generic system+code pairs.
// ---------------------------------------------------------------------------

export interface CodeRowsOptions {
  container: HTMLElement;
  t: Translate;
  /** Current LOINC value (empty when unset). Read fresh on every re-render. */
  loinc: () => string;
  /** Persist a (validated) LOINC — an empty string clears it. */
  setLoinc: (value: string) => void;
  /** Current generic code pairs. Read fresh on every re-render. */
  others: () => { system: string; code: string }[];
  addOther: (system: string, code: string) => void;
  updateOther: (index: number, system: string, code: string) => void;
  removeOther: (index: number) => void;
  onChange?: () => void;
}

export function codeRows(o: CodeRowsOptions): void {
  const { container, t } = o;

  const render = (): void => {
    container.replaceChildren();
    container.append(loincRow());
    o.others().forEach((pair, index) => container.append(pairRow(index, pair)));
    container.append(addPairChip());
  };

  // --- LOINC row (label + value + inline `\d+-\d` validation) ---------------
  const loincRow = (): HTMLElement => {
    const value = o.loinc();
    const row = el('div', 'metric-code-row');
    row.append(textEl('span', t('metrics.loinc'), 'metric-code-label'));
    row.append(
      textEl(
        'span',
        value || t('metrics.codeNone'),
        value ? 'metric-code-value' : 'metric-code-value is-empty',
      ),
    );
    const edit = button(value ? t('common.edit') : t('metrics.codeAdd'), 'metric-code-edit');
    edit.addEventListener('click', () => editLoinc(row));
    row.append(edit);
    return row;
  };

  const editLoinc = (row: HTMLElement): void => {
    row.replaceChildren();
    row.append(textEl('span', t('metrics.loinc'), 'metric-code-label'));

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'metric-code-input';
    input.value = o.loinc();
    input.placeholder = t('metrics.loincPlaceholder');
    input.setAttribute('aria-label', t('metrics.loinc'));

    const error = textEl('span', t('metrics.loincInvalid'), 'metric-code-error');
    error.hidden = true;

    const save = button('✓', 'metric-chip-confirm');
    save.setAttribute('aria-label', t('common.save'));

    const commit = (): void => {
      const raw = input.value.trim();
      // Allow clearing (empty), otherwise require the LOINC `\d+-\d` shape.
      if (raw !== '' && !/^\d+-\d$/.test(raw)) {
        error.hidden = false;
        input.focus();
        return;
      }
      o.setLoinc(raw);
      render();
      o.onChange?.();
    };

    save.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        render();
      }
    });

    row.append(input, save, error);
    input.focus();
  };

  // --- Generic system+code pair row ----------------------------------------
  const pairRow = (index: number, pair: { system: string; code: string }): HTMLElement => {
    const row = el('div', 'metric-code-row');
    row.append(textEl('span', pair.system, 'metric-code-label metric-code-system'));
    row.append(textEl('span', pair.code, 'metric-code-value'));

    const edit = button(t('common.edit'), 'metric-code-edit');
    edit.addEventListener('click', () =>
      pairEditor(
        row,
        pair,
        (system, code) => {
          o.updateOther(index, system, code);
          render();
          o.onChange?.();
        },
        () => render(),
      ),
    );

    const remove = button('×', 'metric-chip-remove');
    remove.setAttribute('aria-label', t('common.remove'));
    remove.addEventListener('click', () => {
      o.removeOther(index);
      render();
      o.onChange?.();
    });

    row.append(edit, remove);
    return row;
  };

  const pairEditor = (
    row: HTMLElement,
    pair: { system: string; code: string },
    onSave: (system: string, code: string) => void,
    onCancel: () => void,
  ): void => {
    row.replaceChildren();

    const systemInput = document.createElement('input');
    systemInput.type = 'text';
    systemInput.className = 'metric-code-input metric-code-system-input';
    systemInput.value = pair.system;
    systemInput.placeholder = t('metrics.codeSystem');
    systemInput.setAttribute('aria-label', t('metrics.codeSystem'));

    const codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.className = 'metric-code-input';
    codeInput.value = pair.code;
    codeInput.placeholder = t('metrics.code');
    codeInput.setAttribute('aria-label', t('metrics.code'));

    const save = button('✓', 'metric-chip-confirm');
    save.setAttribute('aria-label', t('common.save'));

    const commit = (): void => {
      const system = systemInput.value.trim();
      const code = codeInput.value.trim();
      // Both parts are required; an incomplete pair just cancels.
      if (system === '' || code === '') {
        onCancel();
        return;
      }
      onSave(system, code);
    };

    save.addEventListener('click', commit);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    systemInput.addEventListener('keydown', onKey);
    codeInput.addEventListener('keydown', onKey);

    row.append(systemInput, codeInput, save);
    systemInput.focus();
  };

  // --- The persistent "+ code" chip ----------------------------------------
  // BUG FIX: the editor row is inserted BEFORE this chip (it stays at the end),
  // so codes can be added repeatedly — the old code replaced the chip with the
  // row, so it vanished and only one extra code could be added per open detail.
  const addPairChip = (): HTMLButtonElement => {
    const add = button(t('metrics.codeAddPair'), 'metric-chip metric-chip-add');
    add.addEventListener('click', () => {
      const row = el('div', 'metric-code-row');
      pairEditor(
        row,
        { system: '', code: '' },
        (system, code) => {
          o.addOther(system, code);
          render();
          container.querySelector<HTMLElement>('.metric-chip-add')?.focus();
          o.onChange?.();
        },
        () => render(),
      );
      container.insertBefore(row, add);
    });
    return add;
  };

  render();
}
