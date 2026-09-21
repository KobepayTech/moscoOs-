/**
 * The capital engine.
 *
 * The treasury view: what can go out today, what is coming back, where the
 * risk has bunched up, and which of the waiting requests can be funded.
 */

import { date, esc, html, money, pct } from '../lib/format.js';
import { api } from '../lib/api.js';
import { go } from '../lib/router.js';
import { head, page, stat } from '../lib/ui.js';

export function renderCapital(target) {
  return page(target, async () => {
    const data = await api('/capital');
    const { capital, collateral, inflows, arrears, concentration, funding, projection } = data;

    const alertTone = { danger: 'error', warning: 'info', info: 'info' };

    return (
      head('Capital', data.headline) +
      html`
        ${data.alerts
          .map(
            (alert) => html`
              <div class="alert alert-${alertTone[alert.level] ?? 'info'}">${esc(alert.message)}</div>
            `,
          )
          .join('')}

        <div class="grid">
          ${stat(
            'Can be lent today',
            money(capital.spendableNow, { compact: true }),
            capital.spendableNow < capital.available
              ? `Policy allows ${money(capital.available, { compact: true })} — cash is the limit`
              : 'Cash and policy agree',
          )}
          ${stat('Out on loan', money(capital.deployed, { compact: true }), `${pct(capital.utilisationRatio)} of capital`)}
          ${stat('Cash on hand', money(capital.cashOnHand, { compact: true }), 'In the account')}
          ${stat(
            'Promised, not yet paid',
            money(data.committed.amount, { compact: true }),
            `${data.committed.count} approved loan(s)`,
          )}
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-title">What is coming back</div>
            <p class="card-note">
              Scheduled repayments, by window. Money owed by members already behind is counted separately —
              a forecast that treats them alike promises money that does not arrive.
            </p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Within</th>
                    <th class="num">Principal</th>
                    <th class="num">Interest</th>
                    <th class="num">Dependable</th>
                  </tr>
                </thead>
                <tbody>
                  ${inflows
                    .map(
                      (inflow) => html`
                        <tr>
                          <td>
                            ${inflow.windowDays} days
                            <div class="faint" style="font-size:11.5px">
                              to ${date(inflow.through)} · ${inflow.instalmentCount} instalment(s)
                            </div>
                          </td>
                          <td class="num">${money(inflow.principal)}</td>
                          <td class="num muted">${money(inflow.interest)}</td>
                          <td class="num">
                            <strong>${money(inflow.dependable)}</strong>
                            ${inflow.fromBorrowersInArrears > 0
                              ? `<div class="faint" style="font-size:11.5px">less ${money(inflow.fromBorrowersInArrears)} owed by members behind</div>`
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

          <div class="card">
            <div class="card-title">Cash, projected</div>
            <p class="card-note">
              What the account holds now, plus what is dependably due, less what has already been promised.
              No new lending is assumed — that is the decision this informs.
            </p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th class="num">Opening</th>
                    <th class="num">Expected in</th>
                    <th class="num">Promised out</th>
                    <th class="num">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  ${['week', 'month', 'quarter']
                    .map((key) => {
                      const row = projection[key];
                      return html`
                        <tr>
                          <td>${esc(key)}<div class="faint" style="font-size:11.5px">${date(row.on)}</div></td>
                          <td class="num muted">${money(row.opening, { compact: true })}</td>
                          <td class="num">+${money(row.inflow, { compact: true })}</td>
                          <td class="num muted">-${money(row.commitments, { compact: true })}</td>
                          <td class="num"><strong>${money(row.closing, { compact: true })}</strong></td>
                        </tr>
                      `;
                    })
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Can we fund what is waiting?</div>
          <p class="card-note">
            Worked through in order: each request is answered from what the one before it leaves. Answering
            them independently would say the circle can fund several loans it can only fund one of.
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th class="num">Amount</th>
                  <th>Can we?</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                ${funding.length === 0
                  ? '<tr><td colspan="4" class="empty">Nothing waiting.</td></tr>'
                  : funding
                      .map(
                        (verdict) => html`
                          <tr class="clickable" data-loan="${esc(verdict.loanId)}">
                            <td>${esc(verdict.memberName)}</td>
                            <td class="num">${money(verdict.principal)}</td>
                            <td>
                              ${verdict.fundableNow
                                ? '<span class="pill pill-positive">pay out today</span>'
                                : verdict.fundableInDays
                                  ? `<span class="pill pill-warning">in ~${verdict.fundableInDays} days</span>`
                                  : '<span class="pill pill-neutral">waiting</span>'}
                            </td>
                            <td class="muted">${esc(verdict.reason)}</td>
                          </tr>
                        `,
                      )
                      .join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-title">Where the lending is concentrated</div>
            <p class="card-note">
              Half the book sits with ${concentration.borrowersToHalfTheBook} borrower(s). Spread index
              ${concentration.borrowerHerfindahl.toFixed(3)} — 1.0 would mean a single borrower holds
              everything.
            </p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>Borrower</th><th class="num">Owing</th><th class="num">Share</th></tr>
                </thead>
                <tbody>
                  ${concentration.borrowers.length === 0
                    ? '<tr><td colspan="3" class="empty">Nothing out on loan.</td></tr>'
                    : concentration.borrowers
                        .slice(0, 8)
                        .map(
                          (entry) => html`
                            <tr>
                              <td>${esc(entry.memberName)}</td>
                              <td class="num">${money(entry.amount)}</td>
                              <td class="num">
                                ${entry.share > 0.25
                                  ? `<span class="pill pill-warning">${pct(entry.share, 0)}</span>`
                                  : pct(entry.share, 0)}
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
            <div class="card-title">Who is carrying the circle</div>
            <p class="card-note">
              What each sponsor still has locked — not what they promised.
              ${money(collateral.releasedToDate)} of the ${money(collateral.totalPledged)} pledged has been
              released as borrowers repaid.
            </p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>Sponsor</th><th class="num">At risk</th><th class="num">Share</th></tr>
                </thead>
                <tbody>
                  ${concentration.sponsors.length === 0
                    ? '<tr><td colspan="3" class="empty">No cover committed.</td></tr>'
                    : concentration.sponsors
                        .slice(0, 8)
                        .map(
                          (entry) => html`
                            <tr>
                              <td>${esc(entry.memberName)}</td>
                              <td class="num">${money(entry.amount)}</td>
                              <td class="num">
                                ${entry.share > 0.25
                                  ? `<span class="pill pill-warning">${pct(entry.share, 0)}</span>`
                                  : pct(entry.share, 0)}
                              </td>
                            </tr>
                          `,
                        )
                        .join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="grid">
          ${stat('Cover still locked', money(collateral.totalAtRisk, { compact: true }), `${pct(collateral.coverageOfBook)} of the book`)}
          ${stat('Cover released', money(collateral.releasedToDate, { compact: true }), 'Freed as loans were repaid')}
          ${stat(
            'Overdue',
            money(arrears.total, { compact: true }),
            arrears.loanCount
              ? `${arrears.loanCount} loan(s), worst ${arrears.worstDaysPastDue} days late`
              : 'Nothing overdue',
          )}
          ${stat('Portfolio at risk', pct(arrears.portfolioAtRisk), 'Overdue against the book')}
        </div>
      `
    );
  }).then(() => {
    target.querySelectorAll('[data-loan]').forEach((element) => {
      element.addEventListener('click', () => go('loan', element.dataset.loan));
    });
  });
}
