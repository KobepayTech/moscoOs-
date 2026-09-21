/**
 * Who is signed in.
 *
 * Kept apart from the shell so any view can end a session without importing
 * the thing that renders it.
 */

import { api } from './api.js';
import { TOKEN_KEY, requestRender, state, store } from './state.js';

/** Load the signed-in member and the circle's live configuration. */
export async function bootstrap() {
  const [me, config] = await Promise.all([api('/auth/me'), api('/config')]);
  state.me = me.member;
  state.config = config;
}

export function signOut() {
  state.token = null;
  state.me = null;
  store.remove(TOKEN_KEY);
  requestRender();
}
