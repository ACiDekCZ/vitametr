/**
 * Shared Zadat · Import · Export segmented switcher. All three are first-class
 * data routes; this pill sits at the top of the entry, import and export pages
 * and navigates between them (the routes stay separate — deep links and the
 * review flow are unchanged, the strip only switches which one is shown). It
 * mirrors the other segmented controls (container `--surface-2`, active = white
 * pill + shadow). The active tab is inert (no navigation to self); the others
 * call `ctx.navigate`.
 */

import type { AppContext } from '../app-context';
import type { DataRoute } from '../data-nav';
import type { StringKey } from '../../i18n/index';

const TABS: readonly { route: DataRoute; labelKey: StringKey }[] = [
  { route: 'entry', labelKey: 'dataSwitch.entry' },
  { route: 'import', labelKey: 'dataSwitch.import' },
  { route: 'export', labelKey: 'dataSwitch.export' },
];

export function dataSwitch(ctx: AppContext, active: DataRoute): HTMLElement {
  const seg = document.createElement('div');
  seg.className = 'data-switch';

  for (const tab of TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'data-switch-btn';
    b.textContent = ctx.t(tab.labelKey);
    if (tab.route === active) {
      b.classList.add('is-active');
      b.setAttribute('aria-current', 'true');
    } else {
      b.addEventListener('click', () => ctx.navigate(tab.route));
    }
    seg.append(b);
  }

  return seg;
}
