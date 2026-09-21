/**
 * Hash routing.
 *
 * Hash rather than history so the panel can be served from any path without
 * the server needing rewrite rules.
 */

import { state } from './state.js';

/** Set by the shell; the route table lives there. */
let known = new Set();

export function registerRoutes(names) {
  known = new Set(names);
}

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, param] = raw.split('/');
  if (!name || !known.has(name)) return { name: 'dashboard', params: {} };
  return { name, params: param ? { id: decodeURIComponent(param) } : {} };
}

export function go(name, id) {
  location.hash = id ? `#/${name}/${encodeURIComponent(id)}` : `#/${name}`;
}

export function onRouteChange(handler) {
  window.addEventListener('hashchange', () => {
    state.route = parseHash();
    handler();
  });
}
