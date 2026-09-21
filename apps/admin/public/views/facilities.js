/**
 * External capital.
 *
 * A facility is a loan to the circle, not a share in it. This page shows how
 * much of each one is actually at work, because that is all it earns on.
 */

import { date, esc, html, money, pct } from '../lib/format.js';
import { api } from '../lib/api.js';
import { head, page, row, stat, waterfallCard } from '../lib/ui.js';

export function renderFacilities(target) {
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
