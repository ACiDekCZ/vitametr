/**
 * Metrics management ("Veličiny") page (redesign IA, screen 2).
 *
 * A first-class route that separates "what do I track / what is it called" from
 * the application settings. It lists the catalog as a card of rows — each with a
 * visibility switch and an expandable detail (units, LOINC, editable aliases as
 * chips) — behind a search pill and a used/all/custom segmented filter. A round
 * "+" adds a custom metric; two ghost pills at the bottom import a metric pack
 * or open the pack export/reset toolbox.
 *
 * This is a MOVE of catalog management out of settings.ts, not a behaviour
 * change: metric visibility still runs through `applyMetricHidden`, aliases
 * through `learnAlias`/`unlearnAlias`, and the pack tools through the shared
 * `catalog-actions`. Toggles update only their own node (no view-wide re-render
 * flicker); the list repaints only when its membership can change. All
 * user-facing text goes through `ctx.t`.
 */

import './metrics-manage.css';
import type { AppContext, RouteState, View } from '../app-context';
import type { Metric, MetricId } from '../../core/types';
import type { StringKey } from '../../i18n/index';
import type { VitametrPack } from '../../plugins/import/pack';
import { formatDateTime, plural } from '../../i18n/index';
import { switchControl } from '../components/switch';
import { tagChip } from '../components/tag-chip';
import { watchStar } from '../components/watch-star';
import { metricName, renderCatalogTools } from './catalog-actions';
import { runPackImport } from './import-actions';
import { aliasChips, codeRows, tagChips } from './metric-editors';
import { SEEDED_TAG_IDS, WATCHED_TAG, tagLabel, usedTags } from '../../core/tags';
import {
  activatePack,
  bundledPackById,
  bundledPackNameKey,
  bundledPacks,
  CORE_PACK,
  deactivatePack,
  isPackActive,
  packContents,
  packOverlap,
  previewDeactivate,
  type ActivateResult,
  type PackOverlap,
} from '../../core/packs';
import {
  applyMetricHidden,
  applyMetricRemoval,
  buildUserMetricSpec,
  isMetricRemovable,
  measurementCounts,
  metricMeta,
  metricUsageCount,
  selectMetrics,
  type MetricFilter,
  type NewMetricValueType,
} from './metrics-manage-model';

// ---------------------------------------------------------------------------
// Small DOM helpers
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

/**
 * Imported packs: user-imported metric packs (grouped by `Metric.pack`, excluding
 * bundled ids) with their metric count, each removable via an inline confirm (no
 * native dialog). Removing a pack drops its metrics and any measurements that
 * reference them. Returns undefined when there are no imported packs — bundled
 * packs are managed by the toggle card above, not here.
 */
function renderImportedPacksCard(ctx: AppContext, rerender: () => void): HTMLElement | undefined {
  const { t } = ctx;

  const counts = new Map<string, number>();
  for (const m of ctx.catalog().all()) {
    if (!m.pack || bundledPackById(m.pack)) continue;
    counts.set(m.pack, (counts.get(m.pack) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;

  const card = el('section', 'metrics-packs-card card');
  card.append(textEl('h2', t('packs.imported'), 'metrics-packs-title'));
  for (const [packId, count] of counts) {
    const row = el('div', 'metrics-pack-item');
    renderPackRowIdle(ctx, rerender, row, packId, count);
    card.append(row);
  }
  return card;
}

function renderPackRowIdle(
  ctx: AppContext,
  rerender: () => void,
  row: HTMLElement,
  packId: string,
  count: number,
): void {
  const { t } = ctx;
  row.replaceChildren();
  row.classList.remove('is-confirming');
  const text = el('div', 'metrics-pack-text');
  text.append(textEl('span', packId, 'metrics-pack-name'));
  text.append(textEl('span', t('settings.packMetricsCount', { count }), 'metrics-pack-count muted'));
  const removeBtn = button(t('settings.removePack'), 'metrics-pack-remove');
  removeBtn.addEventListener('click', () => renderPackRowConfirm(ctx, rerender, row, packId));
  row.append(text, removeBtn);
}

function renderPackRowConfirm(
  ctx: AppContext,
  rerender: () => void,
  row: HTMLElement,
  packId: string,
): void {
  const { t } = ctx;
  row.replaceChildren();
  row.classList.add('is-confirming');
  row.append(textEl('p', t('settings.removePackConfirm'), 'muted'));

  const choice = el('div', 'settings-choice');
  const cancel = button(t('common.cancel'));
  cancel.addEventListener('click', () => rerender());
  const confirm = button(t('settings.removePack'), 'danger');
  confirm.addEventListener('click', () => {
    const removedIds = new Set(
      ctx
        .catalog()
        .all()
        .filter((m) => m.pack === packId)
        .map((m) => m.id),
    );
    ctx.mutate((data) => {
      data.metrics = data.metrics.filter((m) => m.pack !== packId);
      data.measurements = data.measurements.filter((mm) => !removedIds.has(mm.metricId));
    });
    ctx.toast(t('settings.packRemoved'), 'success');
    rerender();
  });
  choice.append(cancel, confirm);
  row.append(choice);
}

const FILTERS: { filter: MetricFilter; labelKey: StringKey }[] = [
  { filter: 'used', labelKey: 'metrics.filterUsed' },
  { filter: 'all', labelKey: 'metrics.filterAll' },
  { filter: 'custom', labelKey: 'metrics.filterCustom' },
];

const NEW_VALUE_TYPES: { type: NewMetricValueType; labelKey: StringKey }[] = [
  { type: 'number', labelKey: 'entry.valueTypeNumber' },
  { type: 'text', labelKey: 'entry.valueTypeText' },
  { type: 'enum', labelKey: 'entry.valueTypeEnum' },
  { type: 'multi', labelKey: 'entry.valueTypeMulti' },
];

export const metricsManageView: View = {
  render(container: HTMLElement, ctx: AppContext, route?: RouteState): () => void {
    const { t } = ctx;
    const name = (m: Metric): string => metricName(m, t);

    const useTags = ctx.data().settings.useTags !== false;

    // A route param (metrics-manage/<metricId>) targets a metric's detail —
    // e.g. the entry quick-create's "Add details" action lands here. Open that
    // metric's detail and land on a filter where it is guaranteed to show.
    const targetId = route?.param as MetricId | undefined;
    const targetMetric = targetId ? ctx.catalog().byId(targetId) : undefined;

    const state = {
      filter: (targetMetric?.customName !== undefined ? 'custom' : 'all') as MetricFilter,
      query: '',
      tag: undefined as string | undefined,
      expandedId: targetMetric ? targetId : (undefined as MetricId | undefined),
    };
    if (!targetMetric) state.filter = 'used';

    const root = el('div', 'metrics-view');

    // Shared datalist offering the seeded tag vocabulary as suggestions to the
    // per-metric tag editors (free-text custom tags are still allowed).
    const TAG_DATALIST_ID = 'metrics-tag-suggestions';
    if (useTags) {
      const datalist = document.createElement('datalist');
      datalist.id = TAG_DATALIST_ID;
      // "Watched" leads the suggestions (shown with a star); its inserted value
      // is the plain label, which resolveTagInput maps back to WATCHED_TAG.
      datalist.append(new Option(`★ ${tagLabel(WATCHED_TAG, t)}`, tagLabel(WATCHED_TAG, t)));
      for (const seeded of SEEDED_TAG_IDS) {
        datalist.append(new Option(tagLabel(seeded, t)));
      }
      root.append(datalist);
    }

    // --- Header: title + subtitle + round "+" -----------------------------
    const header = el('div', 'metrics-header');
    const heading = el('div', 'metrics-heading');
    heading.append(textEl('h1', t('metrics.title')));
    heading.append(textEl('p', t('metrics.subtitle'), 'metrics-subtitle muted'));
    const addBtn = button('+', 'metrics-add primary');
    addBtn.setAttribute('aria-label', t('metrics.addMetric'));
    addBtn.addEventListener('click', () => openAddMetricDialog());
    header.append(heading, addBtn);
    root.append(header);

    // --- Search pill ------------------------------------------------------
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'metrics-search';
    search.placeholder = t('metrics.search');
    search.setAttribute('aria-label', t('metrics.search'));
    search.addEventListener('input', () => {
      state.query = search.value;
      paintList();
    });
    root.append(search);

    // --- Segmented filter -------------------------------------------------
    const segment = el('div', 'metrics-segment');
    function paintSegment(): void {
      segment.replaceChildren();
      for (const { filter, labelKey } of FILTERS) {
        const b = button(t(labelKey), 'metrics-segment-btn');
        if (state.filter === filter) {
          b.classList.add('is-active');
          b.setAttribute('aria-current', 'true');
        }
        b.addEventListener('click', () => {
          if (state.filter === filter) return;
          state.filter = filter;
          paintSegment();
          paintList();
        });
        segment.append(b);
      }
    }
    paintSegment();
    root.append(segment);

    // --- Tag filter (chip row: union of tags in the catalog) -------------
    const tagFilter = el('div', 'metrics-tag-filter');
    function paintTagFilter(): void {
      if (!useTags) return;
      tagFilter.replaceChildren();
      const tags = usedTags(ctx.catalog().visible());
      if (tags.length === 0) return;

      const makeChip = (label: string, value: string | undefined): HTMLButtonElement =>
        tagChip({
          label,
          isActive: state.tag === value,
          star: value === WATCHED_TAG,
          onToggle: () => {
            state.tag = state.tag === value ? undefined : value;
            paintTagFilter();
            paintList();
          },
        });

      tagFilter.append(makeChip(t('tags.all'), undefined));
      for (const tag of tags) tagFilter.append(makeChip(tagLabel(tag, t), tag));
    }
    paintTagFilter();
    root.append(tagFilter);

    // --- Metrics list (white card) ---------------------------------------
    const listCard = el('div', 'metrics-list card');
    root.append(listCard);

    // Live handles to each rendered row, so expanding/collapsing a detail can
    // mutate just that row (insert/remove its `.metric-detail`) without a full
    // list repaint — which would otherwise reset the scroll position.
    const rowNodes = new Map<MetricId, { wrap: HTMLElement; chevron: HTMLButtonElement }>();

    function paintList(): void {
      rowNodes.clear();
      listCard.replaceChildren();
      const counts = measurementCounts(ctx.data().measurements);
      const metrics = selectMetrics({
        // Display surface → the pack-driven VISIBLE set (a built-in from an
        // inactive pack is resolvable but not shown here).
        metrics: ctx.catalog().visible(),
        filter: state.filter,
        query: state.query,
        counts,
        nameOf: name,
        tag: useTags ? state.tag : undefined,
      });

      if (metrics.length === 0) {
        listCard.append(textEl('p', t('metrics.empty'), 'metrics-empty muted'));
        return;
      }

      for (const metric of metrics) {
        listCard.append(renderRow(metric, counts.get(metric.id) ?? 0));
      }
    }

    function renderRow(metric: Metric, count: number): HTMLElement {
      const wrap = el('div', 'metric-row-wrap');
      const row = el('div', 'metric-row');

      const open = button('', 'metric-row-open');
      const text = el('div', 'metric-row-text');
      text.append(textEl('span', name(metric), 'metric-row-name'));
      text.append(textEl('span', metaText(metric, count), 'metric-row-meta muted'));
      if (useTags && (metric.tags?.length ?? 0) > 0) {
        const tagRow = el('div', 'metric-row-tags');
        for (const tag of metric.tags ?? []) {
          tagRow.append(textEl('span', tagLabel(tag, t), 'tag-chip tag-chip--mini'));
        }
        text.append(tagRow);
      }
      open.replaceChildren(text);
      open.addEventListener('click', () => toggleExpanded(metric.id));

      // Visibility switch (replaces the old hide/show checkbox).
      const vis = switchControl({
        checked: !metric.hidden, // on = visible
        label: t('metrics.toggleVisibility', { name: name(metric) }),
        onChange: (on) => {
          ctx.mutate((d) => applyMetricHidden(d, metric, !on));
        },
      });

      const chevron = button('›', 'metric-row-chevron');
      chevron.setAttribute('aria-label', t('metrics.detailToggle', { name: name(metric) }));
      chevron.setAttribute('aria-expanded', String(state.expandedId === metric.id));
      chevron.addEventListener('click', () => toggleExpanded(metric.id));

      // Star quick-toggle (leading), shown only with the tag UI. Toggling watched
      // can add/remove the "Watched" filter chip, so it refreshes both.
      if (useTags) {
        const star = watchStar({
          ctx,
          metric,
          variant: 'watch-star--inline',
          onToggle: () => {
            paintTagFilter();
            paintList();
          },
        });
        row.append(star, open, vis.el, chevron);
      } else {
        row.append(open, vis.el, chevron);
      }
      wrap.append(row);
      rowNodes.set(metric.id, { wrap, chevron });

      if (state.expandedId === metric.id) {
        const detail = el('div', 'metric-detail');
        paintDetail(metric.id, detail);
        wrap.append(detail);
      }
      return wrap;
    }

    function metaText(metric: Metric, count: number): string {
      const meta = metricMeta(metric, count);
      if (meta.kind === 'none') return t('metrics.noMeasurements');
      const countText = t('metrics.measurementCount', { count: meta.count });
      return meta.unit ? `${meta.unit} · ${countText}` : countText;
    }

    /**
     * Expand or collapse a metric's detail by mutating only the affected rows —
     * remove the previously-open detail, insert the new one — so the list never
     * repaints and the scroll position is preserved. Only one row is open at a
     * time (matching the single `expandedId`).
     */
    function toggleExpanded(id: MetricId): void {
      const previousId = state.expandedId;
      const nextId = previousId === id ? undefined : id;
      state.expandedId = nextId;

      // Collapse whatever was open (the same row when toggling off, or another).
      if (previousId !== undefined && previousId !== nextId) {
        const prev = rowNodes.get(previousId);
        if (prev) {
          prev.wrap.querySelector('.metric-detail')?.remove();
          prev.chevron.setAttribute('aria-expanded', 'false');
        }
      }

      // Expand the newly-open row in place.
      if (nextId !== undefined) {
        const node = rowNodes.get(nextId);
        if (node) {
          node.chevron.setAttribute('aria-expanded', 'true');
          if (!node.wrap.querySelector('.metric-detail')) {
            const detail = el('div', 'metric-detail');
            paintDetail(nextId, detail);
            node.wrap.append(detail);
          }
        }
      }
    }

    // --- Metric detail (units, LOINC, alias chips) ------------------------
    function paintDetail(id: MetricId, host: HTMLElement): void {
      host.replaceChildren();
      const metric = ctx.catalog().byId(id);
      if (!metric) return;

      if (metric.units.length > 0) {
        host.append(detailLine(t('metrics.units'), metric.units.join(', ')));
      }

      // Provenance: how this custom metric came to exist (muted, read-only).
      if (metric.origin) {
        const origin =
          metric.origin.kind === 'import'
            ? t('metrics.originImport')
            : metric.origin.kind === 'pack'
              ? t('metrics.originPack', { pack: metric.pack ?? '' })
              : t('metrics.originManual');
        host.append(textEl('p', origin, 'metric-detail-origin muted'));
      }

      // Recognised names (aliases): repeatable free-text chips.
      host.append(textEl('span', t('metrics.aliases'), 'metric-detail-label'));
      const chips = el('div', 'metric-chips');
      host.append(chips);
      aliasChips({
        container: chips,
        t,
        list: () => ctx.catalog().customAliases(id),
        add: (value) => ctx.mutate(() => ctx.catalog().learnAlias(id, value)),
        remove: (value) => ctx.mutate(() => ctx.catalog().unlearnAlias(id, value)),
      });

      // Tags: editable chips (add from the seeded vocabulary or a free-text tag).
      if (useTags) {
        host.append(textEl('span', t('metrics.tags'), 'metric-detail-label'));
        const tagsHost = el('div', 'metric-chips');
        host.append(tagsHost);
        tagChips({
          container: tagsHost,
          t,
          datalistId: TAG_DATALIST_ID,
          list: () => ctx.catalog().byId(id)?.tags ?? [],
          add: (value) => ctx.mutate(() => ctx.catalog().addTag(id, value)),
          remove: (value) => ctx.mutate(() => ctx.catalog().removeTag(id, value)),
          onChange: () => {
            paintTagFilter();
            paintList();
          },
        });
      }

      // Advanced: external codes — the special-cased LOINC plus a generic,
      // code-system-agnostic list the user can add pairs to. Secondary section,
      // all user-entered/local; the system label is whatever the user types.
      host.append(textEl('span', t('metrics.codesSection'), 'metric-detail-label'));
      const codes = el('div', 'metric-codes');
      host.append(codes);
      codeRows({
        container: codes,
        t,
        loinc: () => currentLoinc(id),
        setLoinc: (value) => persistCodes(id, value, currentOther(id)),
        others: () => currentOther(id),
        addOther: (system, code) => {
          const next = currentOther(id);
          next.push({ system, code });
          persistCodes(id, currentLoinc(id), next);
        },
        updateOther: (index, system, code) => {
          const next = currentOther(id);
          if (index < next.length) next[index] = { system, code };
          persistCodes(id, currentLoinc(id), next);
        },
        removeOther: (index) => {
          persistCodes(
            id,
            currentLoinc(id),
            currentOther(id).filter((_, i) => i !== index),
          );
        },
      });

      // Danger action: remove this single metric, guarded by usage. A metric
      // that is referenced by measurements can't be removed here — the hint
      // tells the user to delete those measurements first.
      const removeHost = el('div', 'metric-detail-remove');
      renderRemoveIdle(id, removeHost);
      host.append(removeHost);
    }

    /**
     * The idle "Remove metric" action. Disabled with a hint when the metric has
     * measurements (only a zero-measurement metric is removable); otherwise a
     * danger button that opens an inline two-step confirm (no native dialog).
     */
    function renderRemoveIdle(id: MetricId, host: HTMLElement): void {
      host.replaceChildren();
      const metric = ctx.catalog().byId(id);
      if (!metric) return;
      const count = metricUsageCount(ctx.data().measurements, id);
      const btn = button(t('metrics.remove'), 'metric-remove danger');
      if (!isMetricRemovable(count)) {
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
        host.append(
          btn,
          textEl('p', t('metrics.removeBlocked', { count }), 'metric-remove-hint muted'),
        );
        return;
      }
      btn.addEventListener('click', () => renderRemoveConfirm(id, host, metric));
      host.append(btn);
    }

    /** Inline confirm for the per-metric remove (mirrors the reset/pack confirms). */
    function renderRemoveConfirm(id: MetricId, host: HTMLElement, metric: Metric): void {
      host.replaceChildren();
      host.append(textEl('p', t('metrics.removeConfirm'), 'muted'));
      const choice = el('div', 'settings-choice');
      const cancel = button(t('common.cancel'));
      cancel.addEventListener('click', () => renderRemoveIdle(id, host));
      const confirm = button(t('metrics.removeConfirmAgain'), 'danger');
      confirm.addEventListener('click', () => {
        // Guarded to zero measurements above, so this never deletes any.
        ctx.mutate((data) => applyMetricRemoval(data, metric));
        ctx.toast(t('metrics.metricRemoved'), 'success');
        state.expandedId = undefined;
        paintTagFilter();
        paintList();
      });
      choice.append(cancel, confirm);
      host.append(choice);
    }

    /** The metric's current LOINC (empty when unset). */
    function currentLoinc(id: MetricId): string {
      return ctx.catalog().byId(id)?.externalCodes?.loinc ?? '';
    }

    /** A mutable copy of the metric's current additional code pairs. */
    function currentOther(id: MetricId): { system: string; code: string }[] {
      return (ctx.catalog().byId(id)?.externalCodes?.other ?? []).map((p) => ({ ...p }));
    }

    function persistCodes(
      id: MetricId,
      loinc: string,
      other: { system: string; code: string }[],
    ): void {
      ctx.mutate(() => ctx.catalog().setExternalCodes(id, { loinc, other }));
    }

    function detailLine(label: string, value: string): HTMLElement {
      const line = el('div', 'metric-detail-line');
      line.append(textEl('span', label, 'metric-detail-label'));
      line.append(textEl('span', value, 'metric-detail-value'));
      return line;
    }

    // --- Add-metric dialog (the header "+") -------------------------------
    function openAddMetricDialog(): void {
      const dialog = document.createElement('dialog');
      dialog.className = 'modal';
      dialog.setAttribute('aria-label', t('metrics.addTitle'));
      dialog.addEventListener('close', () => dialog.remove());

      const box = el('div', 'modal-box');
      box.append(textEl('h3', t('metrics.addTitle')));

      // Dialog-scoped datalists: known units (smart suggestions, a new one may
      // still be typed) and the seeded tag vocabulary (available even when the
      // per-metric tag UI is hidden by `useTags`).
      const UNIT_DATALIST_ID = 'add-metric-unit-suggestions';
      const unitDatalist = document.createElement('datalist');
      unitDatalist.id = UNIT_DATALIST_ID;
      const seenUnitDisplay = new Set<string>();
      for (const u of ctx.units.allUnits()) {
        if (u.display === '' || seenUnitDisplay.has(u.display)) continue;
        seenUnitDisplay.add(u.display);
        unitDatalist.append(new Option(u.display));
      }

      const ADD_TAG_DATALIST_ID = 'add-metric-tag-suggestions';
      const tagDatalist = document.createElement('datalist');
      tagDatalist.id = ADD_TAG_DATALIST_ID;
      tagDatalist.append(new Option(`★ ${tagLabel(WATCHED_TAG, t)}`, tagLabel(WATCHED_TAG, t)));
      for (const seeded of SEEDED_TAG_IDS) tagDatalist.append(new Option(tagLabel(seeded, t)));

      const nameField = field(t('metrics.name'));
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.setAttribute('aria-label', t('metrics.name'));
      nameField.append(nameInput);

      const typeField = field(t('entry.valueTypeLabel'));
      const typeSelect = document.createElement('select');
      typeSelect.setAttribute('aria-label', t('entry.valueTypeLabel'));
      for (const { type, labelKey } of NEW_VALUE_TYPES) {
        typeSelect.add(new Option(t(labelKey), type));
      }
      typeField.append(typeSelect);

      // Unit (number) and allowed-values (enum/multi) fields swap by type.
      // The unit input offers the known units as suggestions but stays free
      // text (a brand-new unit is kept raw, exactly as before).
      const unitField = field(t('entry.unitOptional'));
      const unitInput = document.createElement('input');
      unitInput.type = 'text';
      unitInput.setAttribute('list', UNIT_DATALIST_ID);
      unitInput.setAttribute('aria-label', t('entry.unitOptional'));
      unitField.append(unitInput);

      const enumField = field(t('entry.enumValuesLabel'));
      const enumInput = document.createElement('input');
      enumInput.type = 'text';
      enumInput.placeholder = t('entry.enumValuesHint');
      enumInput.setAttribute('aria-label', t('entry.enumValuesLabel'));
      enumField.append(enumInput);

      // Recognised names (aliases): the SAME repeatable chip editor as the
      // detail. The metric's own name is prepended as its first alias at build
      // time (buildUserMetricSpec), so this list carries only the extra names.
      const extraAliases: string[] = [];
      const aliasField = field(t('metrics.aliases'));
      const aliasHost = el('div', 'metric-chips');
      aliasField.append(aliasHost);
      aliasChips({
        container: aliasHost,
        t,
        list: () => extraAliases,
        add: (value) => {
          if (!extraAliases.includes(value)) extraAliases.push(value);
        },
        remove: (value) => {
          const i = extraAliases.indexOf(value);
          if (i >= 0) extraAliases.splice(i, 1);
        },
      });

      // Tags: the SAME chip editor as the detail, seeded-vocabulary datalist +
      // free text, repeatable. Respect `useTags` — hidden entirely when off.
      const dialogTags: string[] = [];
      const tagsField = field(t('metrics.tags'));
      if (useTags) {
        const tagsHost = el('div', 'metric-chips');
        tagsField.append(tagsHost);
        tagChips({
          container: tagsHost,
          t,
          datalistId: ADD_TAG_DATALIST_ID,
          list: () => dialogTags,
          add: (value) => {
            if (!dialogTags.includes(value)) dialogTags.push(value);
          },
          remove: (value) => {
            const i = dialogTags.indexOf(value);
            if (i >= 0) dialogTags.splice(i, 1);
          },
        });
      }

      // External codes: the special-cased LOINC (label + value + inline `\d+-\d`
      // validation) plus any number of generic system+code pairs — the SAME
      // repeatable row editor as the detail.
      const codesSubhead = textEl('h4', t('metrics.codesSection'), 'modal-subhead');
      let loinc = '';
      const codePairs: { system: string; code: string }[] = [];
      const codesHost = el('div', 'metric-codes');
      codeRows({
        container: codesHost,
        t,
        loinc: () => loinc,
        setLoinc: (value) => {
          loinc = value;
        },
        others: () => codePairs,
        addOther: (system, code) => codePairs.push({ system, code }),
        updateOther: (index, system, code) => {
          if (index < codePairs.length) codePairs[index] = { system, code };
        },
        removeOther: (index) => codePairs.splice(index, 1),
      });

      function syncTypeFields(): void {
        const type = typeSelect.value as NewMetricValueType;
        unitField.hidden = type !== 'number';
        enumField.hidden = type !== 'enum' && type !== 'multi';
      }
      typeSelect.addEventListener('change', syncTypeFields);
      syncTypeFields();

      const actions = el('div', 'settings-choice');
      const cancel = button(t('common.cancel'));
      cancel.addEventListener('click', () => dialog.close());
      const create = button(t('entry.newMetric'), 'primary');
      function submitCreate(): void {
        const spec = buildUserMetricSpec({
          name: nameInput.value,
          valueType: typeSelect.value as NewMetricValueType,
          unit: unitInput.value,
          enumValues: enumInput.value,
          aliases: extraAliases,
          tags: useTags ? dialogTags : [],
          loinc,
          codePairs,
        });
        if (!spec) {
          nameInput.focus();
          return;
        }
        let created: Metric | undefined;
        ctx.mutate(() => {
          created = ctx.catalog().addUserMetric(spec);
        });
        dialog.close();
        ctx.toast(t('metrics.metricAdded'), 'success');
        // Surface the new metric: it has no measurements yet, so switch to the
        // "custom" filter (and clear the search) where it is guaranteed to show.
        state.filter = 'custom';
        state.query = '';
        search.value = '';
        state.expandedId = created?.id;
        paintSegment();
        paintList();
      }
      create.addEventListener('click', submitCreate);
      // Fast add: Enter in the name (or unit) field adds the metric with the
      // current defaults — no need to reach for the button when nothing else
      // needs changing. Not on the enum/alias/tag/code inputs, whose Enter
      // commits their own chip/value.
      const submitOnEnter = (e: KeyboardEvent): void => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitCreate();
        }
      };
      nameInput.addEventListener('keydown', submitOnEnter);
      unitInput.addEventListener('keydown', submitOnEnter);
      actions.append(cancel, create);

      // Order: name/type/unit/enum/alias/(tags), then the External codes subhead
      // with its LOINC + generic pairs, then actions.
      box.append(nameField, typeField, unitField, enumField, aliasField);
      if (useTags) box.append(tagsField);
      box.append(codesSubhead, codesHost, actions);
      box.append(unitDatalist, tagDatalist);
      dialog.append(box);
      document.body.append(dialog);
      dialog.showModal();
      nameInput.focus();
    }

    function field(labelText: string): HTMLElement {
      const wrap = el('div', 'field');
      const label = document.createElement('label');
      label.textContent = labelText;
      wrap.append(label);
      return wrap;
    }

    // --- Pack manager: bundled toggles + imported packs + import/export pills
    // Hidden file input for pack import (the "Import pack" pill triggers it).
    const hidden = document.createElement('input');
    hidden.type = 'file';
    hidden.className = 'visually-hidden';
    hidden.accept = '.json,application/json';
    hidden.setAttribute('aria-label', t('metrics.importPack'));
    hidden.addEventListener('change', () => {
      const file = hidden.files?.[0];
      hidden.value = '';
      if (file) void runPackImport(ctx, file);
    });

    // Which bundled pack row currently has its content preview expanded (one at
    // a time). A pack-change or expand triggers a repaint of the packs host.
    let expandedPackId: string | undefined;

    const packsHost = el('div', 'metrics-packs');

    /** Repaint the pack cards; a pack change also refreshes tags + the metric list. */
    function paintPacks(): void {
      packsHost.replaceChildren();
      packsHost.append(renderBundledPacksCard());
      const imported = renderImportedPacksCard(ctx, () => {
        paintPacks();
        paintList();
      });
      if (imported) packsHost.append(imported);
    }

    function afterPackChange(): void {
      paintPacks();
      paintTagFilter();
      paintList();
    }

    /**
     * The bundled-packs card: the Core pack first (the default baseline, not
     * sorted into the list), then the 14 category packs alphabetical by name.
     */
    function renderBundledPacksCard(): HTMLElement {
      const card = el('section', 'metrics-packs-card card');
      card.append(textEl('h2', t('packs.section'), 'metrics-packs-title'));
      const coreRow = el('div', 'metrics-bundled-item');
      paintBundledRow(coreRow, CORE_PACK);
      card.append(coreRow);
      const packs = bundledPacks().sort((a, b) =>
        t(bundledPackNameKey(a.id)).localeCompare(t(bundledPackNameKey(b.id)), ctx.locale),
      );
      for (const pack of packs) {
        const row = el('div', 'metrics-bundled-item');
        paintBundledRow(row, pack);
        card.append(row);
      }
      return card;
    }

    /** Whether an inactive pack's provided metrics are ALL already visible. */
    function isFullOverlap(overlap: PackOverlap, active: boolean): boolean {
      return !active && overlap.total > 0 && overlap.alreadyHave === overlap.total;
    }

    /** The meta line under a bundled pack's name (count [· partial overlap]). */
    function bundledMetaText(overlap: PackOverlap, active: boolean): string {
      const count = plural(
        overlap.total,
        { one: 'packs.metricCountOne', few: 'packs.metricCountFew', many: 'packs.metricCountMany' },
        { n: overlap.total },
      );
      if (!active && overlap.alreadyHave > 0) {
        return `${count} · ${t('packs.overlap', { m: overlap.alreadyHave })}`;
      }
      return count;
    }

    /**
     * The pack row's meta node: a mini "all already yours" chip when an inactive
     * pack fully overlaps what the user already has (activation only merges
     * aliases/tags), else the muted count [· partial overlap] text.
     */
    function renderBundledMeta(overlap: PackOverlap, active: boolean): HTMLElement {
      if (isFullOverlap(overlap, active)) {
        return textEl(
          'span',
          `✓ ${t('packs.fullOverlap')}`,
          'tag-chip tag-chip--mini metrics-pack-fullhave',
        );
      }
      return textEl('span', bundledMetaText(overlap, active), 'metrics-pack-count muted');
    }

    /** Render one bundled pack row in its idle state (name + meta + switch). */
    function paintBundledRow(row: HTMLElement, pack: VitametrPack): void {
      row.replaceChildren();
      row.classList.remove('is-confirming');
      const active = isPackActive(ctx.data(), pack.id);
      const overlap = packOverlap(ctx.data(), ctx.catalog(), pack);
      const name = t(bundledPackNameKey(pack.id));

      const head = el('div', 'metrics-pack-head');

      // Clickable body → expand/collapse the content preview.
      const open = button('', 'metrics-pack-open');
      open.setAttribute('aria-expanded', String(expandedPackId === pack.id));
      const text = el('div', 'metrics-pack-text');
      text.append(textEl('span', name, 'metrics-pack-name'));
      text.append(renderBundledMeta(overlap, active));
      const chevron = textEl('span', '›', 'metrics-pack-chevron');
      open.append(text, chevron);
      open.addEventListener('click', () => {
        expandedPackId = expandedPackId === pack.id ? undefined : pack.id;
        paintPacks();
      });

      // Toggle: on = active. Stops propagation so it never also expands the row.
      const sw = switchControl({
        checked: active,
        label: name,
        onChange: (on) => {
          if (on) activateBundled(pack);
          else deactivateBundled(row, pack);
        },
      });
      sw.el.addEventListener('click', (e) => e.stopPropagation());

      head.append(open, sw.el);
      row.append(head);

      if (expandedPackId === pack.id) row.append(renderBundledPreview(pack));
    }

    /** The row-expansion content preview: each metric's name + unit, ✓ if present. */
    function renderBundledPreview(pack: VitametrPack): HTMLElement {
      const list = el('div', 'metrics-pack-preview');
      const active = isPackActive(ctx.data(), pack.id);
      const overlap = packOverlap(ctx.data(), ctx.catalog(), pack);
      if (isFullOverlap(overlap, active)) {
        list.append(textEl('p', t('packs.fullOverlapHint'), 'metrics-pack-fullhint muted'));
      }
      for (const item of packContents(ctx.data(), ctx.catalog(), pack)) {
        const line = el('div', 'metrics-pack-preview-item');
        line.append(textEl('span', item.name, 'metrics-pack-preview-name'));
        if (item.unit) line.append(textEl('span', item.unit, 'metrics-pack-preview-unit muted'));
        if (item.hasData && item.lastMeasuredAtIso) {
          line.append(
            textEl(
              'span',
              `✓ ${t('packs.lastMeasured', { date: formatDateTime(item.lastMeasuredAtIso, 'date') })}`,
              'metrics-pack-preview-have muted',
            ),
          );
        }
        list.append(line);
      }
      return list;
    }

    /** Activate a bundled pack: flag it visible, toast in show terms {shown}. */
    function activateBundled(pack: VitametrPack): void {
      let result: ActivateResult = { shown: 0, alreadyVisible: 0 };
      ctx.mutate((data) => {
        result = activatePack(data, ctx.catalog(), pack.id);
      });
      const name = t(bundledPackNameKey(pack.id));
      if (result.shown > 0) {
        ctx.toast(t('packs.activatedShown', { name, shown: result.shown }), 'success');
      } else {
        ctx.toast(t('packs.activatedNoop', { name }), 'success');
      }
      afterPackChange();
    }

    /**
     * Deactivate a bundled pack. Dry-run first: if nothing would be hidden (all its
     * metrics have data or another active pack provides them), turn it off
     * immediately (calm toast). Otherwise an inline two-step confirm on the row
     * states exactly what will be hidden / kept before it happens.
     */
    function deactivateBundled(row: HTMLElement, pack: VitametrPack): void {
      const preview = previewDeactivate(ctx.data(), ctx.catalog(), pack.id);
      const name = t(bundledPackNameKey(pack.id));
      if (preview.hidden === 0) {
        ctx.mutate((data) => deactivatePack(data, ctx.catalog(), pack.id));
        ctx.toast(t('packs.deactivatedKeptAll', { name }), 'success');
        afterPackChange();
        return;
      }
      renderBundledConfirmOff(row, pack, preview.hidden, preview.keptVisible);
    }

    /** Inline confirm shown on the row when turning a pack off would hide metrics. */
    function renderBundledConfirmOff(
      row: HTMLElement,
      pack: VitametrPack,
      hidden: number,
      kept: number,
    ): void {
      row.replaceChildren();
      row.classList.add('is-confirming');
      row.append(
        textEl(
          'p',
          t('packs.confirmOff', { n: hidden, kept, name: t(bundledPackNameKey(pack.id)) }),
          'metrics-pack-confirm-text muted',
        ),
      );
      const choice = el('div', 'settings-choice');
      const back = button(t('common.cancel'));
      // Zpět: restore the row untouched (the switch flips back on).
      back.addEventListener('click', () => paintBundledRow(row, pack));
      const confirm = button(t('common.confirm'), 'danger');
      confirm.addEventListener('click', () => {
        let result = { hidden: 0, keptVisible: 0 };
        ctx.mutate((data) => {
          result = deactivatePack(data, ctx.catalog(), pack.id);
        });
        const name = t(bundledPackNameKey(pack.id));
        ctx.toast(
          t('packs.deactivated', { name, hidden: result.hidden, kept: result.keptVisible }),
          'success',
        );
        afterPackChange();
      });
      choice.append(back, confirm);
      row.append(choice);
    }

    paintPacks();
    root.append(packsHost);

    // Import / export pills under the cards (bundled packs are toggled above).
    const packRow = el('div', 'metrics-pack-row');
    const importBtn = button(t('metrics.importPack'), 'metrics-ghost');
    importBtn.addEventListener('click', () => hidden.click());
    // Export opens a modal hosting the shared catalog tools (metric selection,
    // "only my own" / content toggles, export) — the action and its result in
    // one place.
    const exportBtn = button(t('metrics.exportPack'), 'metrics-ghost');
    exportBtn.addEventListener('click', () => openExportPackDialog());
    packRow.append(importBtn, exportBtn);
    root.append(packRow, hidden);

    /** The pack export tools as a modal dialog. */
    function openExportPackDialog(): void {
      const dialog = document.createElement('dialog');
      dialog.className = 'modal';
      dialog.setAttribute('aria-label', t('metrics.exportPack'));
      dialog.addEventListener('close', () => dialog.remove());

      const box = el('div', 'modal-box');
      box.append(renderCatalogTools(ctx));

      const actions = el('div', 'settings-choice');
      const close = button(t('common.close'));
      close.addEventListener('click', () => dialog.close());
      actions.append(close);
      box.append(actions);

      dialog.append(box);
      document.body.append(dialog);
      dialog.showModal();
    }

    paintList();
    // A route param targeted a metric's detail — reveal it on first paint.
    if (state.expandedId) {
      rowNodes.get(state.expandedId)?.wrap.scrollIntoView({ block: 'center' });
    }

    container.replaceChildren();
    container.append(root);

    return () => {
      container.replaceChildren();
    };
  },
};
