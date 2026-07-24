/**
 * Minimal static file server built only on Node core modules (zero runtime
 * and dev dependencies). Used by the Playwright webServer block to serve the
 * production build in dist/ so `npm run test:e2e` is fully self-contained.
 *
 * Usage: node scripts/serve.js <dir> <port>
 */

import { createReadStream, existsSync, statSync } from 'fs';
import { createServer } from 'http';
import { extname, join, normalize } from 'path';

const dir = process.argv[2] ?? 'dist';
const port = Number(process.argv[3] ?? 8199);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
    '.map': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) {
        pathname += 'index.html';
    }

    // Contain the resolved path within the served directory.
    const filePath = normalize(join(dir, pathname));
    if (!filePath.startsWith(normalize(dir)) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
    }

    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Serving ${dir}/ at http://127.0.0.1:${port}/`);
});
