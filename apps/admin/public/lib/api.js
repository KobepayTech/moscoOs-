/**
 * The API client.
 *
 * Clears the session itself on a 401 rather than importing the session
 * module, which would make a cycle: session imports this.
 */

import { API, TOKEN_KEY, requestRender, state, store } from './state.js';

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = payload?.error?.code;
    this.detail = payload?.error?.detail;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;

  if (response.status === 401 && state.token) {
    state.token = null;
    state.me = null;
    store.remove(TOKEN_KEY);
    requestRender();
    throw new ApiError(401, { error: { message: 'Your session has expired. Please sign in again.' } });
  }
  if (!response.ok) throw new ApiError(response.status, payload);

  return payload;
}
