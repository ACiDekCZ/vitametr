/**
 * Static plugin registry (step K7, design doc §5.3).
 *
 * MVP registration is static: two frozen arrays plus id lookups. No dynamic
 * installation of foreign code — the security boundary is "a plugin is code in
 * this repository". The interfaces are shaped so plugins can later be lazy-loaded
 * as separate modules without changing callers.
 */

import type { ExportPlugin, ImportPlugin } from '../core/contracts.js';
import { manualImportPlugin } from './import/manual.js';
import { jsonBackupImportPlugin } from './import/json-backup.js';
import { fhirImportPlugin } from './import/fhir.js';
import { pdfImportPlugin } from './import/pdf.js';
import { labTextImportPlugin } from './import/lab-text-file.js';
import { appleHealthImportPlugin } from './import/apple-health.js';
import { hl7v2ImportPlugin } from './import/hl7v2.js';
import { jsonBackupExportPlugin } from './export/json-backup.js';
import { csvExportPlugin } from './export/csv.js';
import { fhirExportPlugin } from './export/fhir.js';
import { reportExportPlugin } from './export/report.js';

export const IMPORT_PLUGINS: readonly ImportPlugin[] = Object.freeze([
  manualImportPlugin,
  jsonBackupImportPlugin,
  fhirImportPlugin,
  pdfImportPlugin,
  labTextImportPlugin,
  appleHealthImportPlugin,
  hl7v2ImportPlugin,
]);

export const EXPORT_PLUGINS: readonly ExportPlugin[] = Object.freeze([
  jsonBackupExportPlugin,
  csvExportPlugin,
  fhirExportPlugin,
  reportExportPlugin,
]);

export function importPluginById(id: string): ImportPlugin | undefined {
  return IMPORT_PLUGINS.find((p) => p.id === id);
}

export function exportPluginById(id: string): ExportPlugin | undefined {
  return EXPORT_PLUGINS.find((p) => p.id === id);
}
