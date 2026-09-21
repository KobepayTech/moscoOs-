/**
 * The loan book, and a single loan in full.
 *
 * The detail page is where sponsorship happens: the schedule as it was frozen
 * at disbursement, who is standing behind it, and how much of their cover has
 * been released by repayments so far.
 */

import { state } from '../lib/state.js';
import { date, esc, html, money, pct } from '../lib/format.js';
import { api } from '../lib/api.js';
import { go } from '../lib/router.js';
import { flash, head, page, row, stat } from '../lib/ui.js';

export const LOAN_TONE = {
  awaiting_sponsors: 'warning',
  approved: 'info',
  disbursed: 'accent',
  settled: 'positive',
  defaulted: 'danger',
  declined: 'neutral',
  cancelled: 'neutral',
  draft: 'neutral',
};

export function renderLoans(target) {
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

export function renderLoanDetail(target) {
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
                  A sponsor is released in step with the repayments, so "at risk" falls as the borrower pays.
                </p>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Sponsor</th>
                        <th class="num">Pledged</th>
                        <th class="num">Still at risk</th>
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
                              <td class="num">
                                ${pledge.atRisk === undefined
                                  ? '—'
                                  : pledge.atRisk === 0
                                    ? '<span class="pill pill-positive">released</span>'
                                    : money(pledge.atRisk)}
                              </td>
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
