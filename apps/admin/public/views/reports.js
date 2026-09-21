/**
 * Where the cash went.
 *
 * The ledger page answers "what is the circle worth". This answers the
 * question a meeting actually argues about: the surplus says the circle is
 * doing well, so why is there nothing in the account?
 *
 * The three sections are what make that answerable. A circle funding its
 * lending out of earnings is compounding; one funding it out of capital is
 * growing on money it will have to give back. Same closing balance, very
 * different position.
 */

import { api } from '../lib/api.js';
import { date, esc, html, money } from '../lib/format.js';
import { head, page, stat } from '../lib/ui.js';

const WINDOWS = [
  { key: 'all', label: 'All time', months: null },
  { key: '12m', label: 'Last 12 months', months: 12 },
  { key: '3m', label: 'Last 3 months', months: 3 },
  { key: '1m', label: 'Last month', months: 1 },
];

const SECTION_NOTE = {
  lending:
    'Money going out to borrowers, and principal coming back. Negative is healthy here — it is capital being put to work, not a loss.',
  earnings:
    'Interest and fees actually received, less what it cost to run the circle and to service external capital. Income in the only form that can pay for anything.',
  capital:
    'Subscriptions, savings and external facilities. Money arriving from the people who put it up, which the circle earned no part of.',
};

/** Default window: the whole life of the circle. */
let chosen = 'all';

export function renderReports(target) {
  return page(target, async () => {
    const window = WINDOWS.find((option) => option.key === chosen) ?? WINDOWS[0];
    const from = window.months ? monthsAgo(window.months) : null;
    const statement = await api(`/reports/cash-flow${from ? `?from=${from}` : ''}`);

    const funded = fundingStory(statement);

    return (
      head(
        'Cash flow',
        'A surplus is not money in the account. This is what actually moved.',
        WINDOWS.map(
          (option) => html`
            <button class="btn ${option.key === chosen ? 'btn-primary' : ''}" data-window="${option.key}">
              ${esc(option.label)}
            </button>
          `,
        ).join(''),
      ) +
      html`
        ${statement.reconciles
          ? ''
          : html`
              <div class="alert alert-error">
                This statement does not tie back to the ledger's own cash balance. The books need looking at
                before anyone relies on these figures.
              </div>
            `}

        <div class="grid" style="margin-bottom:16px">
          ${stat(
            'Opened with',
            money(statement.openingCash, { compact: true }),
            statement.from ? date(statement.from) : 'The circle’s first day',
          )}
          ${stat('Came in', money(statement.totalInflow, { compact: true }), `${statement.movements} movement(s)`)}
          ${stat('Went out', money(statement.totalOutflow, { compact: true }), '')}
          ${stat('Closed with', money(statement.closingCash, { compact: true }), date(statement.asOf))}
        </div>

        ${funded
          ? html`<div class="alert alert-${funded.tone}">${esc(funded.message)}</div>`
          : ''}

        ${statement.sections.map(sectionCard).join('')}

        <div class="card" style="margin-top:16px">
          <div class="card-title">Does it tie back?</div>
          <p class="card-note">
            Every figure above is read off the cash lines of entries already posted — there is no separate
            record of cash to drift out of step with the books. The check below is therefore a fact about the
            ledger, not an opinion about it.
          </p>
          <div class="table-wrap">
            <table>
              <tbody>
                <tr>
                  <td class="muted">Opening cash</td>
                  <td class="num">${money(statement.openingCash)}</td>
                </tr>
                ${statement.sections
                  .map(
                    (section) => html`
                      <tr>
                        <td class="muted">${esc(section.label)}</td>
                        <td class="num">${signed(section.net)}</td>
                      </tr>
                    `,
                  )
                  .join('')}
                <tr>
                  <td><strong>Closing cash</strong></td>
                  <td class="num">
                    <strong>${money(statement.closingCash)}</strong>
                    ${statement.reconciles
                      ? '<span class="pill pill-positive">ties back</span>'
                      : '<span class="pill pill-danger">does not tie back</span>'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      `
    );
  }).then(() => {
    target.querySelectorAll('[data-window]').forEach((element) => {
      element.addEventListener('click', () => {
        chosen = element.dataset.window;
        renderReports(target);
      });
    });
  });
}

function sectionCard(section) {
  if (section.lines.length === 0) {
    return html`
      <div class="card" style="margin-top:16px">
        <div class="card-title">${esc(section.label)}</div>
        <div class="empty">Nothing moved under this heading in the period.</div>
      </div>
    `;
  }

  return html`
    <div class="card" style="margin-top:16px">
      <div class="card-title">${esc(section.label)} · ${signed(section.net)}</div>
      <p class="card-note">${esc(SECTION_NOTE[section.name] ?? '')}</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Against</th>
              <th class="num">In</th>
              <th class="num">Out</th>
              <th class="num">Net</th>
            </tr>
          </thead>
          <tbody>
            ${section.lines
              .map(
                (line) => html`
                  <tr>
                    <td>${esc(line.name)}</td>
                    <td class="num">${line.inflow ? money(line.inflow) : '—'}</td>
                    <td class="num muted">${line.outflow ? money(line.outflow) : '—'}</td>
                    <td class="num"><strong>${signed(line.net)}</strong></td>
                  </tr>
                `,
              )
              .join('')}
            <tr>
              <td><strong>Total</strong></td>
              <td class="num"><strong>${money(section.inflow)}</strong></td>
              <td class="num"><strong>${money(section.outflow)}</strong></td>
              <td class="num"><strong>${signed(section.net)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * Say in one sentence what paid for the lending.
 *
 * This is the reading a treasurer would give the meeting, and it is the whole
 * reason for splitting the sections rather than presenting one net figure.
 */
function fundingStory(statement) {
  const of = (name) => statement.sections.find((section) => section.name === name) ?? { net: 0 };
  const lent = -of('lending').net;
  const earned = of('earnings').net;
  const raised = of('capital').net;

  if (lent <= 0) {
    return earned > 0
      ? { tone: 'ok', message: `The circle took in ${fmt(earned)} more than it spent, and lent nothing new out of it.` }
      : null;
  }

  if (earned >= lent) {
    return {
      tone: 'ok',
      message: `${fmt(lent)} went out on loan and the circle earned ${fmt(earned)} in the same period — the lending paid for itself.`,
    };
  }

  if (raised > 0) {
    return {
      tone: 'info',
      message: `${fmt(lent)} went out on loan against ${fmt(earned)} earned; the difference came from ${fmt(raised)} of new capital, which the circle will have to give back.`,
    };
  }

  return {
    tone: 'warning',
    message: `${fmt(lent)} went out on loan against only ${fmt(earned)} earned, with no new capital raised — the circle is lending out of its reserves.`,
  };
}

function fmt(amount) {
  return money(amount, { compact: true });
}

/** A net figure, with the sign made obvious rather than left to be spotted. */
function signed(amount) {
  if (amount === 0) return '<span class="muted">—</span>';
  if (amount > 0) return `<span class="pill pill-positive">+${money(amount)}</span>`;
  return `<span class="muted">${money(amount)}</span>`;
}

function monthsAgo(months) {
  const now = new Date();
  now.setUTCMonth(now.getUTCMonth() - months);
  return now.toISOString().slice(0, 10);
}
