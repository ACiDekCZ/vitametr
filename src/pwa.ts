/**
 * Service-worker registration and update handling (K9).
 *
 * Registers the worker and, when a new version is waiting, invokes the
 * provided callback so the UI can offer a reload. Kept tiny and framework-free.
 */

export interface PwaHandlers {
  /** Called when an updated service worker is installed and waiting. */
  onUpdateReady?(activate: () => void): void;
}

export function registerServiceWorker(handlers: PwaHandlers = {}): void {
  if (!('serviceWorker' in navigator)) return;

  // True only once the user accepts an update — so the first-install
  // controllerchange (from clients.claim) does NOT trigger a reload.
  let activating = false;

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
      // A worker already waiting (update found before this load).
      if (reg.waiting && navigator.serviceWorker.controller) notify(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // Installed while another worker controls the page => an update.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            notify(installing);
          }
        });
      });
    });

    // Reload only for a user-accepted update, never for the first-install claim.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (activating) location.reload();
    });
  });

  function notify(worker: ServiceWorker): void {
    handlers.onUpdateReady?.(() => {
      activating = true;
      // If the worker is already active (no waiting state), skipWaiting won't
      // fire controllerchange — reload directly. Otherwise wait for it to take
      // over, which triggers the controllerchange reload above.
      if (worker.state === 'activated') {
        location.reload();
        return;
      }
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  }
}
