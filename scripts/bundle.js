/**
 * Production build script for Vitametr.
 *
 * Bundles src/main.ts with esbuild (zero runtime dependencies), injects the
 * app version from package.json as the compile-time constant `__APP_VERSION__`,
 * and emits the bundle plus a processed index.html into dist/. The e2e suite
 * and any static file server can then serve dist/ directly.
 *
 * Pass --dev for an unminified build with sourcemaps.
 */

import { execSync } from 'child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const dev = process.argv.includes('--dev');

const pkgVersion = JSON.parse(readFileSync('package.json', 'utf-8')).version;

mkdirSync('dist', { recursive: true });

// The define value must be a valid JS expression, so the version string is
// double-encoded: JSON.stringify gives "0.1.0", wrapped in shell single quotes.
const versionDefine = `--define:__APP_VERSION__='${JSON.stringify(pkgVersion)}'`;
// The service-worker cache key. In production it is the package version so a
// release busts the shell cache. In development the version never changes, so a
// per-build id (this is a build script, not app code, so Date.now() is fine) is
// used — otherwise the cache-first SW would serve a stale main.js forever after
// the first load, hiding every rebuild.
const buildId = dev ? `${pkgVersion}-dev-${Date.now()}` : pkgVersion;
const buildIdDefine = `--define:__BUILD_ID__='${JSON.stringify(buildId)}'`;
// Lets the app skip (and tear down) the service worker in development, where a
// cached shell only shadows freshly rebuilt assets.
const devDefine = `--define:__DEV__=${dev ? 'true' : 'false'}`;
const optimize = dev ? '--sourcemap' : '--minify';

console.log(`Building bundle (${dev ? 'development' : 'production'})...`);
// Code splitting keeps heavy, on-demand plugins (e.g. the PDF importer's
// pdf.js dependency) out of the core bundle: a dynamic import() becomes a
// separate chunk fetched only when that feature is first used.
execSync(
    `npx esbuild src/main.ts --bundle --splitting --format=esm --target=es2022 ${optimize} ${versionDefine} ${devDefine} --external:*.woff2 --outdir=dist --entry-names=main --chunk-names=chunks/[name]-[hash]`,
    { stdio: 'inherit' },
);

// The service worker is a separate bundle (worker scope, not imported by the
// app) emitted at the app root so its scope covers everything. Built as a
// classic (IIFE) worker so registration needs no module-worker support.
execSync(
    `npx esbuild src/sw.ts --bundle --format=iife --target=es2022 ${optimize} ${versionDefine} ${buildIdDefine} --outfile=dist/sw.js`,
    { stdio: 'inherit' },
);

// pdf.js worker, bundled as a classic worker for the (lazy) PDF import plugin.
execSync(
    `npx esbuild node_modules/pdfjs-dist/build/pdf.worker.mjs --bundle --format=iife --target=es2022 ${optimize} --outfile=dist/pdf.worker.js`,
    { stdio: 'inherit' },
);

// Static assets (manifest, icons) served as-is.
cpSync('public', 'dist', { recursive: true });

// Process the app shell: stamp the version into the placeholder so the served
// page always reports the exact build it was produced from.
const html = readFileSync('index.html', 'utf-8');
const processed = html.replaceAll('__APP_VERSION__', pkgVersion);
writeFileSync('dist/index.html', processed);

console.log(`✓ Wrote dist/main.js, dist/sw.js, dist/index.html + assets (v${pkgVersion})`);
