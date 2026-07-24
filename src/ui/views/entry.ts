/**
 * Add Values (entry) screen (K8c).
 *
 * A restrained, mobile-first form for fast one-handed entry: several value rows
 * share one date and one source (a "result sheet" batch), plus a one-tap blood-
 * pressure group that records systolic + diastolic + pulse together. Values run
 * through the shared import pipeline with a silent confirm (no review screen):
 * the manual plugin turns the typed fields into high-confidence proposals, which
 * are prepared, auto-accepted and committed as `confirmed` measurements.
 *
 * All DOM-free logic (search, validation, payload building) lives in
 * entry-model.ts; this file is the view wiring only. All user text goes through
 * ctx.t with existing i18n keys.
 */

import type { AppContext, RouteState, View } from '../app-context';
import type { StringKey } from '../../i18n/index';
import type { Metric, MetricId } from '../../core/types';
import { manualImportPlugin } from '../../plugins/import/manual';
import { parseNumber } from '../../core/normalize';
import { dataSwitch } from '../components/data-switch';
import { metricPicker } from '../components/metric-picker';
import { sourcePicker } from '../components/source-picker';
import {
  resolveSourceSelection,
  selectionSourceName,
  type SourceSelection,
} from '../components/source-picker-model';
import {
  buildManualInput,
  defaultUnitFor,
  metricsInGroup,
  recentMetricIds,
  resolveMetricSelection,
  validateField,
  type EntryFieldInput,
  type EntryFormInput,
} from './entry-model';
import './entry.css';

const BLOOD_PRESSURE_GROUP = 'blood-pressure';

interface SingleRow {
  kind: 'single';
  key: number;
  metric?: Metric;
  query: string;
  unresolved?: string;
  newUnit: string;
  /** Comma-separated aliases typed when creating a new metric. */
  newAliases: string;
  value: string;
  /** Selected values for a 'multi'-valueType metric. */
  multiValues: string[];
  unit?: string;
  refLow: string;
  refHigh: string;
  note: string;
  expanded: boolean;
  /** Value-type chosen while creating a new metric (undefined = infer from typed value). */
  newValueType?: 'number' | 'text' | 'enum' | 'multi';
  /** Comma-separated allowed values typed for a new enum/multi metric. */
  newEnumValues: string;
}

interface BpRow {
  kind: 'bp';
  key: number;
  values: Record<string, string>;
}

type Row = SingleRow | BpRow;

// ---------------------------------------------------------------------------
// Small DOM helper
// ---------------------------------------------------------------------------

type Attrs = Record<string, string | number | boolean | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

export const entryView: View = {
  render(container: HTMLElement, ctx: AppContext, _route: RouteState): () => void {
    let rowSeq = 0;
    const nextKey = (): number => (rowSeq += 1);

    const now = ctx.now();
    const state = {
      date: now.slice(0, 10),
      time: now.includes('T') ? now.slice(11, 16) : '',
      rows: [] as Row[],
      // Source attribution for the batch, edited via the shared source picker.
      // Defaults to the built-in manual source (created on save if absent).
      sourceSelection: { mode: 'manual' } as SourceSelection,
      // The most recent metric quick-created inline, so a successful save can
      // offer an "Add details" toast that jumps to its detail on the Metrics page.
      pendingCreated: undefined as { id: MetricId; name: string } | undefined,
    };

    function newSingleRow(): SingleRow {
      return {
        kind: 'single',
        key: nextKey(),
        query: '',
        newUnit: '',
        newAliases: '',
        value: '',
        multiValues: [],
        refLow: '',
        refHigh: '',
        note: '',
        expanded: false,
        newEnumValues: '',
      };
    }

    state.rows.push(newSingleRow());

    const metricName = (m: Metric): string =>
      m.customName ?? (m.nameKey ? ctx.t(m.nameKey as StringKey) : (m.key ?? ''));

    const unitLabel = (code: string): string => ctx.units.getUnit(code)?.display ?? code;

    /** Most recent unit the user recorded a metric in (for prefill). */
    function lastUsedUnit(metricId: string): string | undefined {
      let best: { takenAt: string; unit: string } | undefined;
      for (const m of ctx.data().measurements) {
        if (m.metricId !== metricId) continue;
        if (!best || m.takenAt > best.takenAt) best = { takenAt: m.takenAt, unit: m.unit };
      }
      return best?.unit;
    }

    // -----------------------------------------------------------------------
    // Source resolution — delegated to the shared source-picker resolver.
    // -----------------------------------------------------------------------

    /** Freshly-created manual source name (when none exists yet). */
    const manualName = (): string => ctx.t('source.kind.manual');

    function sourceNameForInput(): string | undefined {
      return selectionSourceName(ctx.data().sources, state.sourceSelection, manualName());
    }

    // -----------------------------------------------------------------------
    // New-metric creation (never a silent guess)
    // -----------------------------------------------------------------------

    function createUserMetric(row: SingleRow): void {
      const name = (row.unresolved ?? row.query).trim();
      if (!name) return;

      // Explicit choice wins; otherwise infer from what was typed: a
      // non-numeric value means a text (qualitative) metric — no unit.
      const valueTyped = row.value.trim();
      const inferredIsText = valueTyped !== '' && 'error' in parseNumber(valueTyped);
      const valueType: 'number' | 'text' | 'enum' | 'multi' =
        row.newValueType ?? (inferredIsText ? 'text' : 'number');

      const extraAliases = row.newAliases
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a !== '');

      let spec: Omit<Metric, 'id'>;
      if (valueType === 'enum' || valueType === 'multi') {
        const enumValues = row.newEnumValues
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v !== '');
        spec = {
          customName: name,
          aliases: [name, ...extraAliases],
          category: 'custom',
          valueType,
          enumValues,
          canonicalUnit: '',
          units: [],
        };
      } else if (valueType === 'text') {
        spec = {
          customName: name,
          aliases: [name, ...extraAliases],
          category: 'custom',
          valueType: 'text',
          canonicalUnit: '',
          units: [],
        };
      } else {
        const unitRaw = row.newUnit.trim();
        spec = {
          customName: name,
          aliases: [name, ...extraAliases],
          category: 'custom',
          valueType: 'number',
          canonicalUnit: unitRaw,
          units: unitRaw ? [unitRaw] : [],
        };
      }

      let created: Metric | undefined;
      ctx.mutate(() => {
        created = ctx.catalog().addUserMetric({ ...spec, origin: { kind: 'manual' } });
      });
      if (created) {
        row.metric = created;
        row.unresolved = undefined;
        row.query = '';
        row.unit = created.canonicalUnit || undefined;
        // Remember it so a successful save offers "Add details" (full editing
        // — aliases/tags/codes — happens on the Metrics page, not here).
        state.pendingCreated = { id: created.id, name };
      }
      render();
    }

    // -----------------------------------------------------------------------
    // Row rendering
    // -----------------------------------------------------------------------

    function renderMetricPicker(row: SingleRow): HTMLElement {
      const field = el('div', { class: 'field field-metric' });
      field.append(el('label', { text: ctx.t('entry.metric'), for: `metric-${row.key}` }));

      const picker = metricPicker({
        ctx,
        metricName,
        placeholder: ctx.t('entry.metricSearch'),
        ariaLabel: ctx.t('entry.metric'),
        inputId: `metric-${row.key}`,
        value: row.metric ? metricName(row.metric) : row.query,
        createLabel: (q) => `${ctx.t('entry.newMetric')} — “${q}”`,
        onPick: (m) => selectMetric(row, m),
        onCreate: (q) => {
          row.unresolved = q;
          row.query = q;
          render();
        },
        onInput: (value) => {
          row.metric = undefined;
          row.unresolved = undefined;
          row.query = value;
        },
      });
      field.append(picker.el);

      if (row.unresolved) {
        field.append(renderUnresolved(row));
      }
      return field;
    }

    /**
     * Quick-create, deliberately MINIMAL: after choosing "New metric — q" the
     * only inline control is a unit input (with known-unit suggestions). The
     * name is the searched text, the category is `custom`, and the value type is
     * inferred from the value you enter (a non-numeric answer makes it a text
     * metric). Aliases / tags / external codes are NOT set here — the post-save
     * "Add details" toast jumps to the metric's detail on the Metrics page for
     * the full editors.
     */
    function renderUnresolved(row: SingleRow): HTMLElement {
      const box = el('div', { class: 'field-hint unresolved' });
      box.append(el('div', { text: ctx.t('entry.unresolvedHint') }));

      const listId = `entry-unit-list-${row.key}`;
      const datalist = el('datalist', { id: listId });
      const seen = new Set<string>();
      for (const u of ctx.units.allUnits()) {
        if (u.display === '' || seen.has(u.display)) continue;
        seen.add(u.display);
        datalist.append(el('option', { value: u.display }));
      }

      const controls = el('div', { class: 'row-actions' });
      const unitInput = el('input', {
        type: 'text',
        list: listId,
        placeholder: ctx.t('entry.unitOptional'),
        value: row.newUnit,
        'aria-label': ctx.t('entry.unitOptional'),
      });
      unitInput.addEventListener('input', () => {
        row.newUnit = unitInput.value;
      });
      const createBtn = el('button', {
        type: 'button',
        class: 'primary',
        text: ctx.t('entry.newMetric'),
      });
      createBtn.addEventListener('click', () => createUserMetric(row));
      controls.append(unitInput, createBtn);
      box.append(datalist, controls);
      return box;
    }

    function selectMetric(row: SingleRow, metric: Metric): void {
      // Picking any blood-pressure member turns this row into the linked
      // sys/dia/pulse group — the group is entered as one unit.
      if (metric.entryGroup === BLOOD_PRESSURE_GROUP) {
        const idx = state.rows.indexOf(row);
        const bpRow: Row = { kind: 'bp', key: row.key, values: {} };
        if (idx >= 0) state.rows[idx] = bpRow;
        else state.rows.push(bpRow);
        render();
        return;
      }
      row.metric = metric;
      row.unresolved = undefined;
      row.query = '';
      row.unit = defaultUnitFor(metric, ctx.locale, lastUsedUnit(metric.id), ctx.data().settings.unitSystem);
      render();
    }

    function renderUnitField(row: SingleRow): HTMLElement | undefined {
      const metric = row.metric;
      if (!metric || metric.units.length === 0) return undefined;
      const field = el('div', { class: 'field field-unit' });
      field.append(el('label', { text: ctx.t('entry.unit'), for: `unit-${row.key}` }));
      const select = el('select', { id: `unit-${row.key}` });
      for (const code of metric.units) {
        const opt = el('option', { value: code, text: unitLabel(code) });
        if (code === row.unit) opt.selected = true;
        select.append(opt);
      }
      select.addEventListener('change', () => {
        row.unit = select.value;
        revalidate();
      });
      field.append(select);
      return field;
    }

    function renderValueField(row: SingleRow, hint: HTMLElement): HTMLElement {
      const field = el('div', { class: 'field field-value' });
      field.append(el('label', { text: ctx.t('entry.value'), for: `value-${row.key}` }));

      const valueType = row.metric?.valueType;

      if (valueType === 'enum') {
        const select = el('select', { id: `value-${row.key}`, 'aria-label': ctx.t('entry.value') });
        const placeholder = el('option', { value: '', text: ctx.t('entry.selectValue') });
        if (!row.value) placeholder.selected = true;
        select.append(placeholder);
        for (const value of row.metric?.enumValues ?? []) {
          const opt = el('option', { value, text: value });
          if (value === row.value) opt.selected = true;
          select.append(opt);
        }
        select.addEventListener('change', () => {
          row.value = select.value;
          updateHint(row, hint);
        });
        field.append(select);
        return field;
      }

      if (valueType === 'multi') {
        const chips = el('div', { class: 'value-multi-chips', id: `value-${row.key}` });
        for (const value of row.metric?.enumValues ?? []) {
          const active = row.multiValues.includes(value);
          const chip = el('button', {
            type: 'button',
            class: `value-chip${active ? ' is-active' : ''}`,
            text: value,
          });
          chip.addEventListener('click', () => {
            const idx = row.multiValues.indexOf(value);
            if (idx >= 0) row.multiValues.splice(idx, 1);
            else row.multiValues.push(value);
            render();
          });
          chips.append(chip);
        }
        field.append(chips);
        return field;
      }

      // undefined / 'number' / 'text' — plain text input.
      const isText = row.metric !== undefined && row.metric.valueType !== 'number';
      const input = el('input', {
        id: `value-${row.key}`,
        type: 'text',
        inputmode: isText ? 'text' : 'decimal',
        value: row.value,
        'aria-label': ctx.t('entry.value'),
      });
      input.addEventListener('input', () => {
        row.value = input.value;
        updateHint(row, hint);
      });
      field.append(input);
      return field;
    }

    function updateHint(row: SingleRow, hint: HTMLElement): void {
      hint.className = 'field-hint';
      hint.textContent = '';
      if (row.value.trim() === '') return;
      const v = validateField(row.value, row.metric, { unit: row.unit, units: ctx.units });
      if (!v.ok) {
        hint.classList.add('error');
        hint.textContent = ctx.t('entry.invalidValue');
      } else if (v.warning) {
        hint.classList.add('warn');
        hint.textContent = ctx.t('entry.unusualValue');
      }
    }

    function renderMeta(row: SingleRow): HTMLElement {
      const meta = el('div', { class: 'row-meta' });
      const mk = (labelKey: StringKey, cur: string, set: (v: string) => void): HTMLElement => {
        const f = el('div', { class: 'field' });
        f.append(el('label', { text: ctx.t(labelKey) }));
        const inp = el('input', { type: 'text', inputmode: 'decimal', value: cur });
        inp.addEventListener('input', () => set(inp.value));
        f.append(inp);
        return f;
      };
      meta.append(
        mk('entry.refLow', row.refLow, (v) => (row.refLow = v)),
        mk('entry.refHigh', row.refHigh, (v) => (row.refHigh = v)),
      );
      const noteField = el('div', { class: 'field', style: 'grid-column:1/-1' });
      noteField.append(el('label', { text: ctx.t('entry.note') }));
      const noteInput = el('input', { type: 'text', value: row.note });
      noteInput.addEventListener('input', () => (row.note = noteInput.value));
      noteField.append(noteInput);
      meta.append(noteField);
      return meta;
    }

    function renderSingleRow(row: SingleRow): HTMLElement {
      const card = el('div', { class: `card entry-row${row.expanded ? ' expanded' : ''}` });
      const grid = el('div', { class: 'row-grid' });
      const hint = el('div', { class: 'field-hint' });

      grid.append(renderMetricPicker(row));
      grid.append(renderValueField(row, hint));
      const unitField = renderUnitField(row);
      if (unitField) grid.append(unitField);
      card.append(grid, hint);
      updateHint(row, hint);

      card.append(renderMeta(row));

      const actions = el('div', { class: 'row-actions' });
      const moreBtn = el('button', {
        type: 'button',
        class: 'link-button',
        text: ctx.t('metric.detail.range'),
        'aria-expanded': row.expanded,
      });
      moreBtn.addEventListener('click', () => {
        row.expanded = !row.expanded;
        render();
      });
      actions.append(moreBtn);
      actions.append(el('span', { class: 'spacer' }));
      if (state.rows.length > 1) {
        const rm = el('button', {
          type: 'button',
          class: 'remove-row',
          text: ctx.t('common.remove'),
        });
        rm.addEventListener('click', () => {
          state.rows = state.rows.filter((r) => r !== row);
          render();
        });
        actions.append(rm);
      }
      card.append(actions);
      return card;
    }

    function renderBpRow(row: BpRow): HTMLElement {
      const card = el('div', { class: 'card entry-row' });
      card.append(el('div', { class: 'entry-bp-title', text: ctx.t('entry.group.bloodPressure') }));
      const grid = el('div', { class: 'entry-bp-grid' });
      const groupMetrics = metricsInGroup(ctx.catalog(), BLOOD_PRESSURE_GROUP);
      for (const m of groupMetrics) {
        const field = el('div', { class: 'field' });
        field.append(el('label', { text: metricName(m) }));
        const input = el('input', {
          type: 'text',
          inputmode: 'decimal',
          value: row.values[m.id] ?? '',
          'aria-label': metricName(m),
        });
        input.addEventListener('input', () => {
          row.values[m.id] = input.value;
        });
        field.append(input);
        grid.append(field);
      }
      card.append(grid);

      const actions = el('div', { class: 'row-actions' });
      actions.append(el('span', { class: 'spacer' }));
      const rm = el('button', { type: 'button', class: 'remove-row', text: ctx.t('common.remove') });
      rm.addEventListener('click', () => {
        state.rows = state.rows.filter((r) => r !== row);
        render();
      });
      actions.append(rm);
      card.append(actions);
      return card;
    }

    // -----------------------------------------------------------------------
    // Quick-add chips (most-recently-used metrics)
    // -----------------------------------------------------------------------

    /** Append a fresh value row pre-filled with the given metric. */
    function addRowWithMetric(metric: Metric): void {
      const row = newSingleRow();
      row.metric = metric;
      row.unit = defaultUnitFor(metric, ctx.locale, lastUsedUnit(metric.id), ctx.data().settings.unitSystem);
      state.rows.push(row);
      render();
    }

    /** A row of dashed chips built from the profile's recently-used metrics. */
    function renderQuickAdd(): HTMLElement | undefined {
      const catalog = ctx.catalog();
      const metrics: Metric[] = [];
      for (const id of recentMetricIds(ctx.data().measurements, 5)) {
        const metric = catalog.byId(id);
        if (metric) metrics.push(metric);
      }
      if (metrics.length === 0) return undefined;

      const wrap = el('div', { class: 'entry-quickadd' });
      wrap.append(el('div', { class: 'quickadd-label', text: ctx.t('entry.quickAdd') }));
      const chips = el('div', { class: 'quickadd-chips' });
      for (const metric of metrics) {
        const chip = el('button', {
          type: 'button',
          class: 'quickadd-chip',
          text: `+ ${metricName(metric)}`,
        });
        chip.addEventListener('click', () => addRowWithMetric(metric));
        chips.append(chip);
      }
      wrap.append(chips);
      return wrap;
    }

    // -----------------------------------------------------------------------
    // Shared batch header (date/time + source)
    // -----------------------------------------------------------------------

    function renderBatchHeader(): HTMLElement {
      const card = el('div', { class: 'card' });
      const batch = el('div', { class: 'entry-batch' });

      const when = el('div', { class: 'entry-datetime' });
      const dateField = el('div', { class: 'field' });
      dateField.append(el('label', { text: ctx.t('entry.date'), for: 'entry-date' }));
      const dateInput = el('input', { id: 'entry-date', type: 'date', value: state.date });
      dateInput.addEventListener('input', () => (state.date = dateInput.value));
      dateField.append(dateInput);

      const timeField = el('div', { class: 'field' });
      timeField.append(el('label', { text: ctx.t('entry.time'), for: 'entry-time' }));
      const timeInput = el('input', { id: 'entry-time', type: 'time', value: state.time });
      timeInput.addEventListener('input', () => (state.time = timeInput.value));
      timeField.append(timeInput);
      when.append(dateField, timeField);

      batch.append(when, renderSourceField());
      card.append(batch);
      return card;
    }

    function renderSourceField(): HTMLElement {
      const field = el('div', { class: 'field field-source' });
      field.append(el('label', { text: ctx.t('entry.source'), for: 'entry-source' }));

      const picker = sourcePicker(ctx, {
        initial: state.sourceSelection,
        emptyMode: 'manual',
        emptyLabel: ctx.t('source.kind.manual'),
        newLabel: ctx.t('settings.addSource'),
        namePlaceholder: ctx.t('settings.sourceName'),
        nameAriaLabel: ctx.t('settings.sourceName'),
        kindAriaLabel: ctx.t('settings.sourceKind'),
        selectAriaLabel: ctx.t('entry.source'),
        manualName: manualName(),
        selectId: 'entry-source',
        // The picker owns its new-source reveal, so no full re-render is needed
        // on change — just keep the persisted selection in sync.
        onChange: (selection) => {
          state.sourceSelection = selection;
        },
      });
      field.append(picker.el);
      return field;
    }

    // -----------------------------------------------------------------------
    // Validation refresh across rows (used after unit changes)
    // -----------------------------------------------------------------------

    function revalidate(): void {
      render();
    }

    // -----------------------------------------------------------------------
    // Submit
    // -----------------------------------------------------------------------

    async function submit(): Promise<void> {
      const catalog = ctx.catalog();
      let blocked = false;
      let invalid = false;
      const fields: EntryFieldInput[] = [];

      for (const row of state.rows) {
        if (row.kind === 'bp') {
          const groupMetrics = metricsInGroup(catalog, BLOOD_PRESSURE_GROUP);
          for (const m of groupMetrics) {
            const raw = row.values[m.id] ?? '';
            if (raw.trim() === '') continue;
            const v = validateField(raw, m, { unit: m.canonicalUnit, units: ctx.units });
            if (!v.ok) {
              invalid = true;
              continue;
            }
            fields.push({ metric: m.id, rawValue: raw, unit: m.canonicalUnit });
          }
          continue;
        }

        // Single row: resolve a typed-but-unpicked metric first.
        if (!row.metric && row.query.trim() !== '') {
          const resolved = resolveMetricSelection(row.query, catalog);
          if ('metricId' in resolved) {
            row.metric = catalog.byId(resolved.metricId);
            if (row.metric) row.unit = defaultUnitFor(row.metric, ctx.locale, lastUsedUnit(row.metric.id), ctx.data().settings.unitSystem);
          } else {
            row.unresolved = resolved.unresolvedName;
            blocked = true;
          }
        }
        if (!row.metric) continue;

        if (row.metric.valueType === 'multi') {
          // An empty selection means "no value" — skip without blocking submit.
          if (row.multiValues.length === 0) continue;
          fields.push({
            metric: row.metric.id,
            rawValue: '',
            rawValues: row.multiValues,
            valueType: row.metric.valueType,
            unit: row.unit,
            refLow: row.refLow,
            refHigh: row.refHigh,
            note: row.note,
          });
          continue;
        }

        if (row.value.trim() === '') continue;

        const v = validateField(row.value, row.metric, { unit: row.unit, units: ctx.units });
        if (!v.ok) {
          invalid = true;
          continue;
        }
        fields.push({
          metric: row.metric.id,
          rawValue: row.value,
          valueType: row.metric.valueType,
          unit: row.unit,
          refLow: row.refLow,
          refHigh: row.refHigh,
          note: row.note,
        });
      }

      if (blocked || invalid) {
        render();
        return;
      }
      if (fields.length === 0) {
        render();
        return;
      }

      const { sourceId, newSource } = resolveSourceSelection(
        ctx.data().sources,
        state.sourceSelection,
        manualName(),
      );
      const form: EntryFormInput = {
        date: state.date,
        time: state.time || undefined,
        sourceName: sourceNameForInput(),
        fields,
      };
      const input = buildManualInput(form);

      const proposals = await manualImportPlugin.parse({ kind: 'data', data: input }, { catalog });
      const pipeline = ctx.pipeline();
      const items = pipeline.prepare(proposals, { catalog });
      for (const item of items) {
        if (item.resolvedMetricId) item.decision = 'accept';
      }
      const measurements = pipeline.commit(items, { sourceId, pluginId: manualImportPlugin.id });

      if (measurements.length > 0) {
        ctx.mutate((d) => {
          if (newSource && !d.sources.some((s) => s.id === newSource.id)) d.sources.push(newSource);
          d.measurements.push(...measurements);
        });
      }

      // If this save recorded a value for a just-quick-created metric, the toast
      // carries an "Add details" action that opens its detail on the Metrics
      // page (full aliases/tags/codes editing lives there, not in entry).
      const created = state.pendingCreated;
      const createdSaved = created !== undefined && fields.some((f) => f.metric === created.id);
      if (createdSaved && created) {
        ctx.toast(ctx.t('entry.metricCreated', { name: created.name }), 'success', {
          label: ctx.t('metrics.addDetails'),
          onClick: () => ctx.navigate('metrics-manage', created.id),
        });
      } else {
        ctx.toast(ctx.t('entry.saved'), 'success');
      }
      state.pendingCreated = undefined;

      // Reset the value rows for the next entry; keep the date and source so a
      // batch of results can be entered quickly one after another.
      state.rows = [newSingleRow()];
      render();
    }

    // -----------------------------------------------------------------------
    // Top-level render
    // -----------------------------------------------------------------------

    const form = el('form', { class: 'entry-form', novalidate: true });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void submit();
    });

    function render(): void {
      form.replaceChildren();
      form.append(renderBatchHeader());

      const quickAdd = renderQuickAdd();
      if (quickAdd) form.append(quickAdd);

      const rowsWrap = el('div', { class: 'entry-rows' });
      for (const row of state.rows) {
        rowsWrap.append(row.kind === 'bp' ? renderBpRow(row) : renderSingleRow(row));
      }
      form.append(rowsWrap);

      const addRow = el('div', { class: 'entry-actions' });
      const addBtn = el('button', { type: 'button', class: 'link-button', text: ctx.t('entry.addAnother') });
      addBtn.addEventListener('click', () => {
        state.rows.push(newSingleRow());
        render();
      });
      // Blood pressure is reached through the metric search (selecting it turns
      // the row into the sys/dia/pulse group) — no special standing shortcut.
      addRow.append(addBtn);
      form.append(addRow);

      const submitRow = el('div', { class: 'entry-actions entry-save' });
      const saveBtn = el('button', {
        type: 'submit',
        class: 'primary save-values',
        text: ctx.t('entry.add'),
      });
      submitRow.append(saveBtn);
      form.append(submitRow);
    }

    container.replaceChildren();
    container.append(
      el('h1', { text: ctx.t('entry.title') }),
      el('p', { class: 'entry-subtitle muted', text: ctx.t('entry.batchTitle') }),
      // Shared Zadat · Import · Export strip — the file-import path is the Import
      // tab now (the old ghost "have a file?" link is gone).
      dataSwitch(ctx, 'entry'),
      form,
    );
    render();

    return () => {
      container.replaceChildren();
    };
  },
};
