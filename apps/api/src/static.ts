/**
 * Static file serving for the admin panel.
 *
 * The panel is a single-page app, so anything that is not a real file falls
 * back to `index.html` and the client router takes over. Path traversal is
 * blocked by resolving and then checking containment — never by inspecting the
 * request string, which is where these checks usually go wrong.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { type IncomingMessage, type ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createStaticHandler(root: string) {
  const rootPath = resolve(root);

  return ({ res, path }: { req: IncomingMessage; res: ServerResponse; path: string }): boolean => {
    if (!existsSync(rootPath)) return false;

    const relative = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    let target = resolve(join(rootPath, relative));

    // Containment check on the resolved path: a request for `../../etc/passwd`
    // normalises away before it can escape.
    if (target !== rootPath && !target.startsWith(rootPath + sep)) return false;

    if (existsSync(target) && statSync(target).isDirectory()) {
      target = join(target, 'index.html');
    }

    // Single-page app: unknown paths are client routes, not missing files.
    if (!existsSync(target)) {
      const indexPath = join(rootPath, 'index.html');
      if (!existsSync(indexPath)) return false;
      target = indexPath;
    }

    const contentType = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
    const isHtml = contentType.startsWith('text/html');

    res.writeHead(200, {
      'Content-Type': contentType,
      // The shell must never be cached or a deploy leaves stale app code in
      // place; fingerprint-free assets are revalidated instead.
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300, must-revalidate',
    });

    createReadStream(target).pipe(res);
    return true;
  };
}
