// Domain core: pure logic (metrics, measurements, series, normalization).
// No DOM, no storage, no plugin imports.

export * from './types';
export * from './contracts';
export { UNITS } from './units-data';
export { BUILTIN_METRICS, LOINC_ATTRIBUTION } from './catalog-data';
export { createCatalog } from './catalog';
