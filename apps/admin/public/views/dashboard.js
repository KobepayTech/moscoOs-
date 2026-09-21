/**
 * The overview.
 *
 * The first thing a member sees: what the circle is worth, what is out on
 * loan, and whose money is doing the work.
 */

import { state } from '../lib/state.js';
import { date, html, money, pct } from '../lib/format.js';
import { api } from '../lib/api.js';
import { head, page, row, stat, waterfallCard } from '../lib/ui.js';

export function renderDashboard(target) {
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
