/**
 * Application shell (K8a): boot flow (onboarding / lock / main), the app
 * context factory, top navigation, toasts and the auto-lock timer.
 *
 * The onboarding and settings screens here are minimal bootstraps so the whole
 * lock/unlock flow works end to end; K8b replaces them with the full screens.
 */

import type { CryptoProvider, StoreApi } from '../core/contracts';
import { createCatalog } from '../core/catalog';
import { createUnitsEngine } from '../core/units';
import { UNITS } from '../core/units-data';
import { createImportPipeline } from '../core/review';
import { createStore } from '../storage/store';
import { createCryptoProvider } from '../storage/crypto';
import { createIndexedDbBackend } from '../storage/db';
import {
  detectLocale,
  getLocale,
  setLocale,
  t,
  type Locale,
  type StringKey,
} from '../i18n/index';
import type {
  AppContext,
  Route,
  RouteState,
  ToastAction,
  ToastKind,
} from './app-context';
import { formatHash, parseHash } from './router';
import { VIEWS } from './views/index';
import { newMeasurementId, nowIso } from './runtime';
import { applyTheme } from './theme';
import { openFabMenu } from './components/fab-menu';
import { getLastDataRoute, rememberDataRoute } from './data-nav';

const DEFAULT_AUTO_LOCK_MINUTES = 10;

// Injected at build time; the build that last writes the data is stamped for
// diagnostics (schema version drives migrations, this does not).
declare const __APP_VERSION__: string;
const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

/** Mount the application into a root element and run the boot flow. */
export async function mountApp(root: HTMLElement): Promise<void> {
  setLocale(detectLocale());
  const backend = await createIndexedDbBackend();
  const crypto = createCryptoProvider();
  const store = createStore(backend, crypto, { appVersion: APP_VERSION });

  await routeBoot(root, store, crypto);
}

/** Decide which top-level screen to show based on store status. */
async function routeBoot(
  root: HTMLElement,
  store: StoreApi,
  crypto: CryptoProvider,
): Promise<void> {
  const status = await store.status();
  if (status === 'uninitialized') {
    renderOnboarding(root, store, crypto);
    return;
  }
  if (status === 'unlocked') {
    mountShell(root, store, crypto);
    return;
  }
  // status === 'locked': after a reload the in-memory session is always empty.
  // A plaintext profile has no passphrase, so unlock it transparently and boot
  // straight to the shell — only encrypted profiles gate on the lock screen.
  if ((await store.mode()) === 'plaintext') {
    await store.unlock();
    mountShell(root, store, crypto);
    return;
  }
  renderLock(root, store, crypto);
}

// ---------------------------------------------------------------------------
// Onboarding bootstrap (K8b replaces with the full screen)
// ---------------------------------------------------------------------------

function renderOnboarding(
  root: HTMLElement,
  store: StoreApi,
  crypto: CryptoProvider,
): void {
  const rerender = () => renderOnboarding(root, store, crypto);
  root.replaceChildren();
  const screen = el('div', 'center-screen');
  const panel = el('div', 'panel card');

  const title = el('h1');
  title.textContent = t('onboarding.welcome');
  const tagline = el('p', 'muted');
  tagline.textContent = t('onboarding.intro');

  // Language toggle (updates the whole onboarding screen live).
  const langField = el('div', 'field');
  const langLabel = el('label');
  langLabel.textContent = t('onboarding.language');
  const langBtn = el('button') as HTMLButtonElement;
  langBtn.textContent = getLocale() === 'cs' ? 'Čeština · EN' : 'English · CS';
  langBtn.addEventListener('click', () => {
    setLocale(getLocale() === 'cs' ? 'en' : 'cs');
    rerender();
  });
  langField.append(langLabel, langBtn);

  // One optional password: setting it turns on encryption, leaving it empty
  // keeps a plaintext profile. No separate on/off control — the password IS the
  // encryption (all done in-browser via WebCrypto).
  const passField = el('div', 'field');
  const passLabel = el('label');
  passLabel.textContent = t('onboarding.setPassword');
  const passInput = document.createElement('input');
  passInput.type = 'password';
  passInput.setAttribute('aria-label', t('onboarding.setPassword'));
  passField.append(passLabel, passInput);

  // The repeat field + loss warning only matter once a password is being typed.
  const pass2Field = el('div', 'field');
  const pass2Label = el('label');
  pass2Label.textContent = t('onboarding.passphraseRepeat');
  const pass2Input = document.createElement('input');
  pass2Input.type = 'password';
  pass2Input.setAttribute('aria-label', t('onboarding.passphraseRepeat'));
  pass2Field.append(pass2Label, pass2Input);

  const hint = el('p', 'muted');
  hint.textContent = t('onboarding.passwordHint');

  const error = el('p', 'pill above');
  error.style.display = 'none';

  const create = el('button', 'primary') as HTMLButtonElement;
  create.textContent = t('onboarding.create');

  function syncPasswordUi(): void {
    const hasPassword = passInput.value.length > 0;
    pass2Field.style.display = hasPassword ? '' : 'none';
    hint.textContent = hasPassword
      ? t('onboarding.lossWarning')
      : t('onboarding.passwordHint');
  }
  passInput.addEventListener('input', syncPasswordUi);

  function showError(key: 'onboarding.passphraseMismatch' | 'onboarding.passphraseWeak'): void {
    error.textContent = t(key);
    error.style.display = '';
  }

  create.addEventListener('click', () => {
    error.style.display = 'none';
    let passphrase: string | undefined;
    if (passInput.value.length > 0) {
      if (passInput.value.length < 6) return showError('onboarding.passphraseWeak');
      if (passInput.value !== pass2Input.value) return showError('onboarding.passphraseMismatch');
      passphrase = passInput.value;
    }
    void (async () => {
      // The profile name is no longer collected here — it is an optional field in
      // Settings and shown as a localized default until the user sets one.
      await store.init({ profileName: '', passphrase, locale: getLocale() });
      mountShell(root, store, crypto);
    })();
  });

  panel.append(title, tagline, langField, passField, pass2Field, hint, error, create);
  screen.append(panel);
  root.append(screen);
  syncPasswordUi();
}

// ---------------------------------------------------------------------------
// Lock screen
// ---------------------------------------------------------------------------

function renderLock(
  root: HTMLElement,
  store: StoreApi,
  crypto: CryptoProvider,
): void {
  root.replaceChildren();
  const screen = el('div', 'center-screen');
  const panel = el('div', 'panel card');

  const title = el('h1');
  title.textContent = t('lock.title');

  const field = el('div', 'field');
  const label = el('label');
  label.textContent = t('lock.passphrase');
  const input = document.createElement('input');
  input.type = 'password';
  input.setAttribute('aria-label', t('lock.passphrase'));
  field.append(label, input);

  const error = el('p', 'muted');
  error.style.color = ''; // color set via class when shown

  const unlock = el('button', 'primary') as HTMLButtonElement;
  unlock.textContent = t('lock.unlock');

  async function attempt(): Promise<void> {
    // Guard against a second attempt while one is in flight: PBKDF2 is slow, and
    // a concurrent attempt could clear the field mid-typing.
    if (unlock.disabled) return;
    unlock.disabled = true;
    try {
      await store.unlock(input.value || undefined);
      mountShell(root, store, crypto);
    } catch {
      error.textContent = t('lock.wrongPassphrase');
      error.classList.add('pill', 'above');
      input.value = '';
      input.focus();
      unlock.disabled = false;
    }
  }

  unlock.addEventListener('click', () => void attempt());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void attempt();
  });

  // Forgot-password recovery: an encrypted profile has no passphrase reset (the
  // data is unrecoverable by design), so the only in-app recovery is to wipe and
  // start fresh. Kept clearly secondary and gated behind an inline two-step
  // confirm so it can never be mistaken for Unlock. Mirrors the Settings wipe UX.
  const forgotHost = el('div', 'lock-forgot');

  function renderForgotIdle(): void {
    forgotHost.replaceChildren();
    const link = el('button', 'link-button') as HTMLButtonElement;
    link.type = 'button';
    link.textContent = t('lock.forgot');
    link.addEventListener('click', () => renderForgotConfirm(1));
    forgotHost.append(link);
  }

  function renderForgotConfirm(step: 1 | 2): void {
    forgotHost.replaceChildren();
    const explain = el('p', 'muted');
    explain.textContent = t('lock.forgotExplain');
    const prompt = el('p', 'pill above');
    prompt.textContent =
      step === 1 ? t('lock.eraseConfirm') : t('lock.eraseConfirmAgain');

    const row = el('div', 'lock-forgot-actions');
    const back = el('button') as HTMLButtonElement;
    back.type = 'button';
    back.textContent = t('common.cancel');
    back.addEventListener('click', () => renderForgotIdle());
    const erase = el('button', 'danger') as HTMLButtonElement;
    erase.type = 'button';
    erase.textContent = t('lock.erase');
    erase.addEventListener('click', () => {
      if (step === 1) {
        renderForgotConfirm(2);
        return;
      }
      erase.disabled = true;
      back.disabled = true;
      void (async () => {
        await store.wipe();
        // Back to onboarding: re-run the boot flow on a fresh reload, exactly as
        // the Settings "delete all data" path does.
        location.reload();
      })();
    });
    row.append(back, erase);
    forgotHost.append(explain, prompt, row);
  }

  renderForgotIdle();

  panel.append(title, field, error, unlock, forgotHost);
  screen.append(panel);
  root.append(screen);
}

// ---------------------------------------------------------------------------
// Main shell
// ---------------------------------------------------------------------------

interface NavItem {
  route: Route;
  labelKey: StringKey;
  /** The center slot renders as a raised FAB on mobile, a normal item on desktop. */
  fab?: boolean;
}

// Mobile bottom-nav slots: Overview, Timeline, [FAB +], Metrics, Settings — five
// slots with a raised center FAB. The FAB does not navigate: it opens the
// add-data action menu (manual entry / import / export). On desktop the same
// list renders as a left sidebar with the FAB as a normal "Add data" row.
// Import/Export keep their routes but no longer own a nav slot — they are
// reached from the FAB menu (and the Import⇄Export switcher in their headers).
// The `compare` route/view stays intact and reachable by hash (#/compare) — it
// is out of the nav for now and gets an entry point in a later stage.
const NAV_ITEMS: readonly NavItem[] = [
  { route: 'overview', labelKey: 'nav.overview' },
  { route: 'timeline', labelKey: 'nav.timeline' },
  { route: 'entry', labelKey: 'nav.addData', fab: true },
  { route: 'metrics-manage', labelKey: 'nav.metrics' },
  { route: 'settings', labelKey: 'nav.settings' },
];

// Routes that "belong" to the add-data FAB: on any of these the FAB reads as the
// current nav target (there is no dedicated Import/Export/entry slot).
const ADD_DATA_ROUTES: ReadonlySet<Route> = new Set<Route>([
  'entry',
  'import',
  'import-csv',
  'import-filter',
  'export',
  'review',
]);

function mountShell(
  root: HTMLElement,
  store: StoreApi,
  crypto: CryptoProvider,
): void {
  root.replaceChildren();

  // Profile settings are now available: reconcile the theme painted at boot from
  // the cache with the persisted preference (default 'auto'). This also (re)arms
  // the live OS-scheme subscription when the preference is 'auto'.
  applyTheme(store.getData().settings.theme ?? 'auto');

  let route: RouteState = parseHash(location.hash);
  let teardown: (() => void) | undefined;
  let autoLockTimer: ReturnType<typeof setTimeout> | undefined;
  // Locking only applies to an encrypted profile (plaintext has no passphrase).
  let encrypted = false;

  // Cached services; catalog rebuilds when metrics change, and the units engine
  // reloads (in place) to include the profile's custom units.
  const units = createUnitsEngine();
  function reloadUnits(): void {
    units.reloadUnits([...UNITS, ...(store.getData().units ?? [])]);
  }
  reloadUnits();
  let catalog = createCatalog(store.getData());

  const shell = el('div', 'app-shell');
  const nav = el('nav', 'app-nav');
  const main = el('div', 'app-main');
  const header = el('header', 'app-header');
  const content = el('main', 'app-content');
  const toastHost = el('div', 'toast-host');

  // Header
  const brandWrap = el('div', 'brand-wrap');
  const brandIcon = document.createElement('img');
  brandIcon.className = 'brand-icon';
  brandIcon.src = 'icon.svg';
  brandIcon.alt = '';
  brandIcon.width = 30;
  brandIcon.height = 30;
  const brand = el('span', 'brand');
  brand.textContent = t('app.title');
  brandWrap.append(brandIcon, brand);
  // The header is just the brand now: language is a set-once choice and lock is
  // automatic (inactivity + background) with a manual "Lock now" in Settings —
  // neither belongs on every screen (banking-app style).
  header.append(brandWrap);

  main.append(header, content);
  shell.append(nav, main);
  root.append(shell, toastHost);

  const ctx: AppContext = {
    store,
    catalog: () => catalog,
    units,
    pipeline: () =>
      createImportPipeline(catalog, {
        newId: newMeasurementId,
        now: nowIso,
        profileId: store.getData().profile.id,
      }),
    data: () => store.getData(),
    mutate(fn) {
      store.mutate(fn);
      catalog = createCatalog(store.getData());
      reloadUnits();
    },
    locale: getLocale(),
    setLocale(next: Locale) {
      setLocale(next);
      ctx.locale = next;
      store.mutate((d) => {
        d.settings.locale = next;
      });
      rerenderChrome();
      renderRoute();
    },
    t,
    navigate(next: Route, param?: string) {
      // Record an in-app move to a data tab synchronously (renderRoute also does
      // this for deep links / reloads); doing it here as well keeps the sidebar
      // "Data" memory correct even when navigations happen back-to-back.
      rememberDataRoute(next);
      location.hash = formatHash(next, param);
    },
    currentRoute: () => route,
    toast: (message, kind, action) => showToast(toastHost, message, kind, action),
    lock: () => doLock(),
    newMeasurementId,
    now: nowIso,
  };

  function rerenderChrome(): void {
    brand.textContent = t('app.title');
    renderNav();
  }

  function renderNav(): void {
    nav.replaceChildren();
    for (const item of NAV_ITEMS) {
      const label = t(item.labelKey);
      const b = el('button', item.fab ? 'nav-fab' : 'nav-item') as HTMLButtonElement;
      if (item.fab) {
        // Circular "+" on mobile, a plain "Data" row on the sidebar. On mobile
        // it opens the add-data bottom sheet (a menu); on the sidebar it is a
        // plain nav item that jumps straight to the last-used data tab, so the
        // popup semantics only apply on mobile. Accessible name is "Data".
        b.setAttribute('aria-label', label);
        if (!isSidebar()) {
          b.setAttribute('aria-haspopup', 'menu');
          b.setAttribute('aria-expanded', 'false');
        }
        const icon = el('span', 'nav-fab-icon');
        icon.textContent = '+';
        icon.setAttribute('aria-hidden', 'true');
        const text = el('span', 'nav-label');
        text.textContent = label;
        b.append(icon, text);
      } else {
        const indicator = el('span', 'nav-indicator');
        indicator.setAttribute('aria-hidden', 'true');
        const text = el('span', 'nav-label');
        text.textContent = label;
        b.append(indicator, text);
      }
      // The FAB reads as current on any add-data route (entry/import/export/…);
      // a normal item is current on its own route.
      const isActive = item.fab
        ? ADD_DATA_ROUTES.has(route.route)
        : route.route === item.route;
      if (isActive) b.setAttribute('aria-current', 'page');
      if (item.fab) {
        // Device-aware: the sidebar "Data" row navigates straight to the
        // last-used data tab (no popover); the mobile FAB opens the sheet. The
        // decision is made at click time so a resize is always respected.
        b.addEventListener('click', () => {
          if (isSidebar()) ctx.navigate(getLastDataRoute());
          else openFabMenu(ctx, b);
        });
      } else {
        b.addEventListener('click', () => ctx.navigate(item.route));
      }
      nav.append(b);
    }
  }

  function renderRoute(): void {
    teardown?.();
    // Track the last-used data tab (entry/import/export) so the sidebar "Data"
    // item can resume it; non-data routes leave the memory untouched.
    rememberDataRoute(route.route);
    const view = VIEWS[route.route] ?? VIEWS.overview;
    const result = view.render(content, ctx, route);
    teardown = typeof result === 'function' ? result : undefined;
    renderNav();
  }

  async function doLock(): Promise<void> {
    teardown?.();
    clearTimeout(autoLockTimer);
    window.removeEventListener('hashchange', onHashChange);
    document.removeEventListener('visibilitychange', onVisibility);
    resetActivityListeners(false);
    await store.lock();
    renderLock(root, store, crypto);
  }

  function scheduleAutoLock(): void {
    clearTimeout(autoLockTimer);
    const minutes =
      store.getData().settings.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES;
    if (minutes <= 0) return; // 0 disables auto-lock
    autoLockTimer = setTimeout(() => void doLock(), minutes * 60_000);
  }

  function onActivity(): void {
    scheduleAutoLock();
  }
  function resetActivityListeners(add: boolean): void {
    const method = add ? 'addEventListener' : 'removeEventListener';
    for (const evt of ['pointerdown', 'keydown'] as const) {
      window[method](evt, onActivity);
    }
  }

  function onHashChange(): void {
    route = parseHash(location.hash);
    renderRoute();
  }

  function onVisibility(): void {
    if (document.visibilityState !== 'hidden') return;
    void store.flush();
    // Banking-style: an encrypted profile locks when the app goes to the
    // background (switched away / window closed) — no manual button needed.
    if (encrypted) void doLock();
  }

  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('visibilitychange', onVisibility);

  rerenderChrome();
  renderRoute();

  // Arm auto-lock (inactivity + background) only for an encrypted profile.
  void store.mode().then((mode) => {
    encrypted = mode === 'encrypted';
    if (encrypted) {
      resetActivityListeners(true);
      scheduleAutoLock();
    }
  });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function showToast(
  host: HTMLElement,
  message: string,
  kind: ToastKind = 'info',
  action?: ToastAction,
): void {
  const toast = el('div', `toast ${kind}`);
  toast.setAttribute('role', 'status');
  toast.append(el('span', 'toast-text'));
  (toast.firstChild as HTMLElement).textContent = message;
  if (action) {
    // Actionable toasts linger longer so the button can actually be reached.
    toast.classList.add('has-action');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      toast.remove();
    });
    toast.append(btn);
    host.append(toast);
    setTimeout(() => toast.remove(), 8000);
    return;
  }
  host.append(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ---------------------------------------------------------------------------
// Small DOM helper
// ---------------------------------------------------------------------------

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * True on the sidebar layout — the nav renders as a left rail at ≥500px (the
 * same breakpoint the CSS switches on). There the "Data" item is a plain nav row
 * that navigates directly; below it the bottom bar's FAB opens the sheet.
 */
function isSidebar(): boolean {
  return window.matchMedia('(min-width: 500px)').matches;
}
