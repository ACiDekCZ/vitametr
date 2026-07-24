/**
 * Watch (favorite) star toggle — the quick control for the reserved
 * {@link WATCHED_TAG}. Shared by the overview tiles + list rows, the metric
 * detail header, and the Metrics page rows, so all sites behave identically.
 *
 * The star is a real `<button>` with a ≥44×44 hit area. On a click it flips the
 * metric's watched tag inside `ctx.mutate` (add / remove {@link WATCHED_TAG}) and
 * stops propagation, so a star that sits ON a clickable card/row never also
 * triggers the card's navigation. The current state is read fresh from the
 * catalog on each click, so repeated toggles stay correct after a mutation.
 */

import type { AppContext } from '../app-context';
import type { Metric } from '../../core/types';
import { WATCHED_TAG, isWatched } from '../../core/tags';
import './watch-star.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface WatchStarOptions {
  ctx: AppContext;
  metric: Metric;
  /** Extra class for site-specific sizing/placement (e.g. `watch-star--tile`). */
  variant?: string;
  /** Called after a toggle commits, with the new watched state (repaint hook). */
  onToggle?: (watched: boolean) => void;
}

export function watchStar(opts: WatchStarOptions): HTMLButtonElement {
  const { ctx, metric } = opts;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = opts.variant ? `watch-star ${opts.variant}` : 'watch-star';
  btn.setAttribute('aria-label', ctx.t('metric.watchToggle'));

  const apply = (on: boolean): void => {
    btn.classList.toggle('is-watched', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.replaceChildren(starIcon(on));
  };
  apply(isWatched(metric));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const current = ctx.catalog().byId(metric.id) ?? metric;
    const next = !isWatched(current);
    ctx.mutate(() => {
      if (next) ctx.catalog().addTag(metric.id, WATCHED_TAG);
      else ctx.catalog().removeTag(metric.id, WATCHED_TAG);
    });
    apply(next);
    opts.onToggle?.(next);
  });

  return btn;
}

/** A five-point star: filled when watched, outline (stroke only) when idle. */
function starIcon(filled: boolean): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'watch-star-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z',
  );
  path.setAttribute('fill', filled ? 'currentColor' : 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}
