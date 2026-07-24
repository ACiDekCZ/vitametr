/**
 * Shared interactive tag-filter chip (redesign IA, screen 7). Replaces the
 * per-view copies (`.export-tag-chip`, `.metrics-tag-chip`) with one `.tag-chip`
 * button; the active chip carries `.is-active` + `aria-current`. Styling lives in
 * `.tag-chip` (styles.css). The non-interactive row label variant is a plain
 * `<span class="tag-chip tag-chip--mini">` and does not use this helper.
 */

export interface TagChipOptions {
  /** Visible chip label. */
  label: string;
  /** Whether this chip is the active filter. */
  isActive: boolean;
  /** Called when the chip is clicked. */
  onToggle: () => void;
  /** Prepend a small star glyph (the "watched" filter chip). */
  star?: boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function tagChip(opts: TagChipOptions): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = opts.star ? 'tag-chip tag-chip--star' : 'tag-chip';
  if (opts.star) b.append(starGlyph());
  const text = document.createElement('span');
  text.textContent = opts.label;
  b.append(text);
  if (opts.isActive) {
    b.classList.add('is-active');
    b.setAttribute('aria-current', 'true');
  }
  b.addEventListener('click', opts.onToggle);
  return b;
}

/** A small filled star for the "watched" chip. */
function starGlyph(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'tag-chip-star');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z',
  );
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}
