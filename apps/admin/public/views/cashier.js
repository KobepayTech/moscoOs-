/**
 * The cashier's desk.
 *
 * The only page that moves money. Everyone may read it; the buttons appear
 * only for the cashier and the chair, and the API refuses the rest regardless.
 */

import { state } from '../lib/state.js';
import { date, esc, html, money } from '../lib/format.js';
import { api } from '../lib/api.js';
import { go } from '../lib/router.js';
import { head, page, row } from '../lib/ui.js';

export function renderCashier(target) {
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
