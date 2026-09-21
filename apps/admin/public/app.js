/**
 * Mamogoro Circles — admin panel.
 *
 * Plain ES modules, no build step, no framework. That is a deliberate choice
 * for a circle of thirty people: the panel has to open quickly on whatever
 * laptop the secretary has, and a treasurer handing over to the next
 * treasurer should be able to read the whole client in an afternoon.
 *
 * Every member can sign in here. Reading is open to all; only recording money
 * is restricted, and the API enforces that — the UI merely stops showing
 * buttons that would be refused.
 *
 * This file is the shell and nothing else: the route table, the frame drawn
 * around every page, and the start-up sequence. Each workspace lives in its
 * own module under `views/`, and what they share lives under `lib/`:
 *
 *   lib/state.js    shared state and browser storage — imports nothing
 *   lib/format.js   money, dates, percentages, escaping
 *   lib/api.js      the fetch wrapper
 *   lib/router.js   hash routing
 *   lib/session.js  who is signed in
 *   lib/ui.js       the pieces that appear on more than one page
 */

import { esc, html } from './lib/format.js';
import { go, onRouteChange, parseHash, registerRoutes } from './lib/router.js';
import { bootstrap, signOut } from './lib/session.js';
import { THEME_KEY, onRerender, state, store } from './lib/state.js';
import { MARK } from './lib/ui.js';

import { renderCapital } from './views/capital.js';
import { renderCashier } from './views/cashier.js';
import { renderDashboard } from './views/dashboard.js';
import { renderFacilities } from './views/facilities.js';
import { renderGovernance } from './views/governance.js';
import { renderLedger } from './views/ledger.js';
import { renderLoanDetail, renderLoans } from './views/loans.js';
import { renderMemberStatement } from './views/member.js';
import { renderMembers } from './views/members.js';
import { renderRateModel } from './views/rate.js';
import { renderReports } from './views/reports.js';
import { renderSignIn } from './views/signin.js';

const root = document.getElementById('app');

const ROUTES = {
  dashboard: { label: 'Overview', render: renderDashboard },
  capital: { label: 'Capital', render: renderCapital },
  members: { label: 'Members', render: renderMembers },
  member: { label: 'Member statement', render: renderMemberStatement, hidden: true },
  loans: { label: 'Loan book', render: renderLoans },
  loan: { label: 'Loan', render: renderLoanDetail, hidden: true },
  cashier: { label: 'Cashier', render: renderCashier },
  facilities: { label: 'External capital', render: renderFacilities },
  rate: { label: 'Rate model', render: renderRateModel },
  ledger: { label: 'Ledger', render: renderLedger },
  reports: { label: 'Cash flow', render: renderReports },
  governance: { label: 'Votes', render: renderGovernance },
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function render() {
  if (!state.token) return renderSignIn(root);

  const canRecord = ['cashier', 'chair'].includes(state.me?.role);
  const route = ROUTES[state.route.name] ?? ROUTES.dashboard;

  root.className = '';
  root.innerHTML = html`
    <div class="shell">
      <aside class="sidebar">
        <div class="brand" style="color: var(--accent)">
          ${MARK}
          <div>
            <div class="brand-name" style="color: var(--text)">Mamogoro</div>
            <div class="brand-sub">Circles</div>
          </div>
        </div>

        <nav class="nav">
          ${Object.entries(ROUTES)
            .filter(([, definition]) => !definition.hidden)
            .map(
              ([name, definition]) => html`
                <button
                  class="nav-item"
                  data-go="${name}"
                  ${state.route.name === name ? 'aria-current="page"' : ''}
                >
                  <span>${definition.label}</span>
                  ${name === 'governance' && state.notifications.openProposals
                    ? `<span class="nav-badge">${state.notifications.openProposals}</span>`
                    : ''}
                  ${name === 'cashier' && state.notifications.awaitingDisbursement
                    ? `<span class="nav-badge">${state.notifications.awaitingDisbursement}</span>`
                    : ''}
                </button>
              `,
            )
            .join('')}
        </nav>

        <div class="sidebar-footer">
          <div class="who">${esc(state.me?.fullName ?? '')}</div>
          <div class="who-role">${esc(state.me?.role ?? '')}${canRecord ? ' · can record money' : ''}</div>
          <button class="theme-toggle" data-action="toggle-theme">Switch theme</button>
          <button class="theme-toggle" data-action="sign-out">Sign out</button>
        </div>
      </aside>

      <main class="main" id="main">
        ${state.flash ? `<div class="alert alert-${state.flash.kind}">${esc(state.flash.message)}</div>` : ''}
        <div id="page"><div class="empty">Loading…</div></div>
      </main>
    </div>
  `;

  wireShell();
  void route.render(document.getElementById('page'));
}

function wireShell() {
  root.querySelectorAll('[data-go]').forEach((element) => {
    element.addEventListener('click', () => go(element.dataset.go));
  });

  root.querySelector('[data-action="sign-out"]')?.addEventListener('click', signOut);

  root.querySelector('[data-action="toggle-theme"]')?.addEventListener('click', () => {
    const current =
      document.documentElement.dataset.theme ??
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set(THEME_KEY, next);
  });
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

// Views and the router redraw through these hooks rather than importing the
// shell — the shell imports them, and a cycle would be the result. Routes are
// registered here too, so the router can tell a real route from a stray hash
// without owning the table.
onRerender(render);
onRouteChange(render);
registerRoutes(Object.keys(ROUTES));

const savedTheme = store.get(THEME_KEY);
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

state.route = parseHash();

if (state.token) {
  bootstrap()
    .then(render)
    .catch(() => {
      // A stale token from a previous run of the server signs us out cleanly.
      signOut();
    });
} else {
  renderSignIn(root);
}
