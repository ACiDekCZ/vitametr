/**
 * Session-scoped memory of the last "Data" tab the user visited (entry / import
 * / export). The desktop sidebar's single "Data" item navigates straight to this
 * tab — no popover — so a second click lands where the user last was; the shared
 * Zadat·Import·Export strip switches between the three within a page.
 *
 * Memory only: it is deliberately NOT persisted (a fresh session starts on
 * `entry`). Pure, DOM-free logic so it can be unit-tested directly.
 */

/** The three routes that make up the "Data" area, reachable via the tab strip. */
export type DataRoute = 'entry' | 'import' | 'export';

const DATA_ROUTES: ReadonlySet<string> = new Set<DataRoute>(['entry', 'import', 'export']);

let lastDataRoute: DataRoute = 'entry';

/** True for the three routes the tab strip navigates between. */
export function isDataRoute(route: string): route is DataRoute {
  return DATA_ROUTES.has(route);
}

/**
 * Record a visit to a data route. A non-data route is ignored (the memory keeps
 * the previous tab), so the sidebar "Data" item always resumes the last of the
 * three the user actually opened.
 */
export function rememberDataRoute(route: string): void {
  if (isDataRoute(route)) lastDataRoute = route;
}

/** The tab the desktop "Data" sidebar item should navigate to. */
export function getLastDataRoute(): DataRoute {
  return lastDataRoute;
}

/** Test-only reset so specs don't leak state across cases. */
export function resetLastDataRoute(): void {
  lastDataRoute = 'entry';
}
