/**
 * The Mamogoro Circles API server.
 */

import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openDb, type Db } from './db.js';
import { Router } from './http.js';
import { createStaticHandler } from './static.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerFacilityRoutes } from './routes/facilities.js';
import { registerGovernanceRoutes } from './routes/governance.js';
import { registerLoanRoutes } from './routes/loans.js';
import { registerMemberRoutes } from './routes/members.js';

export function buildRouter(db: Db): Router {
  const router = new Router();
  registerDashboardRoutes(router, db);
  registerMemberRoutes(router, db);
  registerLoanRoutes(router, db);
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
    void router.handle(req, res);
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
