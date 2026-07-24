/**
 * View registry (K8a): maps each route to its view module.
 */

import type { Route, View } from '../app-context';
import { overviewView } from './overview';
import { timelineView } from './timeline';
import { entryView } from './entry';
import { metricView } from './metric';
import { reviewView } from './review';
import { settingsView } from './settings';
import { importView } from './import';
import { importCsvView } from './import-csv';
import { importFilterView } from './import-filter';
import { exportView } from './export';
import { reportView } from './report';
import { compareView } from './compare';
import { metricsManageView } from './metrics-manage';

export const VIEWS: Record<Route, View> = {
  overview: overviewView,
  timeline: timelineView,
  entry: entryView,
  metric: metricView,
  import: importView,
  'import-csv': importCsvView,
  'import-filter': importFilterView,
  export: exportView,
  review: reviewView,
  report: reportView,
  compare: compareView,
  'metrics-manage': metricsManageView,
  settings: settingsView,
};
