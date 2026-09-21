/**
 * One member's account with the circle.
 *
 * Every shilling that passed between them and the circle, what it was for,
 * and where they stand now. Open to every member deliberately: a circle where
 * you can only see your own statement is a circle where you have to take it
 * on trust that everyone else's adds up.
 *
 * The sign is from the member's point of view, which is the opposite of the
 * ledger's — money they handed over is positive. That is what makes the
 * running total mean something to the person reading it.
 */

import { api } from '../lib/api.js';
import { date, esc, html, money, pct } from '../lib/format.js';
import { go } from '../lib/router.js';
import { head, page, row, stat } from '../lib/ui.js';
import { state } from '../lib/state.js';

const KIND_LABEL = {
  shares: 'Shares',
  savings: 'Savings',
  borrowed: 'Borrowed',
  repaid: 'Repayment',
  interest: 'Interest',
  fees: 'Fee',
  sponsor_called: 'Sponsor called',
  investor: 'External capital',
  other: '—',
};

const KIND_TONE = {
  shares: 'accent',
  savings: 'accent',
  borrowed: 'warning',
  repaid: 'positive',
  interest: 'info',
  fees: 'info',
  sponsor_called: 'danger',
  investor: 'info',
};

export function renderMemberStatement(target) {
  const memberId = state.route.params.id;

  return page(target, async () => {
    if (!memberId) return '<div class="empty">No member chosen.</div>';

    const data = await api(`/members/${encodeURIComponent(memberId)}/statement`);
    const { member, totals, holding, position, rows } = data;
    const mine = member.id === state.me?.id;

    return (
      head(
        member.fullName,
        `${mine ? 'Your account' : 'Their account'} with the circle — member since ${date(member.joinedOn)}.`,
        '<button class="btn" data-go-members>Back to members</button>',
      ) +
      html`
        <div class="grid" style="margin-bottom:16px">
          ${stat('Shares held', holding.shares.toLocaleString(), `${money(holding.shareValue)} at par`)}
          ${stat(
            'What the stake is worth',
            money(holding.netAssetValue, { compact: true }),
            `${pct(holding.ownershipRatio, 2)} of the circle`,
          )}
          ${stat(
            'Still owed on loans',
            money(position.outstandingPrincipal, { compact: true }),
            position.outstandingPrincipal > 0 ? 'Principal outstanding' : 'Nothing outstanding',
          )}
          ${stat(
            'Cover still locked',
            money(position.coverLocked, { compact: true }),
            position.coverPledged > 0
              ? `${money(position.coverReleased, { compact: true })} released as borrowers repaid`
              : 'Not standing behind anyone',
          )}
        </div>

        <div class="card">
          <div class="card-title">Where it went</div>
          <p class="card-note">
            What ${mine ? 'you have' : 'they have'} paid the circle, and what the circle has paid
            ${mine ? 'you' : 'them'}. The last line is the difference.
          </p>
          <div class="table-wrap">
            <table>
              <tbody>
                ${row('Paid in for shares', money(totals.shares))}
                ${totals.savings !== 0 ? row('Savings', money(totals.savings)) : ''}
                ${totals.fees !== 0 ? row('Fees', money(totals.fees)) : ''}
                ${totals.borrowed !== 0 ? row('Received as loans', money(-totals.borrowed)) : ''}
                ${totals.repaid !== 0 ? row('Principal returned', money(totals.repaid)) : ''}
                ${totals.interest !== 0 ? row('Interest paid', money(totals.interest)) : ''}
                ${totals.sponsorCalled !== 0
                  ? row('Called as a sponsor', money(totals.sponsorCalled), 'danger')
                  : ''}
                ${totals.investor !== 0 ? row('Lent to the circle', money(totals.investor), 'info') : ''}
                <tr>
                  <td><strong>Net position</strong></td>
                  <td class="num">
                    <strong>${money(totals.net)}</strong>
                    ${totals.net >= 0
                      ? '<span class="pill pill-positive">ahead with the circle</span>'
                      : '<span class="pill pill-warning">holding the circle’s money</span>'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <div class="card-title">Every movement</div>
          <p class="card-note">
            ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}, oldest first. A correction appears as its
            own row next to what it corrects — nothing is removed.
          </p>
          ${rows.length === 0
            ? '<div class="empty">Nothing has moved between this member and the circle.</div>'
            : html`
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>What</th>
                        <th></th>
                        <th class="num">Amount</th>
                        <th class="num">Running</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${rows.map(statementRow).join('')}
                    </tbody>
                  </table>
                </div>
              `}
        </div>
      `
    );
  }).then(() => {
    target.querySelector('[data-go-members]')?.addEventListener('click', () => go('members'));
    target.querySelectorAll('[data-loan]').forEach((element) => {
      element.addEventListener('click', () => go('loan', element.dataset.loan));
    });
  });
}

function statementRow(entry) {
  const tone = KIND_TONE[entry.kind];
  const label = KIND_LABEL[entry.kind] ?? entry.kind;

  return html`
    <tr style="${entry.voided ? 'opacity:0.62' : ''}">
      <td class="muted">${date(entry.date)}</td>
      <td>
        ${esc(entry.narration)}
        ${entry.loanIds.length
          ? `<div><button class="link" data-loan="${esc(entry.loanIds[0])}">${esc(entry.loanIds[0])}</button></div>`
          : ''}
      </td>
      <td>
        ${tone ? `<span class="pill pill-${tone}">${esc(label)}</span>` : `<span class="muted">${esc(label)}</span>`}
        ${entry.voided ? '<span class="pill pill-danger">voided</span>' : ''}
        ${entry.reversalOf ? '<span class="pill pill-info">reversal</span>' : ''}
      </td>
      <td class="num">
        ${entry.amount >= 0 ? money(entry.amount) : `<span class="muted">${money(entry.amount)}</span>`}
      </td>
      <td class="num muted">${money(entry.runningTotal)}</td>
    </tr>
  `;
}
