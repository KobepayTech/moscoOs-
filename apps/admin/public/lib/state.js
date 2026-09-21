/**
 * Shared state, browser storage, and the hook the shell re-renders through.
 *
 * Deliberately the only module with no imports of its own. Everything else
 * may depend on it, so it must depend on nothing — that is what keeps the
 * module graph free of cycles.
 */

export const API = '';
export const TOKEN_KEY = 'mamogoro.token';
export const THEME_KEY = 'mamogoro.theme';

/** Browser storage can throw in private mode; never let that break the app. */
export const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const state = {
  token: store.get(TOKEN_KEY),
  me: null,
  config: null,
  route: { name: 'dashboard', params: {} },
  notifications: { unread: 0 },
  flash: null,
};

/**
 * Re-render hook.
 *
 * Modules that change what is on screen — a flash message, signing out —
 * need the shell to redraw, but must not import it: the shell imports them.
 * The shell registers itself here instead.
 */
let rerender = () => {};

export function onRerender(fn) {
  rerender = fn;
}

export function requestRender() {
  rerender();
}
