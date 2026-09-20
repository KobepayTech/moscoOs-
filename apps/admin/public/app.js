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
 */

const API = '';
const TOKEN_KEY = 'mamogoro.token';
const THEME_KEY = 'mamogoro.theme';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Browser storage can throw in private mode; never let that break the app. */
const store = {
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

const state = {
  token: store.get(TOKEN_KEY),
  me: null,
  config: null,
  route: { name: 'dashboard', params: {} },
  notifications: { unread: 0 },
  flash: null,
};

function money(amount, { compact = false } = {}) {
  if (amount === null || amount === undefined) return '—';
  const symbol = state.config?.currency === 'TZS' ? 'TSh' : (state.config?.currency ?? '');
  const sign = amount < 0 ? '-' : '';
  const value = Math.abs(amount);

  if (compact && value >= 1_000_000) {
    return `${sign}${symbol} ${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  return `${sign}${symbol} ${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function pct(ratio, decimals = 1) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(decimals)}%`;
}

function date(value) {
  if (!value) return '—';
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Escape anything that came from the server before it reaches innerHTML. */
function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

function html(strings, ...values) {
  return strings.reduce((out, chunk, index) => out + chunk + (values[index] ?? ''), '');
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = payload?.error?.code;
    this.detail = payload?.error?.detail;
  }
}

async function api(path, { method = 'GET', body } = {}) {
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
    signOut();
    throw new ApiError(401, { error: { message: 'Your session has expired. Please sign in again.' } });
  }
  if (!response.ok) throw new ApiError(response.status, payload);

  return payload;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const ROUTES = {
  dashboard: { label: 'Overview', render: renderDashboard },
  members: { label: 'Members', render: renderMembers },
  loans: { label: 'Loan book', render: renderLoans },
  loan: { label: 'Loan', render: renderLoanDetail, hidden: true },
  cashier: { label: 'Cashier', render: renderCashier },
  facilities: { label: 'External capital', render: renderFacilities },
  rate: { label: 'Rate model', render: renderRateModel },
  ledger: { label: 'Ledger', render: renderLedger },
  governance: { label: 'Votes', render: renderGovernance },
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, param] = raw.split('/');
  if (!name || !ROUTES[name]) return { name: 'dashboard', params: {} };
  return { name, params: param ? { id: decodeURIComponent(param) } : {} };
}

function go(name, id) {
  location.hash = id ? `#/${name}/${encodeURIComponent(id)}` : `#/${name}`;
}

window.addEventListener('hashchange', () => {
  state.route = parseHash();
  render();
});

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const root = document.getElementById('app');

function flash(message, kind = 'ok') {
  state.flash = { message, kind };
  render();
  setTimeout(() => {
    if (state.flash?.message === message) {
      state.flash = null;
      render();
    }
  }, 5000);
}

function signOut() {
  state.token = null;
  state.me = null;
  store.remove(TOKEN_KEY);
  render();
}

const MARK = html`
  <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.35" />
    <circle cx="16" cy="16" r="8.5" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.6" />
    <circle cx="16" cy="16" r="4" fill="currentColor" />
  </svg>
`;

function render() {
  if (!state.token) return renderSignIn();

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

/** Render a page, turning any failure into a message rather than a blank screen. */
async function page(target, build) {
  try {
    target.innerHTML = await build();
  } catch (error) {
    target.innerHTML = html`
      <div class="alert alert-error">
        ${esc(error.message)}
        ${Array.isArray(error.detail)
          ? `<ul>${error.detail.map((problem) => `<li>${esc(problem.message ?? problem)}</li>`).join('')}</ul>`
          : ''}
      </div>
    `;
  }
}

function head(title, subtitle, actions = '') {
  return html`
    <div class="page-head">
      <div>
        <h1 class="page-title">${esc(title)}</h1>
        ${subtitle ? `<p class="page-sub">${esc(subtitle)}</p>` : ''}
      </div>
      <div class="btn-row">${actions}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

function renderSignIn(errorMessage = '') {
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
      render();
    } catch (error) {
      renderSignIn(error.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function renderDashboard(target) {
  return page(target, async () => {
    const data = await api('/dashboard');
    state.notifications.openProposals = data.governance.openProposals;
    state.notifications.awaitingDisbursement = data.lending.awaitingDisbursement;

    const { capital, lending, membership, performance } = data;

    return (
      head('Overview', data.headline) +
      html`
        <div class="grid">
          ${stat('Members', String(membership.active), `${membership.issued.toLocaleString()} shares in issue`)}
          ${stat('Share capital', money(capital.equityPool, { compact: true }), 'Owned by the members')}
          ${stat(
            'External capital',
            money(capital.facilityCommitted, { compact: true }),
            'Borrowed from members, repayable',
          )}
          ${stat(
            'Out on loan',
            money(capital.deployed, { compact: true }),
            `${pct(capital.utilisationRatio)} of all capital`,
          )}
        </div>

        ${waterfallCard(capital)}

        <div class="grid-2">
          <div class="card">
            <div class="card-title">Lending</div>
            <p class="card-note">Where the circle's loans stand today.</p>
            <table>
              <tbody>
                ${row('Awaiting sponsors', lending.awaitingSponsors)}
                ${row('Approved, awaiting payout', lending.awaitingDisbursement)}
                ${row('Live', lending.live)}
                ${row('Fully repaid', lending.settled)}
                ${row(
                  'In arrears',
                  lending.inArrears
                    ? `${lending.inArrears} &middot; ${money(lending.arrearsAmount)}`
                    : '0',
                  lending.inArrears ? 'danger' : 'positive',
                )}
                ${row('Defaulted', lending.defaulted, lending.defaulted ? 'danger' : 'neutral')}
                ${row('Portfolio at risk', pct(lending.portfolioAtRisk), lending.portfolioAtRisk > 0.1 ? 'danger' : 'neutral')}
              </tbody>
            </table>
          </div>

          <div class="card">
            <div class="card-title">Performance to date</div>
            <p class="card-note">
              Interest earned less what the circle owes on external capital and what it spends to run itself.
            </p>
            <table>
              <tbody>
                ${row('Interest on member loans', money(performance.income.interestIncome))}
                ${row('Fees and subscriptions', money(performance.income.feeIncome))}
                ${row('Penalties', money(performance.income.penaltyIncome))}
                ${row('Return owed to investors', `-${money(performance.income.facilityInterestExpense)}`)}
                ${row('Running costs', `-${money(performance.income.operatingExpense)}`)}
                ${row('Loans written off', `-${money(performance.income.loanLoss)}`)}
                <tr>
                  <td><strong>Surplus</strong></td>
                  <td class="num">
                    <strong class="${performance.income.surplus >= 0 ? '' : ''}"
                      >${money(performance.income.surplus)}</strong
                    >
                  </td>
                </tr>
                ${row('Value of one share', money(membership.netAssetValuePerShare))}
              </tbody>
            </table>
            ${performance.booksBalance
              ? '<div class="alert alert-ok" style="margin:14px 0 0">The books balance.</div>'
              : '<div class="alert alert-error" style="margin:14px 0 0">The books do not balance — this needs attention now.</div>'}
          </div>
        </div>
      `
    );
  });
}

function stat(label, value, foot) {
  return html`
    <div class="stat">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${value}</div>
      ${foot ? `<div class="stat-foot">${esc(foot)}</div>` : ''}
    </div>
  `;
}

function row(label, value, tone) {
  const rendered = tone ? `<span class="pill pill-${tone}">${value}</span>` : value;
  return `<tr><td class="muted">${esc(label)}</td><td class="num">${rendered}</td></tr>`;
}

/**
 * The utilisation bar.
 *
 * This is the single most important picture in the system: it shows which
 * money is working and whose it is. The investor is paid on the blue-solid
 * segment alone, and the pale blue is capital sitting idle earning nobody
 * anything.
 */
function waterfallCard(capital) {
  const total = Math.max(1, capital.totalCapital);
  const equityFree = Math.max(0, capital.equityPool - capital.equityUtilised);

  // Segments carry only the amount; the key below names what each one is.
  // A label long enough to be clipped is worse than no label at all.
  const segment = (value, className, label) => {
    if (value <= 0) return '';
    const share = (value / total) * 100;
    const text = share > 8 ? money(value, { compact: true }) : '';
    return `<div class="waterfall-seg ${className}" style="flex: 0 0 ${share}%" title="${esc(label)}">${text}</div>`;
  };

  return html`
    <div class="card" style="margin-top:16px">
      <div class="card-title">Whose money is at work</div>
      <p class="card-note">
        Lending draws the members' own capital first. External capital only starts earning once lending goes
        beyond that line — so the pale blue below is committed but idle, and earns its investor nothing.
      </p>

      <div class="waterfall">
        <div class="waterfall-track">
          ${segment(capital.equityUtilised, 'seg-equity-used', `Members' capital lent: ${money(capital.equityUtilised)}`)}
          ${segment(equityFree, 'seg-equity-free', `Members' capital free: ${money(equityFree)}`)}
          ${segment(capital.facilityUtilised, 'seg-facility-used', `External capital lent: ${money(capital.facilityUtilised)}`)}
          ${segment(capital.facilityIdle, 'seg-facility-idle', `External capital idle: ${money(capital.facilityIdle)}`)}
        </div>

        <div class="waterfall-key">
          <span class="key-item"
            ><span class="key-swatch" style="background: var(--accent)"></span>Members' capital lent
            ${money(capital.equityUtilised, { compact: true })}</span
          >
          <span class="key-item"
            ><span class="key-swatch" style="background: var(--accent-soft)"></span>Members' capital free
            ${money(equityFree, { compact: true })}</span
          >
          <span class="key-item"
            ><span class="key-swatch" style="background: var(--info)"></span>External capital lent
            ${money(capital.facilityUtilised, { compact: true })}</span
          >
          <span class="key-item"
            ><span class="key-swatch" style="background: var(--info-soft)"></span>External capital idle
            ${money(capital.facilityIdle, { compact: true })}</span
          >
        </div>
      </div>

      <div class="grid" style="margin-top:18px">
        ${stat('Free to lend', money(capital.available, { compact: true }), 'Available right now')}
        ${stat('Largest single loan', money(capital.maxSingleLoan, { compact: true }), 'Under current policy')}
        ${stat('Utilisation', pct(capital.utilisationRatio), 'Of the whole capital base')}
      </div>
    </div>
  `;
}

function renderMembers(target) {
  return page(target, async () => {
    const data = await api('/members');
    const { register, members } = data;

    return (
      head(
        'Members',
        `${register.memberCount} members holding ${register.issued.toLocaleString()} of ${register.authorized.toLocaleString()} authorised shares.`,
      ) +
      html`
        <div class="grid" style="margin-bottom:16px">
          ${stat('Issued shares', register.issued.toLocaleString(), `${money(register.parValue)} each`)}
          ${stat('Share capital', money(register.issuedCapital, { compact: true }), 'Paid up by members')}
          ${stat('Unissued', register.unissued.toLocaleString(), 'Room for new members')}
          ${stat('Largest holding', pct(register.largestHoldingRatio), 'Concentration check')}
        </div>

        <div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th class="num">Shares</th>
                  <th class="num">Value</th>
                  <th class="num">Stake</th>
                  <th>Standing</th>
                </tr>
              </thead>
              <tbody>
                ${members
                  .map(
                    (member) => html`
                      <tr>
                        <td>
                          <div>${esc(member.fullName)}</div>
                          <div class="mono">${esc(member.phone)}</div>
                        </td>
                        <td>
                          ${member.role === 'member'
                            ? '<span class="muted">member</span>'
                            : `<span class="pill pill-accent">${esc(member.role)}</span>`}
                        </td>
                        <td class="num">${member.shares.toLocaleString()}</td>
                        <td class="num">${money(member.shareValue)}</td>
                        <td class="num">${pct(member.ownershipRatio, 2)}</td>
                        <td>
                          ${member.fullyPaid
                            ? '<span class="pill pill-positive">fully paid</span>'
                            : '<span class="pill pill-warning">subscription incomplete</span>'}
                          ${member.status !== 'active'
                            ? `<span class="pill pill-danger">${esc(member.status)}</span>`
                            : ''}
                        </td>
                      </tr>
                    `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      `
    );
  });
}

const LOAN_TONE = {
  awaiting_sponsors: 'warning',
  approved: 'info',
  disbursed: 'accent',
  settled: 'positive',
  defaulted: 'danger',
  declined: 'neutral',
  cancelled: 'neutral',
  draft: 'neutral',
};

function renderLoans(target) {
  return page(target, async () => {
    const { loans } = await api('/loans');

    return (
      head('Loan book', 'Every loan the circle has written, and where each one stands.') +
      html`
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Borrower</th>
                  <th>Purpose</th>
                  <th class="num">Amount</th>
                  <th>Status</th>
                  <th class="num">Outstanding</th>
                  <th>Due</th>
                </tr>
              </thead>
              <tbody>
                ${loans.length === 0
                  ? '<tr><td colspan="6" class="empty">No loans yet.</td></tr>'
                  : loans
                      .map((loan) => {
                        const outstanding =
                          loan.state?.principalOutstanding ?? loan.state?.outstanding ?? null;
                        const trouble =
                          loan.state?.status === 'in_arrears' ||
                          loan.state?.status === 'defaulted' ||
                          loan.state?.status === 'overdue';

                        return html`
                          <tr class="clickable" data-loan="${esc(loan.id)}">
                            <td>
                              <div>${esc(loan.memberName)}</div>
                              <div class="mono">${esc(loan.id)}</div>
                            </td>
                            <td class="muted">
                              ${esc((loan.purpose ?? '').slice(0, 52))}${(loan.purpose ?? '').length > 52 ? '…' : ''}
                              ${loan.product === 'short_term'
                                ? '<div><span class="pill pill-info">short term</span></div>'
                                : ''}
                            </td>
                            <td class="num">${money(loan.principal)}</td>
                            <td>
                              <span class="pill pill-${LOAN_TONE[loan.status] ?? 'neutral'}"
                                >${esc(loan.status.replace(/_/g, ' '))}</span
                              >
                              ${trouble
                                ? `<div><span class="pill pill-danger">${esc(loan.state.status.replace(/_/g, ' '))}</span></div>`
                                : ''}
                              ${loan.coverage
                                ? `<div class="meter"><div class="meter-fill ${loan.coverage.fullyCovered ? 'full' : ''}" style="width:${Math.min(100, loan.coverage.coverageRatio * 100)}%"></div></div>
                                   <div class="faint" style="font-size:11.5px;margin-top:3px">${pct(loan.coverage.coverageRatio, 0)} covered</div>`
                                : ''}
                            </td>
                            <td class="num">${outstanding === null ? '—' : money(outstanding)}</td>
                            <td class="muted">${date(loan.maturityOn)}</td>
                          </tr>
                        `;
                      })
                      .join('')}
              </tbody>
            </table>
          </div>
        </div>
      `
    );
  }).then(() => {
    target.querySelectorAll('[data-loan]').forEach((element) => {
      element.addEventListener('click', () => go('loan', element.dataset.loan));
    });
  });
}

function renderLoanDetail(target) {
  return page(target, async () => {
    const id = state.route.params.id;
    const loan = await api(`/loans/${encodeURIComponent(id)}`);
    const canRecord = ['cashier', 'chair'].includes(state.me?.role);

    const scheduleTable = loan.schedule
      ? html`
          <div class="card">
            <div class="card-title">Repayment schedule</div>
            <p class="card-note">
              ${money(loan.schedule.levelServiceInstalment)} a month for
              ${loan.schedule.terms.termMonths} months, carrying all
              ${money(loan.schedule.scheduledInterest)} of interest, then a flat
              ${money(loan.schedule.balloon)} at maturity with no interest on it.
            </p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Due</th>
                    <th class="num">Opening</th>
                    <th class="num">Principal</th>
                    <th class="num">Interest</th>
                    <th class="num">Total</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${loan.schedule.rows
                    .map((scheduleRow, index) => {
                      const status = loan.state?.rows?.[index];
                      return html`
                        <tr class="${scheduleRow.kind === 'balloon' ? 'row-balloon' : ''}">
                          <td>${scheduleRow.kind === 'balloon' ? 'Final' : scheduleRow.index}</td>
                          <td>${date(scheduleRow.dueOn)}</td>
                          <td class="num muted">${money(scheduleRow.openingPrincipal)}</td>
                          <td class="num">${money(scheduleRow.principalDue)}</td>
                          <td class="num">
                            ${scheduleRow.interestDue === 0
                              ? '<span class="pill pill-positive">no interest</span>'
                              : money(scheduleRow.interestDue)}
                          </td>
                          <td class="num"><strong>${money(scheduleRow.totalDue)}</strong></td>
                          <td>
                            ${status?.settled
                              ? '<span class="pill pill-positive">paid</span>'
                              : status?.daysPastDue > 0
                                ? `<span class="pill pill-danger">${status.daysPastDue}d late</span>`
                                : '<span class="pill pill-neutral">due</span>'}
                          </td>
                        </tr>
                      `;
                    })
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>
        `
      : '';

    const coverage = loan.coverage;

    return (
      html`<button class="back-link" data-back>&larr; Back to the loan book</button>` +
      head(
        `${loan.memberName} · ${money(loan.principal)}`,
        loan.purpose ?? '',
        canRecord && loan.status === 'approved'
          ? `<button class="btn btn-primary" data-disburse>Record disbursement</button>`
          : canRecord && loan.status === 'disbursed'
            ? `<button class="btn btn-primary" data-repay>Record repayment</button>`
            : '',
      ) +
      html`
        <div class="grid" style="margin-bottom:16px">
          ${stat('Status', `<span class="pill pill-${LOAN_TONE[loan.status] ?? 'neutral'}">${esc(loan.status.replace(/_/g, ' '))}</span>`, '')}
          ${stat('Applied', date(loan.appliedOn), loan.disbursedOn ? `Paid out ${date(loan.disbursedOn)}` : '')}
          ${loan.state
            ? stat(
                'Outstanding',
                money(loan.state.principalOutstanding ?? loan.state.outstanding),
                loan.state.arrears ? `${money(loan.state.arrears)} in arrears` : 'Up to date',
              )
            : ''}
          ${stat('Maturity', date(loan.maturityOn), '')}
        </div>

        ${coverage
          ? html`
              <div class="card">
                <div class="card-title">Sponsor cover</div>
                <p class="card-note">
                  The circle lends against members' shares, not against a credit score. This loan needs
                  ${money(coverage.required)} of cover before it can be paid out.
                </p>
                <div class="meter">
                  <div
                    class="meter-fill ${coverage.fullyCovered ? 'full' : ''}"
                    style="width:${Math.min(100, coverage.coverageRatio * 100)}%"
                  ></div>
                </div>
                <p class="muted" style="font-size:13px;margin:8px 0 0">
                  ${money(coverage.securedCover)} secured of ${money(coverage.required)}
                  (${pct(coverage.coverageRatio, 0)}) —
                  ${money(coverage.selfCover)} from the borrower's own shares,
                  ${money(coverage.acceptedCover)} from sponsors.
                  ${coverage.shortfall > 0 ? `Still ${money(coverage.shortfall)} short.` : 'Fully covered.'}
                </p>
              </div>
            `
          : ''}

        ${loan.pledges?.length
          ? html`
              <div class="card">
                <div class="card-title">Who is standing behind this loan</div>
                <p class="card-note">
                  Every member can see this. If the loan defaults, these shareholdings are called in the order
                  shown: the borrower's own shares first, then the sponsors', pro rata to what they pledged.
                </p>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Sponsor</th>
                        <th class="num">Pledged</th>
                        <th>Answer</th>
                        <th>Asked</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${loan.pledges
                        .map(
                          (pledge) => html`
                            <tr>
                              <td>${esc(pledge.sponsorName)}</td>
                              <td class="num">${money(pledge.amount)}</td>
                              <td>
                                <span
                                  class="pill pill-${pledge.status === 'accepted'
                                    ? 'positive'
                                    : pledge.status === 'declined' || pledge.status === 'expired'
                                      ? 'danger'
                                      : pledge.status === 'called'
                                        ? 'danger'
                                        : 'warning'}"
                                  >${esc(pledge.status)}</span
                                >
                              </td>
                              <td class="muted">${date(pledge.requestedOn)}</td>
                            </tr>
                          `,
                        )
                        .join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            `
          : ''}

        ${scheduleTable}

        ${loan.repayments?.length
          ? html`
              <div class="card">
                <div class="card-title">Repayments received</div>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th class="num">Amount</th>
                        <th>Reference</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${loan.repayments
                        .map(
                          (repayment) => html`
                            <tr>
                              <td>${date(repayment.paidOn)}</td>
                              <td class="num">${money(repayment.amount)}</td>
                              <td class="mono">${esc(repayment.reference ?? '—')}</td>
                            </tr>
                          `,
                        )
                        .join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            `
          : ''}
      `
    );
  }).then(() => {
    target.querySelector('[data-back]')?.addEventListener('click', () => go('loans'));

    target.querySelector('[data-disburse]')?.addEventListener('click', async () => {
      const reference = prompt('Payment reference (M-Pesa code, cheque number):', '');
      if (reference === null) return;
      try {
        await api(`/loans/${encodeURIComponent(state.route.params.id)}/disburse`, {
          method: 'POST',
          body: { reference },
        });
        flash('Disbursement recorded and posted to the ledger.');
      } catch (error) {
        flash(error.message, 'error');
      }
    });

    target.querySelector('[data-repay]')?.addEventListener('click', async () => {
      const amount = prompt('Amount received (whole shillings):', '');
      if (amount === null) return;
      const parsed = Number(amount.replace(/[^0-9]/g, ''));
      if (!parsed) return flash('Enter a whole number of shillings.', 'error');

      try {
        const result = await api(`/loans/${encodeURIComponent(state.route.params.id)}/repayments`, {
          method: 'POST',
          body: { amount: parsed },
        });
        flash(
          `Recorded: ${money(result.recorded.towardPrincipal)} principal, ` +
            `${money(result.recorded.towardInterest)} interest` +
            (result.recorded.towardPenalty ? `, ${money(result.recorded.towardPenalty)} penalty.` : '.'),
        );
      } catch (error) {
        flash(error.message, 'error');
      }
    });
  });
}

function renderCashier(target) {
  return page(target, async () => {
    const canRecord = ['cashier', 'chair'].includes(state.me?.role);
    const { loans } = await api('/loans?status=approved');
    const live = await api('/loans?status=disbursed');

    return (
      head(
        'Cashier',
        canRecord
          ? 'Loans that have reached full sponsor cover and are waiting to be paid out.'
          : 'Loans waiting to be paid out. Only the cashier can record the money moving.',
      ) +
      html`
        ${!canRecord
          ? '<div class="alert alert-info">You are signed in as a member, so you can see this queue but not act on it.</div>'
          : ''}

        <div class="card">
          <div class="card-title">Awaiting payout (${loans.length})</div>
          <p class="card-note">
            These approved themselves the moment their sponsor cover was complete. No committee decision is
            outstanding — only the payment.
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Borrower</th>
                  <th>Purpose</th>
                  <th class="num">Amount</th>
                  <th>Approved</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${loans.length === 0
                  ? '<tr><td colspan="5" class="empty">Nothing waiting to be paid out.</td></tr>'
                  : loans
                      .map(
                        (loan) => html`
                          <tr>
                            <td>${esc(loan.memberName)}</td>
                            <td class="muted">${esc(loan.purpose ?? '')}</td>
                            <td class="num"><strong>${money(loan.principal)}</strong></td>
                            <td class="muted">${date(loan.approvedOn)}</td>
                            <td class="num">
                              <button class="btn btn-sm" data-open="${esc(loan.id)}">Open</button>
                            </td>
                          </tr>
                        `,
                      )
                      .join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Live loans (${live.loans.length})</div>
          <p class="card-note">Money that is out, and what is due next.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Borrower</th>
                  <th class="num">Outstanding</th>
                  <th class="num">Next due</th>
                  <th>On</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${live.loans.length === 0
                  ? '<tr><td colspan="6" class="empty">No live loans.</td></tr>'
                  : live.loans
                      .map((loan) => {
                        const next = loan.state?.rows?.find((scheduleRow) => !scheduleRow.settled);
                        return html`
                          <tr>
                            <td>${esc(loan.memberName)}</td>
                            <td class="num">
                              ${money(loan.state?.principalOutstanding ?? loan.state?.outstanding)}
                            </td>
                            <td class="num">
                              ${next ? money(next.row.principalDue + next.row.interestDue) : money(loan.state?.payoffAmount)}
                            </td>
                            <td class="muted">${date(next?.row?.dueOn ?? loan.maturityOn)}</td>
                            <td>
                              <span
                                class="pill pill-${loan.state?.status === 'in_arrears' ||
                                loan.state?.status === 'overdue' ||
                                loan.state?.status === 'defaulted'
                                  ? 'danger'
                                  : 'positive'}"
                                >${esc((loan.state?.status ?? '').replace(/_/g, ' '))}</span
                              >
                            </td>
                            <td class="num">
                              <button class="btn btn-sm" data-open="${esc(loan.id)}">Open</button>
                            </td>
                          </tr>
                        `;
                      })
                      .join('')}
              </tbody>
            </table>
          </div>
        </div>
      `
    );
  }).then(() => {
    target.querySelectorAll('[data-open]').forEach((element) => {
      element.addEventListener('click', () => go('loan', element.dataset.open));
    });
  });
}

function renderFacilities(target) {
  return page(target, async () => {
    const data = await api('/facilities');

    return (
      head(
        'External capital',
        'Money members have lent to the circle. It is a liability, not share capital — it does not dilute anyone and it carries no vote.',
      ) +
      waterfallCard({ ...data.capital, ...data.today, ...data.capital.headroom }) +
      html`
        ${data.facilities
          .map(
            (facility) => html`
              <div class="card">
                <div class="page-head" style="margin-bottom:12px">
                  <div>
                    <div class="card-title">${esc(facility.investorName)}</div>
                    <div class="mono">${esc(facility.id)} · funded ${date(facility.fundedOn)}</div>
                  </div>
                  <span class="pill pill-${facility.status === 'active' ? 'positive' : 'neutral'}"
                    >${esc(facility.status)}</span
                  >
                </div>

                <div class="grid">
                  ${stat('Committed', money(facility.principal, { compact: true }), `at ${pct(facility.monthlyRate, 2)} a month`)}
                  ${stat('At work now', money(facility.utilisedNow, { compact: true }), 'Earning today')}
                  ${stat(
                    'Average at work',
                    money(facility.accrual.averageUtilised, { compact: true }),
                    `${pct(facility.accrual.utilisationRatio)} of the facility`,
                  )}
                  ${stat('Earned to date', money(facility.accrual.interestAccrued), `${facility.accrual.utilisedDays} days working`)}
                </div>

                <div class="explain">${esc(facility.explanation)}</div>

                <table>
                  <tbody>
                    ${row('Capital outstanding', money(facility.outstandingPrincipal))}
                    ${row('Return already paid', money(facility.accrual.interestPaid))}
                    ${row('Return still owed', money(facility.accrual.interestOutstanding))}
                    <tr>
                      <td><strong>Total due to this investor</strong></td>
                      <td class="num"><strong>${money(facility.totalDue)}</strong></td>
                    </tr>
                    ${row(
                      'Can be called back',
                      facility.withdrawable
                        ? '<span class="pill pill-positive">yes</span>'
                        : `<span class="pill pill-warning">from ${esc(date(facility.earliestWithdrawalOn))}</span>`,
                    )}
                  </tbody>
                </table>
              </div>
            `,
          )
          .join('')}
        ${data.facilities.length === 0
          ? '<div class="card"><div class="empty">No external capital has been advanced.</div></div>'
          : ''}
      `
    );
  });
}

function renderRateModel(target) {
  return page(target, async () => {
    const data = await api('/rate-model');
    const { model } = data;

    const componentRow = (label, value, note) => html`
      <tr>
        <td>
          ${esc(label)}
          <div class="faint" style="font-size:12px">${esc(note)}</div>
        </td>
        <td class="num">${pct(value, 3)}</td>
        <td class="num muted">${pct(value * 12, 2)}</td>
      </tr>
    `;

    return (
      head(
        'Rate model',
        'The lending rate is not chosen by feel. Every shilling of interest has four calls on it, and the rate is whatever makes them add up.',
      ) +
      html`
        <div class="grid" style="margin-bottom:16px">
          ${stat('Published rate', pct(data.publishedRate, 2), 'per month, on the declining balance')}
          ${stat('Break-even', pct(model.breakEvenMonthlyRate, 2), 'covers costs, funds no growth')}
          ${stat('Required', pct(model.recommendedMonthlyRate, 2), 'to also hit the members’ target')}
          ${stat('Annualised', pct(model.effectiveAnnualRate, 1), `${pct(model.nominalAnnualRate, 0)} nominal`)}
        </div>

        ${data.publishedRateIsSufficient
          ? `<div class="alert alert-ok">The published rate of ${pct(data.publishedRate, 2)} covers the investor, the running costs, expected losses and the members' target return.</div>`
          : `<div class="alert alert-error">The published rate of ${pct(data.publishedRate, 2)} is below the ${pct(model.recommendedMonthlyRate, 2)} the circle needs. At this rate the members' own capital is subsidising the lending.</div>`}

        <div class="card">
          <div class="card-title">What the rate pays for</div>
          <p class="card-note">${esc(data.explanation)}</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th class="num">Monthly</th>
                  <th class="num">Annualised</th>
                </tr>
              </thead>
              <tbody>
                ${componentRow(
                  'Cost of external capital',
                  model.components.costOfExternalCapital,
                  `${money(model.facilityUtilised, { compact: true })} of facility at work, at ${pct(model.inputs.investorMonthlyRate, 2)}`,
                )}
                ${componentRow('Running costs', model.components.operatingCost, `${money(model.inputs.monthlyOperatingCost)} a month`)}
                ${componentRow('Expected losses', model.components.expectedCreditLoss, `${pct(model.inputs.annualExpectedCreditLoss)} of the portfolio a year`)}
                ${componentRow('Members’ target return', model.components.equityGrowthTarget, `${pct(model.inputs.targetAnnualReturnOnEquity)} a year on share capital`)}
                <tr>
                  <td><strong>Required rate</strong></td>
                  <td class="num"><strong>${pct(model.recommendedMonthlyRate, 3)}</strong></td>
                  <td class="num muted">${pct(model.recommendedMonthlyRate * 12, 2)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">What happens if lending slows down</div>
          <p class="card-note">
            Idle money is the real risk, not the rate. Capital sitting in the account still has to be carried by
            the capital that is working, so the less the circle lends, the more it must charge on what it does
            lend.
            ${data.breakEven.utilisation !== null
              ? `Below ${pct(data.breakEven.utilisation, 0)} utilisation — about ${money(data.breakEven.earningAssets, { compact: true })} on loan — the current rate stops covering costs.`
              : ''}
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="num">Utilisation</th>
                  <th class="num">On loan</th>
                  <th class="num">External capital at work</th>
                  <th class="num">Break-even rate</th>
                  <th class="num">Rate needed</th>
                </tr>
              </thead>
              <tbody>
                ${data.sensitivity
                  .map(
                    (sensitivityRow) => html`
                      <tr
                        style="${Math.abs(sensitivityRow.targetUtilisation - model.inputs.targetUtilisation) < 0.001
                          ? 'background: var(--accent-soft)'
                          : ''}"
                      >
                        <td class="num">${pct(sensitivityRow.targetUtilisation, 0)}</td>
                        <td class="num">${money(sensitivityRow.earningAssets, { compact: true })}</td>
                        <td class="num">${money(sensitivityRow.facilityUtilised, { compact: true })}</td>
                        <td class="num">${pct(sensitivityRow.breakEvenMonthlyRate, 2)}</td>
                        <td class="num"><strong>${pct(sensitivityRow.publishedMonthlyRate, 2)}</strong></td>
                      </tr>
                    `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">What the members' capital does over a year</div>
          <p class="card-note">
            Share capital compounding at the published rate, with monthly contributions added.
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="num">Month</th>
                  <th class="num">Opening</th>
                  <th class="num">Contributions</th>
                  <th class="num">Surplus</th>
                  <th class="num">Closing</th>
                </tr>
              </thead>
              <tbody>
                ${data.projection
                  .map(
                    (projectionRow) => html`
                      <tr>
                        <td class="num">${projectionRow.month}</td>
                        <td class="num muted">${money(projectionRow.openingEquity, { compact: true })}</td>
                        <td class="num muted">${money(projectionRow.contributions, { compact: true })}</td>
                        <td class="num">${money(projectionRow.surplus)}</td>
                        <td class="num"><strong>${money(projectionRow.closingEquity, { compact: true })}</strong></td>
                      </tr>
                    `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      `
    );
  });
}

function renderLedger(target) {
  return page(target, async () => {
    const data = await api('/ledger');
    const entries = data.entries.slice().reverse().slice(0, 200);

    return (
      head(
        'Ledger',
        'Every movement of money, open to every member. Nothing here is ever deleted — a mistake is corrected by posting a reversal, and the original stays visible.',
      ) +
      html`
        <div class="grid" style="margin-bottom:16px">
          ${stat('Total assets', money(data.position.totalAssets, { compact: true }), '')}
          ${stat('Liabilities', money(data.position.totalLiabilities, { compact: true }), 'Owed to investors and savers')}
          ${stat('Members’ equity', money(data.position.totalEquity, { compact: true }), 'Share capital plus retained surplus')}
          ${stat(
            'Balance check',
            data.trialBalance.balanced ? '<span class="pill pill-positive">balanced</span>' : '<span class="pill pill-danger">out</span>',
            data.trialBalance.balanced ? 'Debits equal credits' : `Out by ${money(data.trialBalance.difference)}`,
          )}
        </div>

        <div class="card">
          <div class="card-title">Recent entries</div>
          <p class="card-note">Showing the most recent ${entries.length} of ${data.entries.length}.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Entry</th>
                  <th class="num">Amount</th>
                  <th>Reference</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${entries
                  .map(
                    (entry) => html`
                      <tr style="${entry.voided ? 'opacity:0.62' : ''}">
                        <td class="muted">${date(entry.date)}</td>
                        <td>
                          ${esc(entry.narration)}
                          <div class="mono">${esc(entry.id)}</div>
                        </td>
                        <td class="num">${money(entry.amount)}</td>
                        <td class="mono">${esc(entry.reference ?? '—')}</td>
                        <td>
                          ${entry.voided ? '<span class="pill pill-danger">voided</span>' : ''}
                          ${entry.reversalOf ? '<span class="pill pill-info">reversal</span>' : ''}
                        </td>
                      </tr>
                    `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      `
    );
  });
}

function renderGovernance(target) {
  return page(target, async () => {
    const [{ proposals }, { announcements }] = await Promise.all([
      api('/proposals'),
      api('/announcements'),
    ]);

    state.notifications.openProposals = proposals.filter((proposal) => proposal.status === 'open').length;

    return (
      head(
        'Votes',
        'Any member can propose that a record be removed, but nobody removes one alone. Financial records are never deleted — a vote against a ledger entry reverses it and leaves the original visible.',
      ) +
      html`
        <div class="card">
          <div class="card-title">Proposals</div>
          <p class="card-note">
            A proposal carries when enough of the circle turns out (${pct(state.config?.governance.quorumRatio ?? 0.5, 0)}
            of voting weight) and enough of those who voted are in favour
            (${pct(state.config?.governance.passThresholdRatio ?? 2 / 3, 0)}). Weight follows shares.
          </p>

          ${proposals.length === 0 ? '<div class="empty">No proposals.</div>' : ''}

          ${proposals
            .map((proposal) => {
              const tally = proposal.tally;
              const total = Math.max(1, tally.eligibleWeight);
              const canVote = proposal.status === 'open';

              return html`
                <div style="padding:14px 0;border-top:1px solid var(--border)">
                  <div class="page-head" style="margin-bottom:6px">
                    <div>
                      <strong>Remove ${esc(proposal.entityType.replace(/_/g, ' '))}</strong>
                      <span class="mono">${esc(proposal.entityId)}</span>
                      ${proposal.kind === 'void_financial_record'
                        ? '<span class="pill pill-info">reverses, does not delete</span>'
                        : ''}
                      <div class="muted" style="font-size:13px;margin-top:3px">${esc(proposal.reason)}</div>
                      <div class="faint" style="font-size:12px;margin-top:2px">
                        Proposed by ${esc(proposal.proposedByName)} on ${date(proposal.openedOn)} ·
                        closes ${date(proposal.closesOn)}
                      </div>
                    </div>
                    <span
                      class="pill pill-${proposal.status === 'executed'
                        ? 'positive'
                        : proposal.status === 'open'
                          ? 'warning'
                          : 'neutral'}"
                      >${esc(proposal.status)}</span
                    >
                  </div>

                  <div class="vote-bar">
                    <div class="vote-for" style="width:${(tally.forWeight / total) * 100}%"></div>
                    <div class="vote-against" style="width:${(tally.againstWeight / total) * 100}%"></div>
                    <div class="vote-abstain" style="width:${(tally.abstainWeight / total) * 100}%"></div>
                  </div>

                  <div class="faint" style="font-size:12.5px">${esc(proposal.headline)}</div>
                  <div class="muted" style="font-size:12.5px;margin-top:2px">
                    ${tally.forWeight.toLocaleString()} for ·
                    ${tally.againstWeight.toLocaleString()} against ·
                    ${tally.abstainWeight.toLocaleString()} abstaining ·
                    turnout ${pct(tally.turnout, 0)} of ${tally.eligibleWeight.toLocaleString()} shares
                  </div>

                  ${canVote
                    ? html`
                        <div class="btn-row" style="margin-top:10px">
                          <button class="btn btn-sm btn-primary" data-vote="for" data-proposal="${esc(proposal.id)}">
                            In favour
                          </button>
                          <button class="btn btn-sm btn-danger" data-vote="against" data-proposal="${esc(proposal.id)}">
                            Against
                          </button>
                          <button class="btn btn-sm" data-vote="abstain" data-proposal="${esc(proposal.id)}">
                            Abstain
                          </button>
                        </div>
                      `
                    : ''}
                </div>
              `;
            })
            .join('')}
        </div>

        <div class="card">
          <div class="card-title">Announcements</div>
          <p class="card-note">
            Notices to the circle. These are ordinary records, so a vote can remove one outright.
          </p>
          ${announcements.length === 0 ? '<div class="empty">Nothing posted.</div>' : ''}
          ${announcements
            .map(
              (announcement) => html`
                <div style="padding:12px 0;border-top:1px solid var(--border)">
                  <div class="page-head" style="margin-bottom:4px">
                    <div>
                      <strong>${esc(announcement.title)}</strong>
                      <div class="muted" style="font-size:13px">${esc(announcement.body)}</div>
                      <div class="faint" style="font-size:12px;margin-top:3px">
                        ${esc(announcement.postedByName)} · ${date(announcement.postedOn)}
                      </div>
                    </div>
                    <button class="btn btn-sm btn-danger" data-propose="${esc(announcement.id)}">
                      Propose removal
                    </button>
                  </div>
                </div>
              `,
            )
            .join('')}
        </div>
      `
    );
  }).then(() => {
    target.querySelectorAll('[data-vote]').forEach((element) => {
      element.addEventListener('click', async () => {
        try {
          const result = await api(`/proposals/${encodeURIComponent(element.dataset.proposal)}/votes`, {
            method: 'POST',
            body: { choice: element.dataset.vote },
          });
          flash(
            result.outcome === 'delete'
              ? 'Your vote carried the proposal — the record has been removed.'
              : result.outcome === 'void'
                ? 'Your vote carried the proposal — the entry has been reversed and marked void.'
                : `Vote recorded (${result.vote.weight.toLocaleString()} shares).`,
          );
          renderGovernance(target);
        } catch (error) {
          flash(error.message, 'error');
        }
      });
    });

    target.querySelectorAll('[data-propose]').forEach((element) => {
      element.addEventListener('click', async () => {
        const reason = prompt('Why should this be removed? (at least 10 characters)', '');
        if (!reason) return;
        try {
          await api('/proposals', {
            method: 'POST',
            body: { entityType: 'announcement', entityId: element.dataset.propose, reason },
          });
          flash('Proposal opened. The circle has been notified and can now vote.');
          renderGovernance(target);
        } catch (error) {
          flash(error.message, 'error');
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function bootstrap() {
  const [me, config] = await Promise.all([api('/auth/me'), api('/config')]);
  state.me = me.member;
  state.config = config;
}

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
  renderSignIn();
}
