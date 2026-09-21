/**
 * The Mamogoro Circles API server.
 */

import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { type Role } from './auth.js';
import { openDb, type Db } from './db.js';
import { Router } from './http.js';
import { createStaticHandler } from './static.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerFacilityRoutes } from './routes/facilities.js';
import { registerGovernanceRoutes } from './routes/governance.js';
import { registerLoanRoutes } from './routes/loans.js';
import { registerMemberRoutes } from './routes/members.js';
import { registerPaymentRoutes } from './routes/payments.js';

export function buildRouter(db: Db): Router {
  const router = new Router();

  // Authorisation reads the member's current row rather than trusting the
  // role the token was issued with.
  const lookup = db.prepare('SELECT role, full_name, status FROM members WHERE id = ?');
  router.resolvePrincipal = (memberId) => {
    const row = lookup.get(memberId) as unknown as
      | { role: Role; full_name: string; status: string }
      | undefined;
    return row ? { role: row.role, name: row.full_name, status: row.status } : null;
  };

  registerDashboardRoutes(router, db);
  registerMemberRoutes(router, db);
  registerLoanRoutes(router, db);
  registerPaymentRoutes(router, db);
  registerFacilityRoutes(router, db);
  registerGovernanceRoutes(router, db);
  return router;
}

export function createApp(db: Db, options: { staticDir?: string } = {}) {
  const router = buildRouter(db);

  if (options.staticDir) {
    router.fallback = createStaticHandler(options.staticDir);
  }

  return createServer((req, res) => {
    // Last line of defence. Anything that escapes the router's own handling
    // becomes a 500, never an unhandled rejection that ends the process —
    // a circle's server should not be stoppable by one malformed request.
    router.handle(req, res).catch((error) => {
      console.error('Unhandled error escaping the router:', error);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Request failed' } }));
      }
    });
  });
}

/** Where the admin panel's files live, relative to the built server. */
export function defaultAdminDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../admin/public');
}

// Only start listening when run directly; importing this module (as the tests
// do) should give you the app without binding a port.
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const port = Number(process.env.PORT ?? 4000);
  const db = openDb();
  const staticDir = process.env.MAMOGORO_ADMIN_DIR ?? defaultAdminDir();
  const server = createApp(db, { staticDir });

  server.listen(port, () => {
    console.log(`Mamogoro Circles API listening on http://localhost:${port}`);
    console.log(`Admin panel:  http://localhost:${port}/`);
    console.log(`Database: ${process.env.MAMOGORO_DB ?? './data/mamogoro.db'}`);
    if (!process.env.MAMOGORO_SECRET) {
      console.warn('MAMOGORO_SECRET is not set — using the development signing key. Do not do this in production.');
    }
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
