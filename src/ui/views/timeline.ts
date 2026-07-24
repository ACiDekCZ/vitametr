/**
 * Timeline screen (K8f) — a vertical, reverse-chronological rail of events.
 *
 * Restrained clinical, mobile-first: each dated event (a lab draw / a home
 * session) sits on a vertical rail — a dot plus a connector line — with its
 * values listed in a card to the right. All ordering, grouping and
 * name/category resolution live in the DOM-free `timeline-model`; this file is
 * only glue between that model and the DOM.
 *
 * Every user-facing string goes through `ctx.t` / `formatDateTime` /
 * `formatNumber`. No hardcoded copy, no clock, no randomness.
 */

import type { AppContext, View } from '../app-context';
import { formatDateTime } from '../../i18n/index';
import './timeline.css';
import { valueWithUnitEl } from '../format-value';
import type { MetricCategory, SourceId } from '../../core/types';
import {
  applySourceToGroup,
  buildTimeline,
  presentCategories,
  presentSourceIds,
  type TimelineFilters,
  type TimelineGroupModel,
  type TimelineValueModel,
} from './timeline-model';
import { resolveDisplayUnit } from './overview-model';
import { rangeStatusKey } from '../range-status';
import { sourcePicker } from '../components/source-picker';
import type { SourceSelection } from '../components/source-picker-model';

/** Above this many values on an axis, chips give way to a compact <select>. */
const CHIP_LIMIT = 5;

export const timelineView: View = {
  render(container: HTMLElement, ctx: AppContext): void {
    container.replaceChildren();

    const filters: TimelineFilters = {};

    const title = el('h1');
    title.textContent = ctx.t('timeline.title');

    const list = el('div', 'timeline-list');

    const measurements = ctx.data().measurements;
    const catalog = ctx.catalog();

    const filterBar = buildFilterBar(ctx, measurements, catalog, filters, () => renderList());
    container.append(title, filterBar, list);

    function renderList(): void {
      list.replaceChildren();
      const groups = buildTimeline(ctx.data().measurements, ctx.catalog(), filters);
      if (groups.length === 0) {
        const empty = el('div', 'card muted timeline-empty');
        empty.textContent = ctx.t('timeline.empty');
        list.append(empty);
        return;
      }
      for (const group of groups) list.append(renderGroup(ctx, group, renderList));
    }

    renderList();
  },
};

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function buildFilterBar(
  ctx: AppContext,
  measurements: ReturnType<AppContext['data']>['measurements'],
  catalog: ReturnType<AppContext['catalog']>,
  filters: TimelineFilters,
  onChange: () => void,
): HTMLElement {
  const bar = el('div', 'timeline-filters');

  const categories = presentCategories(measurements, catalog);
  const sourceIds = presentSourceIds(measurements);

  // A filter bar only earns its space when there is something to filter by.
  if (categories.length < 2 && sourceIds.length < 2) {
    bar.hidden = true;
    return bar;
  }

  if (categories.length >= 2) {
    bar.append(
      buildFilterAxis(
        ctx.t('timeline.filterCategory'),
        categories.length,
        [
          { value: '', label: ctx.t('timeline.filterAll') },
          ...categories.map((c) => ({
            value: c,
            label: ctx.t(`timeline.category.${c}` as Parameters<AppContext['t']>[0]),
          })),
        ],
        () => filters.category ?? '',
        (value) => {
          filters.category = value === '' ? undefined : (value as MetricCategory);
          onChange();
        },
      ),
    );
  }

  if (sourceIds.length >= 2) {
    bar.append(
      buildFilterAxis(
        ctx.t('timeline.filterSource'),
        sourceIds.length,
        [
          { value: '', label: ctx.t('timeline.filterAll') },
          ...sourceIds.map((id) => ({ value: id, label: sourceLabel(ctx, id) })),
        ],
        () => filters.sourceId ?? '',
        (value) => {
          filters.sourceId = value === '' ? undefined : (value as SourceId);
          onChange();
        },
      ),
    );
  }

  return bar;
}

/**
 * One filter axis. Renders as a row of chips, or falls back to a labelled
 * <select> once the axis carries more than `CHIP_LIMIT` distinct values (the
 * "All" option is not counted toward that limit).
 */
function buildFilterAxis(
  labelText: string,
  optionCount: number,
  options: { value: string; label: string }[],
  getActive: () => string,
  onSelect: (value: string) => void,
): HTMLElement {
  return optionCount > CHIP_LIMIT
    ? buildSelect(labelText, options, getActive(), onSelect)
    : buildChipGroup(labelText, options, getActive(), onSelect);
}

function buildChipGroup(
  labelText: string,
  options: { value: string; label: string }[],
  active: string,
  onSelect: (value: string) => void,
): HTMLElement {
  const group = el('div', 'timeline-chips');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', labelText);

  const chips: HTMLButtonElement[] = [];

  const setActive = (value: string): void => {
    for (const chip of chips) {
      const on = chip.dataset.value === value;
      chip.classList.toggle('is-active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };

  for (const opt of options) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.value = opt.value;
    chip.textContent = opt.label;
    chip.addEventListener('click', () => {
      setActive(opt.value);
      onSelect(opt.value);
    });
    chips.push(chip);
    group.append(chip);
  }

  setActive(active);
  return group;
}

function buildSelect(
  labelText: string,
  options: { value: string; label: string }[],
  active: string,
  onChange: (value: string) => void,
): HTMLElement {
  const field = el('div', 'timeline-filter');
  const label = el('label');
  label.textContent = labelText;
  const select = document.createElement('select');
  select.setAttribute('aria-label', labelText);
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === active) o.selected = true;
    select.append(o);
  }
  select.addEventListener('change', () => onChange(select.value));
  field.append(label, select);
  return field;
}

// ---------------------------------------------------------------------------
// Group — rail + card list
// ---------------------------------------------------------------------------

function renderGroup(
  ctx: AppContext,
  group: TimelineGroupModel,
  onChanged: () => void,
): HTMLElement {
  const entry = el('div', 'timeline-entry');

  // Left rail: a dot (accent for a lab draw, faint otherwise) + connector.
  const rail = el('div', 'timeline-rail');
  const dot = el('span', 'timeline-dot');
  if (isLabEvent(ctx, group)) dot.classList.add('is-lab');
  const line = el('span', 'timeline-line');
  rail.append(dot, line);

  // Right column: group header + card list of values.
  const body = el('div', 'timeline-entry-body');

  const head = el('div', 'timeline-group-head');
  const date = el('span', 'timeline-date');
  date.textContent = formatDateTime(group.takenAt, group.timePrecision);
  const source = el('span', 'timeline-source');
  source.textContent = sourceLabel(ctx, group.sourceId);

  // Bulk source reassignment for this whole batch (works for a source-less
  // batch too — the retroactive-attribution path for old imports).
  const changeBtn = document.createElement('button');
  changeBtn.type = 'button';
  changeBtn.className = 'timeline-change-source';
  changeBtn.textContent = ctx.t('timeline.changeSource');
  changeBtn.addEventListener('click', () => openBulkSourceDialog(ctx, group, onChanged));

  head.append(date, source, changeBtn);

  const values = el('div', 'card timeline-values');
  for (const value of group.values) values.append(renderValue(ctx, value));

  body.append(head, values);
  entry.append(rail, body);
  return entry;
}

/**
 * Bulk-change dialog: the shared source picker + a count of affected
 * measurements + Cancel/Apply. Applying rewrites every group member's
 * `sourceId` in one mutate (appending a freshly-created source if needed) and
 * repaints the timeline in place.
 */
function openBulkSourceDialog(
  ctx: AppContext,
  group: TimelineGroupModel,
  onChanged: () => void,
): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal';
  dialog.setAttribute('aria-label', ctx.t('timeline.changeSource'));
  dialog.addEventListener('close', () => dialog.remove());

  const box = el('div', 'modal-box');
  const heading = el('h3');
  heading.textContent = ctx.t('timeline.changeSource');

  const initial: SourceSelection =
    group.sourceId !== undefined
      ? { mode: 'existing', sourceId: group.sourceId }
      : { mode: 'none' };
  const picker = sourcePicker(ctx, {
    initial,
    emptyMode: 'none',
    emptyLabel: ctx.t('source.none'),
    newLabel: `+ ${ctx.t('review.sourceNew')}…`,
    namePlaceholder: ctx.t('settings.sourceName'),
    nameAriaLabel: ctx.t('settings.sourceName'),
    kindAriaLabel: ctx.t('settings.sourceKind'),
    selectAriaLabel: ctx.t('timeline.changeSource'),
  });

  const count = el('p', 'timeline-change-count muted');
  count.textContent = ctx.t('timeline.changeSourceCount', { count: group.values.length });

  const actions = el('div', 'settings-choice');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = ctx.t('common.cancel');
  cancel.addEventListener('click', () => dialog.close());

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'primary';
  apply.textContent = ctx.t('common.confirm');
  apply.addEventListener('click', () => {
    const { sourceId, newSource } = picker.resolve();
    const memberIds = group.values.map((v) => v.measurementId);
    ctx.mutate((d) => {
      if (newSource && !d.sources.some((s) => s.id === newSource.id)) d.sources.push(newSource);
      d.measurements = applySourceToGroup(d.measurements, memberIds, sourceId);
    });
    dialog.close();
    onChanged();
  });

  actions.append(cancel, apply);
  box.append(heading, picker.el, count, actions);
  dialog.append(box);
  document.body.append(dialog);
  dialog.showModal();
}

function renderValue(ctx: AppContext, value: TimelineValueModel): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'timeline-value';
  row.addEventListener('click', () => ctx.navigate('metric', value.metricId));

  const name = el('span', 'timeline-metric');
  name.textContent = metricName(ctx, value);

  row.append(name, readingEl(ctx, value), statusDot(ctx, value));
  return row;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Metric display name: i18n key for built-ins, custom name for user metrics. */
function metricName(ctx: AppContext, value: TimelineValueModel): string {
  if (value.nameKey) return ctx.t(value.nameKey as Parameters<AppContext['t']>[0]);
  if (value.customName) return value.customName;
  return value.metricId;
}

/**
 * `operator value unitSymbol`, converted to the globally resolved display unit
 * (same resolver as overview/detail/compare/report) and rounded to the metric's
 * display precision. A value that cannot be converted stays in its stored unit.
 */
function readingEl(ctx: AppContext, value: TimelineValueModel): HTMLElement {
  if (value.value === undefined) {
    const span = el('span', 'timeline-reading');
    span.textContent = value.textValue ?? ''; // qualitative result
    return span;
  }
  const metric = ctx.catalog().byId(value.metricId);
  let displayValue = value.value;
  let displayUnit = value.unit;
  if (metric) {
    const target = resolveDisplayUnit(metric, ctx.data().settings, ctx.locale);
    const conv = ctx.units.convert(value.value, value.unit, target, metric);
    if (conv.ok) {
      displayValue = conv.value;
      displayUnit = target;
    }
  }
  const rounded = ctx.units.round(displayValue, displayUnit, metric);
  const unitSymbol = ctx.units.getUnit(displayUnit)?.display ?? displayUnit;
  return valueWithUnitEl({
    value: rounded,
    ...(unitSymbol ? { unit: unitSymbol } : {}),
    ...(value.operator ? { operator: value.operator } : {}),
    wrapClass: 'timeline-reading',
  });
}

/**
 * Compact status dot reflecting the value's position within its own reference
 * range. Colour complements the adjacent value (never the sole signal): an
 * `aria-label` names the state for assistive tech, matching the overview pills.
 */
function statusDot(ctx: AppContext, value: TimelineValueModel): HTMLElement {
  const dot = el('span', 'timeline-status');
  let hasLabel = true;
  switch (value.range) {
    case 'above':
      dot.classList.add('above');
      break;
    case 'below':
      dot.classList.add('below');
      break;
    case 'in-range':
      dot.classList.add('ok');
      break;
    default:
      dot.classList.add('faint');
      hasLabel = false;
  }
  if (hasLabel) {
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', ctx.t(rangeStatusKey(value.range)));
  } else {
    dot.setAttribute('aria-hidden', 'true');
  }
  return dot;
}

/** True when the event's source is a laboratory draw. */
function isLabEvent(ctx: AppContext, group: TimelineGroupModel): boolean {
  if (group.sourceId === undefined) return false;
  const source = ctx.data().sources.find((s) => s.id === group.sourceId);
  return source?.kind === 'lab';
}

/** Source name, its kind label when unnamed, or "none" when unattributed. */
function sourceLabel(ctx: AppContext, sourceId: SourceId | undefined): string {
  if (sourceId === undefined) return ctx.t('common.none');
  const source = ctx.data().sources.find((s) => s.id === sourceId);
  if (source === undefined) return ctx.t('common.none');
  const name = source.name.trim();
  if (name) return name;
  return ctx.t(`source.kind.${source.kind}` as Parameters<AppContext['t']>[0]);
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
