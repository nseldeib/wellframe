// Local web server that turns this mcpb into a launcher for a browser view of
// the user's Wellframe data — "the desktop app, in a tab, fully offline". It
// serves the desktop frontend's static build (`desktop/dist`) and answers the
// `/api/*` routes from `webdata.ts` (the user's real local SQLite). Nothing
// leaves the machine: it binds 127.0.0.1 only and reads the same file the MCP
// tools read.
//
// The served frontend is the exact desktop UI. Two small rewrites of the served
// index.html flip it from Tauri/fixture mode into web-API mode:
//   • `<base href="/">` so its relative asset URLs resolve from root even on a
//     deep client route (e.g. a refresh on /timeline).
//   • an external marker script (`/__wellframe-web.js`) that sets
//     `window.__WELLFRAME_WEB_API__`, which each console's data loader checks to
//     fetch `/api/*` instead of falling back to a browser fixture.
// Both survive the desktop build's strict `default-src 'self'` CSP: same-origin
// scripts and same-origin fetch are allowed, so the shipped Tauri security
// posture is unchanged and un-relaxed here.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ROUTES } from './webdata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default port echoes the desktop app's Tauri dev port (1420 → 7420) so the URL
// is memorable; falls back to an ephemeral port if it's taken.
const DEFAULT_PORT = Number(process.env.WELLFRAME_WEB_PORT) || 7420;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const MARKER_JS = "window.__WELLFRAME_WEB_API__ = '/api';\n";

// Locate the desktop frontend static build. Ordered so an explicit override
// wins, then the packed-bundle layout (pack.sh copies dist → desktop-dist next
// to the server), then the dev tree (mcp-server and desktop are siblings).
export function resolveFrontendDir(): string | null {
  const candidates = [
    process.env.WELLFRAME_WEB_DIST,
    path.join(__dirname, '..', 'desktop-dist'), // packed .mcpb
    path.join(__dirname, '..', '..', 'desktop', 'dist'), // dev tree
  ].filter((p): p is string => Boolean(p));
  return candidates.find((d) => existsSync(path.join(d, 'index.html'))) ?? null;
}

// Inject `<base>` + the marker script immediately after <head>.
export function rewriteIndexHtml(html: string): string {
  const injected =
    '<base href="/">\n    <script src="/__wellframe-web.js"></script>';
  return html.replace(/<head>/i, `<head>\n    ${injected}`);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  frontendDir: string | null,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  // Data API — always available even without a frontend build.
  const route = API_ROUTES[pathname];
  if (route) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    try {
      sendJson(res, 200, await route());
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // Web-mode marker (kept external so the strict 'self' CSP allows it).
  if (pathname === '/__wellframe-web.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(MARKER_JS);
    return;
  }

  if (!frontendDir) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Wellframe web UI build not found in this bundle. The data API is at /api/*.');
    return;
  }

  // Static assets from the build's /assets dir (hashed, immutable).
  if (pathname.startsWith('/assets/')) {
    const assetsRoot = path.join(frontendDir, 'assets');
    const filePath = path.join(frontendDir, pathname);
    if (filePath !== assetsRoot && !filePath.startsWith(assetsRoot + path.sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const buf = await readFile(filePath);
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  // Everything else → the SPA shell (client-side router owns the path).
  try {
    const html = await readFile(path.join(frontendDir, 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(rewriteIndexHtml(html));
  } catch {
    res.writeHead(500);
    res.end('index.html missing');
  }
}

export interface WebServerHandle {
  url: string;
  port: number;
  frontendDir: string | null;
  reused: boolean;
}

let started: WebServerHandle | null = null;
let server: http.Server | null = null;

// Try the preferred port; on EADDRINUSE fall back to an ephemeral one so a
// second host process (or a stale bind) never blocks the launch.
function listen(srv: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        srv.removeListener('error', onError);
        srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port));
      } else {
        reject(err);
      }
    };
    srv.once('error', onError);
    srv.listen(port, '127.0.0.1', () => {
      srv.removeListener('error', onError);
      resolve((srv.address() as { port: number }).port);
    });
  });
}

// Start (or reuse) the local web server. Idempotent: repeated calls return the
// already-running instance so `open_dashboard` can be invoked repeatedly.
export async function startWebServer(): Promise<WebServerHandle> {
  if (started) return { ...started, reused: true };
  const frontendDir = resolveFrontendDir();
  server = http.createServer((req, res) => {
    handle(req, res, frontendDir).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const port = await listen(server, DEFAULT_PORT);
  started = { url: `http://127.0.0.1:${port}/`, port, frontendDir, reused: false };
  return started;
}

// For tests / graceful shutdown.
export async function stopWebServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    started = null;
  }
}
