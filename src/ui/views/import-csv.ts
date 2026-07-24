/**
 * CSV import — column-mapping screen (phase 2).
 *
 * Reads the raw CSV handed over by Settings, pre-fills a column mapping and
 * the number/date formats (locale is a property of the FILE, detected from the
 * data), lets the user adjust them, and builds proposals that flow into the
 * shared review pipeline. When the date order is ambiguous the user MUST pick
 * one before continuing — the importer never guesses (spec §16).
 *
 * Functional first; visual design is refined separately.
 */

import './import-csv.css';
import type { AppContext, View } from '../app-context';
import type { StringKey } from '../../i18n/index';
import {
  buildProposals,
  detectFormats,
  guessMapping,
  isMappingComplete,
  parseCsv,
  type CsvField,
  type CsvFormats,
  type CsvMapping,
  type DateOrder,
  type DecimalSeparator,
} from '../../core/csv';
import { dispatchPreparedImport } from './import-actions';

let pendingCsv: string | undefined;
let pendingCsvFileName: string | undefined;

/** Set by the import action before navigating to the 'import-csv' route. */
export function setPendingCsv(text: string, fileName?: string): void {
  pendingCsv = text;
  pendingCsvFileName = fileName;
}

const FIELD_OPTIONS: ReadonlyArray<{ field: CsvField; key: StringKey }> = [
  { field: 'metric', key: 'csv.field.metric' },
  { field: 'loinc', key: 'csv.field.loinc' },
  { field: 'value', key: 'csv.field.value' },
  { field: 'unit', key: 'csv.field.unit' },
  { field: 'date', key: 'csv.field.date' },
  { field: 'refLow', key: 'csv.field.refLow' },
  { field: 'refHigh', key: 'csv.field.refHigh' },
  { field: 'source', key: 'csv.field.source' },
  { field: 'note', key: 'csv.field.note' },
];

const DATE_ORDERS: ReadonlyArray<{ order: DateOrder; key: StringKey }> = [
  { order: 'dmy', key: 'csv.dateOrder.dmy' },
  { order: 'mdy', key: 'csv.dateOrder.mdy' },
  { order: 'ymd', key: 'csv.dateOrder.ymd' },
];

const PREVIEW_ROWS = 5;

export const importCsvView: View = {
  render(container: HTMLElement, ctx: AppContext): void {
    const { t } = ctx;
    container.replaceChildren();

    const table = parseCsv(pendingCsv ?? '');
    if (table.headers.length === 0 || table.rows.length === 0) {
      container.append(el('h1', t('csv.title')), el('p', t('csv.noRows'), 'muted'));
      return;
    }

    const mapping: CsvMapping = guessMapping(table.headers);
    const detected = detectFormats(table, mapping);
    let decimal: DecimalSeparator = detected.decimal;
    // Force an explicit choice when the date order cannot be detected.
    const ambiguous = detected.dateOrder === 'ambiguous';
    let dateOrder: DateOrder | undefined =
      detected.dateOrder === 'ambiguous' ? undefined : detected.dateOrder;

    // --- Header ---
    container.append(el('h1', t('csv.title')));
    container.append(el('p', t('csv.intro'), 'muted'));
    container.append(el('p', t('csv.rows', { count: table.rows.length }), 'muted'));

    // --- Format controls ---
    const formatCard = el('div', undefined, 'card csv-formats');

    const decField = el('div', undefined, 'field');
    decField.append(labelEl(t('csv.decimalSeparator')));
    const decSelect = selectEl(
      [
        { value: '.', label: t('csv.decimal.dot') },
        { value: ',', label: t('csv.decimal.comma') },
      ],
      decimal,
    );
    decSelect.addEventListener('change', () => {
      decimal = decSelect.value as DecimalSeparator;
    });
    decField.append(decSelect);

    const dateField = el('div', undefined, 'field');
    dateField.append(labelEl(t('csv.dateOrder')));
    const dateSelect = selectEl(
      [
        ...(ambiguous ? [{ value: '', label: '—' }] : []),
        ...DATE_ORDERS.map((o) => ({ value: o.order, label: t(o.key) })),
      ],
      dateOrder ?? '',
    );
    dateField.append(dateSelect);
    if (ambiguous) {
      dateField.append(el('p', t('csv.dateAmbiguous'), 'pill above'));
    }
    dateSelect.addEventListener('change', () => {
      dateOrder = dateSelect.value === '' ? undefined : (dateSelect.value as DateOrder);
      refreshContinue();
    });

    formatCard.append(decField, dateField);
    container.append(formatCard);

    // --- Column mapping ---
    const mapCard = el('div', undefined, 'card csv-mapping');
    mapCard.append(el('h2', t('csv.column')));
    table.headers.forEach((header, colIndex) => {
      const row = el('div', undefined, 'csv-map-row');
      row.append(el('span', header || `#${colIndex + 1}`, 'csv-col-name'));
      const sel = selectEl(
        [
          { value: '', label: t('csv.ignore') },
          ...FIELD_OPTIONS.map((f) => ({ value: f.field, label: t(f.key) })),
        ],
        mapping[colIndex] ?? '',
      );
      sel.addEventListener('change', () => {
        mapping[colIndex] = sel.value === '' ? undefined : (sel.value as CsvField);
        refreshContinue();
      });
      row.append(sel);
      mapCard.append(row);
    });
    container.append(mapCard);

    // --- Preview ---
    const previewCard = el('div', undefined, 'card csv-preview');
    previewCard.append(el('h2', t('csv.preview')));
    const scroll = el('div', undefined, 'csv-scroll');
    const previewTable = document.createElement('table');
    const thead = document.createElement('tr');
    for (const h of table.headers) {
      const th = document.createElement('th');
      th.textContent = h;
      thead.append(th);
    }
    previewTable.append(thead);
    for (const dataRow of table.rows.slice(0, PREVIEW_ROWS)) {
      const tr = document.createElement('tr');
      table.headers.forEach((_h, i) => {
        const td = document.createElement('td');
        td.textContent = dataRow[i] ?? '';
        tr.append(td);
      });
      previewTable.append(tr);
    }
    scroll.append(previewTable);
    previewCard.append(scroll);
    container.append(previewCard);

    // --- Continue ---
    const hint = el('p', t('csv.needValueAndDate'), 'muted');
    const continueBtn = document.createElement('button');
    continueBtn.className = 'primary';
    continueBtn.textContent = t('csv.continue');
    continueBtn.addEventListener('click', () => {
      const formats: CsvFormats = { decimal, dateOrder: dateOrder ?? 'ymd' };
      const proposals = buildProposals(table, mapping, ctx.catalog(), formats);
      const items = ctx.pipeline().prepare(proposals, { catalog: ctx.catalog() });
      dispatchPreparedImport(ctx, items, {
        pluginId: 'csv',
        ...(pendingCsvFileName ? { fileName: pendingCsvFileName } : {}),
      });
    });
    container.append(hint, continueBtn);

    function refreshContinue(): void {
      const ready = isMappingComplete(mapping) && dateOrder !== undefined;
      continueBtn.disabled = !ready;
      hint.style.display = ready ? 'none' : '';
    }
    refreshContinue();
  },
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function labelEl(text: string): HTMLElement {
  return el('label', text);
}

function selectEl(
  options: ReadonlyArray<{ value: string; label: string }>,
  selected: string,
): HTMLSelectElement {
  const select = document.createElement('select');
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === selected) o.selected = true;
    select.append(o);
  }
  return select;
}
