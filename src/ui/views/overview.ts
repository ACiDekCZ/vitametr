/**
 * Overview screen (K8d).
 *
 * Renders one card per tracked metric that has at least one measurement:
 * latest value in the preferred display unit, the change versus the previous
 * reading, a reference-range pill, and how long ago it was measured. Hidden
 * metrics are collapsed behind a toggle. Blood-pressure metrics that are
 * entered together are grouped into a single card. An empty profile shows a
 * call to action that opens the entry screen.
 *
 * All domain reasoning lives in `overview-model.ts`; this module only turns
 * that data into DOM and translates keys through `ctx.t`.
 */

import type { AppContext, View } from '../app-context';
import type { Metric } from '../../core/types';
import type { Locale, StringKey } from '../../i18n/index';
import { formatDateTime, formatNumber, plural } from '../../i18n/index';
import { WATCHED_TAG, tagLabel, usedTags } from '../../core/tags';
import { tagChip } from '../components/tag-chip';
import { watchStar } from '../components/watch-star';
import { valueWithUnitEl } from '../format-value';
import { rangeStatusKey } from '../range-status';
import {
  buildOverviewEntries,
  defaultLayout,
  filterOverviewEntries,
  formatRange,
  groupOverviewEntries,
  isOverviewFiltered,
  rangeBarPosition,
  sparklinePath,
  subsetLabelSpec,
  type DeltaKind,
  type OverviewCardModel,
  type OverviewLayout,
  type OverviewValue,
  type RangeState,
} from './overview-model';
import { isoDay } from './export-model';
import { setReportSelection } from './report';
import { runAutoImport } from './import-actions';
import { ACCEPT_AUTO } from './import-model';
import './overview.css';

const INTL_TAG: Record<Locale, string> = { cs: 'cs-CZ', en: 'en-US' };

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Sparkline box (px) and how many trailing points it shows. */
const SPARK_W = 100;
const SPARK_H = 36;
const SPARK_POINTS = 6;

/** Metric keys of the blood-pressure entry group, in display order. */
const BP_SYSTOLIC = 'bp-systolic';
const BP_DIASTOLIC = 'bp-diastolic';
const BP_PULSE = 'heart-rate';

/** Star quick-toggle wiring passed into the layouts (disabled when tags are off). */
interface WatchOpts {
  /** Whether to render the star at all (tracks `useTags`). */
  enabled: boolean;
  /** Repaint hook invoked after a star toggle commits. */
  onToggle: () => void;
}

interface CardEntry {
  metric: Metric;
  /** Card model, or `undefined` when the metric has no value at the reference
   * date (time-travel "empty at that date" placeholder). */
  model: OverviewCardModel | undefined;
  /** Resolved display name — feeds the search filter. */
  name: string;
  /** The metric's tags — feed the tag filter and primary-tag grouping. */
  tags: string[];
}

export const overviewView: View = {
  render(container: HTMLElement, ctx: AppContext): void {
    let showHidden = false;
    // Ephemeral filter state: survives a grid/list switch (lives here, not in
    // settings) but is never persisted between sessions.
    let query = '';
    let activeTag: string | undefined;
    // Time-travel state (in-memory only — never persisted; reload ⇒ live/today).
    // `asOf` is an ISO date; when set the overview shows the snapshot at/before it.
    let asOf: string | undefined;
    let asOfOpen = false; // whether the date picker is revealed (live mode)
    let asOfFocus = false; // focus the picker on the next paint (after a reveal)

    const paint = (): void => {
      container.replaceChildren();

      const nowIso = ctx.now();
      const todayDay = isoDay(nowIso) || nowIso;
      const inSnapshot = asOf !== undefined;
      // "Now" for age / delta reasoning: the chosen date in snapshot mode.
      const refIso = asOf ?? nowIso;
      const data = ctx.data();
      const catalog = ctx.catalog();
      const settings = data.settings;
      const useTags = settings.useTags !== false;
      const groupByAllTags = settings.overviewGroupByAllTags === true;

      const dateLine = el('p', 'overview-date');
      dateLine.textContent = formatDateLine(nowIso, ctx.locale);
      container.append(dateLine);

      // Build one entry per metric with any history; the card is resolved at the
      // reference date. In snapshot mode a metric with no value at/before the date
      // yields `model: undefined` (an empty placeholder), kept in the set.
      const entryModels = buildOverviewEntries(
        catalog.visible(),
        data.measurements,
        ctx.units,
        settings,
        ctx.locale,
        refIso,
        asOf,
      );
      const entries: CardEntry[] = [];
      let hiddenWithData = false;
      let metricsWithData = 0;
      for (const em of entryModels) {
        metricsWithData += 1;
        if (em.hidden) hiddenWithData = true;
        if (em.hidden && !showHidden) continue;
        entries.push({
          metric: em.metric,
          model: em.model,
          name: resolvedName(ctx, em.metric),
          tags: em.metric.tags ?? [],
        });
      }

      // Header: title + as-of control + Summary + (with data) the grid/list toggle.
      const headerRow = el('div', 'overview-header');
      const heading = el('h1');
      heading.textContent = ctx.t('overview.yourValues');
      const actions = el('div', 'overview-header-actions');

      // Time-travel control: a ghost calendar button revealing a pill date input.
      const open = asOfOpen || inSnapshot;
      const asOfBtn = document.createElement('button');
      asOfBtn.type = 'button';
      asOfBtn.className = 'overview-ghost overview-asof-btn';
      asOfBtn.setAttribute('aria-label', ctx.t('overview.asOf'));
      asOfBtn.append(calendarIcon(), textSpan(ctx.t('overview.asOf')));
      asOfBtn.hidden = open;
      asOfBtn.addEventListener('click', () => {
        asOfOpen = true;
        asOfFocus = true;
        paint();
      });
      const asOfDate = document.createElement('input');
      asOfDate.type = 'date';
      asOfDate.className = 'overview-asof-date';
      asOfDate.value = asOf ?? todayDay;
      asOfDate.setAttribute('aria-label', ctx.t('export.asOfDateLabel'));
      asOfDate.hidden = !open;
      asOfDate.addEventListener('change', () => {
        const v = asOfDate.value;
        // Today (or a cleared field) returns to the live view; any other date
        // enters snapshot mode.
        if (!v || v === todayDay) {
          asOf = undefined;
          asOfOpen = false;
        } else {
          asOf = v;
        }
        paint();
      });
      actions.append(asOfBtn, asOfDate);

      // The summary/print button is filter-aware: with no filter it opens the
      // full report straight away; under an active filter it gains a count + an
      // accent-soft highlight (it will carry the filter) and opens a small menu
      // offering "only filtered" vs "all metrics". `refreshSummary` keeps its
      // label/state in sync as the filter changes (the header is not repainted).
      const goToReport = (): void =>
        inSnapshot ? ctx.navigate('report', asOf) : ctx.navigate('report');
      const summaryBtn = document.createElement('button');
      summaryBtn.type = 'button';
      summaryBtn.className = 'overview-summary-btn';
      const refreshSummary = (): void => {
        const filter = { query, activeTag };
        if (!isOverviewFiltered(filter)) {
          summaryBtn.textContent = ctx.t('report.open');
          summaryBtn.classList.remove('is-filter');
          summaryBtn.removeAttribute('aria-haspopup');
          return;
        }
        const count = filterOverviewEntries(entries, filter).length;
        summaryBtn.textContent = ctx.t('overview.printFiltered', { n: count });
        summaryBtn.classList.add('is-filter');
        summaryBtn.setAttribute('aria-haspopup', 'menu');
      };
      summaryBtn.addEventListener('click', () => {
        const filter = { query, activeTag };
        if (!isOverviewFiltered(filter)) {
          goToReport();
          return;
        }
        const filtered = filterOverviewEntries(entries, filter);
        openPrintMenu(ctx, summaryBtn, {
          filteredCount: filtered.length,
          totalCount: entries.length,
          onOnly: () => {
            const spec = subsetLabelSpec(filter, filtered.length);
            const label =
              spec.kind === 'tag'
                ? tagLabel(spec.tag, ctx.t)
                : plural(
                    spec.count,
                    {
                      one: 'report.subsetCountOne',
                      few: 'report.subsetCountFew',
                      many: 'report.subsetCountMany',
                    },
                    { n: spec.count },
                  );
            setReportSelection({ metricIds: filtered.map((e) => e.metric.id), label });
            goToReport();
          },
          onAll: goToReport,
        });
      });
      refreshSummary();
      actions.append(summaryBtn);
      headerRow.append(heading, actions);
      container.append(headerRow);

      if (asOfFocus) {
        asOfFocus = false;
        asOfDate.focus();
      }

      // Prominent, unmissable snapshot banner above the content.
      if (inSnapshot) {
        container.append(
          renderSnapshotBanner(
            ctx,
            asOf as string,
            () => {
              asOf = undefined;
              asOfOpen = false;
              paint();
            },
            () => ctx.navigate('export', asOf),
          ),
        );
      }

      // Zero-data profile: a full-page prompt with no toolbar (unchanged).
      if (entries.length === 0) {
        container.append(renderSparsePrompt(ctx, 'empty'));
        return;
      }

      // Resolve the active layout: a saved choice wins at both widths, else the
      // default (the card grid, everywhere — the list is an opt-in).
      let layout: OverviewLayout = settings.overviewLayout ?? defaultLayout();

      container.append(renderSummaryChips(ctx, entries));

      if (hiddenWithData) {
        container.append(renderHiddenToggle(ctx, showHidden, (next) => {
          showHidden = next;
          paint();
        }));
      }

      // Sparse (1–2 metrics) nudge sits above the toolbar + content.
      if (metricsWithData < 3) container.append(renderSparsePrompt(ctx, 'sparse'));

      // The content region is the ONLY thing filter / layout changes repaint, so
      // the search input keeps its focus and caret across keystrokes.
      const contentHost = el('div', 'overview-content');

      const renderContent = (): void => {
        // Keep the filter-aware summary/print button in sync (its label + the
        // accent-soft highlight track the current filter without a full repaint).
        refreshSummary();
        contentHost.replaceChildren();
        const filtered = filterOverviewEntries(entries, { query, activeTag });
        if (filtered.length === 0) {
          contentHost.append(
            renderNoMatch(ctx, () => {
              query = '';
              activeTag = undefined;
              searchInput.value = '';
              paintTagChips();
              renderContent();
            }),
          );
          return;
        }
        const groups = groupOverviewEntries(filtered, {
          useTags,
          activeTag,
          allTags: groupByAllTags,
        });
        // The star quick-toggle lives with the tag UI: shown only when tags are
        // on. Toggling watched changes grouping/chips, so it triggers a full
        // repaint (rebuilds entries from the mutated catalog).
        const watch: WatchOpts = { enabled: useTags, onToggle: paint };
        if (layout === 'list') renderListLayout(ctx, contentHost, groups, useTags, watch);
        else renderGridLayout(ctx, contentHost, groups, watch);
      };

      // Layout toggle (grid / list), added to the header actions.
      const toggle = el('div', 'seg overview-layout-toggle');
      const toggleBtns: { layout: OverviewLayout; btn: HTMLButtonElement }[] = [];
      const layoutOptions: { layout: OverviewLayout; icon: 'grid' | 'list'; key: StringKey }[] = [
        { layout: 'grid', icon: 'grid', key: 'overview.layoutGrid' },
        { layout: 'list', icon: 'list', key: 'overview.layoutList' },
      ];
      const updateToggle = (): void => {
        for (const { layout: l, btn } of toggleBtns) {
          const on = l === layout;
          btn.classList.toggle('seg-btn--active', on);
          btn.setAttribute('aria-pressed', String(on));
        }
      };
      for (const opt of layoutOptions) {
        const btn = el('button', 'seg-btn') as HTMLButtonElement;
        btn.type = 'button';
        btn.setAttribute('aria-label', ctx.t(opt.key));
        btn.append(layoutIcon(opt.icon));
        btn.addEventListener('click', () => {
          if (layout === opt.layout) return;
          layout = opt.layout;
          ctx.mutate((d) => {
            d.settings.overviewLayout = opt.layout;
          });
          updateToggle();
          renderContent();
        });
        toggleBtns.push({ layout: opt.layout, btn });
        toggle.append(btn);
      }
      updateToggle();
      actions.prepend(toggle);

      // Filter row: a pill search plus (when tags are on) the tag chips.
      const filterRow = el('div', 'overview-filter');
      const searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'overview-search';
      searchInput.placeholder = ctx.t('overview.search');
      searchInput.setAttribute('aria-label', ctx.t('overview.search'));
      searchInput.value = query;
      searchInput.addEventListener('input', () => {
        query = searchInput.value;
        renderContent();
      });
      filterRow.append(searchInput);

      const tagRow = el('div', 'overview-tag-filter');
      const paintTagChips = (): void => {
        if (!useTags) return;
        tagRow.replaceChildren();
        const tags = usedTags(entries.map((e) => e.metric));
        if (tags.length === 0) return;
        const makeChip = (label: string, value: string | undefined): HTMLButtonElement =>
          tagChip({
            label,
            isActive: activeTag === value,
            star: value === WATCHED_TAG,
            onToggle: () => {
              activeTag = activeTag === value ? undefined : value;
              paintTagChips();
              renderContent();
            },
          });
        // "All tags" first, then the watched chip (ranked first by orderTags),
        // then the rest — the watched chip only exists when a metric is watched.
        tagRow.append(makeChip(ctx.t('tags.all'), undefined));
        for (const tg of tags) tagRow.append(makeChip(tagLabel(tg, ctx.t), tg));
      };
      paintTagChips();
      if (useTags) filterRow.append(tagRow);
      container.append(filterRow);

      container.append(contentHost);
      renderContent();
    };

    paint();
  },
};

// ---------------------------------------------------------------------------
// Grid + list layouts (driven by the filtered, grouped entry set)
// ---------------------------------------------------------------------------

/**
 * Turn a block of entries into card nodes, folding the blood-pressure metrics
 * that were entered together into one combined card. Folding is a grid-only
 * affordance; the list renders one row per metric.
 */
function buildCards(ctx: AppContext, entries: CardEntry[]): { metric: Metric; node: HTMLElement }[] {
  const byKey = new Map<string, CardEntry>();
  for (const entry of entries) {
    if (entry.metric.key !== undefined) byKey.set(entry.metric.key, entry);
  }
  const sys = byKey.get(BP_SYSTOLIC);
  const dia = byKey.get(BP_DIASTOLIC);
  const pulseEntry = byKey.get(BP_PULSE);
  // Fold only when both systolic and diastolic have a value at the reference date;
  // an empty (undefined-model) side renders as its own placeholder card instead.
  const groupBp = sys?.model !== undefined && dia?.model !== undefined;

  const cards: { metric: Metric; node: HTMLElement }[] = [];
  for (const entry of entries) {
    const key = entry.metric.key;
    if (groupBp && (key === BP_DIASTOLIC || key === BP_PULSE)) continue;
    if (groupBp && key === BP_SYSTOLIC) {
      const pulse = pulseEntry?.model !== undefined ? pulseEntry : undefined;
      cards.push({ metric: sys!.metric, node: renderBloodPressureCard(ctx, sys!, dia!, pulse) });
      continue;
    }
    cards.push({ metric: entry.metric, node: renderCard(ctx, entry) });
  }
  return cards;
}

function renderGridLayout(
  ctx: AppContext,
  host: HTMLElement,
  groups: { tag: string | null; entries: CardEntry[] }[],
  watch: WatchOpts,
): void {
  for (const group of groups) {
    const cards = buildCards(ctx, group.entries);
    const grid = el('div', 'grid');
    for (const card of cards) grid.append(wrapWithStar(ctx, card.metric, card.node, watch));
    if (group.tag === null) {
      host.append(grid);
    } else {
      const section = el('section', 'overview-group');
      section.append(groupHeading(ctx, group.tag), grid);
      host.append(section);
    }
  }
}

function renderListLayout(
  ctx: AppContext,
  host: HTMLElement,
  groups: { tag: string | null; entries: CardEntry[] }[],
  useTags: boolean,
  watch: WatchOpts,
): void {
  void useTags; // the list row no longer shows a per-row tag chip (redundant)
  for (const group of groups) {
    const listCard = el('div', 'overview-list');
    listCard.append(listHeader(ctx));
    for (const entry of group.entries) listCard.append(listRow(ctx, entry, watch));
    if (group.tag === null) {
      host.append(listCard);
    } else {
      const section = el('section', 'overview-group');
      section.append(groupHeading(ctx, group.tag), listCard);
      host.append(section);
    }
  }
}

/**
 * Wrap a grid card in a positioned host and overlay the star toggle in its
 * top-right corner (a sibling of the card button, never nested inside it). When
 * the star is disabled (tags off) the card is returned unwrapped, unchanged.
 */
function wrapWithStar(
  ctx: AppContext,
  metric: Metric,
  card: HTMLElement,
  watch: WatchOpts,
): HTMLElement {
  if (!watch.enabled) return card;
  const wrap = el('div', 'metric-card-wrap');
  card.classList.add('metric-card--watchable');
  wrap.append(card, watchStar({ ctx, metric, variant: 'watch-star--tile', onToggle: watch.onToggle }));
  return wrap;
}

function groupHeading(ctx: AppContext, tag: string): HTMLElement {
  const heading = el('h2', 'overview-group-title');
  heading.textContent = tagLabel(tag, ctx.t);
  return heading;
}

/** The list column-header row (desktop only; hidden on the compact phone list). */
function listHeader(ctx: AppContext): HTMLElement {
  const head = el('div', 'overview-list-head');
  const cell = (key: StringKey, area: string): HTMLElement => {
    const c = el('span', `overview-col overview-row-${area}`);
    c.textContent = ctx.t(key);
    return c;
  };
  head.append(
    cell('overview.colMetric', 'metric'),
    cell('overview.colValue', 'value'),
    cell('overview.colRange', 'range'),
    cell('overview.colChange', 'change'),
    cell('overview.colMeasured', 'age'),
    cell('overview.colStatus', 'status'),
  );
  return head;
}

/**
 * One clickable list row → the metric detail. A row is a positioned host holding
 * the clickable `.overview-row` button plus, when tags are on, the star toggle as
 * its FIRST element (a sibling of the button, never nested inside it).
 */
function listRow(ctx: AppContext, entry: CardEntry, watch: WatchOpts): HTMLElement {
  const { metric, model } = entry;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = watch.enabled ? 'overview-row overview-row--watchable' : 'overview-row';
  row.addEventListener('click', () => ctx.navigate('metric', metric.id));

  // No per-row tag chip: under grouping the section heading already names the
  // category, and under a tag filter every row shares it — redundant either way.
  const metricCell = el('div', 'overview-row-metric');
  // Star toggle first (before the name). It sits inside the row and stops
  // propagation, so tapping it toggles watched without opening the detail.
  if (watch.enabled) {
    metricCell.append(
      watchStar({ ctx, metric, variant: 'watch-star--inline', onToggle: watch.onToggle }),
    );
  }
  const name = el('span', 'overview-row-name');
  name.textContent = entry.name;
  name.title = entry.name;
  metricCell.append(name);

  // Empty at the reference date (time-travel): a muted "no value at that date"
  // row that still opens the metric's (full) detail.
  if (model === undefined) {
    row.classList.add('overview-row--empty');
    const emptyCell = el('div', 'overview-row-value');
    emptyCell.append(textEl('span', ctx.t('export.noValueAtDate'), 'muted'));
    row.append(
      metricCell,
      emptyCell,
      mutedDash('range'),
      mutedDash('change'),
      el('span', 'overview-row-age'),
      mutedDash('status'),
    );
    return row;
  }

  const valueCell = el('div', 'overview-row-value');
  valueCell.append(valueBlock(ctx, metric, model.value, model.outOfRange));

  const rangeCell = el('div', 'overview-row-range tnum muted');
  rangeCell.textContent = rangeColumnText(ctx, metric, model);

  const changeCell = el('div', 'overview-row-change');
  changeCell.append(deltaChip(ctx, metric, model) ?? mutedDash());

  const ageCell = el('span', 'overview-row-age');
  ageCell.textContent = relativeWhen(model.ageDays, INTL_TAG[ctx.locale]);

  const statusCell = el('div', 'overview-row-status');
  statusCell.append(statusPill(ctx, model.rangeState));

  row.append(metricCell, valueCell, rangeCell, changeCell, ageCell, statusCell);
  return row;
}

/**
 * The reference range for the "Range" column, in the value's display unit
 * (bounds are pre-converted with the value by `buildOverviewCard`). Formatted at
 * the value's display precision; `—` when the latest measurement states no range.
 */
function rangeColumnText(ctx: AppContext, metric: Metric, model: OverviewCardModel): string {
  const decimals = model.value.unitCode ? metric.precision?.[model.value.unitCode] : undefined;
  return formatRange(model.refLow, model.refHigh, (n) => formatNumber(n, decimals));
}

function mutedDash(area?: string): HTMLElement {
  const dash = el('span', `overview-row-dash muted${area ? ` overview-row-${area}` : ''}`);
  dash.textContent = '—';
  return dash;
}

/** Reference-range status pill for the list "Status" column. */
function statusPill(ctx: AppContext, state: RangeState): HTMLElement {
  const cls = state === 'in-range' ? 'ok' : state === 'above' ? 'above' : state === 'below' ? 'below' : 'muted';
  const pill = el('span', `pill overview-status ${cls}`);
  pill.textContent = ctx.t(rangeStatusKey(state));
  return pill;
}

/** A small inline icon for the grid / list segmented toggle. */
function layoutIcon(kind: 'grid' | 'list'): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'currentColor');
  if (kind === 'grid') {
    for (const [x, y] of [[1, 1], [9, 1], [1, 9], [9, 9]]) {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String(y));
      r.setAttribute('width', '6');
      r.setAttribute('height', '6');
      r.setAttribute('rx', '1.5');
      svg.append(r);
    }
  } else {
    for (const y of [2, 6.8, 11.6]) {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', '1');
      r.setAttribute('y', String(y));
      r.setAttribute('width', '14');
      r.setAttribute('height', '2.4');
      r.setAttribute('rx', '1.2');
      svg.append(r);
    }
  }
  return svg;
}

/**
 * Empty-filter state: nothing matches the search / tag. A ghost button clears
 * both back to their defaults.
 */
function renderNoMatch(ctx: AppContext, onClear: () => void): HTMLElement {
  const wrap = el('div', 'card overview-prompt');
  const message = el('p', 'overview-prompt-text');
  message.textContent = ctx.t('overview.noMatch');
  const actions = el('div', 'overview-prompt-actions');
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'overview-ghost';
  clear.textContent = ctx.t('overview.clearFilters');
  clear.addEventListener('click', onClear);
  actions.append(clear);
  wrap.append(message, actions);
  return wrap;
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

function renderCard(ctx: AppContext, entry: CardEntry): HTMLElement {
  const { metric, model } = entry;
  const card = cardButton(ctx, metric.id);

  // Empty at the reference date (time-travel): a muted placeholder card.
  if (model === undefined) {
    card.classList.add('metric-card--empty');
    card.append(topRow(metricName(ctx, metric), el('span')));
    card.append(textEl('div', ctx.t('export.noValueAtDate'), 'metric-empty muted'));
    return card;
  }

  // Row 1: name … age.
  card.append(topRow(metricName(ctx, metric), ageLabel(ctx, model.ageDays)));

  // Row 2: value + unit + delta chip … sparkline.
  const left = valueBlock(ctx, metric, model.value, model.outOfRange);
  const delta = deltaChip(ctx, metric, model);
  if (delta !== undefined) left.append(delta);
  card.append(valueRow(left, sparkline(model.series)));

  // Row 3: range-bar (omitted for a text value or when there is no range).
  const bar =
    model.value.value !== undefined
      ? rangeBar(model.value.value, model.refLow, model.refHigh, model.rangeState)
      : undefined;
  if (bar !== undefined) card.append(bar);

  return card;
}

/**
 * Combined blood-pressure card: systolic / diastolic together, optional pulse,
 * and a range-bar driven by the worse of the two sides. Tapping opens the
 * systolic metric's detail.
 */
function renderBloodPressureCard(
  ctx: AppContext,
  sys: CardEntry,
  dia: CardEntry,
  pulse: CardEntry | undefined,
): HTMLElement {
  const card = cardButton(ctx, sys.metric.id);

  // Folding only happens when both sides have a value at the reference date.
  const sysM = sys.model as OverviewCardModel;
  const diaM = dia.model as OverviewCardModel;
  const pulseM = pulse?.model;

  const name = el('span', 'metric-name');
  name.textContent = ctx.t('entry.group.bloodPressure');
  const age = ageLabel(ctx, Math.min(sysM.ageDays, diaM.ageDays));
  card.append(topRow(name, age));

  // Row 2: "128/82 mmHg · 64/min" plus the systolic sparkline.
  const left = el('div', 'metric-value');
  const number = el('span', 'metric-number tnum');
  const sysText = formatValue(sysM.value);
  const diaText = formatValue(diaM.value);
  number.textContent = `${sysText}/${diaText}`;
  left.append(number);

  const sysUnit = unitDisplay(ctx, sysM.value.unitCode ?? '');
  const diaUnit = unitDisplay(ctx, diaM.value.unitCode ?? '');
  if (sysM.value.unitCode === diaM.value.unitCode) {
    left.append(unitSpan(sysUnit));
  } else {
    number.textContent = `${sysText} ${sysUnit}/${diaText}`;
    left.append(unitSpan(diaUnit));
  }
  if (pulseM !== undefined) {
    const pulseUnit = unitDisplay(ctx, pulseM.value.unitCode ?? '');
    left.append(unitSpan(`· ${formatValue(pulseM.value)} ${pulseUnit}`));
  }
  card.append(valueRow(left, sparkline(sysM.series)));

  // Row 3: range-bar by the worse of systolic / diastolic.
  const worstState = worstRange(sysM.rangeState, diaM.rangeState);
  const worseM =
    worstState === diaM.rangeState && diaM.rangeState !== sysM.rangeState ? diaM : sysM;
  const bar =
    worseM.value.value !== undefined
      ? rangeBar(worseM.value.value, worseM.refLow, worseM.refHigh, worstState)
      : undefined;
  if (bar !== undefined) card.append(bar);

  return card;
}

// ---------------------------------------------------------------------------
// Card pieces
// ---------------------------------------------------------------------------

function cardButton(ctx: AppContext, metricId: string): HTMLButtonElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card metric-card';
  card.addEventListener('click', () => ctx.navigate('metric', metricId));
  return card;
}

function metricName(ctx: AppContext, metric: Metric): HTMLElement {
  const name = el('span', 'metric-name');
  const full = resolvedName(ctx, metric);
  name.textContent = full;
  name.title = full;
  return name;
}

/** The metric's resolved display name (custom name or translated built-in key). */
function resolvedName(ctx: AppContext, metric: Metric): string {
  return metric.customName ?? (metric.nameKey ? ctx.t(metric.nameKey as StringKey) : '');
}

/** Row 1: a label on the left and the age on the right. */
function topRow(left: HTMLElement, right: HTMLElement): HTMLElement {
  const row = el('div', 'metric-top');
  row.append(left, right);
  return row;
}

/** Row 2 wrapper: the value figures on the left, a sparkline on the right. */
function valueRow(left: HTMLElement, spark: HTMLElement | undefined): HTMLElement {
  const row = el('div', 'metric-value-row');
  row.append(left);
  if (spark !== undefined) row.append(spark);
  return row;
}

/**
 * The value + unit block (delta chip is appended by the caller). Rendered through
 * the shared value/unit typography helper so the number is tabular and the unit
 * (powers via `<sup>`) is muted, exactly like review / detail / report. When
 * `warn` is set — the latest value is out of its reference range — the NUMBER
 * itself is warn-coloured (never the whole card/row); the text status pill still
 * carries the meaning, so colour is never the only signal.
 */
function valueBlock(
  ctx: AppContext,
  metric: Metric,
  value: OverviewValue,
  warn = false,
): HTMLElement {
  // A text (qualitative) value carries no unit and is not run through the
  // numeric formatter.
  if (value.value === undefined) {
    const row = el('div', 'metric-value');
    const number = el('span', 'metric-number tnum');
    number.textContent = value.textValue ?? '';
    row.append(number);
    return row;
  }
  const decimals = value.unitCode ? metric.precision?.[value.unitCode] : undefined;
  return valueWithUnitEl({
    value: value.value,
    unit: value.unitCode !== undefined ? unitDisplay(ctx, value.unitCode) : undefined,
    operator: value.operator,
    decimals,
    warn,
    wrapClass: 'metric-value',
    valueClass: 'metric-number',
    unitClass: 'metric-unit',
  });
}

/** Numeric text with an optional operator prefix, or the raw text for a text value. */
function formatValue(value: OverviewValue, decimals?: number): string {
  if (value.value === undefined) return value.textValue ?? '';
  const num = formatNumber(value.value, decimals);
  return value.operator !== undefined ? `${value.operator} ${num}` : num;
}

function unitSpan(text: string): HTMLElement {
  const span = el('span', 'metric-unit');
  span.textContent = text;
  return span;
}

function unitDisplay(ctx: AppContext, code: string): string {
  return ctx.units.getUnit(code)?.display ?? code;
}

/**
 * The delta chip: a direction arrow plus the magnitude, tinted by the value's
 * range state (never by the direction — direction is descriptive, not a
 * judgement). Returns undefined when there is no numeric change to show.
 */
function deltaChip(
  ctx: AppContext,
  metric: Metric,
  model: OverviewCardModel,
): HTMLElement | undefined {
  if (model.deltaKind !== 'up' && model.deltaKind !== 'down') return undefined;
  if (model.deltaAmount === undefined) return undefined;
  const chip = el('span', `metric-delta ${rangeTint(model.rangeState)}`);
  const decimals = model.deltaAmount.unitCode
    ? metric.precision?.[model.deltaAmount.unitCode]
    : undefined;
  const amount = formatValue(model.deltaAmount, decimals);
  chip.textContent = `${arrowGlyph(model.deltaKind)} ${amount}`;
  chip.setAttribute(
    'aria-label',
    changeLabel(ctx, metric, model),
  );
  return chip;
}

function arrowGlyph(kind: DeltaKind): string {
  return kind === 'up' ? '▴' : '▾';
}

function changeLabel(ctx: AppContext, metric: Metric, model: OverviewCardModel): string {
  if (model.deltaKind === 'same' || model.deltaAmount === undefined) {
    return ctx.t('overview.change.same');
  }
  const decimals = model.deltaAmount.unitCode
    ? metric.precision?.[model.deltaAmount.unitCode]
    : undefined;
  const amount = `${formatValue(model.deltaAmount, decimals)} ${unitDisplay(ctx, model.deltaAmount.unitCode ?? '')}`;
  const key: StringKey = model.deltaKind === 'up' ? 'overview.change.up' : 'overview.change.down';
  return ctx.t(key, { amount });
}

/** Map a range state onto the soft-tint class shared by chips and markers. */
function rangeTint(state: RangeState): string {
  if (state === 'above') return 'above';
  if (state === 'below') return 'below';
  if (state === 'in-range') return 'ok';
  return 'muted';
}

// --- Sparkline ------------------------------------------------------------

/** A ~100×36 sparkline of the last few points, or undefined when too short. */
function sparkline(series: number[]): HTMLElement | undefined {
  const spark = sparklinePath(series.slice(-SPARK_POINTS), SPARK_W, SPARK_H);
  if (spark === undefined) return undefined;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'metric-spark');
  svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', spark.points);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'var(--accent)');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  svg.append(line);

  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', String(spark.last.x));
  dot.setAttribute('cy', String(spark.last.y));
  dot.setAttribute('r', '3.5');
  dot.setAttribute('fill', 'var(--accent)');
  svg.append(dot);

  return svg as unknown as HTMLElement;
}

// --- Range-bar ------------------------------------------------------------

/** Row 3: the reference range-bar with zones, a marker, and the range text. */
function rangeBar(
  value: number,
  refLow: number | undefined,
  refHigh: number | undefined,
  state: RangeState,
): HTMLElement | undefined {
  const pos = rangeBarPosition(value, refLow, refHigh);
  if (pos === undefined) return undefined;

  const row = el('div', 'metric-range');

  const track = el('div', 'range-track');
  const { belowEnd, aboveStart } = pos.zonePercents;
  track.style.background =
    `linear-gradient(90deg,` +
    ` var(--below-soft) 0%, var(--below-soft) ${belowEnd}%,` +
    ` var(--ok-soft) ${belowEnd}%, var(--ok-soft) ${aboveStart}%,` +
    ` var(--above-soft) ${aboveStart}%)`;

  const marker = el('span', `range-marker ${rangeTint(state)}`);
  marker.style.left = `${pos.markerPercent}%`;
  track.append(marker);
  row.append(track);

  const label = el('span', 'range-text tnum');
  label.textContent = rangeText(refLow, refHigh);
  row.append(label);

  return row;
}

/** "3.9–5.6", "< 5.6" or "> 3.9" depending on which bounds are present. */
function rangeText(refLow: number | undefined, refHigh: number | undefined): string {
  if (refLow !== undefined && refHigh !== undefined) {
    return `${formatNumber(refLow)}–${formatNumber(refHigh)}`;
  }
  if (refHigh !== undefined) return `< ${formatNumber(refHigh)}`;
  return `> ${formatNumber(refLow as number)}`;
}

// --- Summary chips --------------------------------------------------------

/** Counts of in-range / above / below / without-range metrics as soft pills. */
function renderSummaryChips(ctx: AppContext, entries: CardEntry[]): HTMLElement {
  let inRange = 0;
  let above = 0;
  let below = 0;
  let noRange = 0;
  for (const { model } of entries) {
    if (model === undefined) continue; // empty at the reference date
    if (model.rangeState === 'in-range') inRange += 1;
    else if (model.rangeState === 'above') above += 1;
    else if (model.rangeState === 'below') below += 1;
    else noRange += 1;
  }

  const row = el('div', 'overview-chips');
  if (inRange > 0) row.append(chip('ok', ctx.t('overview.chip.inRange', { count: inRange }), true));
  if (above > 0) row.append(chip('above', ctx.t('overview.chip.above', { count: above }), true));
  if (below > 0) row.append(chip('below', ctx.t('overview.chip.below', { count: below }), true));
  if (noRange > 0) row.append(chip('muted', ctx.t('overview.chip.noRange', { count: noRange }), false));
  return row;
}

function chip(tint: string, text: string, dot: boolean): HTMLElement {
  const span = el('span', `overview-chip ${tint}`);
  if (dot) span.append(el('span', 'chip-dot'));
  const label = document.createElement('span');
  label.textContent = text;
  span.append(label);
  return span;
}

/** Localized weekday + day + month, e.g. "úterý 21. července". */
function formatDateLine(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_TAG[locale], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(iso));
}

function worstRange(a: RangeState, b: RangeState): RangeState {
  if (a === 'above' || b === 'above') return 'above';
  if (a === 'below' || b === 'below') return 'below';
  if (a === 'in-range' || b === 'in-range') return 'in-range';
  return 'unknown';
}

function ageLabel(ctx: AppContext, days: number): HTMLElement {
  const span = el('span', 'metric-age muted');
  span.textContent = ctx.t('overview.lastMeasured', { when: relativeWhen(days, INTL_TAG[ctx.locale]) });
  return span;
}

/** Locale-aware "N days/weeks/... ago" using a sensible unit for the span. */
function relativeWhen(days: number, tag: string): string {
  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  if (days >= 365) return rtf.format(-Math.round(days / 365), 'year');
  if (days >= 60) return rtf.format(-Math.round(days / 30), 'month');
  if (days >= 14) return rtf.format(-Math.round(days / 7), 'week');
  return rtf.format(-days, 'day');
}

// ---------------------------------------------------------------------------
// Toolbar + empty state
// ---------------------------------------------------------------------------

function renderHiddenToggle(
  ctx: AppContext,
  checked: boolean,
  onChange: (next: boolean) => void,
): HTMLElement {
  const bar = el('div', 'overview-toolbar');
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const text = document.createElement('span');
  text.textContent = ctx.t('overview.showHidden');
  label.append(input, text);
  bar.append(label);
  return bar;
}

/**
 * Empty / sparse-state prompt card: a friendly nudge with two ways to get more
 * data in. Import is the PRIMARY path (most data comes from files) and opens a
 * file picker directly — auto-detection then routes the file to review, exactly
 * like the Import page's dropzone. Manual entry is the secondary path. Shown both
 * for a wholly empty profile and when only 1–2 metrics have data.
 */
function renderSparsePrompt(ctx: AppContext, kind: 'empty' | 'sparse'): HTMLElement {
  const wrap = el('div', 'card overview-prompt');
  const message = el('p', 'overview-prompt-text');
  message.textContent = ctx.t(kind === 'empty' ? 'overview.empty' : 'overview.sparse');

  const actions = el('div', 'overview-prompt-actions');

  // Hidden file input reusing the Import dropzone's broad accept + auto-detect.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = ACCEPT_AUTO;
  fileInput.className = 'visually-hidden';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void runAutoImport(ctx, file);
  });

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'primary';
  importBtn.textContent = ctx.t('overview.import');
  importBtn.addEventListener('click', () => fileInput.click());

  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = ctx.t('overview.addFirst');
  add.addEventListener('click', () => ctx.navigate('entry'));

  actions.append(importBtn, add);
  wrap.append(message, actions, fileInput);
  return wrap;
}

// ---------------------------------------------------------------------------
// Time-travel banner + as-of control
// ---------------------------------------------------------------------------

/**
 * Full-width snapshot banner shown while time-travelling: the reference date, a
 * ghost "export this state" link, and an × that clears the snapshot. Unmissable
 * by design so the user never mistakes an old value for the current one.
 */
function renderSnapshotBanner(
  ctx: AppContext,
  asOf: string,
  onClear: () => void,
  onExport: () => void,
): HTMLElement {
  const bar = el('div', 'overview-asof-banner');
  const text = el('span', 'overview-asof-banner-text');
  text.textContent = ctx.t('overview.asOfBanner', { date: formatDateTime(asOf, 'date') });

  const actions = el('div', 'overview-asof-banner-actions');
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'overview-asof-export';
  exportBtn.textContent = ctx.t('overview.exportThisState');
  exportBtn.addEventListener('click', onExport);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'overview-asof-close';
  close.setAttribute('aria-label', ctx.t('overview.backToToday'));
  close.append(textSpan('×'), textSpan(ctx.t('overview.backToToday')));
  close.addEventListener('click', onClear);

  actions.append(exportBtn, close);
  bar.append(text, actions);
  return bar;
}

/** A small inline calendar glyph for the "as of date" ghost button. */
function calendarIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', '2');
  rect.setAttribute('y', '3');
  rect.setAttribute('width', '12');
  rect.setAttribute('height', '11');
  rect.setAttribute('rx', '2');
  svg.append(rect);
  for (const [x1, y1, x2, y2] of [
    [5, 1.5, 5, 4],
    [11, 1.5, 11, 4],
    [2, 6.5, 14, 6.5],
  ]) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    line.setAttribute('stroke-linecap', 'round');
    svg.append(line);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Print / summary menu (filter-aware) — popover on desktop, bottom sheet on
// mobile (the FAB-menu vocabulary: a modal <dialog> for backdrop + Escape +
// focus-trap; CSS gives the sheet on narrow screens).
// ---------------------------------------------------------------------------

interface PrintMenuOptions {
  filteredCount: number;
  totalCount: number;
  onOnly: () => void;
  onAll: () => void;
}

function openPrintMenu(ctx: AppContext, anchor: HTMLElement, opts: PrintMenuOptions): void {
  // Guard a double-open (Enter + click).
  if (document.querySelector('dialog.overview-print-menu')) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'overview-print-menu';
  dialog.setAttribute('aria-label', ctx.t('report.open'));
  const panel = el('div', 'overview-print-panel');

  const close = (): void => dialog.close();

  // Primary, highlighted choice: only the filtered metrics. Disabled when the
  // filter currently matches nothing (there is no subset to carry).
  const onlyBtn = el('button', 'overview-print-item primary') as HTMLButtonElement;
  onlyBtn.type = 'button';
  onlyBtn.textContent = ctx.t('overview.printOnlyFiltered', { n: opts.filteredCount });
  onlyBtn.disabled = opts.filteredCount === 0;
  onlyBtn.addEventListener('click', () => {
    close();
    opts.onOnly();
  });

  const allBtn = el('button', 'overview-print-item') as HTMLButtonElement;
  allBtn.type = 'button';
  allBtn.textContent = ctx.t('overview.printAll', { n: opts.totalCount });
  allBtn.addEventListener('click', () => {
    close();
    opts.onAll();
  });

  panel.append(onlyBtn, allBtn);
  dialog.append(panel);

  anchor.setAttribute('aria-expanded', 'true');
  dialog.addEventListener('close', () => {
    anchor.setAttribute('aria-expanded', 'false');
    dialog.remove();
    if (document.body.contains(anchor)) anchor.focus();
  });
  // Backdrop click-outside closes.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });

  document.body.append(dialog);
  dialog.showModal();
  positionPrintMenu(dialog, anchor);

  const first = dialog.querySelector<HTMLElement>('.overview-print-item:not([disabled])');
  first?.focus();
}

/** Anchor the menu under the button on wide screens; the bottom sheet (mobile)
 * is positioned entirely by CSS, so leave it alone there. */
function positionPrintMenu(dialog: HTMLElement, anchor: HTMLElement): void {
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 559px)').matches) {
    return;
  }
  const rect = anchor.getBoundingClientRect();
  dialog.style.position = 'fixed';
  dialog.style.margin = '0';
  dialog.style.top = `${Math.round(rect.bottom + 6)}px`;
  const width = dialog.offsetWidth;
  const left = Math.max(8, Math.round(rect.right - width));
  dialog.style.left = `${left}px`;
}

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function textEl(tag: string, text: string, className?: string): HTMLElement {
  const node = el(tag, className);
  node.textContent = text;
  return node;
}

function textSpan(text: string): HTMLElement {
  return textEl('span', text);
}
