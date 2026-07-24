/**
 * Chart renderer (K8e, DOM layer) — turns a pure ChartModel into SVG.
 *
 * No calculations live here (spec §1): the model already carries every pixel
 * coordinate, tick and band rectangle. This module only creates SVG nodes in
 * the SVG namespace, formats tick labels via i18n (locale-aware) and wires the
 * hover/tap tooltip. Semantic text (metric name, "change", "source", range
 * words) is supplied by the view through `handlers`, so this file stays free
 * of hardcoded UI strings.
 */

import { formatDateTime, formatNumber } from '../i18n/index';
import type { ChartModel, ChartModelPoint } from './chart-model';
import './chart.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ChartHandlers {
  /** Accessible summary for the whole chart (role="img" aria-label). */
  ariaLabel?: string;
  /** Tooltip rows for a hovered/tapped point (already localized by the view). */
  tooltip?: (point: ChartModelPoint, index: number) => string[];
  /**
   * In-band caption drawn inside the first reference band (e.g. "referenční
   * rozmezí 3,9–5,6"). Already localized by the view so this module stays
   * translation-free; omit it to draw no caption.
   */
  bandLabel?: string;
}

/** Monotonic counter for per-chart gradient ids (several charts can coexist). */
let gradientSeq = 0;

/** Create an SVG element in the correct namespace with attributes applied. */
function svg(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

/** Format an X tick. Milliseconds → a date label at the axis granularity. */
function formatXTick(ms: number): string {
  return formatDateTime(new Date(ms).toISOString(), 'date');
}

/**
 * Render `model` into `container`. Rebuilds the container's contents on every
 * call (the view drives re-render on resize / unit / period changes).
 */
export function renderChart(
  container: HTMLElement,
  model: ChartModel,
  handlers: ChartHandlers = {},
): void {
  container.replaceChildren();
  container.classList.add('chart');
  // Anchor the absolutely-positioned tooltip to the container.
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const { width, height, plot } = model;
  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    height,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    class: 'chart-svg',
  });
  if (handlers.ariaLabel) root.setAttribute('aria-label', handlers.ariaLabel);

  if (model.isEmpty) {
    container.append(root);
    return;
  }

  const plotBottom = plot.y + plot.height;
  const plotRight = plot.x + plot.width;

  // --- Defs: area gradient (accent 0.18 → 0), unique per chart -----------
  gradientSeq += 1;
  const areaGradientId = `chart-area-${gradientSeq}`;
  const defs = svg('defs');
  const gradient = svg('linearGradient', { id: areaGradientId, x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(
    svg('stop', { class: 'chart-area-stop-top', offset: '0%' }),
    svg('stop', { class: 'chart-area-stop-bottom', offset: '100%' }),
  );
  defs.append(gradient);
  root.append(defs);

  // --- Layer 1: reference-range bands -----------------------------------
  const bandGroup = svg('g', { class: 'chart-bands' });
  for (const band of model.bands) {
    bandGroup.append(
      svg('rect', {
        class: 'chart-band',
        x: band.x,
        y: band.y,
        width: band.width,
        height: band.height,
        rx: 6,
      }),
    );
  }
  // An in-band caption over the first band (localized text supplied by view).
  const firstBand = model.bands[0];
  if (handlers.bandLabel && firstBand) {
    const caption = svg('text', {
      class: 'chart-band-label',
      x: firstBand.x + 6,
      y: firstBand.y + 12,
    });
    caption.textContent = handlers.bandLabel;
    bandGroup.append(caption);
  }
  root.append(bandGroup);

  // --- Gridlines (faint, at Y ticks) ------------------------------------
  const gridGroup = svg('g', { class: 'chart-grid' });
  for (const tick of model.yTicks) {
    gridGroup.append(
      svg('line', {
        class: 'chart-gridline',
        x1: plot.x,
        y1: tick.pos,
        x2: plotRight,
        y2: tick.pos,
      }),
    );
  }
  root.append(gridGroup);

  // --- Axes (labels only — no frame, no tick marks) ---------------------
  const axisGroup = svg('g', { class: 'chart-axis' });

  for (const tick of model.yTicks) {
    const label = svg('text', {
      class: 'chart-tick-label chart-tick-y',
      x: plot.x - 6,
      y: tick.pos,
    });
    label.textContent = formatNumber(tick.value);
    axisGroup.append(label);
  }

  for (const tick of model.xTicks) {
    const label = svg('text', {
      class: 'chart-tick-label chart-tick-x',
      x: tick.pos,
      y: plotBottom + 8,
    });
    label.textContent = formatXTick(tick.value);
    axisGroup.append(label);
  }

  // Y-axis unit label.
  if (model.unitLabel) {
    const unit = svg('text', { class: 'chart-unit-label', x: plot.x - 6, y: plot.y - 4 });
    unit.textContent = model.unitLabel;
    axisGroup.append(unit);
  }
  root.append(axisGroup);

  // --- Layer 2: area fill + connecting polyline -------------------------
  if (model.points.length > 1) {
    const first = model.points[0];
    const last = model.points[model.points.length - 1];
    const areaPath =
      `M${first.cx.toFixed(2)},${first.cy.toFixed(2)} ` +
      model.points
        .slice(1)
        .map((p) => `L${p.cx.toFixed(2)},${p.cy.toFixed(2)}`)
        .join(' ') +
      ` L${last.cx.toFixed(2)},${plotBottom.toFixed(2)}` +
      ` L${first.cx.toFixed(2)},${plotBottom.toFixed(2)} Z`;
    root.append(svg('path', { class: 'chart-area', d: areaPath, fill: `url(#${areaGradientId})` }));
    root.append(svg('polyline', { class: 'chart-line', points: model.polyline }));
  }

  // --- Layer 3: points (shape differs for out-of-range / censored) ------
  const pointGroup = svg('g', { class: 'chart-points' });
  const tooltip = createTooltip(container);

  const lastIndex = model.points.length - 1;
  model.points.forEach((p, index) => {
    const node = createPointNode(p, index === lastIndex);
    // A generous, invisible hit target for hover/tap.
    const hit = svg('circle', { class: 'chart-hit', cx: p.cx, cy: p.cy, r: 14 });
    const show = (): void => showTooltip(tooltip, container, model, p, index, handlers);
    const hide = (): void => hideTooltip(tooltip);
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('pointerdown', show);
    pointGroup.append(node, hit);
  });
  root.append(pointGroup);

  container.append(root);
}

// ---------------------------------------------------------------------------
// Point shapes
// ---------------------------------------------------------------------------

function rangeClass(p: ChartModelPoint): string {
  if (p.rangePosition === 'above') return ' chart-point--above';
  if (p.rangePosition === 'below') return ' chart-point--below';
  return '';
}

/**
 * A point's mark. Shape (not colour alone) encodes state:
 *  - in-range:  filled circle
 *  - out-of-range: filled diamond (rotated square)
 *  - censored (operator): open circle plus a direction arrow (< down, > up)
 */
function createPointNode(p: ChartModelPoint, isLast: boolean): SVGElement {
  if (p.operator !== undefined) {
    return createCensoredNode(p);
  }
  if (p.outOfRange) {
    return createDiamondNode(p);
  }
  const cls = isLast ? 'chart-point chart-point--last' : 'chart-point';
  return svg('circle', { class: cls, cx: p.cx, cy: p.cy, r: isLast ? 5 : 4 });
}

function createDiamondNode(p: ChartModelPoint): SVGElement {
  const r = 4.5;
  const points = `${p.cx},${p.cy - r} ${p.cx + r},${p.cy} ${p.cx},${p.cy + r} ${p.cx - r},${p.cy}`;
  return svg('polygon', { class: `chart-point chart-point--out${rangeClass(p)}`, points });
}

function createCensoredNode(p: ChartModelPoint): SVGElement {
  const group = svg('g', { class: `chart-point chart-point--censored${rangeClass(p)}` });
  group.append(svg('circle', { class: 'chart-point-open', cx: p.cx, cy: p.cy, r: 3.5 }));
  // Arrow points toward the region the true value lies in.
  const up = p.operator === '>' || p.operator === '>=';
  const dy = up ? -1 : 1;
  const tipY = p.cy + dy * 9;
  const baseY = p.cy + dy * 4;
  group.append(
    svg('line', { class: 'chart-arrow', x1: p.cx, y1: baseY, x2: p.cx, y2: tipY }),
    svg('polyline', {
      class: 'chart-arrow',
      points: `${p.cx - 2.5},${tipY - dy * 2.5} ${p.cx},${tipY} ${p.cx + 2.5},${tipY - dy * 2.5}`,
    }),
  );
  return group;
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function createTooltip(container: HTMLElement): HTMLElement {
  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  tip.setAttribute('role', 'status');
  tip.hidden = true;
  container.append(tip);
  return tip;
}

function defaultTooltipLines(p: ChartModelPoint, unitLabel: string): string[] {
  const prefix = p.operator !== undefined ? `${p.operator} ` : '';
  return [
    formatXTick(p.t),
    `${prefix}${formatNumber(p.value)} ${unitLabel}`.trim(),
  ];
}

function showTooltip(
  tip: HTMLElement,
  container: HTMLElement,
  model: ChartModel,
  p: ChartModelPoint,
  index: number,
  handlers: ChartHandlers,
): void {
  const lines = handlers.tooltip?.(p, index) ?? defaultTooltipLines(p, model.unitLabel);
  tip.replaceChildren();
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'chart-tooltip-row';
    row.textContent = line;
    tip.append(row);
  }
  tip.hidden = false;

  // Position within the container, scaling the model's SVG-space cx/cy to the
  // rendered pixel size, and clamp so the tooltip never leaves the container.
  const cw = container.clientWidth || model.width;
  const scale = cw / model.width;
  const px = p.cx * scale;
  const py = p.cy * scale;

  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = px + 10;
  if (left + tw > cw) left = px - tw - 10;
  if (left < 0) left = Math.max(0, Math.min(px, cw - tw));
  let top = py - th - 8;
  if (top < 0) top = py + 12;

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTooltip(tip: HTMLElement): void {
  tip.hidden = true;
}
