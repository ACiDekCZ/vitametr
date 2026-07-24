/**
 * Add-data bottom sheet opened from the mobile center FAB.
 *
 * MOBILE ONLY: on the sidebar layout the "Data" item is a plain nav row that
 * navigates straight to the last-used data tab, so this sheet is never opened
 * there. Each action is DIRECT — it performs the deed instead of dropping the
 * user on a page with another button:
 *   • Enter manually → navigate to the entry form (the form is the action).
 *   • Import file    → open the file picker STRAIGHT from the sheet (a hidden
 *     `<input type=file>` clicked inside the handler so the user gesture stays
 *     valid); a chosen file runs the same auto-detect pipeline as the dropzone,
 *     a cancelled picker leaves the user exactly where they were.
 *   • Export data    → navigate to the export wizard (it needs choices).
 * A small ghost link opens the full Data page for specific formats / packs.
 *
 * A native `<dialog>` in the top layer gives the dimmed overlay, Escape-to-close,
 * backdrop click-outside and a focus trap for free; closing returns focus to the
 * FAB that opened it.
 */

import type { AppContext } from '../app-context';
import type { Route } from '../app-context';
import type { StringKey } from '../../i18n/index';
import { ACCEPT_AUTO } from '../views/import-model';
import { runAutoImport } from '../views/import-actions';

interface FabAction {
  /** 'navigate' opens a route; 'import' opens the file picker in place. */
  kind: 'navigate' | 'import';
  route?: Route;
  titleKey: StringKey;
  descKey: StringKey;
  /** Accent-filled tile (primary) vs the softer `--accent-soft` tile. */
  variant: 'accent' | 'soft';
  icon: string;
}

// Inline SVGs (stroke 2, currentColor) — consistent with the app's other icons,
// never emoji. Pencil (manual), download-into-tray (import), upload (export).
const ICON_PENCIL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_IMPORT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
const ICON_EXPORT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>';

const ACTIONS: readonly FabAction[] = [
  {
    kind: 'navigate',
    route: 'entry',
    titleKey: 'fabMenu.manual.title',
    descKey: 'fabMenu.manual.desc',
    variant: 'accent',
    icon: ICON_PENCIL,
  },
  {
    kind: 'import',
    titleKey: 'fabMenu.import.title',
    descKey: 'fabMenu.import.desc',
    variant: 'soft',
    icon: ICON_IMPORT,
  },
  {
    kind: 'navigate',
    route: 'export',
    titleKey: 'fabMenu.export.title',
    descKey: 'fabMenu.export.desc',
    variant: 'soft',
    icon: ICON_EXPORT,
  },
];

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * Open the file picker straight from a sheet action. The hidden input lives on
 * `document.body` (not inside the dialog, which is removed on close) so it
 * survives the sheet closing while the native picker is up. A chosen file runs
 * the auto-detect import; a cancelled picker just cleans up and does nothing —
 * the user stays where they were.
 */
function pickImportFile(ctx: AppContext): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPT_AUTO;
  input.className = 'visually-hidden';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) void runAutoImport(ctx, file);
  });
  // Modern browsers fire `cancel` when the picker is dismissed with no choice.
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input);
  // Trigger synchronously — no await before this — so the user gesture that
  // opened the sheet still counts as the activation for the file dialog.
  input.click();
}

/**
 * Open the add-data bottom sheet. `anchor` is the FAB button — it takes the open
 * state (`aria-expanded`, rotated glyph) and regains focus on close.
 */
export function openFabMenu(ctx: AppContext, anchor: HTMLElement): void {
  // Guard against a double-open (e.g. Enter + click): if a sheet is up, ignore.
  if (document.querySelector('dialog.fab-menu')) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'fab-menu fab-menu-sheet';
  dialog.setAttribute('aria-label', ctx.t('nav.addData'));

  const panel = el('div', 'fab-menu-panel');
  const handle = el('div', 'fab-menu-handle');
  handle.setAttribute('aria-hidden', 'true');
  panel.append(handle);

  const close = (): void => {
    // The native dialog's `close` event fires for Escape and button close alike;
    // do the teardown there so every close path is handled once.
    dialog.close();
  };

  for (const action of ACTIONS) {
    const btn = el('button', 'fab-menu-action') as HTMLButtonElement;
    btn.type = 'button';

    const tile = el('span', `fab-menu-tile fab-menu-tile-${action.variant}`);
    tile.innerHTML = action.icon;

    const text = el('span', 'fab-menu-text');
    const title = el('span', 'fab-menu-title');
    title.textContent = ctx.t(action.titleKey);
    const desc = el('span', 'fab-menu-desc');
    desc.textContent = ctx.t(action.descKey);
    text.append(title, desc);

    btn.append(tile, text);
    btn.addEventListener('click', () => {
      if (action.kind === 'import') {
        // Open the picker WHILE the click gesture is live, then dismiss the
        // sheet; navigation to review (if any) happens on file-chosen.
        pickImportFile(ctx);
        close();
        return;
      }
      // Close first, then navigate — the close handler restores focus to the
      // FAB, but navigation immediately re-renders the route content anyway.
      const route = action.route;
      close();
      if (route) ctx.navigate(route);
    });
    panel.append(btn);
  }

  // Ghost link to the full Data page (specific formats / packs).
  const openData = el('button', 'fab-menu-open-data') as HTMLButtonElement;
  openData.type = 'button';
  openData.textContent = ctx.t('fabMenu.openDataPage');
  openData.addEventListener('click', () => {
    close();
    ctx.navigate('import');
  });
  panel.append(openData);

  dialog.append(panel);

  anchor.setAttribute('aria-expanded', 'true');
  anchor.classList.add('is-open');

  dialog.addEventListener('close', () => {
    anchor.setAttribute('aria-expanded', 'false');
    anchor.classList.remove('is-open');
    dialog.remove();
    // Return focus to the FAB unless navigation already moved focus into the
    // freshly rendered view.
    if (document.body.contains(anchor)) anchor.focus();
  });

  // Backdrop click-outside: a click on the dialog element itself (not its panel)
  // is a click on the backdrop area.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });

  document.body.append(dialog);
  dialog.showModal();

  const first = dialog.querySelector<HTMLElement>('.fab-menu-action');
  first?.focus();
}
