/**
 * Shared metric picker combobox.
 *
 * A closed text input whose dropdown fills as you type: matching catalog metrics
 * (name, optionally with a muted unit) followed by a final "create" row that
 * offers to make a new metric from the current query. Extracted from the entry
 * view so the import-review "Unresolved" card reuses the exact same interaction
 * (spec §1.3, §2). DOM-only glue; the search/resolve logic lives in the DOM-free
 * `entry-model`. Every user string comes from the caller (already localized).
 *
 * The component is stateless across renders: pick/create fire callbacks and the
 * caller re-renders. Live typing is handled internally (the dropdown rebuilds on
 * input) so a re-render is only needed once a choice is made.
 */

import type { AppContext } from '../app-context';
import type { Metric } from '../../core/types';
import { filterMetrics, resolveMetricSelection } from '../views/entry-model';
import './metric-picker.css';

export interface MetricPickerOptions {
  ctx: AppContext;
  /** Display name of a metric (locale-aware; supplied by the caller). */
  metricName: (metric: Metric) => string;
  /** Input placeholder. */
  placeholder: string;
  /** Accessible label for the input. */
  ariaLabel: string;
  /** DOM id for the input (so a `<label for>` can point at it). */
  inputId?: string;
  /** Initial input text (empty for a closed combobox). */
  value?: string;
  /** Max metric rows before the create row (default 8). */
  maxResults?: number;
  /** Extra class on the wrapper (in addition to `metric-picker`). */
  wrapClass?: string;
  /** Show a muted unit after each metric row (review card); off keeps entry identical. */
  showUnit?: boolean;
  /** Label for the final create row, given the current query. */
  createLabel: (query: string) => string;
  /** Called when a catalog metric is chosen. */
  onPick: (metric: Metric) => void;
  /** Called when the create row is chosen (query = current input text). */
  onCreate: (query: string) => void;
  /** Optional per-keystroke hook (e.g. to mirror the query into caller state). */
  onInput?: (query: string) => void;
}

export interface MetricPicker {
  /** The wrapper element (input + dropdown) to mount. */
  el: HTMLElement;
  /** The input, exposed so the caller can focus it. */
  input: HTMLInputElement;
}

/** Display unit for a metric's canonical unit, or undefined when it has none. */
function unitLabel(ctx: AppContext, metric: Metric): string | undefined {
  const code = metric.canonicalUnit;
  if (!code) return undefined;
  return ctx.units.getUnit(code)?.display ?? code;
}

export function metricPicker(opts: MetricPickerOptions): MetricPicker {
  const { ctx, metricName } = opts;
  const max = opts.maxResults ?? 8;

  const wrap = document.createElement('div');
  wrap.className = opts.wrapClass ? `metric-picker ${opts.wrapClass}` : 'metric-picker';

  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = opts.placeholder;
  input.setAttribute('aria-label', opts.ariaLabel);
  if (opts.inputId) input.id = opts.inputId;
  if (opts.value) input.value = opts.value;

  const suggestions = document.createElement('ul');
  suggestions.className = 'metric-suggestions';

  function rebuild(): void {
    suggestions.replaceChildren();
    const q = input.value.trim();
    if (q === '') return; // closed until the user types

    for (const metric of filterMetrics(q, ctx.catalog(), metricName, max)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const label = document.createElement('span');
      label.textContent = metricName(metric);
      btn.append(label);
      if (opts.showUnit) {
        const unit = unitLabel(ctx, metric);
        if (unit) {
          const u = document.createElement('span');
          u.className = 'metric-suggestion-unit muted';
          u.textContent = unit;
          btn.append(u);
        }
      }
      // mousedown (not click) so the choice lands before the input blurs.
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        opts.onPick(metric);
      });
      const li = document.createElement('li');
      li.append(btn);
      suggestions.append(li);
    }

    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'sugg-new';
    createBtn.textContent = opts.createLabel(q);
    createBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      opts.onCreate(q);
    });
    const li = document.createElement('li');
    li.append(createBtn);
    suggestions.append(li);
  }

  input.addEventListener('input', () => {
    opts.onInput?.(input.value);
    rebuild();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = input.value.trim();
    if (q === '') return;
    const resolved = resolveMetricSelection(q, ctx.catalog());
    if ('metricId' in resolved) {
      const metric = ctx.catalog().byId(resolved.metricId);
      if (metric) opts.onPick(metric);
    } else {
      opts.onCreate(q);
    }
  });

  wrap.append(input, suggestions);
  return { el: wrap, input };
}
