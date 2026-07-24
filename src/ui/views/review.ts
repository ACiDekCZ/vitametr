/**
 * Import review screen (K8g) — the checkable list the user confirms before
 * anything is stored.
 *
 * Restrained clinical, mobile-first. One proposed measurement renders as one
 * row showing its value/unit/date, a confidence indicator and its resolution
 * state. Resolved rows carry an accept/reject toggle (default accept).
 * Unresolved rows (spec §16: never guessed) must first be resolved — assign an
 * existing metric or create a new user metric — or rejected; an unresolved,
 * non-rejected row can never be accepted, and only accepted+resolved rows are
 * committed.
 *
 * All decision arithmetic lives in the DOM-free `review-model`; this file is
 * only glue to the DOM. Every user-facing string goes through `ctx.t` /
 * `formatNumber` / `formatDateTime`. No hardcoded copy, no clock, no randomness.
 *
 * Data reaches this view out-of-band: the AppContext has no "pending import"
 * slot, so the import action (Settings, K8b) calls `setPendingImport(items)`
 * with the pipeline's prepared `ReviewItem[]` and then navigates to 'review'.
 * The state is module-local and consumed on the next render.
 */

import type { AppContext, View } from '../app-context';
import { formatDateTime, formatNumber, plural } from '../../i18n/index';
import type { StringKey } from '../../i18n/index';
import './review.css';
import type { ReviewItem } from '../../core/contracts';
import type { Metric, ProposedMeasurement, TimePrecision } from '../../core/types';
import {
  bulkDecideUndecided,
  canAccept,
  canCommit,
  groupConflictsByMetric,
  hiddenPackCounts,
  isResolved,
  suggestMetrics,
  toCommitList,
  type MetricConflictGroup,
} from './review-model';
import { metricPicker } from '../components/metric-picker';
import { getOfferHiddenMetrics } from './import-actions';
import { activatePack, bundledPackNameKey, hiddenMetricState } from '../../core/packs';
import { measurementText } from '../../core/series';
import { partitionDuplicates } from '../../core/review';
import { buildImportRecord, stampImportId } from '../../core/imports';
import { suggestSource } from '../../core/sources';
import { sourcePicker, type SourcePicker } from '../components/source-picker';
import type { SourceSelection } from '../components/source-picker-model';
import {
  applyResolutions,
  conflictKeyForMeasurement,
  conflictKind,
  detectConflicts,
  keepIncoming,
  DEFAULT_CONFLICT_CHOICE,
  type ConflictChoice,
  type ConflictGroup,
  type ConflictKind,
} from '../../core/conflicts';
import type { Measurement, MetricId, Operator, Source } from '../../core/types';
import { valueWithUnitEl } from '../format-value';

/**
 * Origin plugin id stamped on committed measurements. `ProposedMeasurement`
 * carries no plugin id, and `setPendingImport` keeps the contract's exact
 * signature, so a single generic id is used for the whole review batch.
 */
const IMPORT_PLUGIN_ID = 'import';

/**
 * Provenance of the pending import, threaded from the import action so the
 * commit can record an {@link ImportRecord}. Optional: a batch that arrives
 * without meta (e.g. a legacy caller) still commits, just without a plugin id
 * or file name on its record.
 */
export interface PendingImportMeta {
  /** Real import plugin id ('pdf', 'csv', 'json-backup', 'fhir', ...). */
  pluginId?: string;
  /** Original picked/dropped file name, when available. */
  fileName?: string;
}

/**
 * Module-local hand-off from the import action to the review view. This IS the
 * source of truth for the batch while it is being reviewed: the view mutates
 * these items (and `pendingChoices`) in place, so navigating away and back
 * restores every accept/reject, metric assignment and conflict choice instead of
 * resetting to defaults. It is cleared only on a successful import.
 */
let pendingItems: ReviewItem[] = [];
let pendingMeta: PendingImportMeta = {};
let pendingChoices = new Map<string, ConflictChoice>();
/**
 * Metrics created (via "+ Create") while resolving THIS batch. Their `origin` is
 * stamped `{ kind: 'import' }` at creation, but the batch's importId only exists
 * at commit — so we track the ids here and back-stamp `origin.importId` on commit.
 * Reset per batch in {@link setPendingImport}; only ids created in this batch are
 * ever stamped, so an earlier abandoned review's metrics are never claimed.
 */
let pendingCreatedMetricIds = new Set<MetricId>();

/**
 * Store the prepared items the review screen should show on its next render,
 * plus the originating import's provenance (plugin id + file name) for the
 * import history record. Called by the import action before navigating to
 * 'review'. Side-effect-local to this module by design (file header).
 */
export function setPendingImport(items: ReviewItem[], meta: PendingImportMeta = {}): void {
  // Default a resolved row to accept once, now — not on every render — so the
  // stored decision survives navigation. A fresh batch starts with no choices.
  pendingItems = items.map((item) => ({
    ...item,
    decision: isResolved(item) && item.decision === 'pending' ? 'accept' : item.decision,
  }));
  pendingMeta = meta;
  pendingChoices = new Map();
  pendingCreatedMetricIds = new Set();
}

/**
 * How many items an unfinished import is still holding for review (0 when none).
 * Lets other views surface a "continue review" entry point so a batch the user
 * navigated away from is discoverable, not silently stranded.
 */
export function pendingImportCount(): number {
  return pendingItems.length;
}

/**
 * The full pending batch (items + provenance), for the pre-import filter step: it
 * reads the whole batch, and on "Continue" writes the narrowed subset back via
 * {@link setPendingImport} before navigating to review. Returns the live arrays —
 * callers must not mutate them in place.
 */
export function getPendingImport(): { items: ReviewItem[]; meta: PendingImportMeta } {
  return { items: pendingItems, meta: pendingMeta };
}

export const reviewView: View = {
  render(container: HTMLElement, ctx: AppContext): void {
    container.replaceChildren();

    const title = el('h1');
    title.textContent = ctx.t('review.title');
    container.append(title);

    // Snapshot the provenance for this batch (the click handler runs later).
    const meta = pendingMeta;

    // The persistent batch itself (defaults were applied in setPendingImport):
    // the view mutates these items in place, so leaving and returning to review
    // keeps every decision/assignment instead of resetting.
    const state: ReviewItem[] = pendingItems;

    if (state.length === 0) {
      const empty = el('p', 'card muted review-empty');
      empty.textContent = ctx.t('review.nothing');
      container.append(empty);
      return;
    }

    const subtitle = el('p', 'muted review-subtitle');
    subtitle.textContent = ctx.t('review.proposed');

    // Per-conflict resolution choices, keyed by ConflictGroup.key. Persist across
    // re-renders (a decision/resolution change recomputes the groups); unknown
    // keys fall back to the safe default (keep-new). Persisted at module scope so
    // conflict resolutions also survive navigating away and back.
    const choices = pendingChoices;
    const conflictsSection = el('section', 'review-conflicts');

    // Source attribution for this batch: a shared source picker seeded from the
    // import's stamped source name and plugin id, then editable by the user. The
    // resolved choice is read at commit time via `picker.resolve()`.
    const batchSourceName = state.map((i) => i.proposed.sourceName).find(Boolean);
    const { section: sourceControl, picker } = buildSourceControl(
      ctx,
      initialSourceSelection(ctx.data().sources, batchSourceName, meta.pluginId),
    );

    const list = el('ul', 'review-list');
    const rows = state.map((_, index) => buildRow(ctx, state, index, updateFooter, refreshAll));
    for (const row of rows) list.append(row.element);

    // Bulk "activate the pack for all N" banners: one per disabled pack that hides
    // ≥2 resolved rows in this batch, so the whole category is revealed in a single
    // action instead of N per-row activations. Gated by the offer-hidden setting
    // (off ⇒ the batch was downgraded to unresolved, so there is nothing to bulk).
    const bannersSection = el('div', 'review-hidden-banners');
    function renderBanners(): void {
      bannersSection.replaceChildren();
      if (!getOfferHiddenMetrics(ctx)) return;
      for (const [packId, n] of hiddenPackCounts(state, ctx.data(), ctx.catalog())) {
        bannersSection.append(buildHiddenPackBanner(ctx, packId, n, refreshAll));
      }
    }

    // Re-render every row plus the bulk banners: activating a pack (per-row or
    // bulk) normalizes EVERY row it covers, and showing/creating a metric changes
    // the per-pack hidden counts — so any hidden-pack action rebuilds the batch.
    function refreshAll(): void {
      for (const row of rows) row.refresh();
      renderBanners();
      updateFooter();
    }

    /** Recompute conflicts from the current commit list vs stored data. */
    function currentConflicts(): ConflictGroup[] {
      const preview = ctx.pipeline().commit(toCommitList(state), { pluginId: IMPORT_PLUGIN_ID });
      return detectConflicts(ctx.data().measurements, preview);
    }

    /** Re-render the conflicts section from the current state. */
    function renderConflicts(): void {
      const groups = currentConflicts();
      // Drop choices for keys that are no longer in conflict.
      const live = new Set(groups.map((g) => g.key));
      for (const key of [...choices.keys()]) if (!live.has(key)) choices.delete(key);

      conflictsSection.replaceChildren();
      conflictsSection.hidden = groups.length === 0;
      if (groups.length === 0) return;

      const headerRow = el('div', 'review-conflicts-header');
      const heading = el('h2', 'review-conflicts-title');
      heading.textContent = ctx.t('review.conflictsTitle');
      const done = groups.filter((g) => choices.has(g.key)).length;
      headerRow.append(heading, conflictProgressEl(ctx, done, groups.length));
      const hint = el('p', 'muted review-conflicts-hint');
      hint.textContent = ctx.t('review.conflictsHint');
      conflictsSection.append(headerRow, hint);

      // Group conflicts by metric (most-painful metric first). A metric with more
      // than one conflict gets a header with bulk actions; a lone conflict does
      // not, so an ordinary import stays uncluttered (§2).
      for (const metricGroup of groupConflictsByMetric(groups)) {
        if (metricGroup.groups.length > 1) {
          conflictsSection.append(buildMetricGroupHeader(ctx, metricGroup, choices, renderConflicts));
        }
        for (const group of metricGroup.groups) {
          conflictsSection.append(buildConflictCard(ctx, group, choices, renderConflicts));
        }
      }
    }

    // ---- Footer: Import selected --------------------------------------------
    // Recognized rows default to accept, so a bulk "accept all" was a no-op in the
    // common case (and read as broken); the single "Import selected" action commits
    // every accepted row. Rejecting a specific row stays a per-row toggle.
    const footer = el('div', 'review-footer');

    const commitWrap = el('div', 'review-commit');
    const countPill = el('span', 'pill review-count');
    const commitBtn = button('review-commit', ctx.t('review.commit'));
    commitBtn.addEventListener('click', () => {
      const commitItems = toCommitList(state);
      // Learn raw-name → metric aliases NOW, at import — not when a suggestion was
      // clicked. Only rows the user actually imports (accepted + resolved) teach
      // the catalog; a misclick that was changed or rejected before this never does.
      ctx.mutate(() => {
        for (const it of commitItems) {
          const orig = it.proposed.metric;
          if (typeof orig === 'object' && 'unresolvedName' in orig && it.resolvedMetricId) {
            ctx.catalog().learnAlias(it.resolvedMetricId, orig.unresolvedName);
          }
        }
      });
      // Resolve the user's source choice to a concrete id. For a new source the
      // resolver mints the Source now (deterministic id from the current sources)
      // and we push it inside the mutate below; a name that already exists is
      // reused.
      const existingSources = ctx.data().sources;
      const { sourceId, newSource: sourceToAdd } = picker.resolve();
      const measurements = ctx
        .pipeline()
        .commit(commitItems, { pluginId: IMPORT_PLUGIN_ID, ...(sourceId ? { sourceId } : {}) });
      // Source name for the import record: the resolved source's name when one
      // was chosen, else the proposals' agreed name (labs stamp it).
      const resolvedSource =
        sourceToAdd ?? (sourceId ? existingSources.find((s) => s.id === sourceId) : undefined);
      const sourceName =
        resolvedSource?.name ?? commitItems.map((i) => i.proposed.sourceName).find(Boolean);
      let added = 0;
      let skipped = 0;
      let conflictsResolved = 0;
      ctx.mutate((data) => {
        // Conflicts (same metric + instant, different value) are resolved by the
        // user's per-group choice; everything else runs through the exact-dup
        // filter so re-importing the same file adds nothing (no false trends).
        const groups = detectConflicts(data.measurements, measurements);
        conflictsResolved = groups.length;
        const conflictKeys = new Set(groups.map((g) => g.key));
        const nonConflicting = measurements.filter(
          (m) => !conflictKeys.has(conflictKeyForMeasurement(m)),
        );
        const { fresh, duplicates } = partitionDuplicates(data.measurements, nonConflicting);
        skipped = duplicates.length;

        const { add, removeExistingIds } = applyResolutions(
          groups,
          (g) => choices.get(g.key) ?? DEFAULT_CONFLICT_CHOICE,
        );
        // Drop stored measurements the user chose to replace (keep-new).
        if (removeExistingIds.length > 0) {
          const removeSet = new Set(removeExistingIds);
          data.measurements = data.measurements.filter((m) => !removeSet.has(m.id));
        }

        const toStore = [...fresh, ...add];
        added = toStore.length;
        // Record the import as a first-class entity and stamp each stored
        // measurement with its id — but only when something was actually added.
        if (toStore.length > 0) {
          const importId = ctx.newMeasurementId();
          const record = buildImportRecord({
            id: importId,
            importedAt: ctx.now(),
            pluginId: meta.pluginId ?? IMPORT_PLUGIN_ID,
            ...(sourceName ? { sourceName } : {}),
            ...(meta.fileName ? { fileName: meta.fileName } : {}),
            count: toStore.length,
          });
          data.imports = [...(data.imports ?? []), record];
          data.measurements.push(...stampImportId(toStore, importId));
          // Back-stamp this batch's importId onto the origin of each metric it
          // created (created before the id existed). Only metrics created in THIS
          // batch and still present are stamped, so an abandoned earlier review's
          // metrics are never claimed.
          if (pendingCreatedMetricIds.size > 0) {
            for (const metric of data.metrics) {
              if (
                pendingCreatedMetricIds.has(metric.id) &&
                metric.origin?.kind === 'import' &&
                metric.origin.importId === undefined
              ) {
                metric.origin = { ...metric.origin, importId };
              }
            }
          }
          // Persist a freshly created source only when its measurements landed.
          if (sourceToAdd && !data.sources.some((s) => s.id === sourceToAdd?.id)) {
            data.sources.push(sourceToAdd);
          }
        }
      });
      ctx.toast(
        conflictsResolved > 0
          ? ctx.t('review.importedWithConflicts', { count: added, conflicts: conflictsResolved })
          : skipped > 0
            ? ctx.t('review.importedWithDupes', { count: added, dupes: skipped })
            : ctx.t('review.imported', { count: added }),
        'success',
      );
      setPendingImport([]);
      ctx.navigate('overview');
    });
    commitWrap.append(countPill, commitBtn);

    footer.append(commitWrap);

    container.append(subtitle, conflictsSection, bannersSection, list, sourceControl, footer);

    function updateFooter(): void {
      const committable = toCommitList(state).length;
      countPill.textContent = formatNumber(committable);
      commitBtn.disabled = !canCommit(state);
      renderConflicts();
    }

    renderBanners();
    updateFooter();
  },
};

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface Row {
  element: HTMLElement;
  /** Rebuild the row from the current state (after a resolution/decision change). */
  refresh: () => void;
}

function buildRow(
  ctx: AppContext,
  state: ReviewItem[],
  index: number,
  onChange: () => void,
  refreshAll: () => void,
): Row {
  const element = el('li', 'review-item card');

  function refresh(): void {
    element.replaceChildren();
    const item = state[index];
    const p = item.proposed;

    // Header: metric name + (for a resolved row) the parser's read-confidence.
    // An unresolved row carries the "Nepřiřazeno" badge instead — a confidence
    // indicator there is meaningless (the metric itself isn't identified yet).
    const head = el('div', 'review-item-head');
    const name = el('span', 'review-metric');
    name.textContent = rowMetricName(ctx, item);
    head.append(name);
    if (isResolved(item)) head.append(confidenceEl(ctx, p.confidence));

    // Reading: operator + value + unit, then date.
    const reading = el('div', 'review-reading');
    reading.append(readingEl(ctx, p));
    const dateText = formatWhen(p);
    if (dateText) {
      const dateEl = el('span', 'review-date muted');
      dateEl.textContent = dateText;
      reading.append(dateEl);
    }

    element.append(head, reading);

    if (isResolved(item)) {
      element.classList.remove('review-item--unresolved');
      // "Belongs to a disabled pack" state: the metric resolved but is not
      // currently visible (its providing pack inactive). Only reachable when the
      // offer-hidden setting is on (the gate downgrades it otherwise). Offer to
      // activate the pack / show just this metric / create your own / skip.
      const resolvedMetric = ctx.catalog().byId(item.resolvedMetricId!);
      const hidden =
        resolvedMetric && getOfferHiddenMetrics(ctx)
          ? hiddenMetricState(ctx.data(), ctx.catalog(), resolvedMetric)
          : { hidden: false as const };
      if (resolvedMetric && hidden.hidden) {
        element.classList.add('review-item--hidden-pack');
        element.append(
          buildHiddenPack(
            ctx,
            state,
            index,
            resolvedMetric,
            hidden.suggestedPackId,
            refresh,
            refreshAll,
          ),
        );
        return;
      }
      element.classList.remove('review-item--hidden-pack');
      element.append(buildAcceptReject(ctx, state, index, onChange));
      // A row that was originally unresolved and has now been assigned: offer a way
      // back (a misclick must be reversible), and promise the mapping is learned on
      // import (not now) so re-importing the same name will match automatically.
      const orig = item.proposed.metric;
      if (typeof orig === 'object' && 'unresolvedName' in orig) {
        const foot = el('div', 'review-assigned-foot');
        const hint = el('p', 'muted review-alias-hint');
        hint.textContent = ctx.t('review.aliasLearnedHint');
        const change = button('review-change-metric', ctx.t('review.changeMetric'));
        change.addEventListener('click', () => {
          state[index].resolvedMetricId = undefined;
          state[index].decision = 'pending'; // back to unresolved → the picker returns
          refresh();
          onChange();
        });
        foot.append(hint, change);
        element.append(foot);
      }
    } else {
      element.classList.add('review-item--unresolved');
      element.append(buildResolver(ctx, state, index, refresh, onChange));
    }
  }

  refresh();
  return { element, refresh };
}

/** Accept/reject toggle for a resolved row (default accept). */
function buildAcceptReject(
  ctx: AppContext,
  state: ReviewItem[],
  index: number,
  onChange: () => void,
): HTMLElement {
  const group = el('div', 'review-decision');
  group.setAttribute('role', 'group');

  const acceptBtn = button('review-toggle', ctx.t('review.accept'));
  const rejectBtn = button('review-toggle', ctx.t('review.reject'));

  function sync(): void {
    const decided = state[index].decision;
    acceptBtn.setAttribute('aria-pressed', String(decided === 'accept'));
    rejectBtn.setAttribute('aria-pressed', String(decided === 'reject'));
  }

  acceptBtn.addEventListener('click', () => {
    // Guard mirrors the model: only resolved rows can be accepted.
    if (!canAccept(state[index])) return;
    state[index].decision = 'accept';
    sync();
    onChange();
  });
  rejectBtn.addEventListener('click', () => {
    state[index].decision = 'reject';
    sync();
    onChange();
  });

  sync();
  group.append(acceptBtn, rejectBtn);
  return group;
}

/**
 * Guided resolver for an unresolved row (spec §1): an "Unresolved" badge, up to
 * three intelligent suggestion chips (name + unit match), a search combobox
 * whose last row creates a metric from the raw name, and a single ghost "Reject
 * item". No always-expanded metric list, no competing "create" section.
 */
function buildResolver(
  ctx: AppContext,
  state: ReviewItem[],
  index: number,
  refresh: () => void,
  onChange: () => void,
): HTMLElement {
  const wrap = el('div', 'review-resolver');
  const item = state[index];
  const p = item.proposed;
  const rawName = 'unresolvedName' in p.metric ? p.metric.unresolvedName : '';

  const badge = el('span', 'pill review-unresolved');
  badge.textContent = ctx.t('review.unresolved');
  wrap.append(badge);

  // When rejected, reflect it but keep the controls available to change course.
  if (item.decision === 'reject') wrap.classList.add('review-resolver--rejected');

  /** Assign an existing catalog metric, then re-render the row as resolved. The
   *  raw-name→metric alias is NOT learned here: a review-time click is only a
   *  proposal. Learning happens at commit (see the commit handler), so a misclick
   *  that is changed or rejected before importing never teaches the catalog. */
  function assign(metric: Metric): void {
    state[index].resolvedMetricId = metric.id;
    state[index].decision = 'accept'; // resolved rows default to accept
    refresh();
    onChange();
  }

  /** Create a minimal user metric from the raw name + unit, then assign it. */
  function createAndAssign(name: string, unit: string): void {
    const label = name.trim();
    if (!label) return;
    let created: Metric | undefined;
    ctx.mutate(() => {
      created = ctx.catalog().addUserMetric({
        customName: label,
        aliases: [],
        category: 'custom',
        valueType: 'number',
        canonicalUnit: unit,
        units: unit ? [unit] : [],
        origin: { kind: 'import' },
      });
    });
    // Remember it so the batch's importId can be back-stamped onto its origin at
    // commit (the id does not exist yet). Survives navigating away and back.
    if (created) {
      pendingCreatedMetricIds.add(created.id);
      assign(created);
    }
  }

  // ---- Suggestions (0–3 chips) --------------------------------------------
  const chips = suggestMetrics(rawName, p.unit, ctx.catalog().all(), ctx.units, (k) =>
    ctx.t(k as StringKey),
  );
  if (chips.length > 0) {
    const suggestWrap = el('div', 'review-suggested');
    const label = el('span', 'review-field-label');
    label.textContent = ctx.t('review.suggested');
    const row = el('div', 'review-suggest-chips');
    const unitDisplay = p.unit ? (ctx.units.getUnit(p.unit)?.display ?? p.unit) : '';
    for (const metric of chips) {
      const unit = unitDisplay || (metric.canonicalUnit ? ctx.units.getUnit(metric.canonicalUnit)?.display ?? metric.canonicalUnit : '');
      const text = unit ? `${metricName(ctx, metric)} · ${unit}` : metricName(ctx, metric);
      const chip = button('tag-chip review-suggest-chip', text);
      chip.addEventListener('click', () => assign(metric));
      row.append(chip);
    }
    suggestWrap.append(label, row);
    wrap.append(suggestWrap);
  }

  // ---- Search combobox (with "+ Create '<raw>'" as its last row) ----------
  const searchLabel = el('label', 'review-field-label');
  const searchId = `review-assign-${index}`;
  searchLabel.setAttribute('for', searchId);
  searchLabel.textContent = ctx.t('review.resolve');
  wrap.append(searchLabel);

  // Inline quick-create form, revealed once when the create row is chosen.
  const createHost = el('div', 'review-create-host');

  function revealCreate(): void {
    if (createHost.firstChild) {
      (createHost.querySelector('input') as HTMLInputElement | null)?.focus();
      return;
    }
    const form = el('div', 'review-create');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'review-create-name';
    nameInput.setAttribute('aria-label', ctx.t('entry.newMetric'));
    nameInput.value = rawName; // prefilled, editable

    const unitInput = document.createElement('input');
    unitInput.type = 'text';
    unitInput.className = 'review-create-unit';
    unitInput.placeholder = ctx.t('entry.unitOptional');
    unitInput.setAttribute('aria-label', ctx.t('entry.unitOptional'));
    if (p.unit) unitInput.value = ctx.units.getUnit(p.unit)?.display ?? p.unit;

    const createBtn = button('review-create-btn', ctx.t('common.add'));
    createBtn.addEventListener('click', () => {
      // Normalize the typed unit back to a code when known; otherwise keep the
      // proposal's own unit (already a code) so the created metric stores it.
      const unit = p.unit ?? unitInput.value.trim();
      createAndAssign(nameInput.value, unit);
    });
    form.append(nameInput, unitInput, createBtn);
    createHost.append(form);
    nameInput.focus();
  }

  const picker = metricPicker({
    ctx,
    metricName: (m) => metricName(ctx, m),
    placeholder: ctx.t('entry.metricSearch'),
    ariaLabel: ctx.t('review.resolve'),
    inputId: searchId,
    maxResults: 6,
    showUnit: true,
    createLabel: () => ctx.t('review.createMetric', { name: rawName }),
    onPick: (m) => assign(m),
    onCreate: () => {
      // Collapse the dropdown (it is absolutely positioned and would overlap the
      // inline form) before revealing the quick-create.
      picker.input.value = '';
      picker.input.dispatchEvent(new Event('input'));
      revealCreate();
    },
  });
  // A direct "create this metric" action, so a user who already knows the metric
  // isn't in the catalog can skip searching the combobox entirely and go straight
  // to the (prefilled) quick-create.
  const createDirect = button('review-create-direct', ctx.t('review.createMetric', { name: rawName }));
  createDirect.addEventListener('click', revealCreate);
  wrap.append(picker.el, createDirect, createHost);

  // ---- Reject (single secondary action, footer-right) ---------------------
  const footer = el('div', 'review-resolver-footer');
  const rejectBtn = button('review-reject-item', ctx.t('review.rejectItem'));
  rejectBtn.setAttribute('aria-pressed', String(item.decision === 'reject'));
  rejectBtn.addEventListener('click', () => {
    state[index].decision = state[index].decision === 'reject' ? 'pending' : 'reject';
    refresh();
    onChange();
  });
  footer.append(rejectBtn);
  wrap.append(footer);

  return wrap;
}

/**
 * "Belongs to a disabled pack" state for a resolved row whose metric is hidden
 * (its providing pack inactive). Four exits (spec Fáze 4): activate the pack
 * (primary — reveals the whole category), show just this metric (force-show it
 * alone), create it as your own (a guarded two-step that spawns a user metric
 * and learns the incoming name as its alias), or skip (reject the row). Each
 * mutation re-renders the row: activating/showing makes the metric visible, so
 * the row falls back to the normal accept/reject; create repoints it to the new
 * user metric; skip drops it from the commit list.
 */
function buildHiddenPack(
  ctx: AppContext,
  state: ReviewItem[],
  index: number,
  metric: Metric,
  suggestedPackId: string | undefined,
  refresh: () => void,
  refreshAll: () => void,
): HTMLElement {
  const wrap = el('div', 'review-hidden-pack');
  const item = state[index];
  const mName = metricName(ctx, metric);
  const packName = suggestedPackId ? ctx.t(bundledPackNameKey(suggestedPackId)) : '';

  // Lead line: reads as a THIRD state (recognized but hidden), distinct from a
  // resolved row and from the "Unresolved" row. The calm accent left-border on
  // `.review-item--hidden-pack` carries the visual differentiation.
  const msg = el('p', 'review-hidden-pack-lead');
  msg.textContent = suggestedPackId
    ? ctx.t('review.hiddenPack', { metric: mName, pack: packName })
    : ctx.t('review.hiddenMetric', { metric: mName });
  wrap.append(msg);

  const actions = el('div', 'review-hidden-pack-actions');

  // Primary — activate the pack (reveals the whole category). Only when a pack
  // would reveal the metric. Re-renders EVERY row: activation normalizes them all.
  if (suggestedPackId) {
    const activate = button('review-hidden-activate primary', ctx.t('review.activatePack', { pack: packName }));
    activate.addEventListener('click', () => {
      ctx.mutate((d) => {
        activatePack(d, ctx.catalog(), suggestedPackId);
      });
      refreshAll();
    });
    actions.append(activate);
  }

  // Quieter secondary cluster: show just this / create your own (escape hatch) /
  // skip. Kept below the primary so the user isn't pushed toward a duplicate.
  const secondary = el('div', 'review-hidden-secondary');

  // Secondary — show just this metric (force-show without activating the pack).
  const showOne = button('review-hidden-show', ctx.t('review.showJustThis'));
  showOne.addEventListener('click', () => {
    ctx.mutate((d) => {
      const shown = d.settings.shownMetrics ?? [];
      if (!shown.includes(metric.id)) d.settings.shownMetrics = [...shown, metric.id];
    });
    refreshAll();
  });
  secondary.append(showOne);

  // Escape hatch — create as your own (guarded — the built-in already exists).
  const createOwn = button('review-hidden-create', ctx.t('review.createOwn'));
  createOwn.addEventListener('click', () => askCreateGuard());
  secondary.append(createOwn);

  // Skip — drop this row from the import.
  const skip = button('review-hidden-skip', ctx.t('review.skip'));
  skip.setAttribute('aria-pressed', String(item.decision === 'reject'));
  skip.addEventListener('click', () => {
    state[index].decision = 'reject';
    refreshAll();
  });
  secondary.append(skip);

  actions.append(secondary);
  wrap.append(actions);

  /** The incoming imported name: the raw unresolved name, else the metric name. */
  function incomingName(): string {
    const m = item.proposed.metric;
    return typeof m === 'object' && 'unresolvedName' in m ? m.unresolvedName : mName;
  }

  /** Two-step confirm before creating a user metric that shadows the built-in. */
  function askCreateGuard(): void {
    actions.replaceChildren();
    const q = el('p', 'review-hidden-guard-q muted');
    q.textContent = suggestedPackId
      ? ctx.t('review.createOwnConfirm', { metric: mName, pack: packName })
      : ctx.t('review.createOwnConfirmPlain', { metric: mName });
    const btns = el('div', 'review-hidden-guard-btns');
    const confirm = button('review-hidden-guard-yes primary', ctx.t('common.confirm'));
    confirm.addEventListener('click', () => createOwnMetric());
    const back = button('review-hidden-guard-no', ctx.t('common.back'));
    back.addEventListener('click', () => refresh()); // restore this row's actions
    btns.append(confirm, back);
    actions.append(q, btns);
  }

  /**
   * Create a user metric seeded from the built-in (same value type / units) with
   * the incoming name, stamp its import origin, learn the incoming name as its
   * alias, and repoint this row to it (accepted). Future imports of that name can
   * then reach the user's own metric.
   */
  function createOwnMetric(): void {
    const name = incomingName();
    let created: Metric | undefined;
    ctx.mutate(() => {
      created = ctx.catalog().addUserMetric({
        customName: name,
        aliases: [],
        category: 'custom',
        valueType: metric.valueType,
        canonicalUnit: metric.canonicalUnit,
        units: [...metric.units],
        origin: { kind: 'import' },
        ...(metric.enumValues ? { enumValues: [...metric.enumValues] } : {}),
      });
      ctx.catalog().learnAlias(created.id, name);
    });
    if (!created) return;
    pendingCreatedMetricIds.add(created.id);
    state[index].resolvedMetricId = created.id;
    state[index].decision = 'accept';
    refreshAll(); // the row repoints to a user metric → per-pack counts change
  }

  return wrap;
}

/**
 * Bulk "activate the pack for all N" banner (spec Fáze 4): shown once per disabled
 * pack that hides ≥2 resolved rows in this batch. One click activates the pack —
 * every row it covers re-resolves to a normal resolved row via {@link refreshAll}
 * (which also drops this banner, the pack now being active).
 */
function buildHiddenPackBanner(
  ctx: AppContext,
  packId: string,
  n: number,
  refreshAll: () => void,
): HTMLElement {
  const banner = el('div', 'review-hidden-banner');
  const packName = ctx.t(bundledPackNameKey(packId));
  const activate = button(
    'review-hidden-banner-btn primary',
    ctx.t('review.activatePackAll', { pack: packName, n }),
  );
  activate.addEventListener('click', () => {
    ctx.mutate((d) => {
      activatePack(d, ctx.catalog(), packId);
    });
    refreshAll();
  });
  banner.append(activate);
  return banner;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * One competing value inside a conflict card: its origin badge, the value+unit,
 * a provenance line, and which resolution choice its "keep this" button maps to.
 */
interface ConflictSide {
  badgeKey: StringKey;
  badgeParams?: Record<string, string | number>;
  /** Badge variant class suffix (styling only). */
  variant: 'new' | 'stored' | 'first' | 'second';
  m: Measurement;
  /** The choice selected when this side's "keep this" is pressed. */
  choice: ConflictChoice;
  /** Summary label shown once this side is the decision. */
  decidedKey: StringKey;
  /** Params for the summary label (e.g. the occurrence number). */
  decidedParams?: Record<string, string | number>;
  /** True for an already-stored value (adds import-record provenance). */
  isStored: boolean;
}

/** One competing incoming occurrence at index `i`, badge/choice/summary bound to it. */
function incomingSide(m: Measurement, i: number, kind: ConflictKind): ConflictSide {
  if (i === 0) {
    // The first occurrence: "keep this" behaves as keep-new (keep it, drop the
    // rest). Badge/summary wording differs by kind (a stored conflict speaks of
    // the "new" value; a within-import one of the "first").
    return kind === 'stored-vs-import'
      ? { badgeKey: 'review.conflictBadgeNew', variant: 'new', m, choice: 'keep-new', decidedKey: 'review.conflictDecidedNew', isStored: false }
      : { badgeKey: 'review.conflictBadgeFirst', variant: 'first', m, choice: 'keep-new', decidedKey: 'review.conflictDecidedFirst', isStored: false };
  }
  if (i === 1) {
    return {
      badgeKey: 'review.conflictBadgeSecond',
      variant: 'second',
      m,
      choice: 'keep-second',
      decidedKey: 'review.conflictDecidedSecond',
      isStored: false,
    };
  }
  // Third and beyond: bind "keep this" to this exact occurrence index so the
  // right value is kept (keep-new/keep-second only reach the first two slots).
  return {
    badgeKey: 'review.conflictBadgeNth',
    badgeParams: { n: i + 1 },
    variant: 'second',
    m,
    choice: keepIncoming(i),
    decidedKey: 'review.conflictDecidedNth',
    decidedParams: { n: i + 1 },
    isStored: false,
  };
}

/**
 * Build the ordered competing sides for a group, type-aware (§1b). N values in
 * one conflict render as one vertical block list — the pair (N=2) is just the
 * two-item case of it, no separate path (§3). A stored×import conflict shows the
 * stored value(s) FIRST (§1), then each incoming occurrence; an import×import
 * conflict lists the distinct incoming occurrences (no stored value exists). The
 * choice each side's "keep this" maps to binds the decision to the value.
 */
function conflictSides(group: ConflictGroup, kind: ConflictKind): ConflictSide[] {
  if (kind === 'stored-vs-import') {
    const sides: ConflictSide[] = group.existing.map((m) => ({
      badgeKey: 'review.conflictBadgeStored',
      variant: 'stored',
      m,
      choice: 'keep-existing',
      decidedKey: 'review.conflictDecidedStored',
      isStored: true,
    }));
    group.incoming.forEach((m, i) => sides.push(incomingSide(m, i, kind)));
    return sides;
  }
  // import×import: distinct incoming occurrences, no stored value exists.
  return group.incoming.map((m, i) => incomingSide(m, i, kind));
}

/** Index of the first incoming (non-stored) side — where the divider goes. */
function firstIncomingIndex(sides: readonly ConflictSide[]): number {
  const idx = sides.findIndex((s) => !s.isStored);
  return idx < 0 ? sides.length : idx;
}

/** Number of blocks shown before the ">4 values" collapse hides the rest. */
const CONFLICT_COLLAPSE_AFTER = 4;
const CONFLICT_COLLAPSE_VISIBLE = 3;

/**
 * One conflict group (§1): the metric + instant, then a vertical list of every
 * competing value block — each with an origin badge, the value+unit via the
 * shared formatter, a provenance line, and a "keep this" button. Stored value(s)
 * come first, separated by a divider from the import occurrences. Below the list
 * are the shared actions "keep all" and (with several incoming occurrences) "keep
 * the last from the import". A conflict with more than four blocks shows the
 * first three and reveals the rest inline via a "show more" row (no inner
 * scroll). After a choice the card collapses to a decision summary with a Change
 * control (§1c). The chosen value is written into `choices` (default keep-new).
 */
function buildConflictCard(
  ctx: AppContext,
  group: ConflictGroup,
  choices: Map<string, ConflictChoice>,
  onChange: () => void,
): HTMLElement {
  const kind = conflictKind(group);
  const card = el('div', 'review-conflict card');

  const head = el('div', 'review-conflict-head');
  const metric = ctx.catalog().byId(group.metricId);
  const name = el('span', 'review-conflict-metric');
  name.textContent = metric ? metricName(ctx, metric) : group.metricId;
  const when = el('span', 'review-conflict-when muted');
  when.textContent = formatDateTime(group.takenAt, group.timePrecision);
  head.append(name, when);
  card.append(head);

  const sides = conflictSides(group, kind);

  // Decided → collapsed summary with a Change control (§1c).
  const decided = choices.get(group.key);
  if (decided !== undefined) {
    card.classList.add('review-conflict--decided');
    card.append(decisionSummary(ctx, group, sides, decided, choices, onChange));
    return card;
  }

  // Undecided → the block list, each block with its own "keep this". N=2 is the
  // two-block case of the same list — no separate path (§3).
  const list = el('div', 'review-conflict-pair');
  if (sides.length > 2) list.classList.add('review-conflict-pair--stacked');
  const dividerAt = firstIncomingIndex(sides);
  const collapse = sides.length > CONFLICT_COLLAPSE_AFTER;

  sides.forEach((side, i) => {
    // A subtle divider between the stored block(s) and the import occurrences.
    if (i === dividerAt && dividerAt > 0) list.append(el('div', 'review-conflict-divider'));
    const block = sideBlock(ctx, group, side, choices, onChange);
    if (collapse && i >= CONFLICT_COLLAPSE_VISIBLE) block.hidden = true;
    list.append(block);
  });
  card.append(list);

  // ">4 values": reveal the hidden blocks inline (the card grows into the page).
  if (collapse) {
    const hiddenCount = sides.length - CONFLICT_COLLAPSE_VISIBLE;
    const showMore = button('review-conflict-show-more', ctx.t('review.showMore', { n: hiddenCount }));
    showMore.addEventListener('click', () => {
      for (const b of list.querySelectorAll<HTMLElement>('.review-conflict-block[hidden]')) {
        b.hidden = false;
      }
      showMore.remove();
    });
    card.append(showMore);
  }

  // Shared actions: keep all, and (only when several import occurrences compete)
  // keep the last one in file order — the common reimport case.
  const actions = el('div', 'review-conflict-actions');
  const keepAllLabel =
    sides.length > 2 ? ctx.t('review.keepAll', { n: sides.length }) : ctx.t('review.conflictKeepBoth');
  const keepAll = button('review-conflict-btn review-conflict-keep-both', keepAllLabel);
  keepAll.addEventListener('click', () => {
    choices.set(group.key, 'keep-both');
    onChange();
  });
  actions.append(keepAll);

  if (group.incoming.length >= 2) {
    const keepLatest = button('review-conflict-btn review-conflict-keep-latest', ctx.t('review.keepLatest'));
    keepLatest.addEventListener('click', () => {
      choices.set(group.key, 'keep-latest');
      onChange();
    });
    actions.append(keepLatest);
  }
  card.append(actions);

  return card;
}

/**
 * Header for a metric with more than one conflict (§2): "{metric} — {n}
 * conflicts" plus bulk ghost actions. A bulk action is a two-step inline confirm
 * and applies only to the metric's still-undecided conflicts, so a card the user
 * already decided keeps its choice. A lone conflict gets no header.
 */
function buildMetricGroupHeader(
  ctx: AppContext,
  metricGroup: MetricConflictGroup,
  choices: Map<string, ConflictChoice>,
  onChange: () => void,
): HTMLElement {
  const header = el('div', 'review-conflict-group');
  const metric = ctx.catalog().byId(metricGroup.metricId);
  const metricLabel = metric ? metricName(ctx, metric) : metricGroup.metricId;
  const n = metricGroup.groups.length;

  const title = el('span', 'review-conflict-group-title');
  title.textContent = plural(
    n,
    { one: 'review.groupConflictsOne', few: 'review.groupConflictsFew', many: 'review.groupConflictsMany' },
    { metric: metricLabel, n },
  );

  const actions = el('div', 'review-conflict-group-actions');
  header.append(title, actions);

  const keys = metricGroup.groups.map((g) => g.key);
  const hasStored = metricGroup.groups.some((g) => g.existing.length > 0);

  function renderActions(): void {
    actions.replaceChildren();
    const keepNew = button('review-bulk-btn review-bulk-keep-new', ctx.t('review.bulkKeepNew'));
    keepNew.addEventListener('click', () => askConfirm('keep-new'));
    actions.append(keepNew);
    if (hasStored) {
      const keepStored = button('review-bulk-btn review-bulk-keep-stored', ctx.t('review.bulkKeepStored'));
      keepStored.addEventListener('click', () => askConfirm('keep-existing'));
      actions.append(keepStored);
    }
  }

  function askConfirm(choice: ConflictChoice): void {
    actions.replaceChildren();
    const undecided = keys.filter((k) => !choices.has(k)).length;
    const question = el('span', 'review-bulk-confirm-q muted');
    question.textContent = plural(
      undecided,
      { one: 'review.bulkConfirmOne', few: 'review.bulkConfirmFew', many: 'review.bulkConfirmMany' },
      { n: undecided },
    );
    const yes = button('review-bulk-btn review-bulk-confirm-yes', ctx.t('common.confirm'));
    yes.addEventListener('click', () => {
      bulkDecideUndecided(keys, choices, choice);
      onChange();
    });
    const no = button('review-bulk-btn review-bulk-confirm-no', ctx.t('common.back'));
    no.addEventListener('click', renderActions);
    actions.append(question, yes, no);
  }

  renderActions();
  return header;
}

/** One competing-value block: badge, value+unit, provenance, "keep this". */
function sideBlock(
  ctx: AppContext,
  group: ConflictGroup,
  side: ConflictSide,
  choices: Map<string, ConflictChoice>,
  onChange: () => void,
): HTMLElement {
  const block = el('div', `review-conflict-block review-conflict-block--${side.variant}`);

  const badge = el('span', 'pill review-conflict-badge');
  badge.textContent = ctx.t(side.badgeKey, side.badgeParams);
  block.append(badge);

  block.append(conflictValueEl(ctx, side.m, true));

  const prov = provenanceEl(ctx, side.m, side.isStored);
  if (prov) block.append(prov);

  const keep = button('review-conflict-btn review-conflict-keep-this', ctx.t('review.conflictKeepThis'));
  keep.addEventListener('click', () => {
    choices.set(group.key, side.choice);
    onChange();
  });
  block.append(keep);
  return block;
}

/** Collapsed decision summary: which side was kept + its value + Change. */
function decisionSummary(
  ctx: AppContext,
  group: ConflictGroup,
  sides: ConflictSide[],
  choice: ConflictChoice,
  choices: Map<string, ConflictChoice>,
  onChange: () => void,
): HTMLElement {
  const wrap = el('div', 'review-conflict-summary');

  const label = el('span', 'review-conflict-decided-label');
  const values = el('span', 'review-conflict-decided-values');
  if (choice === 'keep-both') {
    if (sides.length > 2) {
      // Many values kept: name the count rather than listing every reading.
      label.textContent = ctx.t('review.conflictDecidedAll');
      const count = el('span');
      count.textContent = plural(
        sides.length,
        {
          one: 'review.conflictValueCountOne',
          few: 'review.conflictValueCountFew',
          many: 'review.conflictValueCountMany',
        },
        { count: sides.length },
      );
      values.append(count);
    } else {
      label.textContent = ctx.t('review.conflictDecidedBoth');
      sides.forEach((side, i) => {
        if (i > 0) values.append(document.createTextNode(', '));
        values.append(conflictValueEl(ctx, side.m, false));
      });
    }
  } else if (choice === 'keep-latest') {
    // The last incoming occurrence in file order.
    label.textContent = ctx.t('review.conflictDecidedLatest');
    values.append(conflictValueEl(ctx, group.incoming[group.incoming.length - 1], false));
  } else {
    const side = sides.find((s) => s.choice === choice) ?? sides[0];
    label.textContent = ctx.t(side.decidedKey, side.decidedParams);
    values.append(conflictValueEl(ctx, side.m, false));
  }
  wrap.append(label, document.createTextNode(' · '), values);

  // Reopening drops the recorded decision, returning the card to the pair view.
  const change = button('review-conflict-change', ctx.t('review.conflictChange'));
  change.addEventListener('click', () => {
    choices.delete(group.key);
    onChange();
  });
  wrap.append(change);
  return wrap;
}

/** Value+unit element for a competing value (numeric via formatter, else text). */
function conflictValueEl(ctx: AppContext, m: Measurement, emphasis: boolean): HTMLElement {
  if (m.value === undefined) {
    const span = el('span', 'review-conflict-reading');
    span.textContent = measurementText(m) ?? '';
    return span;
  }
  const unit = m.unit ? ctx.units.getUnit(m.unit)?.display ?? m.unit : undefined;
  return valueWithUnitEl({
    value: m.value,
    ...(unit ? { unit } : {}),
    ...(m.operator ? { operator: m.operator } : {}),
    emphasis,
    wrapClass: 'review-conflict-reading',
  });
}

/**
 * Provenance line under a competing value (§1a): the original text from the file
 * (`origin.rawText`) — what tells two same-file values apart — plus, for a stored
 * value, its originating import's source · date. Returns undefined when there is
 * nothing to show.
 */
function provenanceEl(ctx: AppContext, m: Measurement, isStored: boolean): HTMLElement | undefined {
  const lines: string[] = [];
  const raw = m.origin?.rawText?.trim();
  if (raw) lines.push(raw);
  if (isStored) {
    const records = ctx.data().imports ?? [];
    const rec = m.importId ? records.find((r) => r.id === m.importId) : undefined;
    if (rec) {
      const source = rec.fileName ?? rec.sourceName ?? rec.pluginId;
      lines.push(ctx.t('review.conflictProvenance', { source, date: formatDateTime(rec.importedAt, 'date') }));
    }
  }
  if (lines.length === 0) return undefined;
  const prov = el('div', 'review-conflict-prov muted');
  for (const line of lines) {
    const span = el('span');
    span.textContent = line;
    prov.append(span);
  }
  return prov;
}

/** Progress dots for the conflicts header: filled = resolved, with an a11y label. */
function conflictProgressEl(ctx: AppContext, done: number, total: number): HTMLElement {
  const span = el('span', 'review-conflicts-progress');
  span.textContent = '●'.repeat(done) + '○'.repeat(Math.max(0, total - done));
  const label = ctx.t('review.conflictResolved', { done, total });
  span.title = label;
  span.setAttribute('aria-label', label);
  return span;
}

// ---------------------------------------------------------------------------
// Source attribution
// ---------------------------------------------------------------------------

/**
 * Seed the source selection from the batch's stamped source name and originating
 * plugin id: reuse a matching existing source, propose creating a new one, or
 * none.
 */
function initialSourceSelection(
  sources: readonly Source[],
  sourceName: string | undefined,
  pluginId: string | undefined,
): SourceSelection {
  const suggestion = suggestSource(sources, sourceName, pluginId);
  if (suggestion.mode === 'existing') return { mode: 'existing', sourceId: suggestion.sourceId };
  if (suggestion.mode === 'new') return { mode: 'new', name: suggestion.name, kind: suggestion.kind };
  return { mode: 'none' };
}

/**
 * Compact source control near the commit footer: a labelled shared source picker
 * to keep the suggestion, pick an existing source, create a new one, or choose
 * none. The `.review-source-*` class hooks are preserved for styling and tests.
 * Returns the section to mount and the picker to read at commit time.
 */
function buildSourceControl(
  ctx: AppContext,
  initial: SourceSelection,
): { section: HTMLElement; picker: SourcePicker } {
  const section = el('section', 'review-source');

  const selectId = 'review-source-select';
  const label = el('label', 'review-field-label');
  label.setAttribute('for', selectId);
  label.textContent = ctx.t('review.source');

  const picker = sourcePicker(ctx, {
    initial,
    emptyMode: 'none',
    emptyLabel: ctx.t('review.sourceNone'),
    newLabel: `${ctx.t('review.sourceNew')}…`,
    namePlaceholder: ctx.t('settings.sourceName'),
    nameAriaLabel: ctx.t('review.sourceNew'),
    kindAriaLabel: ctx.t('settings.sourceKind'),
    selectAriaLabel: ctx.t('review.source'),
    selectId,
    selectClass: 'review-source-select',
    newFormClass: 'review-source-new',
    nameInputClass: 'review-source-name',
    kindSelectClass: 'review-source-kind',
  });

  section.append(label, picker.el);
  return { section, picker };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Display name of an item's metric: resolved catalog metric, or source name. */
function rowMetricName(ctx: AppContext, item: ReviewItem): string {
  if (item.resolvedMetricId) {
    const metric = ctx.catalog().byId(item.resolvedMetricId);
    if (metric) return metricName(ctx, metric);
  }
  const m = item.proposed.metric;
  return 'unresolvedName' in m ? m.unresolvedName : '';
}

/** Metric display name: i18n key for built-ins, custom name for user metrics. */
function metricName(ctx: AppContext, metric: Metric): string {
  if (metric.customName) return metric.customName;
  if (metric.nameKey) return ctx.t(metric.nameKey as StringKey);
  return metric.key ?? '';
}

/** Value+unit element for a proposed measurement (numeric via formatter, else text). */
function readingEl(ctx: AppContext, p: ProposedMeasurement): HTMLElement {
  if (p.value === undefined) {
    const span = el('span', 'review-value');
    span.textContent = measurementText(p) ?? ''; // qualitative proposal
    return span;
  }
  const unit = p.unit ? ctx.units.getUnit(p.unit)?.display ?? p.unit : undefined;
  return valueWithUnitEl({
    value: p.value,
    ...(unit ? { unit } : {}),
    ...(p.operator ? { operator: p.operator } : {}),
    valueClass: 'review-value',
  });
}

/** Localised date/time, or empty when the proposal carried no timestamp. */
function formatWhen(p: ProposedMeasurement): string {
  if (!p.takenAt) return '';
  const precision: TimePrecision =
    p.timePrecision ?? (p.takenAt.includes('T') ? 'datetime' : 'date');
  return formatDateTime(p.takenAt, precision);
}

/**
 * Confidence indicator. No i18n keys exist for the level words (high/medium/
 * low), so the level is shown as filled/empty dots rather than invented copy;
 * `review.confidence` labels it for assistive tech.
 */
function confidenceEl(ctx: AppContext, level: 'high' | 'medium' | 'low'): HTMLElement {
  const filled = level === 'high' ? 3 : level === 'medium' ? 2 : 1;
  const span = el('span', `pill review-confidence review-confidence--${level}`);
  span.textContent = '●'.repeat(filled) + '○'.repeat(3 - filled);
  // Level-specific label so the dots explain themselves (e.g. a low reading is
  // usually an unrecognized unit / incomplete row), rather than a bare "Confidence".
  const key: StringKey =
    level === 'high'
      ? 'review.confidenceHigh'
      : level === 'medium'
        ? 'review.confidenceMedium'
        : 'review.confidenceLow';
  span.title = ctx.t(key);
  span.setAttribute('aria-label', ctx.t(key));
  return span;
}


// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function button(className: string, text: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = text;
  return btn;
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
