/**
 * Application runtime context (K8a) — the contract every view builds against.
 *
 * The context wires together the unlocked store, the domain services
 * (catalog, units engine, import pipeline) and cross-cutting UI concerns
 * (navigation, locale, toasts, lock). Views receive an AppContext and never
 * reach for storage or crypto directly.
 */

import type { Catalog, StoreApi, UnitsEngine, ImportPipeline } from '../core/contracts';
import type { MeasurementId, ProfileData } from '../core/types';
import type { Locale, StringKey } from '../i18n/index';

/** The set of top-level screens; also the router's hash routes. */
export type Route =
  | 'overview'
  | 'timeline'
  | 'entry'
  | 'metric'
  | 'import'
  | 'import-csv'
  | 'import-filter'
  | 'export'
  | 'review'
  | 'report'
  | 'compare'
  | 'metrics-manage'
  | 'settings';

export interface RouteState {
  route: Route;
  /** Optional target, e.g. a metric id for the detail view. */
  param?: string;
}

export type ToastKind = 'info' | 'success' | 'error';

/** An optional actionable button shown inside a toast (e.g. "Add details"). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * A view is a self-contained module: it renders into a container and returns
 * an optional teardown to release listeners/observers when navigation leaves.
 */
export interface View {
  render(container: HTMLElement, ctx: AppContext, route: RouteState): void | (() => void);
}

export interface AppContext {
  /** Unlocked store — getData()/mutate() operate on in-memory ProfileData. */
  store: StoreApi;
  /** Rebuilt whenever ProfileData.metrics changes (user metrics/aliases). */
  catalog(): Catalog;
  units: UnitsEngine;
  /** Import pipeline bound to the current profile's id/time/id-generator deps. */
  pipeline(): ImportPipeline;

  data(): ProfileData;
  /** Apply a mutation to ProfileData and schedule a persist; refreshes catalog. */
  mutate(fn: (data: ProfileData) => void): void;

  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: StringKey, params?: Record<string, string | number>): string;

  navigate(route: Route, param?: string): void;
  currentRoute(): RouteState;

  toast(message: string, kind?: ToastKind, action?: ToastAction): void;
  lock(): Promise<void>;

  /** Fresh id/time helpers for records created by views (composition boundary). */
  newMeasurementId(): MeasurementId;
  now(): string;
}
