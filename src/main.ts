/**
 * Application entry point. Loads styles, then boots the app shell (K8a),
 * which decides between onboarding, the lock screen and the main app.
 */

import './ui/styles.css';
import { mountApp } from './ui/app';
import { applyBootTheme } from './ui/theme';
import { registerServiceWorker } from './pwa';
import { detectLocale, setLocale, t } from './i18n/index';

// Injected by the bundler; true only for development builds.
declare const __DEV__: boolean;

function main(): void {
  const root = document.getElementById('app');
  if (!root) {
    throw new Error('Missing #app root element');
  }

  // Paint the theme before anything renders: the onboarding / lock screen shows
  // before the (possibly encrypted) profile is unlocked, so we rely on the
  // cached resolved theme here and reconcile with settings.theme after unlock.
  applyBootTheme();

  void mountApp(root);

  setLocale(detectLocale());

  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // Development: run without a service worker. A cache-first (or even
    // network-first) worker only risks shadowing freshly rebuilt assets, so
    // tear down any worker/cache a previous build left behind and don't
    // register a new one — the dev server is the single source of truth.
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())));
    }
    if ('caches' in self) {
      void caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))));
    }
    return;
  }

  registerServiceWorker({
    onUpdateReady(activate) {
      showUpdateBanner(t('update.available'), t('update.reload'), activate);
    },
  });
}

/** Minimal, dependency-free "new version available" banner. */
function showUpdateBanner(message: string, actionLabel: string, activate: () => void): void {
  const host = document.createElement('div');
  host.className = 'toast-host';
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.textContent = `${message} `;
  const btn = document.createElement('button');
  btn.textContent = actionLabel;
  btn.addEventListener('click', activate);
  toast.append(btn);
  host.append(toast);
  document.body.append(host);
}

main();
