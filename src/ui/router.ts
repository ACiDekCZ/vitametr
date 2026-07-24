/**
 * Hash router (K8a). Pure parse/format helpers keep the routing logic
 * testable without a DOM; the shell wires them to hashchange events.
 */

import type { Route, RouteState } from './app-context';

const ROUTES: readonly Route[] = [
  'overview',
  'timeline',
  'entry',
  'metric',
  'import',
  'import-csv',
  'import-filter',
  'export',
  'review',
  'report',
  'compare',
  'metrics-manage',
  'settings',
];

const DEFAULT_ROUTE: Route = 'overview';

/** Parse a location hash ('#/metric/builtin:glucose') into a RouteState. */
export function parseHash(hash: string): RouteState {
  const clean = hash.replace(/^#\/?/, '');
  if (clean === '') return { route: DEFAULT_ROUTE };
  const [head, ...rest] = clean.split('/');
  const route = (ROUTES as readonly string[]).includes(head)
    ? (head as Route)
    : DEFAULT_ROUTE;
  const param = rest.length > 0 ? decodeURIComponent(rest.join('/')) : undefined;
  return param ? { route, param } : { route };
}

/** Format a RouteState back into a hash string. */
export function formatHash(route: Route, param?: string): string {
  return param ? `#/${route}/${encodeURIComponent(param)}` : `#/${route}`;
}

export function isRoute(value: string): value is Route {
  return (ROUTES as readonly string[]).includes(value);
}
