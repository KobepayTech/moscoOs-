/**
 * Sign in.
 *
 * Owns the whole screen rather than a page slot, so it takes the app root
 * instead of the usual page target.
 */

import { api } from '../lib/api.js';
import { esc, html } from '../lib/format.js';
import { parseHash } from '../lib/router.js';
import { bootstrap } from '../lib/session.js';
import { TOKEN_KEY, requestRender, state, store } from '../lib/state.js';
import { MARK } from '../lib/ui.js';

export function renderSignIn(root, errorMessage = '') {
  root.className = 'signin';
  root.innerHTML = html`
    <form class="signin-card" id="signin-form">
      <div class="signin-brand" style="color: var(--accent)">
        ${MARK}
        <div>
          <div class="brand-name" style="color: var(--text); font-size: 17px">Mamogoro Circles</div>
          <div class="brand-sub">Member sign in</div>
        </div>
      </div>

      ${errorMessage ? `<div class="alert alert-error">${esc(errorMessage)}</div>` : ''}

      <div class="field">
        <label for="phone">Phone number</label>
        <input id="phone" name="phone" autocomplete="username" inputmode="tel" required />
      </div>

      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
      </div>

      <button class="btn btn-primary" style="width:100%" type="submit">Sign in</button>

      <p class="signin-hint">
        Every member of the circle can sign in and see the whole book — the ledger, the loan register and who
        is standing behind whom. Recording money is limited to the cashier.
      </p>
    </form>
  `;

  document.getElementById('signin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);

    try {
      const result = await api('/auth/login', {
        method: 'POST',
        body: { phone: form.get('phone'), password: form.get('password') },
      });

      state.token = result.token;
      state.me = result.member;
      store.set(TOKEN_KEY, result.token);

      await bootstrap();
      state.route = parseHash();
      requestRender();
    } catch (error) {
      renderSignIn(root, error.message);
    }
  });
}
